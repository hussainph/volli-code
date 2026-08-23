import { describe, expect, it } from "vite-plus/test";
import {
  ACTIVITY_KINDS,
  ATTEMPT_STOP_REASONS,
  COMPACTION_REASONS,
  type ObservabilityEvent,
} from "@volli/shared";

import { observabilityMetrics, observabilitySpan } from "./genai";

const attempt: ObservabilityEvent = {
  kind: "provider-attempt",
  providerId: "anthropic",
  modelId: "claude-sonnet-4",
  api: "anthropic-messages",
  reasoningLevel: "medium",
  stopReason: "stop",
  durationMs: 1200,
  ttftMs: 300,
  chunkCount: 42,
  inputTokens: 100,
  outputTokens: 200,
  cacheReadTokens: 50,
  cacheWriteTokens: 25,
  reasoningTokens: 10,
  totalTokens: 385,
  costUsd: 0.0042,
  responseModelId: "claude-sonnet-4-20250514",
  runId: "run-1",
};

describe("observabilitySpan — provider attempts", () => {
  it("names the span with the convention's `{operation} {request model}` recipe", () => {
    expect(observabilitySpan(attempt).name).toBe("chat claude-sonnet-4");
  });

  it("maps usage onto GenAI attributes and cost onto Volli's own", () => {
    expect(observabilitySpan(attempt)).toEqual({
      name: "chat claude-sonnet-4",
      kind: "client",
      durationMs: 1200,
      failed: false,
      attributes: {
        "volli.run.id": "run-1",
        "gen_ai.operation.name": "chat",
        "gen_ai.provider.name": "anthropic",
        "gen_ai.system": "anthropic",
        "gen_ai.request.model": "claude-sonnet-4",
        "gen_ai.response.model": "claude-sonnet-4-20250514",
        "gen_ai.response.finish_reasons": "stop",
        "gen_ai.response.time_to_first_chunk": 300,
        "gen_ai.usage.input_tokens": 100,
        "gen_ai.usage.output_tokens": 200,
        "gen_ai.usage.cache_read.input_tokens": 50,
        "gen_ai.usage.cache_creation.input_tokens": 25,
        "gen_ai.usage.reasoning.output_tokens": 10,
        "volli.provider.api": "anthropic-messages",
        "volli.request.reasoning_level": "medium",
        "volli.usage.total_tokens": 385,
        "volli.usage.cost_usd": 0.0042,
        "volli.stream.chunks": 42,
      },
    });
  });

  it("omits what the provider did not report rather than reporting zero", () => {
    const sparse = observabilitySpan({
      kind: "provider-attempt",
      providerId: "openai",
      modelId: "gpt-5",
      api: "openai-responses",
      stopReason: "stop",
      durationMs: 10,
    });
    for (const absent of [
      "gen_ai.usage.input_tokens",
      "gen_ai.usage.output_tokens",
      "gen_ai.response.model",
      "gen_ai.response.time_to_first_chunk",
      "volli.usage.cost_usd",
      "volli.stream.chunks",
      "volli.request.reasoning_level",
      "volli.run.id",
    ]) {
      expect(sparse.attributes).not.toHaveProperty(absent);
    }
  });

  it("fails only the stop reasons that produced no answer", () => {
    const failedBy = Object.fromEntries(
      ATTEMPT_STOP_REASONS.map((stopReason) => [
        stopReason,
        observabilitySpan({ ...attempt, stopReason }).failed,
      ]),
    );
    expect(failedBy).toEqual({
      stop: false,
      length: false,
      toolUse: false,
      error: true,
      aborted: true,
      deferred: false,
      unknown: false,
    });
  });

  it("carries a bounded provider error class as `error.type` on a failed attempt", () => {
    expect(
      observabilitySpan({
        ...attempt,
        stopReason: "error",
        providerErrorClass: "rate-limit",
      }).attributes["error.type"],
    ).toBe("rate-limit");
    // Synthetic or pre-classification events retain the stop reason as the
    // safe fallback; provider prose never crosses this boundary either way.
    expect(observabilitySpan({ ...attempt, stopReason: "error" }).attributes["error.type"]).toBe(
      "error",
    );
    expect(observabilitySpan(attempt).attributes).not.toHaveProperty("error.type");
  });
});

describe("observabilitySpan — product events", () => {
  it("times a completed turn and does not fail an interrupted one", () => {
    expect(observabilitySpan({ kind: "turn", outcome: "completed", durationMs: 900 })).toEqual({
      name: "volli.agent.turn",
      kind: "internal",
      durationMs: 900,
      failed: false,
      attributes: { "volli.turn.outcome": "completed" },
    });
    const interrupted = observabilitySpan({ kind: "turn", outcome: "interrupted" });
    expect(interrupted.durationMs).toBe(0);
    expect(interrupted.failed).toBe(false);
  });

  it("names a tool span after Volli's activity kind, never a model-supplied name", () => {
    const span = observabilitySpan({
      kind: "tool",
      activityKind: "run-command",
      outcome: "completed",
      durationMs: 55,
      runId: "run-2",
    });
    expect(span.name).toBe("execute_tool run-command");
    expect(span.attributes["gen_ai.tool.name"]).toBe("run-command");
    expect(span.attributes["gen_ai.tool.type"]).toBe("function");
    expect(span.attributes["volli.run.id"]).toBe("run-2");
  });

  it("keeps every activity kind inside the bounded tool vocabulary", () => {
    for (const activityKind of ACTIVITY_KINDS) {
      const span = observabilitySpan({ kind: "tool", activityKind, outcome: "completed" });
      expect(span.name).toBe(`execute_tool ${activityKind}`);
      expect(span.attributes["gen_ai.tool.name"]).toBe(activityKind);
    }
  });

  it("fails a tool span only when the call failed", () => {
    const failed = observabilitySpan({
      kind: "tool",
      activityKind: "edit-file",
      outcome: "failed",
    });
    expect(failed.failed).toBe(true);
    expect(failed.attributes["error.type"]).toBe("tool_failed");
  });

  it("records allowed and denied authority decisions as working policy, not faults", () => {
    const denied = observabilitySpan({
      kind: "authority",
      outcome: "denied",
      cause: "call.unreadable",
    });
    const allowed = observabilitySpan({
      kind: "authority",
      outcome: "allowed",
      waitDurationMs: 120,
    });

    expect(denied.failed).toBe(false);
    expect(denied.attributes).toEqual({
      "volli.authority.outcome": "denied",
      "volli.authority.cause": "call.unreadable",
    });
    expect(allowed).toMatchObject({
      name: "volli.agent.authority",
      durationMs: 120,
      failed: false,
      attributes: { "volli.authority.outcome": "allowed" },
    });
  });

  it("carries compaction token counts only on the arm that measured them", () => {
    for (const reason of COMPACTION_REASONS) {
      expect(
        observabilitySpan({
          kind: "compaction",
          outcome: "compacted",
          reason,
          tokensBefore: 900,
          tokensAfter: 100,
        }).attributes,
      ).toEqual({
        "volli.compaction.outcome": "compacted",
        "volli.compaction.reason": reason,
        "volli.compaction.tokens_before": 900,
        "volli.compaction.tokens_after": 100,
      });
    }
    const failed = observabilitySpan({
      kind: "compaction",
      outcome: "failed",
      reason: "manual",
    });
    expect(failed.failed).toBe(true);
    expect(failed.attributes["error.type"]).toBe("compaction_failed");
    expect(failed.attributes).not.toHaveProperty("volli.compaction.tokens_before");
  });

  it("reports an attachment failure's bounded reason as the error type", () => {
    expect(
      observabilitySpan({ kind: "attachment", phase: "failed", failureReason: "configuration" })
        .attributes,
    ).toEqual({
      "volli.attachment.phase": "failed",
      "volli.attachment.failure_reason": "configuration",
      "error.type": "configuration",
    });
    // A failure the runtime could not name still marks the span failed.
    expect(observabilitySpan({ kind: "attachment", phase: "failed" }).attributes).toEqual({
      "volli.attachment.phase": "failed",
      "error.type": "attachment_failed",
    });
    expect(observabilitySpan({ kind: "attachment", phase: "started" }).failed).toBe(false);
  });

  it("records attention as a state, never as a span failure", () => {
    const span = observabilitySpan({ kind: "attention", phase: "raised", reason: "auth" });
    expect(span.failed).toBe(false);
    expect(span.attributes).toEqual({
      "volli.attention.phase": "raised",
      "volli.attention.reason": "auth",
    });
  });

  it("reports lost telemetry under its own name and does not colour it a failure", () => {
    expect(observabilitySpan({ kind: "dropped", reason: "queue-full", count: 12 })).toEqual({
      name: "volli.observability.dropped",
      kind: "internal",
      durationMs: 0,
      failed: false,
      attributes: { "volli.dropped.reason": "queue-full", "volli.dropped.count": 12 },
    });
  });
});

describe("observabilityMetrics", () => {
  it("maps provider requests, token splits, and cost without a run-id label", () => {
    const metrics = observabilityMetrics(attempt);

    expect(metrics).toEqual(
      expect.arrayContaining([
        {
          name: "volli.agent.model.request.count",
          instrument: "counter",
          unit: "{request}",
          value: 1,
          attributes: {
            "gen_ai.provider.name": "anthropic",
            "gen_ai.request.model": "claude-sonnet-4",
            "gen_ai.response.finish_reasons": "stop",
          },
        },
        {
          name: "gen_ai.client.operation.duration",
          instrument: "histogram",
          unit: "s",
          value: 1.2,
          attributes: {
            "gen_ai.provider.name": "anthropic",
            "gen_ai.request.model": "claude-sonnet-4",
            "gen_ai.response.finish_reasons": "stop",
          },
        },
        {
          name: "gen_ai.client.token.usage",
          instrument: "counter",
          unit: "{token}",
          value: 100,
          attributes: {
            "gen_ai.provider.name": "anthropic",
            "gen_ai.request.model": "claude-sonnet-4",
            "gen_ai.token.type": "input",
            "volli.token.type": "input",
          },
        },
        {
          name: "volli.agent.cost.usage",
          instrument: "counter",
          unit: "USD",
          value: 0.0042,
          attributes: {
            "gen_ai.provider.name": "anthropic",
            "gen_ai.request.model": "claude-sonnet-4",
          },
        },
      ]),
    );
    expect(metrics.filter((metric) => metric.name === "gen_ai.client.token.usage")).toHaveLength(5);
    expect(metrics.every((metric) => !("volli.run.id" in metric.attributes))).toBe(true);
    expect(
      observabilityMetrics({ ...attempt, stopReason: "error" }).find(
        (metric) => metric.name === "volli.agent.model.request.count",
      )?.attributes["error.type"],
    ).toBe("unknown");
  });

  it("counts and times tools, authority decisions, compactions, and drops", () => {
    const tool = observabilityMetrics({
      kind: "tool",
      activityKind: "read-file",
      outcome: "failed",
      durationMs: 240,
      waitDurationMs: 60,
      runId: "run-1",
    });
    expect(tool).toEqual([
      {
        name: "volli.agent.tool.call.count",
        instrument: "counter",
        unit: "{call}",
        value: 1,
        attributes: { "gen_ai.tool.name": "read-file", "volli.tool.outcome": "failed" },
      },
      {
        name: "volli.agent.tool.execution.duration",
        instrument: "histogram",
        unit: "s",
        value: 0.24,
        attributes: { "gen_ai.tool.name": "read-file", "volli.tool.outcome": "failed" },
      },
      {
        name: "volli.agent.tool.wait.duration",
        instrument: "histogram",
        unit: "s",
        value: 0.06,
        attributes: { "gen_ai.tool.name": "read-file", "volli.tool.outcome": "failed" },
      },
    ]);

    expect(observabilityMetrics({ kind: "authority", outcome: "allowed" })).toEqual([
      {
        name: "volli.agent.authority.decision.count",
        instrument: "counter",
        unit: "{decision}",
        value: 1,
        attributes: { "volli.authority.outcome": "allowed" },
      },
    ]);
    expect(
      observabilityMetrics({ kind: "compaction", outcome: "compacted", reason: "threshold" }),
    ).toEqual([
      {
        name: "volli.agent.compaction.count",
        instrument: "counter",
        unit: "{compaction}",
        value: 1,
        attributes: {
          "volli.compaction.outcome": "compacted",
          "volli.compaction.reason": "threshold",
        },
      },
    ]);
    expect(observabilityMetrics({ kind: "dropped", reason: "queue-full", count: 3 })).toEqual([
      {
        name: "volli.observability.dropped.count",
        instrument: "counter",
        unit: "{event}",
        value: 3,
        attributes: { "volli.dropped.reason": "queue-full" },
      },
    ]);
  });
});

describe("observabilitySpan — the export boundary", () => {
  /**
   * The privacy proof, stated as a property rather than a list: an attribute
   * value may only be a number, a boolean, or a string the event itself carried.
   * The vocabulary has no free-form field, so if this holds for every event
   * shape, nothing this module emits can be user content.
   */
  /**
   * The only strings this module contributes itself: the convention's operation
   * names, its fixed tool type, and the bounded error classes it names for
   * failures the event described without wording. Spelled out here so adding a
   * literal to the mapper without adding it to this list fails the build.
   */
  const FROZEN_WORDS = new Set([
    "chat",
    "execute_tool",
    "function",
    "denied",
    "tool_failed",
    "compaction_failed",
    "attachment_failed",
    "input",
    "output",
    "cache-read",
    "cache-write",
    "reasoning",
    "unknown",
  ]);

  it("emits only scalars, and only strings the event itself carried", () => {
    const events: ObservabilityEvent[] = [
      attempt,
      { kind: "turn", outcome: "completed", durationMs: 1 },
      { kind: "tool", activityKind: "search", outcome: "failed", durationMs: 2 },
      { kind: "authority", outcome: "denied", cause: "call.unreadable" },
      { kind: "compaction", outcome: "compacted", reason: "threshold", tokensBefore: 5 },
      { kind: "attachment", phase: "failed", failureReason: "aborted" },
      { kind: "attention", phase: "cleared", reason: "context" },
      { kind: "dropped", reason: "sink-error", count: 3 },
    ];
    for (const event of events) {
      const carried = new Set(
        Object.values(event).filter((value): value is string => typeof value === "string"),
      );
      const span = observabilitySpan(event);
      for (const value of Object.values(span.attributes)) {
        if (typeof value !== "string") {
          expect(typeof value === "number" || typeof value === "boolean").toBe(true);
          continue;
        }
        expect(carried.has(value) || FROZEN_WORDS.has(value)).toBe(true);
      }
      for (const metric of observabilityMetrics(event)) {
        expect(metric.attributes).not.toHaveProperty("volli.run.id");
        for (const value of Object.values(metric.attributes)) {
          if (typeof value !== "string") {
            expect(typeof value === "number" || typeof value === "boolean").toBe(true);
            continue;
          }
          expect(carried.has(value) || FROZEN_WORDS.has(value)).toBe(true);
        }
      }
    }
  });

  it("never sets a message on the span status, because a message is prose", () => {
    // Enforced by shape: `ObservabilitySpan` has no message field at all.
    expect(observabilitySpan(attempt)).not.toHaveProperty("message");
  });
});

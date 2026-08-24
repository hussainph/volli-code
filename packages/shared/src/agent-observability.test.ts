import { describe, expect, it } from "vite-plus/test";

import {
  ATTEMPT_STOP_REASONS,
  NOOP_OBSERVABILITY_SINK,
  OBSERVED_TOOL_IDS,
  PROVIDER_ERROR_CLASSES,
  ObservabilityReducer,
  observedToolId,
  type ObservabilityEvent,
} from "./agent-observability";
import type {
  RuntimeActivityObservation,
  RuntimeObservation,
  SettledAssistantMessage,
} from "./agent-runtime";
import type { ActivityDescriptor } from "./session-activity";

/**
 * Stuffed into every content-bearing field of a fixture observation. A reduced
 * event that serializes to something containing it has leaked user material,
 * whatever the field was called.
 */
const SENSITIVE = "SENSITIVE-user-material";

function leaks(event: ObservabilityEvent | null): boolean {
  return JSON.stringify(event ?? null).includes(SENSITIVE);
}

function descriptor(overrides: Partial<ActivityDescriptor> = {}): ActivityDescriptor {
  return {
    kind: "run-command",
    nativeToolName: SENSITIVE,
    subject: { label: SENSITIVE, path: SENSITIVE, lineRange: { start: 1, end: 2 } },
    outcome: {
      exitCode: 1,
      matchCount: null,
      fileCount: null,
      lineCount: null,
      bytes: null,
      addedLines: null,
      removedLines: null,
      diff: SENSITIVE,
      summary: SENSITIVE,
    },
    startedAt: null,
    endedAt: null,
    ...overrides,
  };
}

function activity(
  state: RuntimeActivityObservation["state"],
  overrides: Partial<ActivityDescriptor> = {},
): RuntimeObservation {
  const base = {
    kind: "activity" as const,
    turnId: "turn-1",
    activityId: "activity-1",
    descriptor: descriptor(overrides),
    input: { command: SENSITIVE },
    output: { stdout: SENSITIVE },
  };
  if (state === "failed") return { ...base, state, error: SENSITIVE };
  return { ...base, state };
}

function settledMessage(): SettledAssistantMessage {
  return {
    entryId: "entry-1",
    role: "assistant",
    text: SENSITIVE,
    reasoning: SENSITIVE,
    model: { providerId: "anthropic", modelId: "claude" },
    usage: { inputTokens: 10, outputTokens: 2, costUsd: 0.01 },
  };
}

describe("ObservabilityReducer turns", () => {
  it("times a completed turn from its own started observation", () => {
    let tick = 1_000;
    const reducer = new ObservabilityReducer(() => tick);
    expect(reducer.reduce({ kind: "turn", state: "started", turnId: "t1" })).toBeNull();
    tick = 1_450;
    expect(reducer.reduce({ kind: "turn", state: "completed", turnId: "t1" })).toEqual({
      kind: "turn",
      outcome: "completed",
      durationMs: 450,
    });
  });

  it("times an interrupted turn the same way", () => {
    let tick = 0;
    const reducer = new ObservabilityReducer(() => tick);
    reducer.reduce({ kind: "turn", state: "started", turnId: "t1" });
    tick = 90;
    expect(reducer.reduce({ kind: "turn", state: "interrupted", turnId: "t1" })).toEqual({
      kind: "turn",
      outcome: "interrupted",
      durationMs: 90,
    });
  });

  it("reports a terminal turn it never saw start without inventing a duration", () => {
    const reducer = new ObservabilityReducer(() => 5);
    const event = reducer.reduce({ kind: "turn", state: "completed", turnId: "recovered" });
    expect(event).toEqual({ kind: "turn", outcome: "completed" });
    expect(event).not.toHaveProperty("durationMs");
  });

  it("forgets a turn once it terminates, so a replayed terminal has no duration", () => {
    const reducer = new ObservabilityReducer(() => 7);
    reducer.reduce({ kind: "turn", state: "started", turnId: "t1" });
    reducer.reduce({ kind: "turn", state: "completed", turnId: "t1" });
    expect(reducer.reduce({ kind: "turn", state: "completed", turnId: "t1" })).toEqual({
      kind: "turn",
      outcome: "completed",
    });
  });

  it("defaults its clock so a caller without one still reduces", () => {
    const reducer = new ObservabilityReducer();
    reducer.reduce({ kind: "turn", state: "started", turnId: "t1" });
    const event = reducer.reduce({ kind: "turn", state: "completed", turnId: "t1" });
    expect(event?.kind).toBe("turn");
  });
});

describe("ObservabilityReducer tools", () => {
  it("reduces a completed activity to kind, outcome, and measured duration", () => {
    const reducer = new ObservabilityReducer(() => 0);
    const event = reducer.reduce(activity("completed", { startedAt: 100, endedAt: 260 }));
    expect(event).toEqual({
      kind: "tool",
      activityKind: "run-command",
      outcome: "completed",
      durationMs: 160,
    });
    expect(leaks(event)).toBe(false);
  });

  it("reduces a failed activity without its error prose", () => {
    const reducer = new ObservabilityReducer(() => 0);
    const event = reducer.reduce(activity("failed"));
    expect(event).toEqual({ kind: "tool", activityKind: "run-command", outcome: "failed" });
    expect(leaks(event)).toBe(false);
  });

  it("omits duration when the descriptor clock is absent or ran backwards", () => {
    const reducer = new ObservabilityReducer(() => 0);
    expect(reducer.reduce(activity("completed"))).not.toHaveProperty("durationMs");
    expect(
      reducer.reduce(activity("completed", { startedAt: 500, endedAt: 400 })),
    ).not.toHaveProperty("durationMs");
  });

  it("drops started and progress activity outright", () => {
    const reducer = new ObservabilityReducer(() => 0);
    expect(reducer.reduce(activity("started"))).toBeNull();
    expect(reducer.reduce(activity("progress"))).toBeNull();
  });

  it("names a tool Volli ships, so per-tool rates are answerable", () => {
    const reducer = new ObservabilityReducer(() => 0);
    // `fetch-url` is one capability class over two distinct tools; without the
    // id there is no way to tell a search from a fetch.
    expect(
      reducer.reduce(activity("completed", { kind: "fetch-url", nativeToolName: "web_search" })),
    ).toMatchObject({ activityKind: "fetch-url", toolId: "web_search" });
    expect(
      reducer.reduce(activity("completed", { kind: "fetch-url", nativeToolName: "web_fetch" })),
    ).toMatchObject({ activityKind: "fetch-url", toolId: "web_fetch" });
  });

  it("refuses to name a tool it does not ship, rather than exporting the name", () => {
    const reducer = new ObservabilityReducer(() => 0);
    // The default fixture's `nativeToolName` is the sensitive marker, which
    // stands in for every name Volli has not allowlisted: an MCP tool, a tool a
    // future Pi adds, or one a model simply invented.
    const event = reducer.reduce(activity("completed"));
    expect(event).not.toHaveProperty("toolId");
    expect(leaks(event)).toBe(false);
    // The capability class still carries the call, so it is counted either way.
    expect(event).toMatchObject({ activityKind: "run-command" });
  });

  it("reports execution time with an approval wait taken back out", () => {
    const reducer = new ObservabilityReducer(() => 0);
    reducer.reduce({
      kind: "authority",
      state: "allowed",
      turnId: "turn-1",
      toolCallId: "activity-1",
      waitDurationMs: 60,
    });
    // 160ms wall clock, 60ms of which was a person deciding.
    expect(reducer.reduce(activity("completed", { startedAt: 100, endedAt: 260 }))).toMatchObject({
      durationMs: 100,
      waitDurationMs: 60,
    });
  });

  it("reports no execution time when the wait outlasts the whole measured span", () => {
    const reducer = new ObservabilityReducer(() => 0);
    reducer.reduce({
      kind: "authority",
      state: "allowed",
      turnId: "turn-1",
      toolCallId: "activity-1",
      waitDurationMs: 5_000,
    });
    // The two clocks disagree about a call this reducer only saw the ends of;
    // a duration derived from that contradiction would be worse than none.
    const event = reducer.reduce(activity("completed", { startedAt: 100, endedAt: 260 }));
    expect(event).not.toHaveProperty("durationMs");
    expect(event).toMatchObject({ waitDurationMs: 5_000 });
  });
});

describe("observedToolId", () => {
  it("admits every tool Volli ships and nothing else", () => {
    for (const id of OBSERVED_TOOL_IDS) expect(observedToolId(id)).toBe(id);
    for (const rejected of [
      "mcp__github__create_issue",
      "Read",
      "bash ",
      "",
      "../../etc/passwd",
      undefined,
      null,
      42,
      { toString: () => "bash" },
    ]) {
      expect(observedToolId(rejected)).toBeUndefined();
    }
  });
});

const freshReducer = () => new ObservabilityReducer(() => 0);

describe("ObservabilityReducer lifecycle facts", () => {
  it("keeps an authority denial's cause and nothing the model chose", () => {
    const event = freshReducer().reduce({
      kind: "authority",
      state: "denied",
      turnId: null,
      toolCallId: "activity-1",
      tool: SENSITIVE,
      cause: "call.unreadable",
      reason: SENSITIVE,
    });
    expect(event).toEqual({ kind: "authority", outcome: "denied", cause: "call.unreadable" });
    expect(leaks(event)).toBe(false);
  });

  it("keeps an allowed authority decision and separates its wait from tool execution", () => {
    const reducer = freshReducer();
    const decision = reducer.reduce({
      kind: "authority",
      state: "allowed",
      turnId: "turn-1",
      toolCallId: "activity-1",
      waitDurationMs: 40,
    });
    const tool = reducer.reduce(activity("completed", { startedAt: 100, endedAt: 260 }));

    expect(decision).toEqual({ kind: "authority", outcome: "allowed", waitDurationMs: 40 });
    expect(tool).toEqual({
      kind: "tool",
      activityKind: "run-command",
      outcome: "completed",
      durationMs: 120,
      waitDurationMs: 40,
    });
  });

  it("keeps authority decisions without a wait, and never invents negative execution time", () => {
    const reducer = freshReducer();
    expect(
      reducer.reduce({
        kind: "authority",
        state: "allowed",
        turnId: "turn-1",
        toolCallId: "activity-1",
      }),
    ).toEqual({ kind: "authority", outcome: "allowed" });
    expect(
      reducer.reduce({
        kind: "authority",
        state: "denied",
        turnId: "turn-1",
        toolCallId: "activity-1",
        waitDurationMs: 200,
        tool: SENSITIVE,
        cause: "call.unreadable",
        reason: SENSITIVE,
      }),
    ).toEqual({
      kind: "authority",
      outcome: "denied",
      cause: "call.unreadable",
      waitDurationMs: 200,
    });
    expect(reducer.reduce(activity("failed", { startedAt: 100, endedAt: 150 }))).toEqual({
      kind: "tool",
      activityKind: "run-command",
      outcome: "failed",
      waitDurationMs: 200,
    });
  });

  it("keeps a landed compaction's reason and both token measurements", () => {
    const event = freshReducer().reduce({
      kind: "compaction",
      state: "compacted",
      reason: "threshold",
      entryId: "entry-9",
      tokensBefore: 90_000,
      tokensAfter: 12_000,
    });
    expect(event).toEqual({
      kind: "compaction",
      outcome: "compacted",
      reason: "threshold",
      tokensBefore: 90_000,
      tokensAfter: 12_000,
    });
  });

  it("keeps a failed compaction's reason and drops its diagnostic prose", () => {
    const event = freshReducer().reduce({
      kind: "compaction",
      state: "failed",
      reason: "overflow",
      message: SENSITIVE,
    });
    expect(event).toEqual({ kind: "compaction", outcome: "failed", reason: "overflow" });
    expect(leaks(event)).toBe(false);
  });

  it("reduces attachment phases, bounding a failure to its reason", () => {
    expect(freshReducer().reduce({ kind: "attachment", state: "started" })).toEqual({
      kind: "attachment",
      phase: "started",
    });
    const failed = freshReducer().reduce({
      kind: "attachment",
      state: "failed",
      failure: { reason: "auth", message: SENSITIVE },
    });
    expect(failed).toEqual({ kind: "attachment", phase: "failed", failureReason: "auth" });
    expect(leaks(failed)).toBe(false);
  });

  it("reduces attention to its frozen reason vocabulary", () => {
    const event = freshReducer().reduce({
      kind: "attention",
      state: "raised",
      reason: "context",
      message: SENSITIVE,
    });
    expect(event).toEqual({ kind: "attention", phase: "raised", reason: "context" });
    expect(leaks(event)).toBe(false);
  });
});

describe("ObservabilityReducer content carriers", () => {
  it("reduces every content-bearing observation kind to null", () => {
    const reducer = new ObservabilityReducer(() => 0);
    const carriers: RuntimeObservation[] = [
      { kind: "delta", turnId: "t1", channel: "text", text: SENSITIVE },
      { kind: "message-settled", turnId: "t1", message: settledMessage() },
      { kind: "compaction-progress", state: "started", reason: "manual" },
      {
        kind: "interaction",
        state: "cancelled",
        interactionId: "i1",
        reason: "abandoned",
      },
    ];
    for (const observation of carriers) {
      expect(reducer.reduce(observation)).toBeNull();
    }
  });
});

describe("observability vocabulary", () => {
  it("keeps the noop sink callable and silent", () => {
    expect(NOOP_OBSERVABILITY_SINK.record({ kind: "turn", outcome: "completed" })).toBeUndefined();
  });

  it("holds unknown in the attempt stop-reason vocabulary for the adapter's fallback", () => {
    expect(ATTEMPT_STOP_REASONS).toContain("unknown");
    expect(new Set(ATTEMPT_STOP_REASONS).size).toBe(ATTEMPT_STOP_REASONS.length);
  });

  it("keeps provider failures in a closed error-class vocabulary", () => {
    expect(PROVIDER_ERROR_CLASSES).toEqual([
      "auth",
      "rate-limit",
      "overloaded",
      "timeout",
      "transport",
      "invalid-request",
      "unknown",
    ]);
  });
});

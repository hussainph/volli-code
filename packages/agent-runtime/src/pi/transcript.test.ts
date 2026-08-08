import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vite-plus/test";
import {
  attentionReasonFor,
  classifyDiagnostic,
  classifySessionEntry,
  errorText,
  recoveryRefFor,
  sanitizeDiagnostic,
} from "./transcript";

function assistant(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: "anthropic-messages",
    provider: "anthropic",
    model: "claude-haiku-4-5",
    usage: {
      input: 120,
      output: 40,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 160,
      cost: { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0, total: 0.3 },
    },
    stopReason: "stop",
    timestamp: 0,
    ...overrides,
  };
}

function messageEntry(message: AssistantMessage): SessionEntry {
  return { type: "message", id: "a1b2c3d4", parentId: null, timestamp: "t", message };
}

describe("sanitizeDiagnostic", () => {
  it("collapses whitespace", () => {
    expect(sanitizeDiagnostic("  request\n  failed  ")).toBe("request failed");
  });

  it("redacts prefixed provider keys", () => {
    expect(sanitizeDiagnostic("bad key sk-ant-abc123 rejected")).toBe(
      "bad key [redacted] rejected",
    );
  });

  it("redacts long opaque tokens", () => {
    expect(sanitizeDiagnostic(`token ${"a".repeat(40)} rejected`)).toBe(
      "token [redacted] rejected",
    );
  });

  it("bounds the length", () => {
    const long = sanitizeDiagnostic("word ".repeat(200));
    expect(long).toHaveLength(301);
    expect(long.endsWith("…")).toBe(true);
  });
});

describe("attentionReasonFor", () => {
  it("maps every failure reason", () => {
    expect(attentionReasonFor({ reason: "auth", message: "" })).toBe("auth");
    expect(attentionReasonFor({ reason: "configuration", message: "" })).toBe("configuration");
    expect(attentionReasonFor({ reason: "model", message: "" })).toBe("runtime-failure");
    expect(attentionReasonFor({ reason: "aborted", message: "" })).toBe("runtime-failure");
    expect(attentionReasonFor({ reason: "unknown", message: "" })).toBe("runtime-failure");
  });
});

describe("classifyDiagnostic", () => {
  it("recognises auth failures", () => {
    expect(classifyDiagnostic("No API key found for anthropic")).toBe("auth");
  });

  it("treats everything else as a model failure", () => {
    expect(classifyDiagnostic("upstream connect timeout")).toBe("model");
  });
});

describe("errorText", () => {
  it("reads Error messages", () => {
    expect(errorText(new Error("boom"))).toBe("boom");
  });

  it("stringifies anything else", () => {
    expect(errorText("boom")).toBe("boom");
  });
});

describe("recoveryRefFor", () => {
  it("returns a bounded reference for a persisted session", () => {
    expect(recoveryRefFor("s-1", "/sessions/s-1.jsonl")).toEqual({
      runtime: "pi",
      sessionId: "s-1",
      sessionFilePath: "/sessions/s-1.jsonl",
    });
  });

  it("returns nothing when the session is not persisted", () => {
    expect(recoveryRefFor("s-1", undefined)).toBeUndefined();
  });
});

describe("classifySessionEntry", () => {
  it("ignores entries that are not messages", () => {
    const entry: SessionEntry = {
      type: "model_change",
      id: "e1",
      parentId: null,
      timestamp: "t",
      provider: "anthropic",
      modelId: "claude-haiku-4-5",
    };
    expect(classifySessionEntry(entry)).toBeUndefined();
  });

  it("ignores messages that are not from the assistant", () => {
    const entry: SessionEntry = {
      type: "message",
      id: "e2",
      parentId: null,
      timestamp: "t",
      message: { role: "user", content: "hello", timestamp: 0 },
    };
    expect(classifySessionEntry(entry)).toBeUndefined();
  });

  it("settles text and reasoning with sanitized usage", () => {
    expect(
      classifySessionEntry(
        messageEntry(
          assistant({
            content: [
              { type: "thinking", thinking: "weighing options" },
              { type: "text", text: "Done." },
            ],
          }),
        ),
      ),
    ).toEqual({
      kind: "settled",
      message: {
        entryId: "a1b2c3d4",
        role: "assistant",
        text: "Done.",
        reasoning: "weighing options",
        model: { providerId: "anthropic", modelId: "claude-haiku-4-5" },
        usage: { inputTokens: 120, outputTokens: 40, costUsd: 0.3 },
      },
    });
  });

  it("omits reasoning when the model produced none", () => {
    const outcome = classifySessionEntry(
      messageEntry(assistant({ content: [{ type: "text", text: "Done." }] })),
    );
    expect(outcome).toMatchObject({ kind: "settled" });
    expect(outcome?.kind === "settled" && outcome.message.reasoning).toBeUndefined();
  });

  it("reports an aborted run with its own detail", () => {
    expect(
      classifySessionEntry(
        messageEntry(assistant({ stopReason: "aborted", errorMessage: "Aborted by user" })),
      ),
    ).toEqual({ kind: "failed", failure: { reason: "aborted", message: "Aborted by user" } });
  });

  it("reports an aborted run without detail", () => {
    expect(classifySessionEntry(messageEntry(assistant({ stopReason: "aborted" })))).toEqual({
      kind: "failed",
      failure: { reason: "aborted", message: "Run interrupted." },
    });
  });

  it("reports an auth failure", () => {
    expect(
      classifySessionEntry(
        messageEntry(
          assistant({ stopReason: "error", errorMessage: "No API key found for anthropic" }),
        ),
      ),
    ).toEqual({
      kind: "failed",
      failure: { reason: "auth", message: "No API key found for anthropic" },
    });
  });

  it("reports a model failure without detail", () => {
    expect(classifySessionEntry(messageEntry(assistant({ stopReason: "error" })))).toEqual({
      kind: "failed",
      failure: { reason: "model", message: "The model run failed." },
    });
  });
});

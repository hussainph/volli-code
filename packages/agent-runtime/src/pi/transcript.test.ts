import type { AssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vite-plus/test";
import {
  attentionReasonFor,
  classifyAssistantMessage,
  classifyDiagnostic,
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
    expect(attentionReasonFor({ reason: "context", message: "" })).toBe("context");
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

  it("recognises provider context-window failures", () => {
    expect(classifyDiagnostic("maximum context length exceeded")).toBe("context");
    expect(classifyDiagnostic("too many tokens for this context window")).toBe("context");
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

describe("classifyAssistantMessage", () => {
  it("settles text and reasoning with sanitized usage", () => {
    expect(
      classifyAssistantMessage(
        "a1b2c3d4",
        assistant({
          content: [
            { type: "thinking", thinking: "weighing options" },
            { type: "text", text: "Done." },
          ],
        }),
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
    const outcome = classifyAssistantMessage(
      "entry",
      assistant({ content: [{ type: "text", text: "Done." }] }),
    );
    expect(outcome).toMatchObject({ kind: "settled" });
    expect(outcome.kind === "settled" && outcome.message.reasoning).toBeUndefined();
  });

  it("does not settle a tool-call-only assistant message as an empty bubble", () => {
    expect(
      classifyAssistantMessage(
        "entry",
        assistant({
          stopReason: "toolUse",
          content: [
            {
              type: "toolCall",
              id: "tool-1",
              name: "read",
              arguments: { path: "MARKER.txt" },
            },
          ],
        }),
      ),
    ).toEqual({ kind: "ignored" });
  });

  it("reports an aborted run with and without provider detail", () => {
    expect(
      classifyAssistantMessage(
        "entry",
        assistant({ stopReason: "aborted", errorMessage: "Aborted by user" }),
      ),
    ).toEqual({ kind: "failed", failure: { reason: "aborted", message: "Aborted by user" } });
    expect(classifyAssistantMessage("entry", assistant({ stopReason: "aborted" }))).toEqual({
      kind: "failed",
      failure: { reason: "aborted", message: "Run interrupted." },
    });
  });

  it("reports auth and model failures", () => {
    expect(
      classifyAssistantMessage(
        "entry",
        assistant({ stopReason: "error", errorMessage: "No API key found for anthropic" }),
      ),
    ).toEqual({
      kind: "failed",
      failure: { reason: "auth", message: "No API key found for anthropic" },
    });
    expect(classifyAssistantMessage("entry", assistant({ stopReason: "error" }))).toEqual({
      kind: "failed",
      failure: { reason: "model", message: "The model run failed." },
    });
  });
});

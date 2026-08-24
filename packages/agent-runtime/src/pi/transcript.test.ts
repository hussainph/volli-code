import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { RuntimeFailure } from "@volli/shared";
import { describe, expect, it } from "vite-plus/test";
import {
  assistantUsage,
  attentionReasonFor,
  costBasisForApi,
  classifyAssistantMessage,
  classifyDiagnostic,
  errorText,
  isTransientTransportFailure,
  recoveryRefFor,
  sanitizeDiagnostic,
  sessionUsageFrom,
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

  it("recognises each provider family's own spent-window sentence (VC-155)", () => {
    // Overflow recovery hangs off this classification: a refusal it does not
    // recognize is a Session told it broke instead of one that compacts and
    // continues. Each case is the sentence its provider actually sends.
    expect(classifyDiagnostic("prompt is too long: 213021 tokens > 204698 maximum")).toBe(
      "context",
    );
    expect(classifyDiagnostic("Your input exceeds the context window of this model.")).toBe(
      "context",
    );
    expect(classifyDiagnostic("input is too long for requested model")).toBe("context");
    expect(
      classifyDiagnostic(
        "The input token count (1189234) exceeds the maximum number of tokens allowed (1048576).",
      ),
    ).toBe("context");
  });
});

/** Classified the way a live failure reaches it, so the reason gate is real. */
function failureFor(message: string): RuntimeFailure {
  const sanitized = sanitizeDiagnostic(message);
  return { reason: classifyDiagnostic(sanitized), message: sanitized };
}

describe("isTransientTransportFailure", () => {
  it.each([
    "WebSocket error",
    "WebSocket closed 1006",
    "WebSocket closed",
    "WebSocket connect timeout after 30000ms",
    "WebSocket stream closed before response.completed",
    "read ECONNRESET",
    "connect ETIMEDOUT 10.0.0.1:443",
    "connect ECONNREFUSED 127.0.0.1:443",
    "socket hang up",
    "fetch failed",
    "Network error while reading the response",
  ])("retries a dropped connection: %s", (message) => {
    expect(isTransientTransportFailure(failureFor(message))).toBe(true);
  });

  it.each([
    "malformed provider payload",
    "The model run failed.",
    "429 Too Many Requests",
    "You exceeded your current quota",
    "maximum context length exceeded",
    "No API key found for anthropic",
  ])("leaves a failure only the user can answer alone: %s", (message) => {
    expect(isTransientTransportFailure(failureFor(message))).toBe(false);
  });

  it("does not retry a socket the provider closed over credentials", () => {
    const failure = failureFor("WebSocket closed 4001 unauthorized");
    expect(failure.reason).toBe("auth");
    expect(isTransientTransportFailure(failure)).toBe(false);
  });

  it("does not retry a run that was asked to stop", () => {
    expect(isTransientTransportFailure({ reason: "aborted", message: "WebSocket closed" })).toBe(
      false,
    );
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
        usage: {
          inputTokens: 120,
          outputTokens: 40,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          costUsd: 0.3,
        },
      },
    });
  });

  it("drops non-finite usage numbers rather than persisting them (VC-155)", () => {
    // A model with no cost table multiplies through to NaN, and JSON persists
    // NaN as null — which the recovery marker validator refuses, poisoning the
    // sidecar. An absent field is the honest spelling of "not measured".
    const outcome = classifyAssistantMessage(
      "entry",
      assistant({
        content: [{ type: "text", text: "Done." }],
        usage: {
          input: Number.NaN,
          output: Number.POSITIVE_INFINITY,
          cacheRead: Number.NaN,
          cacheWrite: Number.NEGATIVE_INFINITY,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: Number.NaN },
        },
      }),
    );
    expect(outcome).toMatchObject({ kind: "settled" });
    expect(outcome.kind === "settled" && outcome.message.usage).toEqual({});
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

describe("assistantUsage", () => {
  it("measures a reply that only called tools — the spend a transcript never sees", () => {
    expect(
      assistantUsage(
        assistant({
          content: [{ type: "toolCall", id: "1", name: "read", arguments: {} }],
          stopReason: "toolUse",
        }),
      ),
    ).toEqual({
      cause: "assistant",
      providerId: "anthropic",
      modelId: "claude-haiku-4-5",
      inputTokens: 120,
      outputTokens: 40,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd: 0.3,
      costBasis: "catalog-estimate",
    });
  });

  it("measures a reply that failed after the provider had already billed it", () => {
    const usage = assistantUsage(
      assistant({ stopReason: "error", errorMessage: "The model run failed." }),
    );
    expect(usage?.inputTokens).toBe(120);
    expect(usage?.costUsd).toBe(0.3);
  });

  it("reports nothing for a reply the provider never metered", () => {
    expect(
      assistantUsage(
        assistant({
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
        }),
      ),
    ).toBeNull();
  });

  it("keeps an unpriceable cost absent instead of reading it back as free", () => {
    const usage = assistantUsage(
      assistant({
        usage: {
          input: 10,
          output: 2,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 12,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: Number.NaN },
        },
      }),
    );
    expect(usage?.costUsd).toBeNull();
    expect(usage?.costBasis).toBe("unavailable");
  });
});

describe("costBasisForApi", () => {
  // Every built-in adapter but one multiplies provider token counts by the
  // local model catalogue. Calling that a bill is the mislabel this map exists
  // to prevent, so each family is pinned by name rather than defaulted.
  it.each([
    "openai-completions",
    "mistral-conversations",
    "openai-responses",
    "azure-openai-responses",
    "openai-codex-responses",
    "anthropic-messages",
    "bedrock-converse-stream",
    "google-generative-ai",
    "google-vertex",
  ])("prices %s from the local catalogue", (api) => {
    expect(costBasisForApi(api)).toBe("catalog-estimate");
  });

  // pi-messages carries the backend's own accounting verbatim.
  it("trusts a backend that reported its own usage", () => {
    expect(costBasisForApi("pi-messages")).toBe("provider-reported");
  });

  it("refuses to guess for an API family it does not know", () => {
    expect(costBasisForApi("some-custom-gateway")).toBe("unavailable");
  });
});

describe("sessionUsageFrom", () => {
  const model = { provider: "anthropic", model: "claude-haiku-4-5", api: "anthropic-messages" };

  it("keeps a provider's own numbers whatever the operation was", () => {
    expect(
      sessionUsageFrom(
        {
          input: 190_000,
          output: 900,
          cacheRead: 12,
          cacheWrite: 3,
          totalTokens: 190_915,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.42 },
        },
        model,
        "compaction",
      ),
    ).toEqual({
      cause: "compaction",
      providerId: "anthropic",
      modelId: "claude-haiku-4-5",
      inputTokens: 190_000,
      outputTokens: 900,
      cacheReadTokens: 12,
      cacheWriteTokens: 3,
      costUsd: 0.42,
      costBasis: "catalog-estimate",
    });
  });

  // Every field non-finite is how a model with no price table arrives. Nothing
  // was measured, so there is nothing to record — and null here is the same
  // answer as the all-zero placeholder, arrived at from the other direction.
  it("reports nothing when every number came back unusable", () => {
    expect(
      sessionUsageFrom(
        {
          input: Number.NaN,
          output: Number.NaN,
          cacheRead: Number.NaN,
          cacheWrite: Number.NaN,
          totalTokens: 0,
          cost: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            total: Number.POSITIVE_INFINITY,
          },
        },
        model,
        "utility",
      ),
    ).toBeNull();
  });

  // Pi's compaction result declares its usage block optional. An absent block
  // and an empty one say the same thing, and both are answered here so no
  // caller has to remember to guard separately.
  it("reports nothing when the executor supplied no usage block at all", () => {
    expect(sessionUsageFrom(undefined, model, "compaction")).toBeNull();
  });

  it("keeps a priced request whose tokens were never reported", () => {
    const usage = sessionUsageFrom(
      {
        input: Number.NaN,
        output: Number.NaN,
        cacheRead: Number.NaN,
        cacheWrite: Number.NaN,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.02 },
      },
      model,
      "utility",
    );
    expect(usage).toMatchObject({ cause: "utility", inputTokens: null, costUsd: 0.02 });
  });
});

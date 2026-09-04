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

/**
 * The sentence Anthropic sends when a replayed `thinking` block is bound to a
 * prefix that has since changed, verbatim from the preserved-thinking doc,
 * with the clause it appends without the beta header and the closing one that
 * names what changed. Every property this file pins about it — that it
 * survives the sanitizer whole, that it classifies as `reasoning`, that no
 * retry predicate wants it — is read off these bytes rather than a paraphrase.
 */
const SIGNATURE_REFUSED =
  'messages.1.content.0: Invalid `signature` in `thinking` block. The block is bound to a different conversation. Remove the block, or set `thinking.block_binding.prefix_mismatch_behavior` to "drop_block". That setting requires the `thinking-binding-controls-2026-08-01` value in the `anthropic-beta` header. The `system` prompt differs from when the block was created.';

/** The same refusal as the Anthropic SDK hands it to pi-ai: status, then the JSON body. */
const SIGNATURE_REFUSED_ENVELOPE = `400 ${JSON.stringify({
  type: "error",
  error: { type: "invalid_request_error", message: SIGNATURE_REFUSED },
  request_id: "req_011CVK9vX3mF7pQwLtRs2ZbN",
})}`;

/** The older refusal every thinking model sends when a block came back altered. */
const BLOCK_MODIFIED =
  "messages.3.content.0: `thinking` or `redacted_thinking` blocks in the latest assistant message cannot be modified. These blocks must remain as they were in the original response.";

describe("sanitizeDiagnostic", () => {
  it("collapses whitespace", () => {
    expect(sanitizeDiagnostic("  request\n  failed  ")).toBe("request failed");
  });

  it("keeps the provider's own vocabulary out of the redactor (VC-242)", () => {
    // The two identifiers the preserved-thinking refusal exists to name are 24
    // and 36 characters of word characters, which is exactly the shape the
    // opaque-run rule redacts. A person reading `set [redacted] to "drop_block"`
    // has been told to fix something they cannot see.
    const sanitized = sanitizeDiagnostic(SIGNATURE_REFUSED);
    expect(sanitized).toBe(SIGNATURE_REFUSED);
    expect(sanitized).toContain("prefix_mismatch_behavior");
    expect(sanitized).toContain("thinking-binding-controls-2026-08-01");
    // And the sentence that says what changed is the last one; the bound must
    // reach it.
    expect(sanitized).toContain("The `system` prompt differs from when the block was created.");
    expect(sanitized).not.toContain("[redacted]");
  });

  it("still redacts everything that only looks like words by accident", () => {
    // What separates vocabulary from a credential, one property at a time: a
    // key is one long segment, or mixed case, or has no plain word in it.
    expect(sanitizeDiagnostic("key a3f9c2e17b4d8a6f0e5c3b2a19d7f4e6 refused")).toBe(
      "key [redacted] refused",
    );
    expect(sanitizeDiagnostic("key AIzaSyD-example_key-with_mixed-case1 refused")).toBe(
      "key [redacted] refused",
    );
    expect(sanitizeDiagnostic("id 123e4567-e89b-12d3-a456-426614174000 refused")).toBe(
      "id [redacted] refused",
    );
    expect(sanitizeDiagnostic("token eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9 refused")).toBe(
      "token [redacted] refused",
    );
  });

  it("unwraps a provider's error envelope down to its sentence", () => {
    // pi-ai hands on the Anthropic SDK's message as is: the status, then the
    // whole JSON body. The envelope is a log's business; the request id inside
    // it is redacted like any other opaque run and the sentence is what is
    // kept. The status stays in front because the auth classifier reads it.
    expect(sanitizeDiagnostic(SIGNATURE_REFUSED_ENVELOPE)).toBe(`400 ${SIGNATURE_REFUSED}`);
    expect(
      sanitizeDiagnostic(
        '401 {"error":{"message":"Incorrect API key provided.","type":"invalid_request_error"}}',
      ),
    ).toBe("401 Incorrect API key provided.");
    expect(sanitizeDiagnostic('{"message":"upstream timeout"}')).toBe("upstream timeout");
  });

  it("leaves text that is not an envelope alone, braces and all", () => {
    expect(sanitizeDiagnostic("expected { but found }")).toBe("expected { but found }");
    expect(sanitizeDiagnostic('{"code":400}')).toBe('{"code":400}');
    expect(sanitizeDiagnostic("not json {")).toBe("not json {");
    // An `error` that is not an object, or one with nothing to say, yields to
    // the top-level sentence; an envelope with neither is not an envelope.
    expect(sanitizeDiagnostic('{"error":null,"message":"top-level sentence"}')).toBe(
      "top-level sentence",
    );
    expect(sanitizeDiagnostic('{"error":{"message":""},"message":"the other one"}')).toBe(
      "the other one",
    );
    expect(sanitizeDiagnostic('{"error":{"message":""},"message":""}')).toBe(
      '{"error":{"message":""},"message":""}',
    );
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
    expect(long).toHaveLength(401);
    expect(long.endsWith("…")).toBe(true);
  });
});

describe("attentionReasonFor", () => {
  it("maps every failure reason", () => {
    expect(attentionReasonFor({ reason: "auth", message: "" })).toBe("auth");
    expect(attentionReasonFor({ reason: "configuration", message: "" })).toBe("configuration");
    expect(attentionReasonFor({ reason: "context", message: "" })).toBe("context");
    // The generic dead end with a Retry, and deliberately nothing more specific:
    // by the time this reaches a person the runtime has already dropped the
    // reasoning and been refused again, so the one repair the doc names is
    // spent and what is left is a run to try again.
    expect(attentionReasonFor({ reason: "reasoning", message: "" })).toBe("runtime-failure");
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

  it("recognises a refused reasoning block by either of its sentences (VC-242)", () => {
    // The preserved-thinking refusal, and the older one every thinking model
    // sends for a block that came back altered. Both are answered the same way
    // — drop the reasoning, send the turn again — and neither is a `model`
    // failure, which is the arm that would have handed them a Retry that
    // re-sends the identical array forever.
    expect(classifyDiagnostic(sanitizeDiagnostic(SIGNATURE_REFUSED))).toBe("reasoning");
    expect(classifyDiagnostic(sanitizeDiagnostic(SIGNATURE_REFUSED_ENVELOPE))).toBe("reasoning");
    expect(classifyDiagnostic(sanitizeDiagnostic(BLOCK_MODIFIED))).toBe("reasoning");
    // Ahead of the broader signals: the sentence names a header and a setting,
    // and neither the auth nor the context pattern may claim it.
    expect(classifyDiagnostic("Invalid `signature` in `thinking` block; check your api key")).toBe(
      "reasoning",
    );
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
    // Re-sending the identical array can never clear it; the doc says so.
    SIGNATURE_REFUSED,
    BLOCK_MODIFIED,
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

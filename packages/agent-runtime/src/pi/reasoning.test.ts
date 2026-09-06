import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vite-plus/test";
import { providerReasoningDropped, withoutReasoning } from "./reasoning";

function assistant(content: AssistantMessage["content"]): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: "anthropic-messages",
    provider: "anthropic",
    model: "claude-fable-5-1",
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: 0,
  };
}

describe("withoutReasoning", () => {
  it("drops every reasoning block and keeps the text and tool calls in order", () => {
    // Signed, unsigned and redacted are the three shapes pi-ai serializes to
    // `thinking`, plain text and `redacted_thinking`; the doc's repair names
    // all three. What survives is exactly what the doc says to keep.
    const message = assistant([
      { type: "thinking", thinking: "", thinkingSignature: "EqQBCkYIBxgC" },
      { type: "text", text: "Reading the test." },
      { type: "thinking", thinking: "unsigned, mid-stream" },
      { type: "toolCall", id: "tc-1", name: "read", arguments: { path: "a.ts" } },
      {
        type: "thinking",
        thinking: "[Reasoning redacted]",
        thinkingSignature: "opaque",
        redacted: true,
      },
      { type: "text", text: "Done." },
    ]);

    const stripped = withoutReasoning(message) as AssistantMessage;

    expect(stripped.content).toEqual([
      { type: "text", text: "Reading the test." },
      { type: "toolCall", id: "tc-1", name: "read", arguments: { path: "a.ts" } },
      { type: "text", text: "Done." },
    ]);
    // Everything that is not content — the model, the usage, the stop reason —
    // is the same turn's; only its reasoning went.
    expect(stripped).toEqual({ ...message, content: stripped.content });
    expect(message.content).toHaveLength(6);
  });

  it("returns the very same message when there is nothing to drop", () => {
    // Identity is the contract, not equality: a context with no reasoning is
    // left untouched rather than copied, and a caller can tell the two apart.
    const plain = assistant([{ type: "text", text: "no thinking here" }]);
    const user: AgentMessage = { role: "user", content: "hello", timestamp: 0 };
    const toolResult: AgentMessage = {
      role: "toolResult",
      toolCallId: "tc-1",
      toolName: "read",
      content: [{ type: "text", text: "ok" }],
      isError: false,
      timestamp: 0,
    };

    expect(withoutReasoning(plain)).toBe(plain);
    expect(withoutReasoning(user)).toBe(user);
    expect(withoutReasoning(toolResult)).toBe(toolResult);
  });
});

/**
 * The diagnostic pi-ai appends when Anthropic drops blocks from a request,
 * in the exact shape `anthropic-messages.js` builds it (~606): the type, the
 * structural path and the reason it reports, under `details.transformations`.
 */
function droppedDiagnostic(
  transformations: { type?: string; path?: string; reason?: string }[],
): AssistantMessage["diagnostics"] {
  return [
    {
      type: "anthropic_input_transformations",
      timestamp: 1,
      details: { transformations },
    },
  ];
}

describe("providerReasoningDropped", () => {
  it("says nothing about a turn the provider left alone", () => {
    // The overwhelmingly common case, and the one that must stay silent: every
    // turn on every model without the flag, and every clean turn on the models
    // with it. A notice that fired on a turn that lost nothing would teach a
    // person to ignore the one that matters.
    expect(
      providerReasoningDropped(assistant([{ type: "text", text: "hello" }]), "turn-1"),
    ).toBeUndefined();
    const empty = assistant([{ type: "text", text: "hello" }]);
    empty.diagnostics = droppedDiagnostic([]);
    expect(providerReasoningDropped(empty, "turn-1")).toBeUndefined();
  });

  it("ignores a diagnostic that is not about dropped input", () => {
    // `diagnostics` is a general channel — pi-ai puts recoveries and provider
    // faults on it too. Only the one type is this function's business.
    const message = assistant([{ type: "text", text: "hello" }]);
    message.diagnostics = [{ type: "anthropic_stream_recovery", timestamp: 1, details: {} }];
    expect(providerReasoningDropped(message, "turn-1")).toBeUndefined();
  });

  it("reports what was dropped, in Volli's vocabulary, once for the turn", () => {
    // The shape the preserved-thinking doc prints: a prefix mismatch names the
    // block whose binding broke. `prefix_binding_mismatch` is the provider's
    // word; `prefix-mismatch` is ours, and the path is kept verbatim because
    // it is what makes a report actionable when someone diffs two bodies.
    const message = assistant([{ type: "text", text: "answered anyway" }]);
    message.diagnostics = droppedDiagnostic([
      {
        type: "prefix_binding_mismatch",
        path: "messages.1.content.0",
        reason: "The `system` prompt differs from when the block was created.",
      },
      { type: "prefix_binding_mismatch", path: "messages.3.content.0" },
    ]);

    expect(providerReasoningDropped(message, "turn-7")).toEqual({
      kind: "provider-reasoning-dropped",
      turnId: "turn-7",
      count: 2,
      causes: ["prefix-mismatch"],
      paths: ["messages.1.content.0", "messages.3.content.0"],
    });
  });

  it("tells a server-side model fallback apart from an edit of ours", () => {
    // The distinction the whole vocabulary exists for. A prefix mismatch means
    // Volli changed something before a signed block; a model mismatch means
    // Anthropic answered on a model that cannot read the block, which happens
    // with nobody touching the picker and is not a bug in this integration.
    const message = assistant([{ type: "text", text: "answered anyway" }]);
    message.diagnostics = droppedDiagnostic([
      { type: "model_binding_mismatch", path: "messages.1.content.0" },
    ]);

    expect(providerReasoningDropped(message, "turn-1")).toMatchObject({
      count: 1,
      causes: ["model-mismatch"],
    });
  });

  it("keeps a transformation type it has never seen out of the vocabulary", () => {
    // Substring similarity is not evidence: a future provider word containing
    // "prefix" must still be unknown until Volli gives it an explicit meaning.
    const message = assistant([{ type: "text", text: "answered anyway" }]);
    message.diagnostics = droppedDiagnostic([
      { type: "future_prefix_rewrite", path: "messages.1.content.0" },
      { path: "messages.2.content.0" },
    ]);

    expect(providerReasoningDropped(message, "turn-1")).toMatchObject({
      count: 2,
      causes: ["unknown"],
    });
  });

  it("ignores a malformed transformations payload instead of failing the Turn", () => {
    const message = assistant([{ type: "text", text: "answered anyway" }]);
    message.diagnostics = [
      {
        type: "anthropic_input_transformations",
        timestamp: 1,
        details: { transformations: { type: "prefix_binding_mismatch" } },
      },
    ];

    expect(providerReasoningDropped(message, "turn-1")).toBeUndefined();
  });

  it("ignores malformed entries without miscounting the valid transformations", () => {
    const message = assistant([{ type: "text", text: "answered anyway" }]);
    message.diagnostics = [
      {
        type: "anthropic_input_transformations",
        timestamp: 1,
        details: {
          transformations: [
            "prefix_binding_mismatch",
            null,
            { type: "prefix_binding_mismatch", path: "messages.1.content.0" },
          ],
        },
      },
    ];

    expect(providerReasoningDropped(message, "turn-1")).toMatchObject({
      count: 1,
      causes: ["prefix-mismatch"],
    });
  });

  it("reports every distinct cause in one observation", () => {
    const message = assistant([{ type: "text", text: "answered anyway" }]);
    message.diagnostics = droppedDiagnostic([
      { type: "prefix_binding_mismatch", path: "messages.1.content.0" },
      { type: "model_binding_mismatch", path: "messages.2.content.0" },
      { type: "prefix_binding_mismatch", path: "messages.3.content.0" },
    ]);

    expect(providerReasoningDropped(message, "turn-1")).toMatchObject({
      count: 3,
      causes: ["prefix-mismatch", "model-mismatch"],
    });
  });
});

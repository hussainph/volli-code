import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vite-plus/test";
import { withoutReasoning } from "./reasoning";

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

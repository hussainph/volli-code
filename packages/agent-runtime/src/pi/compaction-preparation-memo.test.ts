/**
 * Compaction counts each settled message once per tokenizer family (VC-1083),
 * even though stripping reasoning hands the estimator a fresh copy each time.
 */
import { type AgentMessage } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vite-plus/test";
import { type Entry } from "./harness-session";
import { prepareModelCompaction } from "./compaction-preparation";
import { withoutReasoning } from "./reasoning";
import { estimateMessageTokens } from "./token-counting";

const counted = vi.hoisted(() => ({ messages: [] as unknown[] }));

vi.mock("./token-counting", async (importOriginal) => {
  const original = await importOriginal<typeof import("./token-counting")>();
  return {
    ...original,
    estimateMessageTokens: (message: AgentMessage, target: Model<Api>) => {
      counted.messages.push(message);
      return original.estimateMessageTokens(message, target);
    },
  };
});

function model(id: string, api = "openai-responses"): Model<Api> {
  return {
    id,
    name: id,
    api,
    provider: "test",
    baseUrl: "https://example.test/v1",
    reasoning: true,
    input: ["text"],
    cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0 },
    contextWindow: 100_000,
    maxTokens: 8_000,
  } as Model<Api>;
}

function reasoned(text: string): AgentMessage {
  return {
    role: "assistant",
    content: [
      { type: "thinking", thinking: "private reasoning ".repeat(20), thinkingSignature: "sig" },
      { type: "text", text },
    ],
    api: "openai-responses",
    provider: "test",
    model: "gpt-5",
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
  } as AgentMessage;
}

function path(): Entry[] {
  const messages: AgentMessage[] = [];
  for (let i = 0; i < 6; i += 1) {
    messages.push({ role: "user", content: `question ${i} `.repeat(40), timestamp: 0 });
    messages.push(reasoned(`answer ${i} `.repeat(40)));
  }
  return messages.map((message, index) => ({
    type: "message",
    id: `entry-${index}`,
    seq: index + 1,
    parentId: null,
    timestamp: index,
    message,
  }));
}

const SETTINGS = { enabled: true, reserveTokens: 16_384, keepRecentTokens: 300 };

describe("compaction token estimates", () => {
  it("counts each settled message once across repeated preparations", () => {
    const entries = path();
    counted.messages.length = 0;
    const first = prepareModelCompaction(entries, SETTINGS, model("gpt-5"));
    const second = prepareModelCompaction(entries, SETTINGS, model("gpt-5.1"));
    expect(second).toEqual(first);
    expect(counted.messages).toHaveLength(entries.length);
    // Still the stripped estimate: reasoning spends no keep-recent budget.
    const reply = entries[1]!.type === "message" ? entries[1]!.message : null;
    expect(counted.messages).not.toContain(reply);
    expect(first!.tokensBefore).toBe(
      entries.reduce(
        (total, entry) =>
          total +
          (entry.type === "message"
            ? estimateMessageTokens(withoutReasoning(entry.message), model("gpt-5"))
            : 0),
        0,
      ),
    );
  });

  it("keeps one estimate per tokenizer family", () => {
    const entries = path();
    counted.messages.length = 0;
    prepareModelCompaction(entries, SETTINGS, model("gpt-5"));
    prepareModelCompaction(entries, SETTINGS, model("claude", "anthropic-messages"));
    expect(counted.messages).toHaveLength(entries.length * 2);
  });
});

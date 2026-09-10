import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, Model, Tool, Usage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vite-plus/test";
import {
  estimateContextTokens,
  estimateMessageTokens,
  projectedContextTokens,
} from "./token-counting";

function model(overrides: Partial<Model<"anthropic-messages" | "openai-completions">> = {}) {
  return {
    id: "claude-fable-5-1",
    name: "Claude Fable 5.1",
    api: "anthropic-messages",
    provider: "anthropic",
    baseUrl: "https://api.anthropic.com",
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200000,
    maxTokens: 64000,
    ...overrides,
  } as Model<"anthropic-messages" | "openai-completions">;
}

function usage(overrides: Partial<Usage> = {}): Usage {
  return {
    input: 100,
    output: 20,
    cacheRead: 50,
    cacheWrite: 10,
    totalTokens: 180,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    ...overrides,
  };
}

function assistant(
  content: AssistantMessage["content"],
  overrides: Partial<AssistantMessage> = {},
): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: "anthropic-messages",
    provider: "anthropic",
    model: "claude-fable-5-1",
    usage: usage(),
    stopReason: "stop",
    timestamp: 0,
    ...overrides,
  };
}

function user(text: string): AgentMessage {
  return { role: "user", content: text, timestamp: 0 };
}

const tool: Tool = {
  name: "read_file",
  description: "Read a file from disk.",
  parameters: { type: "object", properties: { path: { type: "string" } } } as Tool["parameters"],
};

describe("estimateMessageTokens", () => {
  it("counts known OpenAI BPE text and treats special-token spellings as literal text", () => {
    const openai = model({ id: "gpt-4o", api: "openai-completions", provider: "openai" });
    expect(estimateMessageTokens(user("hello world"), openai)).toBe(10);
    expect(estimateMessageTokens(user("<|endoftext|>"), openai)).toBeGreaterThan(9);
  });

  it("does not divide CJK, emoji or dense Unicode by four in the fallback", () => {
    for (const text of ["追加情報".repeat(100), "👩🏽‍💻".repeat(100)]) {
      expect(estimateMessageTokens(user(text), model())).toBeGreaterThan(text.length);
    }
  });
  it("is monotone in text length for a real-tokenizer (OpenAI o200k) model", () => {
    const openai = model({
      id: "gpt-4o",
      api: "openai-completions",
      provider: "openai",
    });
    const short = estimateMessageTokens(user("hi"), openai);
    const long = estimateMessageTokens(user("hi ".repeat(500)), openai);
    expect(long).toBeGreaterThan(short);
    expect(short).toBeGreaterThan(0);
  });

  it("uses a conservative estimator for Anthropic: never below chars/4", () => {
    const anthropic = model();
    const prose = "The quiet harbor holds its breath. ".repeat(80);
    const code = "function f() { return { a: 1, b: 2 }; } ".repeat(50);
    for (const text of [prose, code]) {
      const tokens = estimateMessageTokens(user(text), anthropic);
      // `chars/4` is the heuristic this module exists to replace; the
      // conservative estimator must never dip under it.
      expect(tokens).toBeGreaterThanOrEqual(Math.ceil(text.length / 4));
    }
  });

  it("routes OpenAI ids to their published tokenizer, distinct from the fallback", () => {
    const openai = model({ id: "gpt-4o", api: "openai-completions", provider: "openai" });
    const older = model({ id: "gpt-4-turbo", api: "openai-completions", provider: "openai" });
    const text = "The quiet harbor holds its breath. ".repeat(80);
    const o200k = estimateMessageTokens(user(text), openai);
    const cl100k = estimateMessageTokens(user(text), older);
    const fallback = estimateMessageTokens(user(text), model());
    // Both exact counts track their vocabulary; the conservative fallback is
    // visibly the highest of the three.
    expect(o200k).toBeGreaterThan(0);
    expect(cl100k).toBeGreaterThan(0);
    expect(fallback).toBeGreaterThan(o200k);
    expect(fallback).toBeGreaterThan(cl100k);
  });

  it("charges images a flat conservative figure, never chars/4 of the base64 blob", () => {
    const image = { type: "image" as const, data: "A".repeat(100000), mimeType: "image/png" };
    const tokens = estimateMessageTokens(
      { role: "user", content: [{ type: "text", text: "look" }, image], timestamp: 0 },
      model(),
    );
    expect(tokens).toBeGreaterThan(1000);
    expect(tokens).toBeLessThan(5000);
  });

  it("counts tool-call arguments as JSON, not dropped", () => {
    const tokens = estimateMessageTokens(
      assistant([
        {
          type: "toolCall",
          id: "call_1",
          name: "edit_file",
          arguments: { path: "src/x.ts", content: "const x = 1;\n".repeat(200) },
        },
      ]),
      model(),
    );
    expect(tokens).toBeGreaterThan(300);
  });

  it("counts thinking blocks, which replayed context still carries", () => {
    const withThinking = assistant([
      { type: "thinking", thinking: "step one, then two. ".repeat(100) },
      { type: "text", text: "done" },
    ]);
    const withoutThinking = assistant([{ type: "text", text: "done" }]);
    expect(estimateMessageTokens(withThinking, model())).toBeGreaterThan(
      estimateMessageTokens(withoutThinking, model()),
    );
  });

  it("prices a compaction summary as the wrapper Pi sends, not the bare summary", () => {
    const summary: AgentMessage = {
      role: "compactionSummary",
      summary: "The user built a token counter. ".repeat(100),
      tokensBefore: 90000,
      timestamp: 0,
    };
    const tokens = estimateMessageTokens(summary, model());
    expect(tokens).toBeGreaterThan(200);
  });

  it("prices a context-excluded bash execution at zero", () => {
    const excluded: AgentMessage = {
      role: "bashExecution",
      command: "make build",
      output: "lots of output ".repeat(500),
      exitCode: 0,
      cancelled: false,
      truncated: false,
      timestamp: 0,
      excludeFromContext: true,
    };
    expect(estimateMessageTokens(excluded, model())).toBe(0);
  });

  it("estimates an unrecognized custom role at zero rather than guessing", () => {
    expect(estimateMessageTokens({ role: "mystery" } as unknown as AgentMessage, model())).toBe(0);
  });
});

describe("estimateContextTokens", () => {
  it("includes the system prompt and tool definitions", () => {
    const base = estimateContextTokens([user("hello")], model());
    const withSystem = estimateContextTokens(
      [user("hello")],
      model(),
      "You are terse. ".repeat(50),
    );
    const withTools = estimateContextTokens([user("hello")], model(), undefined, [tool]);
    expect(withSystem).toBeGreaterThan(base);
    expect(withTools).toBeGreaterThan(base);
  });

  it("scales with message count", () => {
    const messages = Array.from({ length: 20 }, (_, i) => user(`message number ${i} `.repeat(20)));
    const one = estimateContextTokens(messages.slice(0, 10), model());
    const all = estimateContextTokens(messages, model());
    expect(all).toBeGreaterThan(one * 1.8);
  });
});

describe("projectedContextTokens", () => {
  it("combines the measured half with an estimate of the suffix", () => {
    const messages: AgentMessage[] = [
      user("earlier context ".repeat(200)),
      assistant([{ type: "text", text: "reply" }]),
      user("brand new tail that the measurement cannot have seen ".repeat(50)),
    ];
    const projected = projectedContextTokens(messages, model());
    // Measured half alone is 180; the tail must be added on top of it.
    expect(projected).toBeGreaterThan(180);
    // But far below a from-scratch estimate of the whole array (measured half
    // is not double-counted as text).
    expect(projected).toBeLessThan(180 + 5000);
  });

  it("never reuses usage retained behind a compaction summary", () => {
    const summary: AgentMessage = {
      role: "compactionSummary",
      summary: "summary of everything compacted",
      tokensBefore: 180000,
      timestamp: 0,
    };
    const tail = [user("fresh tail after compaction ".repeat(100))];
    const projected = projectedContextTokens([summary, ...tail], model());
    const estimated = estimateContextTokens([summary, ...tail], model());
    // The stale 180k measurement is not in the number: it is the pure estimate.
    expect(projected).toBe(estimated);
    expect(projected).toBeLessThan(10000);
  });

  it("skips usage from another model instead of projecting with it", () => {
    const other = assistant([{ type: "text", text: "reply" }], { model: "gpt-4o" });
    const messages: AgentMessage[] = [user("hello ".repeat(300)), other, user("tail")];
    expect(projectedContextTokens(messages, model())).toBe(
      estimateContextTokens(messages, model()),
    );
  });

  it("falls back to the pure estimate when no usage is valid", () => {
    const messages: AgentMessage[] = [
      user("hello"),
      assistant([{ type: "text", text: "reply" }], {
        usage: usage({ input: Number.NaN }),
      }),
      user("tail"),
    ];
    expect(projectedContextTokens(messages, model())).toBe(
      estimateContextTokens(messages, model()),
    );
  });

  it("rejects invalid totals, deferred replies and another provider's measurement", () => {
    for (const overrides of [
      { usage: usage({ totalTokens: Number.NaN }) },
      { usage: usage({ totalTokens: -1 }) },
      { usage: usage({ input: -1 }) },
      { provider: "gateway" },
      { api: "openai-completions" },
      { stopReason: "deferred" as const },
    ]) {
      const messages = [assistant([{ type: "text", text: "reply" }], overrides)];
      expect(projectedContextTokens(messages, model())).toBe(
        estimateContextTokens(messages, model()),
      );
    }
  });

  it("falls back when the newest measurement is zero", () => {
    const messages: AgentMessage[] = [
      user("hello"),
      assistant([{ type: "text", text: "reply" }], {
        usage: usage({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 }),
      }),
      user("tail"),
    ];
    expect(projectedContextTokens(messages, model())).toBe(
      estimateContextTokens(messages, model()),
    );
  });

  it("accepts an all-cache-served turn: cache read and write count as occupancy", () => {
    const messages: AgentMessage[] = [
      user("hello"),
      assistant([{ type: "text", text: "reply" }], {
        usage: usage({ input: 0, output: 10, cacheRead: 5000, cacheWrite: 0, totalTokens: 5010 }),
      }),
    ];
    expect(projectedContextTokens(messages, model())).toBeGreaterThanOrEqual(5010);
  });
});

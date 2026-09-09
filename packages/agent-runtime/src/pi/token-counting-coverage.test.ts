/**
 * Branch-coverage companions for token-counting.test.ts: exercises the
 * tokenizer-selection, safeJson, per-role and usage-validation paths the
 * primary suite leaves uncovered. Same helpers, kept local so this file can
 * evolve independently.
 */
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Api, AssistantMessage, Model, Tool, Usage } from "@earendil-works/pi-ai";
import { countTokens as countO200kRaw } from "gpt-tokenizer/encoding/o200k_base";
import { countTokens as countCl100kRaw } from "gpt-tokenizer/encoding/cl100k_base";
import { describe, expect, it } from "vite-plus/test";
import {
  estimateContextTokens,
  estimateMessageTokens,
  projectedContextTokens,
} from "./token-counting";

/** The module's own framing constant, restated so counts here are exact. */
const PER_MESSAGE_FRAMING = 8;
const LITERAL = { disallowedSpecial: new Set<string>() };
const countO200k = (text: string) => countO200kRaw(text, LITERAL);
const countCl100k = (text: string) => countCl100kRaw(text, LITERAL);

function model(overrides: Partial<Model<Api>> = {}): Model<Api> {
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
  } as Model<Api>;
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

const TEXT = "The quiet harbor holds its breath. ";

describe("tokenizer selection", () => {
  it("uses o200k for an Azure OpenAI Responses deployment of a GPT-4o model", () => {
    const azure = model({
      id: "gpt-4o-2024-08-13",
      api: "azure-openai-responses",
      provider: "azure",
    });
    const fallback = estimateMessageTokens(user(TEXT.repeat(80)), model());
    expect(estimateMessageTokens(user(TEXT.repeat(80)), azure)).toBeGreaterThan(0);
    expect(estimateMessageTokens(user(TEXT.repeat(80)), azure)).toBeLessThan(fallback);
  });

  it("uses cl100k for an Azure GPT-4 deployment and treats specials as literal text", () => {
    const azureLegacy = model({ id: "GPT-4", api: "azure-openai-responses", provider: "azure" });
    expect(estimateMessageTokens(user(TEXT.repeat(80)), azureLegacy)).toBeGreaterThan(0);
    expect(estimateMessageTokens(user("<|im_end|>"), azureLegacy)).toBeGreaterThan(9);
  });

  it("routes gpt-3.5 ids to cl100k and o-series ids to o200k, and the two disagree", () => {
    const legacy = model({ id: "gpt-3.5-turbo", api: "openai-completions", provider: "openai" });
    const reasoning = model({ id: "o4-mini", api: "openai-completions", provider: "openai" });
    // A text the two published vocabularies genuinely tokenize differently:
    // o200k merges longer byte runs, so it produces strictly fewer tokens. A
    // `> 0` assertion here would pass with both routes wired to the same
    // counter, which is the mistake this pins.
    const dense = 'トークン化のテスト🧪{"key":"value","n":12345}'.repeat(40);
    const legacyTokens = estimateMessageTokens(user(dense), legacy);
    const reasoningTokens = estimateMessageTokens(user(dense), reasoning);
    expect(legacyTokens).toBe(PER_MESSAGE_FRAMING + countCl100k(dense));
    expect(reasoningTokens).toBe(PER_MESSAGE_FRAMING + countO200k(dense));
    expect(reasoningTokens).toBeLessThan(legacyTokens);
    // Both are real tokenizers, so both sit well under the conservative
    // fallback the same text would otherwise be charged.
    expect(legacyTokens).toBeLessThan(estimateMessageTokens(user(dense), model()));
  });

  it("falls back to the conservative estimator for an OpenAI-API id with no published vocabulary", () => {
    const unknown = model({ id: "gpt-9-fable", api: "openai-completions", provider: "openai" });
    const fallback = estimateMessageTokens(user(TEXT.repeat(80)), model());
    // Same text, same route: an unmatched OpenAI id uses the UTF-8 fallback.
    expect(estimateMessageTokens(user(TEXT.repeat(80)), unknown)).toBe(fallback);
  });
});

describe("conservative fallback", () => {
  it("mixes ASCII density with UTF-8 bytes for non-ASCII text", () => {
    // 21 ASCII chars -> ceil(21/3)=7 tokens; 6 two-byte chars contribute
    // their 12 UTF-8 bytes. 19 is exactly what the hybrid formula produces.
    const mixed = "abcdefghijklmnopqrst åäöåäö";
    const count = estimateMessageTokens(user(mixed), model());
    expect(count).toBe(8 + 7 + 12);
    const ascii = estimateMessageTokens(user("abcdefghijklmnopqrst "), model());
    expect(count).toBeGreaterThan(ascii);
  });
});

describe("tool-call argument JSON", () => {
  it("prices an unserializable (cyclic) argument payload at its framing, not a crash", () => {
    const cyclic: Record<string, unknown> = { path: "src/x.ts" };
    cyclic.self = cyclic;
    const tokens = estimateMessageTokens(
      assistant([{ type: "toolCall", id: "call_1", name: "edit_file", arguments: cyclic }]),
      model(),
    );
    // The "{}" replacement plus the tool name: tiny but non-zero.
    expect(tokens).toBeGreaterThan(8);
    expect(tokens).toBeLessThan(60);
  });

  it('serializes nullish arguments as the string "null"', () => {
    const tokens = estimateMessageTokens(
      assistant([
        {
          type: "toolCall",
          id: "call_1",
          name: "noop",
          arguments: undefined as unknown as Record<string, never>,
        },
      ]),
      model(),
    );
    expect(tokens).toBeGreaterThan(8);
    const alsoNull = estimateMessageTokens(
      assistant([
        {
          type: "toolCall",
          id: "call_2",
          name: "noop",
          arguments: null as unknown as Record<string, never>,
        },
      ]),
      model(),
    );
    expect(alsoNull).toBe(tokens);
  });

  it('falls back to "null" when JSON.stringify yields nothing usable', () => {
    // A function argument is non-nullish (so `?? null` keeps it) but
    // stringify renders it as undefined, exercising the `?? "null"` fallback.
    const tokens = estimateMessageTokens(
      assistant([
        {
          type: "toolCall",
          id: "call_3",
          name: "noop",
          arguments: (() => "x") as unknown as Record<string, never>,
        },
      ]),
      model(),
    );
    expect(tokens).toBeGreaterThan(8);
  });

  it("ignores unrecognized content blocks in user and assistant content", () => {
    const before = estimateMessageTokens(user("hello"), model());
    const withUnknown = estimateMessageTokens(
      {
        role: "user",
        content: [
          { type: "text", text: "hello" },
          { type: "future-block" } as unknown as { type: "text"; text: string },
        ],
        timestamp: 0,
      },
      model(),
    );
    expect(withUnknown).toBe(before);
    const plain = assistant([{ type: "text", text: "reply" }]);
    const assistantWithUnknown = estimateMessageTokens(
      assistant([
        { type: "text", text: "reply" },
        { type: "future-block" } as unknown as { type: "text"; text: string },
      ]),
      model(),
    );
    expect(assistantWithUnknown).toBe(estimateMessageTokens(plain, model()));
  });
});

describe("per-role coverage", () => {
  it("counts a tool result: framing, tool name, text and image content", () => {
    const result: AgentMessage = {
      role: "toolResult",
      toolCallId: "call_1",
      toolName: "read_file",
      content: [
        { type: "text", text: "file contents here ".repeat(20) },
        { type: "image", data: "A".repeat(5000), mimeType: "image/png" },
      ],
      isError: false,
      timestamp: 0,
    };
    const textOnly: AgentMessage = {
      role: "toolResult",
      toolCallId: "call_1",
      toolName: "read_file",
      content: [{ type: "text", text: "file contents here ".repeat(20) }],
      isError: false,
      timestamp: 0,
    };
    const withImage = estimateMessageTokens(result, model());
    expect(withImage).toBeGreaterThan(estimateMessageTokens(textOnly, model()));
    expect(withImage).toBeGreaterThan(4000);
  });

  it("counts a custom message with string content", () => {
    const custom: AgentMessage = {
      role: "custom",
      customType: "note",
      content: "a custom note ".repeat(50),
      display: true,
      timestamp: 0,
    };
    expect(estimateMessageTokens(custom, model())).toBeGreaterThan(150);
  });

  it("counts an in-context bash execution as the rendered command plus output", () => {
    const included: AgentMessage = {
      role: "bashExecution",
      command: "make build",
      output: "lots of output ".repeat(500),
      exitCode: 0,
      cancelled: false,
      truncated: false,
      timestamp: 0,
    };
    const tokens = estimateMessageTokens(included, model());
    // Same shape as the excluded twin at zero: included must carry the output,
    // rendered with the command prefixed exactly as convertToLlm renders it.
    expect(tokens).toBeGreaterThan(2500);
    const rendered = user("Ran `make build`\n" + "lots of output ".repeat(500));
    expect(tokens).toBe(estimateMessageTokens(rendered, model()));
  });

  it("prices a branch summary as its own wrapper, not the compaction wrapper", () => {
    const branch: AgentMessage = {
      role: "branchSummary",
      summary: "The user built a token counter. ".repeat(100),
      fromId: "msg_1",
      timestamp: 0,
    };
    const tokens = estimateMessageTokens(branch, model());
    expect(tokens).toBeGreaterThan(200);
    // Distinguishable from the compaction wrapper by the different framing text.
    const compaction: AgentMessage = {
      role: "compactionSummary",
      summary: "The user built a token counter. ".repeat(100),
      tokensBefore: 90000,
      timestamp: 0,
    };
    expect(tokens).not.toBe(estimateMessageTokens(compaction, model()));
  });
});

describe("usage validation", () => {
  it("rejects a null usage object and non-finite or non-numeric fields", () => {
    const reply = [{ type: "text" as const, text: "reply" }];
    const cases: Partial<AssistantMessage>[] = [
      { usage: null as unknown as Usage },
      { usage: usage({ input: Number.POSITIVE_INFINITY }) },
      { usage: usage({ output: Number.NaN }) },
      { usage: usage({ cacheRead: -5 }) },
      { usage: usage({ cacheWrite: "many" as unknown as number }) },
      { usage: usage({ totalTokens: Number.POSITIVE_INFINITY }) },
    ];
    for (const overrides of cases) {
      const messages: AgentMessage[] = [assistant(reply, overrides)];
      expect(projectedContextTokens(messages, model())).toBe(
        estimateContextTokens(messages, model()),
      );
    }
  });

  it("searches past an invalid newest reply and projects from the older measurement", () => {
    const older = assistant([{ type: "text", text: "reply" }], {
      usage: usage({ totalTokens: 200 }),
    });
    const broken = assistant([{ type: "text", text: "reply" }], {
      usage: usage({ totalTokens: Number.NaN }),
    });
    const tail = user("fresh tail ".repeat(100));
    const projected = projectedContextTokens([older, broken, tail], model());
    // The 200-token measurement of the older reply, plus the estimated suffix
    // (the invalid reply itself and the tail) — not a re-estimate of `older`.
    expect(projected).toBe(
      projectedContextTokens([older], model()) +
        estimateMessageTokens(broken, model()) +
        estimateMessageTokens(tail, model()),
    );
  });

  it("adds nothing when the measured reply is the last message (suffix boundary)", () => {
    const measured = assistant([{ type: "text", text: "reply" }]);
    // With no messages after the measurement, the projection is the
    // measurement alone — identical whether or not older context precedes it.
    expect(projectedContextTokens([user("hello"), measured], model())).toBe(
      projectedContextTokens([measured], model()),
    );
  });

  it("ignores an error-stop reply that still carries usage", () => {
    const errored = assistant([{ type: "text", text: "reply" }], { stopReason: "error" });
    const messages: AgentMessage[] = [user("hello ".repeat(200)), errored];
    expect(projectedContextTokens(messages, model())).toBe(
      estimateContextTokens(messages, model()),
    );
  });
});

describe("estimateContextTokens edges", () => {
  it("adds nothing for an empty or missing tool list", () => {
    const messages = [user("hello")];
    const bare = estimateContextTokens(messages, model());
    expect(estimateContextTokens(messages, model(), undefined, [])).toBe(bare);
    const tools: Tool[] = [
      {
        name: "read_file",
        description: "Read a file from disk.",
        parameters: {
          type: "object",
          properties: { path: { type: "string" } },
        } as Tool["parameters"],
      },
    ];
    expect(estimateContextTokens(messages, model(), undefined, tools)).toBeGreaterThan(bare);
  });

  it("adds no system-prompt framing when there is no system prompt", () => {
    const messages = [user("hello")];
    // Exactly the per-message estimate, nothing on top.
    expect(estimateContextTokens(messages, model())).toBe(
      estimateMessageTokens(messages[0]!, model()),
    );
  });
});

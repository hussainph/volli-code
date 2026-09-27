import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
  normalizeContext,
  type AssistantMessage,
  type Model,
  type SystemMessage,
  type Tool,
  type Usage,
  type UserMessage,
} from "@earendil-works/pi-ai";
import { describe, expect, it } from "vite-plus/test";
import {
  createContextTokenProjector,
  estimateContextTokens,
  estimateMessageTokens,
  projectedContextTokens,
} from "./token-counting";
import { systemHead, withSystemHead } from "./transcript-context";

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

function user(text: string): UserMessage {
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

  // Pi 0.86 carries the prompt and the tool declarations as system messages
  // inside the transcript. The estimator prices them there, and only there:
  // the transcript is the one spelling of a request it accepts, so the same
  // tokens cannot be handed over beside it a second time (VC-421 review, B).
  it("prices the head as the prompt plus each declaration, once, on top of the conversation", () => {
    const systemPrompt = "You are concise.";
    const head = systemHead(systemPrompt, [tool]);
    const conversation: UserMessage[] = [user("hello")];
    const transcript = withSystemHead(head, conversation);
    // The head is the prompt with its framing and one declaration per tool —
    // what the separate `(systemPrompt, tools)` pair cost before 0.86.
    expect(estimateContextTokens(transcript, model())).toBe(
      estimateMessageTokens(head, model()) + estimateContextTokens(conversation, model()),
    );
    expect(estimateMessageTokens(head, model())).toBe(
      estimateMessageTokens({ role: "system", content: systemPrompt, timestamp: 0 }, model()) +
        estimateMessageTokens(
          { role: "system", content: "", toolsAdded: [tool], timestamp: 0 },
          model(),
        ),
    );
    // Pi's own fold of the pair is the same transcript, and costs the same.
    expect(
      estimateContextTokens(
        normalizeContext({ systemPrompt, tools: [tool], messages: conversation }).messages,
        model(),
      ),
    ).toBe(estimateContextTokens(transcript, model()));
    expect(projectedContextTokens(transcript, model())).toBe(
      estimateContextTokens(transcript, model()),
    );
    const projector = createContextTokenProjector();
    const first = projector(transcript, model());
    // Memoized by the head's identity, and the same answer as the direct one.
    expect(projector(transcript, model())).toBe(first);
    expect(first).toBe(estimateContextTokens(transcript, model()));
  });

  it("prices sections as rendered and a removed section as nothing", () => {
    const plain = { role: "system" as const, content: "base", timestamp: 0 };
    expect(
      estimateMessageTokens(
        { ...plain, sections: { style: "Spell units out.", gone: null } },
        model(),
      ),
    ).toBeGreaterThan(estimateMessageTokens(plain, model()));
    expect(estimateMessageTokens({ ...plain, sections: { gone: null } }, model())).toBe(
      estimateMessageTokens(plain, model()),
    );
  });

  it("prices a tool delta at its names alone, and an empty system message at nothing", () => {
    // No prompt text means no prompt framing: only the removed name is sent.
    expect(
      estimateMessageTokens(
        { role: "system", content: "", toolsRemoved: [{ name: "phantom_tool" }], timestamp: 0 },
        model(),
      ),
    ).toBe(
      estimateMessageTokens(user("phantom_tool"), model()) -
        // A user message's framing alone: the name without the wrapper.
        estimateMessageTokens(user(""), model()),
    );
    expect(estimateMessageTokens({ role: "system", content: "", timestamp: 0 }, model())).toBe(0);
  });

  // What a transcript's declarations cost is what a provider is sent: Pi's
  // `getCurrentTools`, one declaration per name, later ones winning, removed
  // ones gone — however many system messages carry them (VC-421 review, A).
  describe("declarations over a whole transcript", () => {
    const head: SystemMessage = {
      role: "system",
      content: "You are concise.",
      toolsAdded: [tool],
      timestamp: 0,
    };
    const otherTool: Tool = {
      name: "write_file",
      description: "Write a file to disk, replacing what was there.",
      parameters: {
        type: "object",
        properties: { path: { type: "string" } },
      } as Tool["parameters"],
    };
    const redeclared: SystemMessage = {
      role: "system",
      content: "",
      toolsAdded: [tool],
      timestamp: 2,
    };

    it("counts a declaration once however many system messages carry it", () => {
      const once: AgentMessage[] = [head, user("hello")];
      const twice: AgentMessage[] = [head, user("hello"), redeclared];
      expect(estimateContextTokens(twice, model())).toBe(estimateContextTokens(once, model()));
      // The memoizing projector agrees, and keeps agreeing off its per-tool memo.
      const projector = createContextTokenProjector();
      expect(projector(twice, model())).toBe(estimateContextTokens(twice, model()));
      expect(projector(twice, model())).toBe(estimateContextTokens(twice, model()));
    });

    it("prices a sidecar conversation behind the head as the one request it is", () => {
      // The compaction shape: a sidecar conversation, which never holds the
      // head but can hold a tool-change message Pi persisted, put back behind
      // the attachment's own head exactly as the runtime sends it. Previously
      // the tool in both was counted twice and `tokensBefore` read too high.
      const conversation: AgentMessage[] = [user("hello"), redeclared];
      expect(estimateContextTokens(withSystemHead(head, conversation), model())).toBe(
        estimateContextTokens(withSystemHead(head, [user("hello")]), model()),
      );
      expect(projectedContextTokens(withSystemHead(head, conversation), model())).toBe(
        estimateContextTokens([head, user("hello")], model()),
      );
    });

    it("prices consecutive deltas as their net effect, not their sum", () => {
      // Pi reconciles once per request, but a sidecar can replay several
      // tool-change messages in a row: an addition, then its removal, then
      // the same tool again. The provider is sent one declaration per name
      // that survives, and the names removed along the way.
      const added: SystemMessage = {
        role: "system",
        content: "",
        toolsAdded: [otherTool],
        timestamp: 2,
      };
      const removed: SystemMessage = {
        role: "system",
        content: "",
        toolsRemoved: [{ name: otherTool.name }],
        timestamp: 3,
      };
      const addedAgain: SystemMessage = { ...added, timestamp: 4 };
      expect(estimateContextTokens([head, user("hello"), added, removed], model())).toBe(
        estimateContextTokens([head, user("hello")], model()) +
          estimateMessageTokens(removed, model()),
      );
      expect(
        estimateContextTokens([head, user("hello"), added, removed, addedAgain], model()),
      ).toBe(
        estimateContextTokens([head, user("hello"), added], model()) +
          estimateMessageTokens(removed, model()),
      );
    });

    it("prices a removed tool at its name and not its declaration", () => {
      const both: SystemMessage = { ...head, toolsAdded: [tool, otherTool] };
      const removal: SystemMessage = {
        role: "system",
        content: "",
        toolsRemoved: [{ name: otherTool.name }],
        timestamp: 2,
      };
      expect(estimateContextTokens([both, user("hello"), removal], model())).toBe(
        estimateContextTokens([head, user("hello")], model()) +
          estimateMessageTokens(removal, model()),
      );
    });

    it("lets a later declaration replace an earlier one", () => {
      const revised: Tool = { ...tool, description: "Read a file from disk, with line numbers." };
      const redeclaredRevised: SystemMessage = { ...redeclared, toolsAdded: [revised] };
      expect(estimateContextTokens([head, user("hello"), redeclaredRevised], model())).toBe(
        estimateContextTokens([{ ...head, toolsAdded: [revised] }, user("hello")], model()),
      );
    });

    it("prices a delta after the measured reply whole, declarations included", () => {
      // The request the measurement covers did not carry the added tool, so
      // the delta is exactly the unmeasured part — whole, not text alone.
      const measured = assistant([{ type: "text", text: "reply" }], {
        usage: usage({ totalTokens: 900 }),
      });
      const added: SystemMessage = {
        role: "system",
        content: "",
        toolsAdded: [otherTool],
        timestamp: 3,
      };
      expect(projectedContextTokens([head, user("hello"), measured, added], model())).toBe(
        projectedContextTokens([head, user("hello"), measured], model()) +
          estimateMessageTokens(added, model()),
      );
      expect(estimateMessageTokens(added, model())).toBeGreaterThan(0);
    });
  });

  it("prices block content as the joined text pi-ai renders", () => {
    expect(
      estimateMessageTokens(
        {
          role: "system",
          content: [
            { type: "text", text: "a" },
            { type: "text", text: "b" },
          ],
          timestamp: 0,
        },
        model(),
      ),
    ).toBe(estimateMessageTokens({ role: "system", content: "a\nb", timestamp: 0 }, model()));
  });

  it("estimates an unrecognized custom role at zero rather than guessing", () => {
    expect(estimateMessageTokens({ role: "mystery" } as unknown as AgentMessage, model())).toBe(0);
  });
});

describe("estimateContextTokens", () => {
  it("includes the system prompt and tool definitions the head carries", () => {
    const conversation = [user("hello")];
    const base = estimateContextTokens(conversation, model());
    const withSystem = estimateContextTokens(
      withSystemHead(systemHead("You are terse. ".repeat(50), []), conversation),
      model(),
    );
    const withTools = estimateContextTokens(
      withSystemHead(systemHead("", [tool]), conversation),
      model(),
    );
    expect(withSystem).toBeGreaterThan(base);
    expect(withTools).toBeGreaterThan(base);
  });

  it("prices a transcript with an empty prompt at its declarations alone", () => {
    // Pi seeds no head for an empty prompt with no tools, and one with only
    // declarations for an empty prompt with tools; neither carries prompt
    // framing. Volli's composed prompt is never empty, so this is the shape
    // only a bare `Agent` or a test reaches — pinned so the estimator does not
    // invent framing for text that is not sent.
    const conversation: UserMessage[] = [user("hello")];
    expect(normalizeContext({ systemPrompt: "", messages: conversation }).messages).toEqual(
      conversation,
    );
    expect(
      estimateContextTokens(withSystemHead(systemHead("", [tool]), conversation), model()),
    ).toBe(
      estimateContextTokens(conversation, model()) +
        estimateMessageTokens(
          { role: "system", content: "", toolsAdded: [tool], timestamp: 0 },
          model(),
        ),
    );
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

  it("reuses settled prefixes without changing projections as messages are appended", () => {
    const projector = createContextTokenProjector();
    const anthropic = model();
    const openai = model({ id: "gpt-4o", api: "openai-completions", provider: "openai" });
    const messages: AgentMessage[] = withSystemHead(
      systemHead("system instructions ".repeat(100), [tool]),
      [user("first ".repeat(100)), user("second ".repeat(100))],
    );

    for (const currentModel of [anthropic, openai]) {
      expect(projector(messages, currentModel)).toBe(
        projectedContextTokens(messages, currentModel),
      );
    }

    messages.push(user("appended tail ".repeat(100)));
    expect(projector(messages, anthropic)).toBe(projectedContextTokens(messages, anthropic));
  });

  it("matches the direct projection when the transcript has no head", () => {
    const messages = [user("plain context")];
    const currentModel = model();
    expect(createContextTokenProjector()(messages, currentModel)).toBe(
      projectedContextTokens(messages, currentModel),
    );
  });

  it("reuses one cache across different models of the same tokenizer family", () => {
    // The cache is keyed by tokenizer FAMILY, not by model, because
    // `estimateMessageTokens` depends on the model only through its counter.
    // Two models that share a family must therefore share an answer — and a
    // model from another family must not be served from that cache.
    const projector = createContextTokenProjector();
    const fable = model();
    const otherAnthropic = model({ id: "claude-opus-5", name: "Claude Opus 5" });
    const messages = [user("shared conservative context ".repeat(40))];

    const first = projector(messages, fable);
    expect(projector(messages, otherAnthropic)).toBe(first);
    expect(first).toBe(projectedContextTokens(messages, otherAnthropic));

    // A different family is a different count, and the shared cache must not
    // flatten the two together.
    const gpt = model({ id: "gpt-4o", api: "openai-completions", provider: "openai" });
    expect(projector(messages, gpt)).toBe(projectedContextTokens(messages, gpt));
  });

  it("agrees with the direct projection on the cl100k family", () => {
    const projector = createContextTokenProjector();
    const gpt4 = model({ id: "gpt-4", api: "openai-completions", provider: "openai" });
    const messages = withSystemHead(systemHead("cl100k system ".repeat(30), [tool]), [
      user("cl100k context ".repeat(30)),
    ]);
    expect(projector(messages, gpt4)).toBe(projectedContextTokens(messages, gpt4));
  });

  it("takes the measured-usage shortcut and estimates only the suffix after it", () => {
    // The branch the other cases never reach: when a settled reply carries this
    // model's own usage, the prefix is not estimated at all. A cache that
    // quietly estimated it anyway would still return a plausible number, so the
    // only honest check is against the uncached function on the same input.
    const projector = createContextTokenProjector();
    const currentModel = model();
    const measured = assistant([{ type: "text", text: "settled reply" }], {
      usage: usage({ input: 9_000, output: 120, totalTokens: 9_120 }),
    });
    const messages: AgentMessage[] = withSystemHead(
      systemHead("system instructions ".repeat(50), [tool]),
      [user("early ".repeat(50)), measured, user("tail ".repeat(50))],
    );

    const projected = projector(messages, currentModel);
    expect(projected).toBe(projectedContextTokens(messages, currentModel));
    // Cheaper than the pure estimate, which is the point of the shortcut.
    expect(projected).toBeLessThan(estimateContextTokens(messages, currentModel) + 9_120);

    // Appending after the measurement extends only the suffix, and the cached
    // and uncached answers must still agree.
    messages.push(user("appended after the measurement ".repeat(50)));
    expect(projector(messages, currentModel)).toBe(projectedContextTokens(messages, currentModel));
  });
});

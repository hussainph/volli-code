import {
  DEFAULT_COMPACTION_SETTINGS,
  InMemorySessionRepo,
  type AgentMessage,
  type CompactionEntry,
  type CustomEntry,
  type Entry,
  type MessageEntry,
  type Session,
} from "@earendil-works/pi-agent-core";
import {
  createAssistantMessageEventStream,
  createModels,
  fauxProvider,
  type AssistantMessage,
  type Model,
  type Models,
  type Usage,
} from "@earendil-works/pi-ai";
import { describe, expect, it } from "vite-plus/test";
import {
  compactionDue,
  compactSession,
  contextMessages,
  contextWindowOf,
  conversationPath,
  occupiedContextTokens,
  type ConversationReader,
} from "./compaction";

const PROVIDER_ID = "anthropic";
const MODEL_ID = "claude-haiku-4-5";

function usage(overrides: Partial<Usage> = {}): Usage {
  return {
    input: 100,
    output: 20,
    cacheRead: 5,
    cacheWrite: 7,
    totalTokens: 132,
    cost: { input: 0.001, output: 0.002, cacheRead: 0, cacheWrite: 0, total: 0.003 },
    ...overrides,
  };
}

function assistant(text: string, overrides: Partial<AssistantMessage> = {}): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "anthropic-messages",
    provider: PROVIDER_ID,
    model: MODEL_ID,
    usage: usage(),
    stopReason: "stop",
    timestamp: 0,
    ...overrides,
  };
}

function user(text: string): AgentMessage {
  return { role: "user", content: text, timestamp: 0 };
}

let nextSeq = 0;

function messageEntry(message: AgentMessage): MessageEntry {
  nextSeq += 1;
  return {
    type: "message",
    id: `entry-${nextSeq}`,
    seq: nextSeq,
    parentId: null,
    timestamp: nextSeq,
    message,
  };
}

function customEntry(customType: string, data?: unknown): CustomEntry {
  nextSeq += 1;
  return {
    type: "custom",
    id: `entry-${nextSeq}`,
    seq: nextSeq,
    parentId: null,
    timestamp: nextSeq,
    customType,
    ...(data === undefined ? {} : { data }),
  };
}

/** Reads acceptance markers the way the runtime's own sidecar writes them. */
const reader: ConversationReader = {
  acceptedMessage: (entry) =>
    entry.customType === "accepted" ? (entry.data as AgentMessage) : undefined,
  replayable: (entry) =>
    entry.message.role !== "assistant" || (entry.message as AssistantMessage).stopReason === "stop",
};

/** Scripts one reply per provider call, in order. */
function scriptedModels(replies: readonly string[]): Models {
  const faux = fauxProvider({
    api: "anthropic-messages",
    provider: PROVIDER_ID,
    models: [{ id: MODEL_ID }],
  });
  const models = createModels();
  let call = 0;
  models.setProvider({
    ...faux.provider,
    streamSimple: ((model: Model<string>) => {
      const stream = createAssistantMessageEventStream();
      const text = replies[call++];
      const message: AssistantMessage = {
        ...assistant(text ?? ""),
        api: model.api,
        provider: model.provider,
        model: model.id,
        ...(text === undefined
          ? { stopReason: "error" as const, errorMessage: "no scripted reply", content: [] }
          : {}),
      };
      stream.push(
        text === undefined
          ? { type: "error", reason: "error", error: message }
          : { type: "done", reason: "stop", message },
      );
      stream.end(message);
      return stream;
    }) as typeof faux.provider.streamSimple,
  });
  return models;
}

async function memorySession(): Promise<Session> {
  return new InMemorySessionRepo().create();
}

describe("contextWindowOf", () => {
  it("reports a usable window", () => {
    expect(contextWindowOf({ contextWindow: 128_000.7 })).toBe(128_000);
  });

  it("reports nothing for a window no meter could divide by", () => {
    expect(contextWindowOf({ contextWindow: 0 })).toBeUndefined();
    expect(contextWindowOf({ contextWindow: Number.NaN })).toBeUndefined();
    expect(contextWindowOf({ contextWindow: -1 })).toBeUndefined();
  });
});

describe("occupiedContextTokens", () => {
  it("sums the four measured token fields of the newest reply", () => {
    const path = [
      messageEntry(assistant("older", { usage: usage({ input: 9_000 }) })),
      messageEntry(user("between")),
      messageEntry(assistant("newer", { usage: usage({ input: 1_000, totalTokens: 1_032 }) })),
    ];
    // 1000 input + 20 output + 5 cache read + 7 cache write — cached prompt
    // tokens are context the model held, not a separate budget.
    expect(occupiedContextTokens(path)).toBe(1_032);
  });

  it("has no answer for a path whose replies never reported usage", () => {
    expect(occupiedContextTokens([messageEntry(user("only a question"))])).toBeUndefined();
    expect(
      occupiedContextTokens([
        messageEntry(
          assistant("failed", { stopReason: "error", usage: usage({ totalTokens: 5_000 }) }),
        ),
      ]),
    ).toBeUndefined();
  });
});

describe("compactionDue", () => {
  it("applies Pi's reserve rule to measured occupancy", () => {
    const window = 100_000;
    const reserve = DEFAULT_COMPACTION_SETTINGS.reserveTokens;
    expect(compactionDue(window - reserve, window, DEFAULT_COMPACTION_SETTINGS)).toBe(false);
    expect(compactionDue(window - reserve + 1, window, DEFAULT_COMPACTION_SETTINGS)).toBe(true);
  });

  it("never compacts an unmeasured conversation", () => {
    expect(compactionDue(undefined, 1_000, DEFAULT_COMPACTION_SETTINGS)).toBe(false);
  });

  it("never compacts when compaction is switched off", () => {
    expect(compactionDue(999_999, 1_000, { ...DEFAULT_COMPACTION_SETTINGS, enabled: false })).toBe(
      false,
    );
  });
});

describe("conversationPath", () => {
  it("restores user messages that only a command marker holds", () => {
    const accepted = user("delivered through a command");
    const path = conversationPath(
      [
        customEntry("turn-marker"),
        customEntry("accepted", accepted),
        messageEntry(assistant("answered")),
      ],
      reader,
    );

    expect(path.map((entry) => entry.type)).toEqual(["message", "message"]);
    expect(contextMessages(path)).toEqual([accepted, assistant("answered")]);
  });

  it("drops a message the attachment judged unreplayable", () => {
    const path = conversationPath(
      [
        messageEntry(user("start")),
        messageEntry(assistant("half-written", { stopReason: "aborted" })),
      ],
      reader,
    );

    expect(contextMessages(path)).toEqual([user("start")]);
  });

  it("passes an entry type it does not own through untouched", () => {
    const compaction: CompactionEntry = {
      type: "compaction",
      id: "compaction-1",
      seq: 99,
      parentId: null,
      timestamp: 99,
      summary: "what came before",
      retainedTail: [user("kept")],
      tokensBefore: 4_000,
    };

    expect(conversationPath([compaction], reader)).toEqual([compaction]);
  });
});

describe("contextMessages", () => {
  it("elides everything before the last compaction entry", () => {
    const compaction = (id: string, summary: string): CompactionEntry => ({
      type: "compaction",
      id,
      seq: 0,
      parentId: null,
      timestamp: 0,
      summary,
      retainedTail: [user(`tail of ${summary}`)],
      tokensBefore: 1,
    });
    const path: Entry[] = [
      messageEntry(user("first")),
      compaction("c1", "older"),
      messageEntry(user("second")),
      compaction("c2", "newer"),
      messageEntry(user("third")),
    ];

    const messages = contextMessages(path);

    expect(messages).toEqual([
      { role: "compactionSummary", summary: "newer", tokensBefore: 1, timestamp: 0 },
      user("tail of newer"),
      user("third"),
    ]);
  });
});

describe("compactSession", () => {
  const settings = DEFAULT_COMPACTION_SETTINGS;

  /** A history long enough that Pi's cut point leaves something behind it. */
  function longPath(): MessageEntry[] {
    return [
      messageEntry(user("the original request")),
      messageEntry(assistant("a long early answer")),
      messageEntry(user("x".repeat(90_000))),
      messageEntry(assistant("the recent answer")),
    ];
  }

  it("appends a durable compaction entry and returns the elided context", async () => {
    const sidecar = await memorySession();
    const models = scriptedModels(["## Goal\nfinish the ticket"]);
    const model = models.getModel(PROVIDER_ID, MODEL_ID)!;
    const path = longPath();

    const outcome = await compactSession({ sidecar, path, models, model, settings });

    expect(outcome.kind).toBe("compacted");
    if (outcome.kind !== "compacted") return;
    expect(outcome.entry.type).toBe("compaction");
    expect(outcome.entry.summary).toContain("finish the ticket");
    expect(outcome.entry.tokensBefore).toBeGreaterThan(0);
    // Billed to the Session: the summarization call's own usage rides on the entry.
    expect(outcome.entry.usage).toEqual(usage());
    expect(outcome.entry.retainedTail).toEqual([path[2]?.message, path[3]?.message]);
    // The entry is a real one in the tree, not a marker: Pi can find it by type.
    expect(await sidecar.findEntriesOnBranch({ type: "compaction" })).toEqual([outcome.entry]);
    // The early exchange is summarized away; the recent tail survives verbatim.
    expect(JSON.stringify(outcome.messages)).not.toContain("a long early answer");
    expect(JSON.stringify(outcome.messages)).toContain("the recent answer");
  });

  it("writes nothing when Pi finds nothing to compact", async () => {
    const sidecar = await memorySession();
    const models = scriptedModels([]);
    const model = models.getModel(PROVIDER_ID, MODEL_ID)!;

    expect(await compactSession({ sidecar, path: [], models, model, settings })).toEqual({
      kind: "skipped",
    });
    expect(await sidecar.findEntries()).toEqual([]);
  });

  it("writes nothing when summarization fails, and sanitizes what it reports", async () => {
    const sidecar = await memorySession();
    const models = scriptedModels([]);
    const model = models.getModel(PROVIDER_ID, MODEL_ID)!;

    const outcome = await compactSession({
      sidecar,
      path: longPath(),
      models,
      model,
      settings,
      customInstructions: "focus on the failing test",
    });

    expect(outcome.kind).toBe("failed");
    if (outcome.kind !== "failed") return;
    expect(outcome.message).toContain("Summarization failed");
    expect(await sidecar.findEntries()).toEqual([]);
  });
});

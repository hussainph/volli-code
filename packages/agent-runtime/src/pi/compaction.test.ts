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
  type Context,
  type Model,
  type Models,
  type Usage,
} from "@earendil-works/pi-ai";
import { describe, expect, it } from "vite-plus/test";
import { composeFirstUserMessage } from "../prompt";
import {
  compactionDue,
  compactSession,
  contextMessages,
  contextWindowOf,
  conversationPath,
  estimatedContextTokens,
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

/** Scripts one reply per provider call, in order, retaining what each was sent. */
function scriptedModels(replies: readonly string[], sent: Context[] = []): Models {
  const faux = fauxProvider({
    api: "anthropic-messages",
    provider: PROVIDER_ID,
    models: [{ id: MODEL_ID }],
  });
  const models = createModels();
  let call = 0;
  models.setProvider({
    ...faux.provider,
    streamSimple: ((model: Model<string>, context: Context) => {
      sent.push(context);
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

describe("estimatedContextTokens", () => {
  it("counts what a context holds without asking what the model measured", () => {
    // Pi's heuristic is four characters to the token, per message.
    expect(estimatedContextTokens([user("a".repeat(400))])).toBe(100);
    expect(estimatedContextTokens([])).toBe(0);
  });

  it("ignores the stale usage a retained reply still carries", () => {
    // The one number an estimate of a *compacted* context must not start from:
    // the tail keeps the usage of the reply that overflowed, and reading it back
    // would report the window as full immediately after emptying it. Pi's own
    // `estimateContextTokens` would answer 200,000 here.
    const retained = assistant("short", { usage: usage({ input: 200_000, totalTokens: 200_000 }) });

    expect(estimatedContextTokens([retained])).toBeLessThan(100);
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

  it("elides the Brief and the Turn Reminder the first message carried", () => {
    // "Everything before the last compaction entry" includes the first message,
    // and the first message is where Volli puts everything volatile it has to
    // say (VC-164): the Runtime Brief, and any Turn Reminder the Session's
    // measured facts earn. Both therefore end at the first compaction — the
    // Brief always did, and VC-156's dependency fact now shares its fate,
    // having moved out of the system prompt where it would have survived
    // forever. That is deliberate; `runtime.test.ts` carries the reasoning and
    // pins the same behaviour end to end.
    const opening = composeFirstUserMessage(
      {
        identity: {
          role: "ticket",
          sessionId: "session-1",
          rootThreadId: "thread-1",
          attachmentId: "attachment-1",
          projectId: "project-1",
          ticketId: "ticket-1",
        },
        brief: { text: "VC-12 — read the marker." },
        workspaceEnvironment: { dependencies: "absent", installCommand: "pnpm install" },
      },
      "start here",
    );
    // The real bytes, not a stand-in: this test fails the day a reminder is
    // given a delivery that outlives compaction without anyone saying so.
    expect(opening).toContain("BEGIN TICKET BRIEF");
    expect(opening).toContain("BEGIN WORKSPACE ENVIRONMENT");

    const path: Entry[] = [
      messageEntry(user(opening)),
      messageEntry(assistant("working on it")),
      {
        type: "compaction",
        id: "c1",
        seq: 0,
        parentId: null,
        timestamp: 0,
        summary: "read the marker, then report the token",
        retainedTail: [assistant("working on it")],
        tokensBefore: 200_000,
      },
      messageEntry(user("carry on")),
    ];

    const admitted = JSON.stringify(contextMessages(path));

    expect(admitted).not.toContain("BEGIN TICKET BRIEF");
    expect(admitted).not.toContain("BEGIN WORKSPACE ENVIRONMENT");
    expect(admitted).toContain("read the marker, then report the token");
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

  it("summarizes through a request that shares no prefix with the Session", async () => {
    // Why VC-164's "the compaction request itself reuses the parent's exact
    // prefix" was struck rather than implemented, pinned at the boundary where
    // it would have had to be implemented. Pi builds the summarization request
    // itself, and builds it to be standalone: its own system prompt, no tools,
    // and the history flattened into one <conversation> blob instead of the
    // message array — so there is no prefix here to share, and obtaining one
    // would mean reimplementing `compact()`, which is the single thing this
    // module exists to forbid.
    //
    // Failing this test means Pi changed its mind about that. It is then worth
    // re-reading the struck clause, not worth working around here.
    const sidecar = await memorySession();
    const sent: Context[] = [];
    const models = scriptedModels(["## Goal\nfinish the ticket"], sent);
    const model = models.getModel(PROVIDER_ID, MODEL_ID)!;

    await compactSession({ sidecar, path: longPath(), models, model, settings });

    expect(sent).toHaveLength(1);
    const [summarization] = sent;
    expect(summarization?.tools ?? []).toEqual([]);
    // Pi's own, and nothing this runtime composed or could compose: the module
    // hands `compact()` a model and a path, never a prompt.
    expect(summarization?.systemPrompt).toContain("summarization");
    expect(summarization?.messages).toHaveLength(1);
    expect(JSON.stringify(summarization?.messages)).toContain("<conversation>");
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

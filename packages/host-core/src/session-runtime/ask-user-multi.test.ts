import { describe, expect, it, vi } from "vite-plus/test";
import { dirname, join } from "node:path";
import {
  createSessionEngine,
  createSessionRuntime,
  sessionRootThreadId,
} from "@volli/session-engine";
import {
  decodeSessionEventPayload,
  readInteractionAnswers,
  readInteractionPrompts,
  type AgentRuntime,
  type RuntimeAskUserQuestion,
  type RuntimeAttachmentHandle,
  type SessionInteractionResolution,
  type SessionRuntimeSpec,
} from "@volli/shared";
import { createSessionTools } from "../../../agent-runtime/src/pi/tools";
import { insertProject } from "../db/projects-repo";
import { openRawDb, openTestDb, testProject } from "../db/test-helpers";
import { createSqliteSessionLedger } from "../session-control/sqlite-ledger";
import { createPiNativeAdapter } from "./pi-adapter";
import { createInMemoryTranscriptArtifactStore } from "@volli/session-engine/testing";

const questions: RuntimeAskUserQuestion[] = [
  {
    question: "Spike it, or migrate the whole thing?",
    choices: ["Spike first", "Full migration"],
  },
  {
    question: "Which checks should block release?",
    choices: ["Unit tests", "Integration tests"],
  },
  { question: "What else should we keep in mind?", choices: [] },
];

const legacyOptions = [
  { id: "spike", label: "Spike first" },
  { id: "migration", label: "Full migration", description: "Two more days" },
];

const resolution: SessionInteractionResolution = {
  optionIds: ["choice:1"],
  response: null,
  // Deliberately not in prompt order: ids, not array position, address answers.
  answers: [
    { promptId: "prompt:2", optionIds: [], response: "Keep the old API." },
    { promptId: "prompt:0", optionIds: ["choice:1"], response: null },
    // A typed alternative wins even when a stale selection accompanies it.
    { promptId: "prompt:1", optionIds: ["choice:0"], response: "  Also smoke it.  " },
  ],
};

type ToolOutcome = { text: string } | { error: string };

/**
 * Only the model is scripted. The spec comes from the real native adapter and
 * the tool is built by the production Session tool assembly, calls its real
 * askUser port and parks on the Session Engine's durable interaction.
 */
function scriptedModel(input: object) {
  const call = new AbortController();
  let spec: SessionRuntimeSpec | undefined;
  let pending: Promise<ToolOutcome> | undefined;
  let outcome: ToolOutcome | undefined;
  const abort = async () => {
    call.abort();
    await pending;
  };
  const runtime: AgentRuntime = {
    inspectModelAccess: async () => ({ observedAt: 0, providers: [], models: [] }),
    completeUtility: async () => {
      throw new Error("This fixture never calls a provider.");
    },
    startSession: async (started): Promise<RuntimeAttachmentHandle> => {
      spec = started;
      // ask_user has no execution-environment dependency. No fake tool or
      // substitute askUser callback is installed here.
      const tool = createSessionTools(started, {} as never).find((one) => one.name === "ask_user");
      if (!tool) throw new Error("The real Session surface omitted ask_user.");
      return {
        submitUserMessage: async () => {
          await started.observer({ kind: "turn", state: "started", turnId: "turn-1" });
          pending = tool
            .execute("call-7", input, call.signal)
            .then(
              (result): ToolOutcome => {
                const part = result.content[0];
                if (part?.type !== "text") throw new Error("ask_user returned no text.");
                return { text: part.text };
              },
              (error: unknown): ToolOutcome => ({
                error: error instanceof Error ? error.message : String(error),
              }),
            )
            .then((result) => {
              outcome = result;
              return result;
            });
          return { kind: "delivered", delivery: "prompt" };
        },
        selectModel: async () => ({ kind: "selected" }),
        retry: async () => {
          throw new Error("No retries in this fixture.");
        },
        compact: async () => ({ kind: "compacted" }),
        interrupt: abort,
        close: abort,
        reconcile: async (cursor) => ({ cursor, observations: [] }),
        recovery: {
          runtime: "pi",
          sessionId: "pi-session-1",
          sessionFilePath: join(started.workspacePath, "pi-session-1.jsonl"),
        },
      };
    },
  };
  return {
    runtime,
    call,
    get spec() {
      return spec;
    },
    get outcome() {
      return outcome;
    },
    result: async () => {
      if (!pending) throw new Error("The real message command has not executed the tool.");
      return pending;
    },
    abort,
  };
}

async function fixture(input: object = { questions }, batch = true) {
  const db = openTestDb();
  insertProject(db.db, testProject({ id: "project-1" }));
  let now = 1_000;
  const clock = { now: () => now++ };
  const ids = { next: (kind: string) => `${kind}-${now++}` };
  const model = scriptedModel(input);
  const engine = createSessionEngine({ ledger: createSqliteSessionLedger(db.db), clock, ids });
  const adapter = createPiNativeAdapter({
    sessionDataDir: join(dirname(db.dbPath), "pi"),
    createRuntime: () => model.runtime,
    resolveRuntimeContext: async (sessionId) => ({
      role: "project",
      projectId: "project-1",
      ticketId: null,
      rootThreadId: sessionRootThreadId(sessionId),
      brief: "Ask related decisions together.",
      model: { providerId: "fixture", modelId: "deterministic", reasoningLevel: "off" },
      toolSurface: ["ask_user"],
      promptResources: [],
      ...(batch ? { askUserQuestions: true as const } : {}),
    }),
    now: clock.now,
  });
  const venue = { id: "local", kind: "local" as const };
  const host = createSessionRuntime({
    engine,
    executor: adapter,
    artifacts: createInMemoryTranscriptArtifactStore(),
    locations: {
      resolve: async () => ({ directory: dirname(db.dbPath), venue }),
      prepare: async () => ({ directory: dirname(db.dbPath), venue }),
      reaffirm: async () => undefined,
    },
    clock,
    ids,
  });
  const { sessionId } = await host.command({
    commandId: "create",
    command: {
      kind: "session.create",
      projectId: "project-1",
      ticketId: null,
      role: "project",
      parentSessionId: null,
      title: "Multi question test",
    },
  });
  await host.command({
    commandId: "attach",
    sessionId,
    command: { kind: "adapter.attach", continuity: "fresh" },
  });
  await host.command({
    commandId: "submit",
    sessionId,
    command: {
      kind: "message.submit",
      settle: "opened",
      message: {
        id: "message-1",
        role: "user",
        parts: [{ type: "text", text: "Ask what blocks you." }],
      },
    },
  });
  const snapshot = async () => (await host.snapshot({ sessionId })).projection;
  const opened = async () => {
    await vi.waitFor(async () => expect((await snapshot()).interactions.active).toHaveLength(1));
    // The adapter commits opened before parking. Flush that continuation too.
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(model.outcome).toBeUndefined();
    return (await snapshot()).interactions.active[0]!;
  };
  const answer = (answerResolution: SessionInteractionResolution) =>
    host.command({
      commandId: "answer",
      sessionId,
      command: {
        kind: "interaction.resolve",
        interactionId: "ask-user:call-7",
        resolution: answerResolution,
      },
    });
  const stored = () =>
    db.db
      .prepare(
        "SELECT payload FROM session_events WHERE session_id = ? AND json_extract(payload, '$.kind') LIKE 'interaction.%' ORDER BY sequence",
      )
      .all(sessionId) as { payload: string }[];
  return {
    db,
    engine,
    host,
    model,
    sessionId,
    snapshot,
    opened,
    answer,
    stored,
    cleanup: async () => {
      await model.abort();
      db.cleanup();
    },
  };
}

describe("ask_user real tool → Pi adapter → SQLite Session interaction", () => {
  it("parks three questions in one interaction and returns every answer with one command", async () => {
    const f = await fixture();
    try {
      const interaction = await f.opened();
      expect(f.model.spec?.tools.askUserQuestions).toBe(true);
      expect(interaction.id).toBe("ask-user:call-7");
      expect(readInteractionPrompts(interaction)).toEqual([
        {
          id: "prompt:0",
          label: questions[0]!.question,
          detail: null,
          options: [
            { id: "choice:0", label: "Spike first", description: null },
            { id: "choice:1", label: "Full migration", description: null },
          ],
          multiple: false,
          custom: true,
        },
        {
          id: "prompt:1",
          label: questions[1]!.question,
          detail: null,
          options: [
            { id: "choice:0", label: "Unit tests", description: null },
            { id: "choice:1", label: "Integration tests", description: null },
          ],
          multiple: false,
          custom: true,
        },
        {
          id: "prompt:2",
          label: questions[2]!.question,
          detail: null,
          options: [],
          multiple: false,
          custom: true,
        },
      ]);
      expect(interaction.title).toBe(questions[0]!.question);
      expect(interaction.options).toEqual(readInteractionPrompts(interaction)[0]!.options);
      expect(interaction.multiple).toBe(false);
      expect(f.stored()).toHaveLength(1);
      expect(f.stored()[0]!.payload).toBe(
        JSON.stringify({ kind: "interaction.opened", interaction }),
      );

      const receipt = await f.answer(resolution);
      expect(receipt.receipt?.status).toBe("accepted");
      expect(await f.model.result()).toEqual({
        text: JSON.stringify([
          { question: questions[0]!.question, answer: "Full migration" },
          { question: questions[1]!.question, answer: "  Also smoke it.  " },
          { question: questions[2]!.question, answer: "Keep the old API." },
        ]),
      });
      const projection = await f.snapshot();
      expect(projection.interactions.active).toEqual([]);
      expect(projection.interactions.resolved[0]?.resolution).toEqual(resolution);
      expect(
        f.db.db
          .prepare(
            "SELECT intent FROM session_commands WHERE session_id = ? AND json_extract(intent, '$.kind') = 'interaction.resolve'",
          )
          .all(f.sessionId),
      ).toHaveLength(1);
      expect(f.stored().map((row) => JSON.parse(row.payload).kind)).toEqual([
        "interaction.opened",
        "interaction.resolved",
      ]);
    } finally {
      await f.cleanup();
    }
  });

  it("replays the actual stored event and answers through the codec and a reopened SQLite ledger", async () => {
    const f = await fixture();
    try {
      const interaction = await f.opened();
      await f.answer(resolution);
      const payloads = f
        .stored()
        .map((row) => decodeSessionEventPayload(JSON.parse(row.payload), "stored ask_user event"));
      const opened = payloads[0]!;
      const resolved = payloads[1]!;
      expect(opened.kind).toBe("interaction.opened");
      expect(resolved.kind).toBe("interaction.resolved");
      if (opened.kind !== "interaction.opened" || resolved.kind !== "interaction.resolved")
        throw new Error("Missing interaction events");
      expect(opened.interaction).toEqual(interaction);
      expect(readInteractionAnswers(opened.interaction, resolved.resolution)).toEqual(
        resolution.answers,
      );
      // N−1-readable interaction vocabulary: no new event kind or fields on
      // prompts/answers, and the original flat first-prompt fields coexist.
      expect(Object.keys(opened.interaction).toSorted()).toEqual([
        "attachmentId",
        "detail",
        "id",
        "kind",
        "multiple",
        "native",
        "options",
        "prompts",
        "title",
      ]);
      expect(readInteractionPrompts(opened.interaction).map((prompt) => prompt.id)).toEqual([
        "prompt:0",
        "prompt:1",
        "prompt:2",
      ]);
      f.db.db
        .prepare("DELETE FROM session_projection_checkpoints WHERE session_id = ?")
        .run(f.sessionId);
      f.db.db.close();
      f.db.db = openRawDb(f.db.dbPath);
      f.db.db.pragma("foreign_keys = ON");
      const ledger = createSqliteSessionLedger(f.db.db);
      const events = await ledger.transaction((transaction) =>
        transaction.listEvents({ sessionId: f.sessionId }),
      );
      const replayed = events
        .filter((event) => event.payload.kind.startsWith("interaction."))
        .map((event) => event.payload);
      expect(replayed).toEqual(payloads);
      const engine = createSessionEngine({
        ledger,
        clock: { now: () => 9_000 },
        ids: { next: (kind) => `replay-${kind}` },
      });
      const projection = await engine.getSession({ sessionId: f.sessionId });
      expect(projection?.interactions.active).toEqual([]);
      expect(projection?.interactions.resolved[0]?.interaction).toEqual(interaction);
      expect(projection?.interactions.resolved[0]?.resolution).toEqual(resolution);
    } finally {
      await f.cleanup();
    }
  });

  it("names missing answers without copying the flat first answer into later questions", async () => {
    const f = await fixture();
    try {
      await f.opened();
      await f.answer({ optionIds: ["choice:0"], response: null });
      expect(await f.model.result()).toEqual({
        text: JSON.stringify([
          { question: questions[0]!.question, answer: "Spike first" },
          { question: questions[1]!.question, answer: null, unanswered: true },
          { question: questions[2]!.question, answer: null, unanswered: true },
        ]),
      });
    } finally {
      await f.cleanup();
    }
  });

  it.each([false])(
    "keeps the historical flat interaction and answer bytes (batch declaration: %s)",
    async (batch) => {
      const f = await fixture(
        {
          question: questions[0]!.question,
          options: legacyOptions,
          multiple: true,
        },
        batch,
      );
      try {
        const interaction = await f.opened();
        const native = {
          id: "pi-session-1",
          detail: {
            runtime: "pi",
            sessionId: "pi-session-1",
            sessionFilePath: join(dirname(f.db.dbPath), "pi-session-1.jsonl"),
          },
        };
        expect(f.model.spec?.tools.askUserQuestions).toBe(batch ? true : undefined);
        expect(JSON.stringify(interaction)).toBe(
          JSON.stringify({
            id: "ask-user:call-7",
            attachmentId: interaction.attachmentId,
            kind: "question",
            title: "Spike it, or migrate the whole thing?",
            detail: null,
            options: [
              { id: "spike", label: "Spike first", description: null },
              { id: "migration", label: "Full migration", description: "Two more days" },
            ],
            multiple: true,
            native,
            prompts: [
              {
                id: "prompt:0",
                label: "Spike it, or migrate the whole thing?",
                detail: null,
                options: [
                  { id: "spike", label: "Spike first", description: null },
                  { id: "migration", label: "Full migration", description: "Two more days" },
                ],
                multiple: true,
                custom: true,
              },
            ],
          }),
        );
        expect(f.stored()[0]!.payload).toBe(
          JSON.stringify({ kind: "interaction.opened", interaction }),
        );
        await f.answer({ optionIds: ["spike", "migration"], response: "  and time-box it  " });
        expect(await f.model.result()).toEqual({
          text: "Chose: spike, migration\n\nand time-box it",
        });
      } finally {
        await f.cleanup();
      }
    },
  );

  it.each([
    { options: legacyOptions, multiple: false, allowOther: false, custom: false },
    { options: legacyOptions, multiple: true, allowOther: true, custom: true },
    { options: [], multiple: false, allowOther: false, custom: true },
  ])("preserves legacy flat option and custom rules: %j", async (legacy) => {
    const { custom, ...input } = legacy;
    const f = await fixture({ question: "Historical question", ...input }, false);
    try {
      const interaction = await f.opened();
      expect(readInteractionPrompts(interaction)).toEqual([
        {
          id: "prompt:0",
          label: "Historical question",
          detail: null,
          options: input.options.map((option) => ({
            ...option,
            description: option.description ?? null,
          })),
          multiple: input.multiple,
          custom,
        },
      ]);
      const optionIds = input.options.length === 0 ? [] : ["migration"];
      await f.answer({ optionIds, response: null });
      expect(await f.model.result()).toEqual({
        text:
          optionIds.length === 0
            ? "The question was answered with no choice and no reply."
            : "Chose: migration",
      });
    } finally {
      await f.cleanup();
    }
  });

  it("names a dismissed batch question without inventing a default", async () => {
    const f = await fixture({ questions: [questions[0]] });
    try {
      await f.opened();
      await f.answer({ optionIds: [], response: "  " });
      expect(await f.model.result()).toEqual({
        text: JSON.stringify([
          { question: questions[0]!.question, answer: null, unanswered: true },
        ]),
      });
    } finally {
      await f.cleanup();
    }
  });

  it.each([
    [{ questions: [] }, "must not have fewer than 1 items"],
    [{ questions: [...questions, questions[0], questions[1]] }, "must not have more than 4 items"],
    [{ questions: [{ question: " ", choices: [] }] }, "needs question text"],
    [{ questions: [{ question: "Pick?", choices: ["Only"] }] }, "needs 2-5 choices"],
    [
      { questions: [{ question: "Pick?", choices: ["Same", " Same "] }] },
      "needs non-empty, distinct choices",
    ],
    [
      { questions: [{ question: "Pick?", choices: ["", "Other"] }] },
      "needs non-empty, distinct choices",
    ],
    [
      { questions: [{ question: "Pick?", choices: ["A", "B", "C", "D", "E", "F"] }] },
      "must not have more than 5 items",
    ],
    [{ questions: [{ question: "Pick?" }] }, "invalid fields"],
    [{ question: "Flat", questions }, "invalid fields"],
  ] as const)("rejects an invalid batch before writing a card: %j", async (input, error) => {
    const f = await fixture(input);
    try {
      expect(await f.model.result()).toMatchObject({ error: expect.stringContaining(error) });
      expect((await f.snapshot()).interactions.active).toEqual([]);
      expect(f.stored()).toEqual([]);
    } finally {
      await f.cleanup();
    }
  });

  it("names a downgraded flat call retried on the new declaration without parking", async () => {
    const f = await fixture({
      question: "Flat call from a downgraded executor",
      options: legacyOptions,
    });
    try {
      expect(await f.model.result()).toMatchObject({ error: expect.stringContaining("questions") });
      expect((await f.snapshot()).interactions.active).toEqual([]);
      expect(f.stored()).toEqual([]);
    } finally {
      await f.cleanup();
    }
  });

  it("names a stale downgraded flat card after upgrade and lets cancellation clear it", async () => {
    const f = await fixture({
      question: "Flat call left by a downgraded executor",
      options: legacyOptions,
    });
    try {
      expect(await f.model.result()).toMatchObject({ error: expect.stringContaining("questions") });
      const attachmentId = (await f.snapshot()).liveExecutor!.id;
      // Replay the old stored card vocabulary, as separately written/read by
      // the exact N-1 build in the compatibility lane. No live wait survived.
      const options = legacyOptions.map((option) => ({
        id: option.id,
        label: option.label,
        description: option.description ?? null,
      }));
      await f.engine.observe({
        id: "restored-flat-opened",
        sessionId: f.sessionId,
        occurredAt: 8_000,
        provenance: { source: { kind: "adapter", id: "pi", detail: null }, venue: null },
        kind: "interaction.opened",
        interaction: {
          id: "ask-user:call-7",
          attachmentId,
          kind: "question",
          title: "Flat call left by a downgraded executor",
          detail: null,
          options,
          multiple: false,
          native: { id: null, detail: null },
          prompts: [
            {
              id: "prompt:0",
              label: "Flat call left by a downgraded executor",
              detail: null,
              options,
              multiple: false,
              custom: true,
            },
          ],
        },
      });
      const attempted = await f.answer({ optionIds: ["spike"], response: null });
      expect(attempted.receipt).toMatchObject({
        status: "rejected",
        code: "PI_INTERACTION_UNKNOWN",
        detail: expect.stringContaining("Nothing is waiting on this question"),
      });
      await f.host.cancelInteraction({
        sessionId: f.sessionId,
        interactionId: "ask-user:call-7",
        reason: "abandoned",
      });
      expect((await f.snapshot()).interactions.active).toEqual([]);
      expect(f.stored().map((row) => JSON.parse(row.payload).kind)).toEqual([
        "interaction.opened",
        "interaction.cancelled",
      ]);
    } finally {
      await f.cleanup();
    }
  });

  it("does not give an older Session the new questions execution surface", async () => {
    const f = await fixture({ questions }, false);
    try {
      expect(f.model.spec?.tools.askUserQuestions).toBeUndefined();
      expect(await f.model.result()).toEqual({
        error: "ask_user: this Session supports only the single-question fields.",
      });
      expect(f.stored()).toEqual([]);
    } finally {
      await f.cleanup();
    }
  });

  it("preserves a flat dismissal as an empty answer, not a fabricated choice", async () => {
    const f = await fixture({ question: "What should I change?" }, false);
    try {
      await f.opened();
      await f.answer({ optionIds: [], response: null });
      expect(await f.model.result()).toEqual({
        text: "The question was answered with no choice and no reply.",
      });
      expect(JSON.parse(f.stored()[1]!.payload).kind).toBe("interaction.resolved");
    } finally {
      await f.cleanup();
    }
  });

  it.each(["tool abort", "executor interrupt", "attachment release", "Session cancellation"])(
    "withdraws the entire batch on %s, without inventing any answers",
    async (action) => {
      const f = await fixture();
      try {
        await f.opened();
        if (action === "tool abort") f.model.call.abort();
        else if (action === "executor interrupt")
          await f.host.command({
            commandId: "interrupt",
            sessionId: f.sessionId,
            command: { kind: "executor.interrupt" },
          });
        else if (action === "Session cancellation")
          await f.host.cancelInteraction({
            sessionId: f.sessionId,
            interactionId: "ask-user:call-7",
            reason: "abandoned",
          });
        else
          await f.host.command({
            commandId: "release",
            sessionId: f.sessionId,
            command: {
              kind: "adapter.release",
              attachmentId: (await f.snapshot()).liveExecutor!.id,
            },
          });
        expect(await f.model.result()).toEqual({
          error: "The question was withdrawn before anyone answered it.",
        });
        expect((await f.snapshot()).interactions.active).toEqual([]);
        const payloads = f.stored().map((row) => JSON.parse(row.payload));
        expect(payloads.map((payload) => payload.kind)).toEqual([
          "interaction.opened",
          "interaction.cancelled",
        ]);
        expect(payloads[1].reason).toBe(
          action === "Session cancellation" ? "abandoned" : "withdrawn",
        );
        expect(payloads[1]).not.toHaveProperty("resolution");
      } finally {
        await f.cleanup();
      }
    },
  );
});

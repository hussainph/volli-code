import { describe, expect, it } from "vite-plus/test";

import {
  ACTIVITY_METADATA_KEY,
  type RuntimeObservation,
  type SessionInteraction,
} from "@volli/shared";

import {
  RuntimeObservationTranslator,
  sessionMainBranchId,
  sessionRootThreadId,
  type TranslatedObservation,
} from "./observation-translation";

const NAMESPACE = "pi";
const SESSION_ID = "session-1";
const ATTACHMENT_ID = "attachment-1";

class Recorder {
  readonly observations: TranslatedObservation[] = [];
  #nextFailure: Error | null = null;

  /** The next durable write refuses, as a rejected ledger write does. */
  failNext(): void {
    this.#nextFailure = new Error("sink unavailable");
  }

  readonly emit = async (observation: TranslatedObservation): Promise<void> => {
    const failure = this.#nextFailure;
    this.#nextFailure = null;
    if (failure !== null) throw failure;
    this.observations.push(observation);
  };

  kinds(): string[] {
    return this.observations.map((observation) => observation.kind);
  }

  of<Kind extends TranslatedObservation["kind"]>(
    kind: Kind,
  ): Extract<TranslatedObservation, { kind: Kind }>[] {
    return this.observations.filter(
      (observation): observation is Extract<TranslatedObservation, { kind: Kind }> =>
        observation.kind === kind,
    );
  }
}

/** A clock that never repeats, so a durable `occurredAt` names which emission it was. */
function tickingTranslator(): RuntimeObservationTranslator {
  let clock = 1_000;
  return new RuntimeObservationTranslator({
    namespace: NAMESPACE,
    sessionId: SESSION_ID,
    attachmentId: ATTACHMENT_ID,
    now: () => clock++,
  });
}

function fixedTranslator(): RuntimeObservationTranslator {
  return new RuntimeObservationTranslator({
    namespace: NAMESPACE,
    sessionId: SESSION_ID,
    attachmentId: ATTACHMENT_ID,
    now: () => 1_000,
  });
}

function composition(): { translate: (o: RuntimeObservation) => Promise<void>; sink: Recorder } {
  const translator = tickingTranslator();
  const sink = new Recorder();
  return { translate: (observation) => translator.translate(observation, sink.emit), sink };
}

function activity(overrides: Partial<Extract<RuntimeObservation, { kind: "activity" }>> = {}) {
  return {
    kind: "activity",
    turnId: "turn-1",
    activityId: "call-7",
    state: "started",
    descriptor: {
      kind: "run-command",
      nativeToolName: "bash",
      subject: { label: "vp test", path: null, lineRange: null },
      outcome: null,
      startedAt: 10,
      endedAt: null,
    },
    input: { command: "vp test" },
    output: null,
    ...overrides,
  } as Extract<RuntimeObservation, { kind: "activity" }>;
}

const permission: Omit<SessionInteraction, "attachmentId"> = {
  id: "permission-1",
  kind: "permission",
  title: "Write file",
  detail: null,
  options: [{ id: "allow", label: "Allow", description: null }],
  multiple: false,
  native: { id: "native-permission-1", detail: null },
};

describe("Session transcript addressing", () => {
  it("derives one root Thread and main Branch per Session", () => {
    expect(sessionRootThreadId(SESSION_ID)).toBe("thread:session-1:root");
    expect(sessionMainBranchId(SESSION_ID)).toBe("branch:session-1:main");
  });
});

describe("live observation translation", () => {
  it("opens and closes a turn", async () => {
    const { translate, sink } = composition();

    await translate({ kind: "turn", state: "started", turnId: "turn-1" });
    await translate({ kind: "turn", state: "completed", turnId: "turn-1" });

    expect(sink.observations).toEqual([
      { id: "pi:turn:turn-1:started", kind: "turn.started", occurredAt: 1000, turnId: "turn-1" },
      {
        id: "pi:turn:turn-1:completed",
        kind: "turn.completed",
        occurredAt: 1001,
        turnId: "turn-1",
      },
    ]);
  });

  it("records an interrupted turn without pretending it completed", async () => {
    const { translate, sink } = composition();

    await translate({ kind: "turn", state: "interrupted", turnId: "turn-1" });

    expect(sink.kinds()).toEqual(["turn.interrupted"]);
    expect(sink.observations[0].id).toBe("pi:turn:turn-1:interrupted");
  });

  it("opens a streamed message with a reset and grows it with appends", async () => {
    const { translate, sink } = composition();

    await translate({ kind: "turn", state: "started", turnId: "turn-1" });
    await translate({ kind: "delta", turnId: "turn-1", channel: "text", text: "He" });
    await translate({ kind: "delta", turnId: "turn-1", channel: "text", text: "llo" });

    const deltas = sink.of("transcript.delta");
    const messageId = `pi:${ATTACHMENT_ID}:turn-1:0`;
    expect(deltas.map((delta) => delta.messageId)).toEqual([messageId, messageId, messageId]);
    expect(deltas.map((delta) => delta.delta)).toEqual([
      { op: "reset", message: { id: messageId, role: "assistant", parts: [] } },
      {
        op: "part.upsert",
        key: "text",
        index: 0,
        part: { type: "text", text: "He", state: "streaming" },
      },
      { op: "part.append", key: "text", text: "llo" },
    ]);
    expect(deltas.map((delta) => delta.id)).toEqual([
      `pi:delta:${ATTACHMENT_ID}:1`,
      `pi:delta:${ATTACHMENT_ID}:2`,
      `pi:delta:${ATTACHMENT_ID}:3`,
    ]);
    expect(deltas[0].threadId).toBe(sessionRootThreadId(SESSION_ID));
    expect(deltas[0].branchId).toBe(sessionMainBranchId(SESSION_ID));
    expect(deltas[0].attemptId).toBe(`attempt:${messageId}`);
    expect(deltas[0].turnId).toBeNull();
  });

  it("carries a reasoning delta as the overlay's own reasoning part, ahead of the text", async () => {
    const { translate, sink } = composition();

    await translate({ kind: "turn", state: "started", turnId: "turn-1" });
    await translate({ kind: "delta", turnId: "turn-1", channel: "reasoning", text: "think" });
    await translate({ kind: "delta", turnId: "turn-1", channel: "reasoning", text: "ing" });
    await translate({ kind: "delta", turnId: "turn-1", channel: "text", text: "done" });

    expect(sink.of("transcript.delta").map((delta) => delta.delta)).toEqual([
      {
        op: "reset",
        message: { id: `pi:${ATTACHMENT_ID}:turn-1:0`, role: "assistant", parts: [] },
      },
      {
        op: "part.upsert",
        key: "reasoning",
        index: 0,
        part: { type: "reasoning", text: "think", state: "streaming" },
      },
      { op: "part.append", key: "reasoning", text: "ing" },
      {
        op: "part.upsert",
        key: "text",
        index: 1,
        part: { type: "text", text: "done", state: "streaming" },
      },
    ]);
  });

  it("projects execute lifecycle into a generic stamped tool and durable result", async () => {
    const { translate, sink } = composition();

    await translate({ kind: "turn", state: "started", turnId: "turn-1" });
    await translate({ kind: "delta", turnId: "turn-1", channel: "reasoning", text: "checking" });
    await translate(activity({ state: "started" }));
    await translate(activity({ state: "progress", output: { content: "partial" } }));
    await translate(
      activity({
        state: "completed",
        descriptor: {
          kind: "run-command",
          nativeToolName: "bash",
          subject: { label: "vp test", path: null, lineRange: null },
          outcome: {
            exitCode: 0,
            matchCount: null,
            fileCount: null,
            lineCount: 1,
            bytes: 7,
            addedLines: null,
            removedLines: null,
            diff: null,
            summary: "partial",
          },
          startedAt: 10,
          endedAt: 20,
        },
        output: { content: "complete" },
      }),
    );
    await translate({ kind: "delta", turnId: "turn-1", channel: "text", text: "Done." });

    const activityMessageId = `pi:${ATTACHMENT_ID}:turn-1:activity:call-7`;
    const activityDeltas = sink
      .of("transcript.delta")
      .filter((observation) => observation.messageId === activityMessageId);
    expect(activityDeltas.map((observation) => observation.delta)).toEqual([
      { op: "reset", message: { id: activityMessageId, role: "assistant", parts: [] } },
      expect.objectContaining({
        op: "part.upsert",
        key: "activity:call-7",
        index: 0,
        part: expect.objectContaining({
          type: "dynamic-tool",
          toolName: "volli.activity",
          toolCallId: "call-7",
          state: "input-available",
          input: { command: "vp test" },
        }),
      }),
      expect.objectContaining({
        op: "part.upsert",
        key: "activity:call-7",
        index: 0,
        part: expect.objectContaining({
          type: "dynamic-tool",
          toolName: "volli.activity",
          toolCallId: "call-7",
          state: "output-available",
          input: { command: "vp test" },
          output: { content: "partial" },
          preliminary: true,
        }),
      }),
    ]);

    const [settled] = sink.of("transcript.message");
    expect(settled).toMatchObject({
      id: `pi:activity:${ATTACHMENT_ID}:turn-1:call-7:completed`,
      threadId: sessionRootThreadId(SESSION_ID),
      branchId: sessionMainBranchId(SESSION_ID),
      attemptId: `attempt:${activityMessageId}`,
      turnId: "turn-1",
      message: {
        id: activityMessageId,
        role: "assistant",
        parts: [
          {
            type: "dynamic-tool",
            toolName: "volli.activity",
            toolCallId: "call-7",
            state: "output-available",
            input: { command: "vp test" },
            output: { content: "complete" },
            toolMetadata: {
              [ACTIVITY_METADATA_KEY]: expect.objectContaining({
                kind: "run-command",
                nativeToolName: "bash",
              }),
            },
          },
        ],
      },
    });
    expect(settled.cursor).toBeUndefined();
    expect(
      sink.of("transcript.delta").map((observation) => [observation.messageId, observation.delta]),
    ).toContainEqual([
      `pi:${ATTACHMENT_ID}:turn-1:0`,
      {
        op: "part.upsert",
        key: "text",
        index: 1,
        part: { type: "text", text: "Done.", state: "streaming" },
      },
    ]);
  });

  it("settles failed activity as a durable generic tool error", async () => {
    const { translate, sink } = composition();

    await translate({
      kind: "activity",
      turnId: "turn-1",
      activityId: "call-8",
      state: "failed",
      descriptor: {
        kind: "other",
        nativeToolName: "custom_reader",
        subject: { label: "config", path: null, lineRange: null },
        outcome: null,
        startedAt: 10,
        endedAt: 20,
      },
      input: { file: "config" },
      output: { message: "denied" },
      error: "The file could not be read.",
    });

    const [settled] = sink.of("transcript.message");
    expect(settled.id).toBe(`pi:activity:${ATTACHMENT_ID}:turn-1:call-8:failed`);
    expect(settled.cursor).toBeUndefined();
    expect(settled.message).toEqual({
      id: `pi:${ATTACHMENT_ID}:turn-1:activity:call-8`,
      role: "assistant",
      parts: [
        {
          type: "dynamic-tool",
          toolName: "volli.activity",
          toolCallId: "call-8",
          state: "output-error",
          input: { file: "config" },
          errorText: "The file could not be read.",
          toolMetadata: {
            [ACTIVITY_METADATA_KEY]: {
              kind: "other",
              nativeToolName: "custom_reader",
              subject: { label: "config", path: null, lineRange: null },
              outcome: null,
              startedAt: 10,
              endedAt: 20,
            },
          },
        },
      ],
    });
  });

  it("names a failed activity that reported no error at all", async () => {
    const { translate, sink } = composition();

    await translate(activity({ state: "failed", activityId: "call-silent" }));

    expect(sink.of("transcript.message")[0].message.parts).toEqual([
      expect.objectContaining({ state: "output-error", errorText: "Activity failed." }),
    ]);
  });

  it("withdraws activity overlays a completed or interrupted turn cannot settle", async () => {
    const { translate, sink } = composition();

    await translate({ kind: "turn", state: "started", turnId: "turn-1" });
    await translate(activity({ activityId: "call-active" }));
    await translate({ kind: "turn", state: "interrupted", turnId: "turn-1" });
    await translate({ kind: "turn", state: "started", turnId: "turn-2" });
    await translate(activity({ turnId: "turn-2", activityId: "call-complete" }));
    await translate({ kind: "turn", state: "completed", turnId: "turn-2" });

    expect(sink.of("transcript.message")).toEqual([]);
    expect(
      sink
        .of("transcript.delta")
        .filter((observation) => observation.delta.op === "message.remove")
        .map((observation) => observation.messageId),
    ).toEqual([
      `pi:${ATTACHMENT_ID}:turn-1:activity:call-active`,
      `pi:${ATTACHMENT_ID}:turn-2:activity:call-complete`,
    ]);
  });

  it("keeps an activity overlay tracked until its reset, settlement, or removal reaches the Session", async () => {
    const { translate, sink } = composition();
    const started = activity({ activityId: "call-retry" });

    sink.failNext();
    await expect(translate(started)).rejects.toThrow("sink unavailable");
    await translate(started);

    const activityMessageId = `pi:${ATTACHMENT_ID}:turn-1:activity:call-retry`;
    expect(sink.of("transcript.delta").map((observation) => observation.delta.op)).toEqual([
      "reset",
      "part.upsert",
    ]);

    sink.failNext();
    await expect(
      translate(activity({ activityId: "call-retry", state: "completed" })),
    ).rejects.toThrow("sink unavailable");
    await translate({ kind: "turn", state: "completed", turnId: "turn-1" });

    expect(sink.of("transcript.delta").at(-1)).toMatchObject({
      messageId: activityMessageId,
      delta: { op: "message.remove" },
    });
  });

  it("retries a failed closed-turn activity removal on the next turn without repeating it", async () => {
    const { translate, sink } = composition();
    const activityMessageId = `pi:${ATTACHMENT_ID}:turn-1:activity:call-retry-later`;

    await translate({ kind: "turn", state: "started", turnId: "turn-1" });
    await translate(activity({ activityId: "call-retry-later" }));

    sink.failNext();
    await expect(translate({ kind: "turn", state: "completed", turnId: "turn-1" })).rejects.toThrow(
      "sink unavailable",
    );

    await translate({ kind: "turn", state: "started", turnId: "turn-2" });
    await translate({ kind: "turn", state: "started", turnId: "turn-3" });

    expect(
      sink
        .of("transcript.delta")
        .filter((observation) => observation.delta.op === "message.remove")
        .map((observation) => observation.messageId),
    ).toEqual([activityMessageId]);
  });

  it("retires the provisional overlay before settling under the stable entry id", async () => {
    const { translate, sink } = composition();

    await translate({ kind: "turn", state: "started", turnId: "turn-1" });
    await translate({ kind: "delta", turnId: "turn-1", channel: "text", text: "Hello" });
    await translate({
      kind: "message-settled",
      turnId: "turn-1",
      message: {
        entryId: "entry-7",
        role: "assistant",
        text: "Hello",
        reasoning: "thinking",
        model: { providerId: "openai-codex", modelId: "gpt-5.6-terra" },
        usage: { inputTokens: 11, outputTokens: 3, costUsd: 0.5 },
      },
      occurredAt: 42,
      recoveryCursor: "marker-7",
    });

    const [settled] = sink.of("transcript.message");
    const provisionalId = `pi:${ATTACHMENT_ID}:turn-1:0`;
    const messageId = `pi:${ATTACHMENT_ID}:entry:entry-7`;
    expect(settled.id).toBe("pi:message:entry-7");
    expect(settled.message.id).toBe(messageId);
    expect(sink.of("transcript.delta").at(-1)).toMatchObject({
      messageId: provisionalId,
      delta: { op: "message.remove" },
    });
    expect(settled.threadId).toBe(sessionRootThreadId(SESSION_ID));
    expect(settled.branchId).toBe(sessionMainBranchId(SESSION_ID));
    expect(settled.attemptId).toBe(`attempt:${messageId}`);
    expect(settled.turnId).toBe("turn-1");
    expect(settled.occurredAt).toBe(42);
    expect(settled.cursor).toEqual({ entryId: "marker-7" });
    expect(settled.message.parts).toEqual([
      { type: "reasoning", text: "thinking", state: "done" },
      { type: "text", text: "Hello", state: "done" },
    ]);
    expect(settled.message.metadata).toEqual({
      providerId: "openai-codex",
      modelId: "gpt-5.6-terra",
      cost: 0.5,
      tokens: { input: 11, output: 3, reasoning: null, cacheRead: null, cacheWrite: null },
    });
  });

  it("gives each message of a turn its own id, and starts over on the next turn", async () => {
    const { translate, sink } = composition();

    await translate({ kind: "turn", state: "started", turnId: "turn-1" });
    await translate({ kind: "delta", turnId: "turn-1", channel: "text", text: "one" });
    await translate({
      kind: "message-settled",
      turnId: "turn-1",
      message: { entryId: "entry-1", role: "assistant", text: "one" },
    });
    await translate({ kind: "delta", turnId: "turn-1", channel: "text", text: "two" });
    await translate({
      kind: "message-settled",
      turnId: "turn-1",
      message: { entryId: "entry-2", role: "assistant", text: "two" },
    });
    await translate({ kind: "turn", state: "started", turnId: "turn-2" });
    await translate({
      kind: "message-settled",
      turnId: "turn-2",
      message: { entryId: "entry-3", role: "assistant", text: "three" },
    });

    expect(sink.of("transcript.message").map((message) => message.message.id)).toEqual([
      `pi:${ATTACHMENT_ID}:entry:entry-1`,
      `pi:${ATTACHMENT_ID}:entry:entry-2`,
      `pi:${ATTACHMENT_ID}:entry:entry-3`,
    ]);
    expect(
      sink
        .of("transcript.delta")
        .filter((delta) => delta.delta.op === "reset")
        .map((delta) => delta.messageId),
    ).toEqual([`pi:${ATTACHMENT_ID}:turn-1:0`, `pi:${ATTACHMENT_ID}:turn-1:1`]);
  });

  it("omits metadata a settled message has nothing to say about", async () => {
    const { translate, sink } = composition();

    await translate({
      kind: "message-settled",
      turnId: "turn-1",
      message: { entryId: "entry-1", role: "assistant", text: "bare", reasoning: "" },
    });

    const [settled] = sink.of("transcript.message");
    expect(settled.message.metadata).toBeUndefined();
    expect(settled.message.parts).toEqual([{ type: "text", text: "bare", state: "done" }]);
  });

  it("tells a cost with no token counts from token counts with no cost", async () => {
    const { translate, sink } = composition();

    await translate({
      kind: "message-settled",
      turnId: "turn-1",
      message: { entryId: "cost-only", role: "assistant", text: "a", usage: { costUsd: 0.25 } },
    });
    await translate({
      kind: "message-settled",
      turnId: "turn-1",
      message: { entryId: "input-only", role: "assistant", text: "b", usage: { inputTokens: 4 } },
    });
    await translate({
      kind: "message-settled",
      turnId: "turn-1",
      message: { entryId: "output-only", role: "assistant", text: "d", usage: { outputTokens: 6 } },
    });
    await translate({
      kind: "message-settled",
      turnId: "turn-1",
      message: {
        entryId: "model-only",
        role: "assistant",
        text: "c",
        model: { providerId: "openai-codex", modelId: "gpt-5.6-sol" },
      },
    });

    expect(sink.of("transcript.message").map((settled) => settled.message.metadata)).toEqual([
      { providerId: null, modelId: null, cost: 0.25, tokens: null },
      {
        providerId: null,
        modelId: null,
        cost: null,
        tokens: { input: 4, output: null, reasoning: null, cacheRead: null, cacheWrite: null },
      },
      {
        providerId: null,
        modelId: null,
        cost: null,
        tokens: { input: null, output: 6, reasoning: null, cacheRead: null, cacheWrite: null },
      },
      { providerId: "openai-codex", modelId: "gpt-5.6-sol", cost: null, tokens: null },
    ]);
  });

  it("withdraws a transient claim a settled message has nothing durable to replace", async () => {
    const { translate, sink } = composition();

    await translate({ kind: "delta", turnId: "turn-1", channel: "text", text: "..." });
    await translate({
      kind: "message-settled",
      turnId: "turn-1",
      message: { entryId: "entry-1", role: "assistant", text: "" },
    });

    expect(sink.of("transcript.message")).toEqual([]);
    expect(sink.of("transcript.delta").at(-1)?.delta).toEqual({ op: "message.remove" });
  });

  it("settles a message no overlay ever claimed without withdrawing anything", async () => {
    const { translate, sink } = composition();

    await translate({
      kind: "message-settled",
      turnId: "turn-1",
      message: { entryId: "entry-1", role: "assistant", text: "" },
    });

    expect(sink.observations).toEqual([]);
  });

  it("withdraws an in-flight message no turn is left to finish", async () => {
    const { translate, sink } = composition();

    await translate({ kind: "turn", state: "started", turnId: "turn-1" });
    await translate({ kind: "delta", turnId: "turn-1", channel: "text", text: "half" });
    await translate({ kind: "turn", state: "interrupted", turnId: "turn-1" });

    expect(sink.kinds()).toEqual([
      "turn.started",
      "transcript.delta",
      "transcript.delta",
      "transcript.delta",
      "turn.interrupted",
    ]);
    expect(sink.of("transcript.delta").at(-1)?.delta).toEqual({ op: "message.remove" });
  });

  it("raises and clears attention under one id per reason", async () => {
    const { translate, sink } = composition();

    await translate({
      kind: "attention",
      state: "raised",
      reason: "auth",
      message: "Log in to openai-codex to continue.",
    });
    await translate({ kind: "attention", state: "cleared", reason: "auth", message: "" });

    const attentionId = `pi:attention:${ATTACHMENT_ID}:auth`;
    const raised = sink.of("attention.raised")[0];
    expect(raised.id).toBe(`${attentionId}:raised:live:1`);
    // Exhaustive, not partial: the Attention this raises is the whole of what
    // the projection pairs with its clearance, so a field appearing here that
    // nobody asked for is the failure this pins.
    expect(raised.attention).toEqual({
      id: attentionId,
      kind: "auth_required",
      detail: "Log in to openai-codex to continue.",
      diagnostic: null,
    });
    expect(sink.of("attention.cleared")[0]).toMatchObject({
      id: `${attentionId}:cleared:live:2`,
      attentionId,
    });
    expect(raised.cursor).toBeUndefined();
  });

  it("identifies a recoverable attention by its marker rather than by a live counter", async () => {
    const { translate, sink } = composition();

    await translate({
      kind: "attention",
      state: "raised",
      reason: "context",
      message: "over",
      recoveryCursor: "marker-9",
      occurredAt: 77,
    });
    await translate({
      kind: "attention",
      state: "cleared",
      reason: "context",
      message: "",
      recoveryCursor: "marker-10",
    });

    const attentionId = `pi:attention:${ATTACHMENT_ID}:context`;
    expect(sink.observations.map(({ id }) => id)).toEqual([
      `${attentionId}:raised:marker-9`,
      `${attentionId}:cleared:marker-10`,
    ]);
    expect(sink.of("attention.raised")[0]).toMatchObject({
      cursor: { entryId: "marker-9" },
      occurredAt: 77,
    });
    expect(sink.of("attention.cleared")[0].cursor).toEqual({ entryId: "marker-10" });
  });

  it("maps every runtime attention reason onto product vocabulary", async () => {
    const { translate, sink } = composition();

    for (const reason of [
      "auth",
      "configuration",
      "context",
      "runtime-failure",
      "partial-turn",
    ] as const) {
      await translate({ kind: "attention", state: "raised", reason, message: reason });
    }

    expect(sink.of("attention.raised").map((raised) => raised.attention.kind)).toEqual([
      "auth_required",
      "configuration_invalid",
      "context_limit_reached",
      "adapter_unrecoverable",
      "partial_turn_interrupted",
    ]);
  });

  it("records a runtime failure that lands after the attachment opened", async () => {
    const { translate, sink } = composition();

    await translate({
      kind: "attachment",
      state: "failed",
      failure: { reason: "model", message: "Model is unavailable." },
    });

    expect(sink.of("attachment.failed")[0]).toEqual({
      id: `pi:attachment:${ATTACHMENT_ID}:failed:1`,
      kind: "attachment.failed",
      occurredAt: 1000,
      detail: "Model is unavailable.",
    });
  });

  it("records a failure that named no reason at all", async () => {
    const { translate, sink } = composition();

    await translate({ kind: "attachment", state: "failed" });

    expect(sink.of("attachment.failed")[0].detail).toBeNull();
  });

  it("records a close the Session did not ask for", async () => {
    const { translate, sink } = composition();

    await translate({ kind: "attachment", state: "closed" });

    expect(sink.of("attachment.closed")[0]).toEqual({
      id: `pi:attachment:${ATTACHMENT_ID}:closed`,
      kind: "attachment.closed",
      occurredAt: 1000,
      outcome: "completed",
    });
  });

  it("says nothing about an attachment opening or recovering, which the Engine records itself", async () => {
    const { translate, sink } = composition();

    await translate({ kind: "attachment", state: "started" });
    await translate({ kind: "attachment", state: "recovered" });

    expect(sink.observations).toEqual([]);
  });

  it("translates a denied authority observation into a durable authority.denied fact", async () => {
    const { translate, sink } = composition();

    await translate({
      kind: "authority",
      state: "denied",
      turnId: "turn-1",
      tool: "bash",
      cause: "command.destructive-removal",
      reason: "rm -rf ~ discards more than this Session's workspace.",
    });

    expect(sink.of("authority.denied")).toEqual([
      {
        id: `pi:authority:${ATTACHMENT_ID}:1`,
        kind: "authority.denied",
        occurredAt: 1000,
        turnId: "turn-1",
        tool: "bash",
        cause: "command.destructive-removal",
        reason: "rm -rf ~ discards more than this Session's workspace.",
      },
    ]);
  });

  it("carries a refusal reported before any turn has opened with a null turnId", async () => {
    const { translate, sink } = composition();

    await translate({
      kind: "authority",
      state: "denied",
      turnId: null,
      tool: "read",
      cause: "path.outside-workspace",
      reason: "refused",
      occurredAt: 55,
    });

    expect(sink.of("authority.denied")[0]).toMatchObject({ turnId: null, occurredAt: 55 });
  });

  it("names an interaction by the ask rather than by a counter", async () => {
    const { translate, sink } = composition();

    await translate({ kind: "interaction", state: "opened", interaction: permission });
    await translate({
      kind: "interaction",
      state: "resolved",
      interactionId: "permission-1",
      resolution: { optionIds: ["allow"], response: null },
    });

    expect(sink.observations).toEqual([
      {
        id: `pi:interaction:${ATTACHMENT_ID}:permission-1:opened`,
        kind: "interaction.opened",
        occurredAt: 1000,
        interaction: permission,
      },
      {
        id: `pi:interaction:${ATTACHMENT_ID}:permission-1:resolved`,
        kind: "interaction.resolved",
        occurredAt: 1001,
        interactionId: "permission-1",
        resolution: { optionIds: ["allow"], response: null },
      },
    ]);
  });
});

describe("cold replay translation", () => {
  it("maps a cold replay to byte-stable durable Session observations", async () => {
    const translator = tickingTranslator();
    const sink = new Recorder();
    const durable: RuntimeObservation[] = [
      {
        kind: "turn",
        state: "started",
        turnId: "turn-1",
        occurredAt: 101,
        recoveryCursor: "marker-1",
      },
      {
        kind: "message-settled",
        turnId: "turn-1",
        message: { entryId: "message-1", role: "assistant", text: "Remember me" },
        occurredAt: 102,
        recoveryCursor: "marker-2",
      },
      {
        kind: "activity",
        state: "completed",
        turnId: "turn-1",
        activityId: "tool-1",
        descriptor: {
          kind: "read-file",
          nativeToolName: "read",
          subject: { label: "README.md", path: "README.md", lineRange: null },
          outcome: null,
          startedAt: 90,
          endedAt: 100,
        },
        input: { path: "README.md" },
        output: "contents",
        occurredAt: 103,
        recoveryCursor: "marker-3",
      },
      {
        kind: "attention",
        state: "raised",
        reason: "partial-turn",
        message: "The turn stopped early.",
        occurredAt: 104,
        recoveryCursor: "marker-4",
      },
      {
        kind: "interaction",
        state: "opened",
        interaction: permission,
        occurredAt: 105,
      },
      {
        kind: "turn",
        state: "completed",
        turnId: "turn-1",
        occurredAt: 106,
        recoveryCursor: "marker-5",
      },
    ];
    for (const observation of durable) await translator.translate(observation, sink.emit);
    const live = [...sink.observations];

    // A fresh translator, because that is the only shape the guarantee is
    // about: a relaunch rehydrates an attachment and reconciles it from a null
    // cursor, and nothing of the first run's translation survives that. Replaying
    // through the instance that did the live pass would prove only that the same
    // counters give the same answers twice.
    const relaunched = tickingTranslator();
    const replayed = durable.flatMap((observation) => relaunched.replay(observation));

    expect(replayed).toEqual(live);
  });

  it("cannot re-mint a cursorless attention's id after a relaunch, and nothing mints one", async () => {
    const sink = new Recorder();
    const live = tickingTranslator();
    // A cursorless attention is identified by a counter the whole translation
    // shares, so what precedes it decides its number — and a delta is what
    // precedes it in any real turn.
    await live.translate(
      { kind: "delta", turnId: "turn-1", channel: "text", text: "Working" },
      sink.emit,
    );
    const attention: RuntimeObservation = {
      kind: "attention",
      state: "raised",
      reason: "auth",
      message: "Log in to openai-codex to continue.",
      occurredAt: 200,
    };
    await live.translate(attention, sink.emit);

    // Replay drops deltas, so the counter a relaunch starts from is not the one
    // the live pass reached, and the id does not survive.
    const [replayed] = tickingTranslator().replay(attention);
    expect(sink.of("attention.raised")[0].id).toBe(
      `pi:attention:${ATTACHMENT_ID}:auth:raised:live:3`,
    );
    expect(replayed).toMatchObject({ id: `pi:attention:${ATTACHMENT_ID}:auth:raised:live:1` });

    // Contained rather than fixed: the runtime stamps every attention marker
    // with its recovery cursor, so this arm has no producer and no replay ever
    // offers one back. See `RuntimeObservationTranslator`'s `#sequence`.
  });

  it("replays nothing a Session either already knows or must not reopen", () => {
    const translator = fixedTranslator();
    const ignored: RuntimeObservation[] = [
      { kind: "attachment", state: "closed" },
      { kind: "delta", turnId: "turn-1", channel: "text", text: "late" },
      {
        kind: "authority",
        state: "denied",
        turnId: "turn-1",
        tool: "bash",
        cause: "command.destructive-removal",
        reason: "refused",
      },
      activity({ state: "started" }),
      activity({ state: "progress", output: { content: "partial" } }),
      {
        kind: "message-settled",
        turnId: "turn-1",
        message: { entryId: "empty", role: "assistant", text: "" },
      },
    ];

    expect(ignored.flatMap((observation) => translator.replay(observation))).toEqual([]);
  });

  it("replays an interaction the executor is still waiting on", () => {
    expect(
      fixedTranslator().replay({ kind: "interaction", state: "opened", interaction: permission }),
    ).toEqual([
      {
        id: `pi:interaction:${ATTACHMENT_ID}:permission-1:opened`,
        kind: "interaction.opened",
        occurredAt: 1_000,
        interaction: permission,
      },
    ]);
  });

  /**
   * The reason the two paths are separate at all. `reconcile` is not gated on
   * the binding being idle, so a replayed `turn.started` reaching the live path
   * would zero the message counter mid-turn and re-mint an id the message the
   * user is watching already holds.
   */
  it("leaves a streaming message alone when a turn replays underneath it", async () => {
    const translator = fixedTranslator();
    const sink = new Recorder();

    await translator.translate({ kind: "turn", state: "started", turnId: "turn-1" }, sink.emit);
    await translator.translate(
      { kind: "delta", turnId: "turn-1", channel: "text", text: "half" },
      sink.emit,
    );
    translator.replay({ kind: "turn", state: "started", turnId: "turn-1" });
    await translator.translate(
      { kind: "delta", turnId: "turn-1", channel: "text", text: " written" },
      sink.emit,
    );

    expect(sink.of("transcript.delta").map((delta) => [delta.messageId, delta.delta.op])).toEqual([
      [`pi:${ATTACHMENT_ID}:turn-1:0`, "reset"],
      [`pi:${ATTACHMENT_ID}:turn-1:0`, "part.upsert"],
      [`pi:${ATTACHMENT_ID}:turn-1:0`, "part.append"],
    ]);
  });
});

import { describe, expect, test } from "vite-plus/test";

import {
  SESSION_PROJECTION_CHECKPOINT_VERSION,
  projectSession,
  type Session,
  type SessionAttachment,
  type SessionEventPayload,
  type SessionProjection,
  type SessionProjectionEvent,
} from "../session-ledger";
import {
  CLOUD_SESSION_FOLD_VERSION,
  CLOUD_SESSION_STATE_MAX_BYTES,
  CloudSessionStateTooLargeError,
  cloudSessionView,
  foldCloudSessionState,
  readCloudSessionState,
  type CloudSessionState,
  type CloudSessionView,
} from "./session-state";

const CLOUD_SESSION_ACTIVE_LIMIT = 32;

const cloudSessionStateBytes = (state: CloudSessionState) =>
  new TextEncoder().encode(JSON.stringify(state)).length;

const SESSION: Session = {
  id: "11111111-1111-4111-8111-111111111111",
  projectId: "22222222-2222-4222-8222-222222222222",
  ticketId: null,
  role: "project",
  parentSessionId: null,
  title: "Fold",
  createdAt: 100,
};

const provenance = {
  source: { kind: "system", id: "test", detail: { sessionOrigin: { kind: "user" } } },
  venue: { id: "local", kind: "local" },
} as const;

/** A log builder: each payload becomes the next event, one millisecond apart. */
function log(payloads: readonly (SessionEventPayload & { commandId?: string })[], start = 1) {
  return payloads.map(({ commandId, ...payload }, index): SessionProjectionEvent => {
    const sequence = start + index;
    return {
      id: `event-${sequence}`,
      sessionId: SESSION.id,
      sequence,
      occurredAt: 1_000 + sequence,
      recordedAt: 1_000 + sequence,
      provenance,
      ...(commandId === undefined ? {} : { commandId }),
      payload: payload as SessionEventPayload,
    };
  });
}

function attachment(id: string): SessionAttachment {
  return {
    id,
    sessionId: SESSION.id,
    adapterId: "pi",
    venue: { id: "local", kind: "local" },
    continuity: "fresh",
    native: null,
    authority: null,
  };
}

function command(id: string, intent: Record<string, unknown>) {
  return {
    kind: "command.recorded" as const,
    commandId: id,
    command: {
      id,
      sessionId: SESSION.id,
      createdAt: 1,
      intent: intent as never,
      route: null,
    },
  };
}

function attention(id: string, detail: string | null = null) {
  return {
    kind: "attention.raised" as const,
    attention: {
      id,
      kind: "input_required" as const,
      attachmentId: "attachment-1",
      detail,
      diagnostic: null,
    },
  };
}

function interaction(id: string) {
  return {
    kind: "interaction.opened" as const,
    interaction: {
      id,
      attachmentId: "attachment-1",
      kind: "question" as const,
      title: "Which?",
      detail: null,
      options: [],
      multiple: false,
      native: { adapterId: "pi", id: null },
    } as never,
  };
}

/** A Session's life with every kind the cloud view reads. */
const RICH: SessionEventPayload[] = [
  { kind: "session.created", session: SESSION },
  {
    kind: "model.selected",
    selection: { providerId: "anthropic", modelId: "opus", reasoningLevel: "high" },
    tier: "deep",
  },
  command("start-1", { kind: "executor.start", adapterId: "pi", continuity: "fresh" }),
  {
    kind: "attachment.opened",
    attachment: attachment("attachment-1"),
    commandId: "start-1",
  } as never,
  command("submit-1", { kind: "message.submit", text: "hi" }),
  { kind: "turn.started", attachmentId: "attachment-1", turnId: "turn-1" },
  {
    kind: "transcript.referenced",
    attachmentId: "attachment-1",
    turnId: "turn-1",
    reference: { id: "sha256:aa", mediaType: "application/json", digest: null },
    digest: { role: "assistant", reply: true, todoList: [{ text: "plan", status: "pending" }] },
  } as never,
  attention("attention-1", "Answer me"),
  interaction("interaction-1"),
  {
    kind: "usage.recorded",
    attachmentId: "attachment-1",
    turnId: "turn-1",
    attribution: { projectId: SESSION.projectId, ticketId: null },
    usage: {
      cause: "assistant",
      providerId: "anthropic",
      modelId: "opus",
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd: 0.01,
      costBasis: "catalog-estimate",
    },
  },
  {
    kind: "interaction.resolved",
    attachmentId: "attachment-1",
    interactionId: "interaction-1",
    resolution: { optionId: "yes" } as never,
  },
  { kind: "attention.cleared", attentionId: "attention-1" },
  { kind: "turn.completed", attachmentId: "attachment-1", turnId: "turn-1" },
  { kind: "attachment.closed", attachmentId: "attachment-1", outcome: "completed" },
  { kind: "attachment.exited", attachmentId: "attachment-1", exitCode: 0 },
  { kind: "session.signaled", signal: "blocked", reason: "Need a key" },
  { kind: "session.stopped", reason: "Enough", by: { kind: "user" } },
  command("start-2", { kind: "executor.start", adapterId: "pi", continuity: "resume" }),
  {
    kind: "attachment.opened",
    attachment: attachment("attachment-2"),
    commandId: "start-2",
  } as never,
  command("submit-2", { kind: "message.submit", text: "again" }),
  { kind: "turn.started", attachmentId: "attachment-2", turnId: "turn-2" },
  {
    kind: "turn.interrupted",
    attachmentId: "attachment-2",
    turnId: "turn-2",
    stopDetail: {
      category: "rate_limited",
      message: null,
      providerType: null,
      httpStatus: 429,
      retry: "exhausted",
      resetsAt: null,
    },
  } as never,
  { kind: "session.retitled", title: "Renamed" },
  { kind: "session.archived" },
];

/** The fields the cloud view shares with the local projection, read off the projection. */
function sharedFields(projection: SessionProjection): Omit<
  CloudSessionView,
  "attention" | "interactions" | "throughSequence" | "truncated"
> & {
  attention: unknown;
  interactions: unknown;
} {
  return {
    session: projection.session,
    status: projection.status,
    latestTurnId: projection.latestTurnId,
    latestTurnOrigin: projection.latestTurnOrigin,
    turnActive: projection.turnActive,
    lastTurnOutcome: projection.lastTurnOutcome,
    lastTurnStopDetail: projection.lastTurnStopDetail ?? null,
    // The cloud fold keeps no adapter-native detail; compare it scrubbed.
    liveAttachment:
      projection.liveExecutor === null
        ? null
        : {
            ...projection.liveExecutor,
            native: null,
            failure:
              projection.liveExecutor.failure === null
                ? null
                : { ...projection.liveExecutor.failure, diagnostic: null },
          },
    pendingExecutorStartId: projection.pendingExecutorStart?.id ?? null,
    attention: {
      active: projection.attention.active.map((item) => ({ ...item, diagnostic: null })),
      primary:
        projection.attention.primary === null
          ? null
          : { ...projection.attention.primary, diagnostic: null },
    },
    interactions: {
      active: projection.interactions.active.map((item) => ({
        ...item,
        native: { id: null, detail: null },
      })),
    },
    needsUser:
      projection.interactions.active.length > 0 ||
      projection.attention.active.some(({ kind }) => kind === "input_required"),
    signal: projection.signal,
    stopped: projection.stopped,
    modelSelection: projection.modelSelection,
    modelTier: projection.modelTier,
    modelAuto: projection.modelAuto ?? null,
    usage: projection.usage,
    todoList: projection.todoList ?? null,
    latestReply: projection.latestReply ?? null,
    resumedAfterStop: projection.resumedAfterStop,
    lastActivityAt: projection.lastActivityAt,
    bornTicketless: projection.bornTicketless,
  };
}

function viewShared(view: CloudSessionView) {
  const {
    attention: raised,
    interactions: asked,
    throughSequence: _t,
    truncated: _x,
    ...rest
  } = view;
  return {
    ...rest,
    attention: { active: raised.active, primary: raised.primary },
    interactions: { active: asked.active },
  };
}

/** Folds one event at a time, as accepting one fact per mutation does. */
function foldEach(events: readonly SessionProjectionEvent[]): CloudSessionState {
  let state: CloudSessionState | null = null;
  for (const event of events) {
    state = foldCloudSessionState(state, SESSION, [event], event.sequence);
  }
  return state!;
}

describe("foldCloudSessionState", () => {
  test("agrees with the local projection after every fact, one fact per fold", () => {
    const events = log(RICH);
    let state: CloudSessionState | null = null;
    for (const [index, event] of events.entries()) {
      state = foldCloudSessionState(state, SESSION, [event], event.sequence);
      const local = projectSession(SESSION, events.slice(0, index + 1));
      expect(viewShared(cloudSessionView(state))).toEqual(sharedFields(local));
      expect(state.throughSequence).toBe(event.sequence);
    }
    const view = cloudSessionView(state!);
    expect(view).toMatchObject({
      status: "archived",
      lastTurnOutcome: "interrupted",
      latestTurnId: "turn-2",
      resumedAfterStop: true,
      truncated: false,
      todoList: [{ text: "plan", status: "pending" }],
      session: { title: "Renamed" },
    });
    expect(view.liveAttachment?.id).toBe("attachment-2");
  });

  test("folds a batch to the same state as one fact at a time", () => {
    const events = log(RICH);
    const batched = foldCloudSessionState(
      foldCloudSessionState(null, SESSION, events.slice(0, 9), 9),
      SESSION,
      events.slice(9),
      events.length,
    );
    expect(batched).toEqual(foldEach(events));
  });

  test("keeps none of the local fold's unbounded history", () => {
    const state = foldEach(log(RICH));
    const { projection } = state.fold;
    expect(projection.commands).toEqual([]);
    expect(projection.receipts).toEqual([]);
    expect(projection.resumptions).toEqual([]);
    expect(projection.interactions.resolved).toEqual([]);
    expect(state).not.toHaveProperty("fold.version");
    expect(state).not.toHaveProperty("fold.compatibility");
  });

  test("passes over unreadable facts: `through` runs ahead of the last fact folded", () => {
    const [created, model] = log(RICH.slice(0, 2));
    const first = foldCloudSessionState(null, SESSION, [created!], 3);
    expect(first.throughSequence).toBe(3);
    expect(first.fold.throughSequence).toBe(1);
    const next = foldCloudSessionState(first, SESSION, [{ ...model!, sequence: 4 }], 4);
    expect(cloudSessionView(next).modelSelection?.modelId).toBe("opus");
    expect(foldCloudSessionState(next, SESSION, [], 9).throughSequence).toBe(9);
  });

  test("refuses facts outside its window and a window that moves back", () => {
    const events = log(RICH.slice(0, 3));
    const state = foldCloudSessionState(null, SESSION, events.slice(0, 2), 2);
    expect(() => foldCloudSessionState(state, SESSION, [events[1]!], 3)).toThrow(/outside/);
    expect(() => foldCloudSessionState(state, SESSION, [events[2]!], 2)).toThrow(/outside/);
    expect(() =>
      foldCloudSessionState(state, SESSION, [{ ...events[2]!, sessionId: "other" }], 3),
    ).toThrow(/outside/);
    expect(() => foldCloudSessionState(state, SESSION, [], 1)).toThrow(/back to 1/);
    expect(() => foldCloudSessionState(state, SESSION, [], 2.5)).toThrow(/back to 2.5/);
  });

  test("caps active attention and interactions, oldest first, and counts what it dropped", () => {
    const raised = CLOUD_SESSION_ACTIVE_LIMIT + 3;
    const payloads: SessionEventPayload[] = [{ kind: "session.created", session: SESSION }];
    for (let index = 0; index < raised; index += 1) {
      payloads.push(attention(`attention-${index}`), interaction(`interaction-${index}`));
    }
    // Clearing a dropped item is a no-op; clearing a kept one still clears it.
    payloads.push(
      { kind: "attention.cleared", attentionId: "attention-0" },
      { kind: "attention.cleared", attentionId: `attention-${raised - 1}` },
    );
    const view = cloudSessionView(foldEach(log(payloads)));
    expect(view.attention.active).toHaveLength(CLOUD_SESSION_ACTIVE_LIMIT - 1);
    expect(view.attention.active[0]!.id).toBe("attention-3");
    expect(view.attention.primary?.id).toBe(`attention-${raised - 2}`);
    expect(view.attention.dropped).toBe(3);
    expect(view.interactions.active).toHaveLength(CLOUD_SESSION_ACTIVE_LIMIT);
    expect(view.interactions.dropped).toBe(3);
    expect(view.needsUser).toBe(true);
  });

  test("keeps open attachments, the newest closed ones and the newest that ever opened", () => {
    const payloads: SessionEventPayload[] = [{ kind: "session.created", session: SESSION }];
    for (let index = 1; index <= 6; index += 1) {
      payloads.push(
        { kind: "attachment.opened", attachment: attachment(`attachment-${index}`) },
        { kind: "attachment.closed", attachmentId: `attachment-${index}`, outcome: "completed" },
      );
    }
    // Failed attachments never opened: the newest opened one must survive them.
    for (let index = 1; index <= 4; index += 1) {
      payloads.push({
        kind: "attachment.failed",
        attachment: attachment(`failed-${index}`),
        failure: { code: "x", detail: null, diagnostic: null },
      });
    }
    payloads.push({ kind: "attachment.opened", attachment: attachment("live") });
    const events = log(payloads);
    const before = foldEach(events.slice(0, -1));
    expect(before.fold.projection.attachments.map(({ id }) => id)).toEqual([
      "attachment-6",
      "failed-2",
      "failed-3",
      "failed-4",
    ]);
    const state = foldCloudSessionState(before, SESSION, events.slice(-1), events.length);
    expect(state.fold.projection.attachments.map(({ id }) => id)).toEqual([
      "failed-2",
      "failed-3",
      "failed-4",
      "live",
    ]);
    // A re-attach is still recognised as one, as the whole list would say.
    expect(cloudSessionView(state).liveAttachment).toMatchObject({ id: "live", reattached: true });
    expect(cloudSessionView(state).liveAttachment).toEqual(
      projectSession(SESSION, events).liveExecutor,
    );
  });

  test("caps the pending start and attribution lists, newest kept", () => {
    const payloads: SessionEventPayload[] = [{ kind: "session.created", session: SESSION }];
    for (let index = 0; index < 20; index += 1) {
      payloads.push(
        command(`start-${index}`, { kind: "executor.start", adapterId: "pi", continuity: "fresh" }),
        command(`submit-${index}`, { kind: "message.submit", text: "x" }),
      );
    }
    const state = foldEach(log(payloads));
    expect(state.fold.pendingExecutorStarts).toHaveLength(16);
    expect(state.fold.pendingAttachmentCommands).toHaveLength(16);
    expect(state.fold.pendingTurnCommands).toHaveLength(16);
    expect(cloudSessionView(state).pendingExecutorStartId).toBe("start-19");
  });

  test("stays under its bound however long the Session runs", () => {
    const payloads: SessionEventPayload[] = [{ kind: "session.created", session: SESSION }];
    for (let turn = 0; turn < 400; turn += 1) {
      payloads.push(
        { kind: "attachment.opened", attachment: attachment(`attachment-${turn}`) },
        command(`submit-${turn}`, { kind: "message.submit", text: "x".repeat(200) }),
        { kind: "turn.started", attachmentId: `attachment-${turn}`, turnId: `turn-${turn}` },
        attention(`attention-${turn}`, "d".repeat(300)),
        { kind: "turn.completed", attachmentId: `attachment-${turn}`, turnId: `turn-${turn}` },
        { kind: "attachment.closed", attachmentId: `attachment-${turn}`, outcome: "completed" },
      );
    }
    const events = log(payloads);
    const state = foldEach(events);
    expect(cloudSessionStateBytes(state)).toBeLessThanOrEqual(CLOUD_SESSION_STATE_MAX_BYTES);
    expect(state.truncated).toBe(false);
    // The local fold kept everything and is many times larger.
    const local = projectSession(SESSION, events);
    expect(JSON.stringify(local).length).toBeGreaterThan(4 * CLOUD_SESSION_STATE_MAX_BYTES);
  });

  test("tightens the trim when the first level is still too big, clamping free text", () => {
    const big = "b".repeat(3_000);
    const payloads: SessionEventPayload[] = [
      { kind: "session.created", session: SESSION },
      { kind: "session.retitled", title: big },
      { kind: "session.signaled", signal: "done", reason: big },
      { kind: "session.stopped", reason: big, by: { kind: "user" } },
      {
        kind: "transcript.referenced",
        attachmentId: null,
        turnId: null,
        reference: { id: "sha256:bb", mediaType: null, digest: null },
        digest: { role: "assistant", todoList: [{ text: big, status: "pending" }] },
      } as never,
    ];
    for (let index = 0; index < 30; index += 1) payloads.push(attention(`a-${index}`, big));
    const events = log(payloads);
    const state = foldCloudSessionState(null, SESSION, events, events.length);
    expect(state.truncated).toBe(true);
    expect(cloudSessionStateBytes(state)).toBeLessThanOrEqual(CLOUD_SESSION_STATE_MAX_BYTES);
    const view = cloudSessionView(state);
    expect(view.session.title).toHaveLength(1024);
    expect(view.session.title!.endsWith("…")).toBe(true);
    expect(view.signal?.reason).toHaveLength(1024);
    expect(view.stopped?.reason).toHaveLength(1024);
    expect(view.todoList).toBeNull();
    expect(view.attention.active.map(({ id }) => id)).toEqual(["a-29"]);
    expect(view.attention.dropped).toBe(29);
    // What the tight trim dropped stays dropped, and the flag says so.
    const next = foldCloudSessionState(
      state,
      SESSION,
      log([attention("a-30")], events.length + 1),
      events.length + 1,
    );
    expect(next.truncated).toBe(true);
    expect(cloudSessionView(next).attention.active.map(({ id }) => id)).toEqual(["a-29", "a-30"]);
  });

  test("keeps adapter-native detail out of the state, however large", () => {
    const native = { adapterId: "pi", id: "n", detail: { file: "x".repeat(200_000) } };
    const events = log([
      { kind: "session.created", session: SESSION },
      { kind: "attachment.opened", attachment: { ...attachment("a"), native } },
      {
        kind: "interaction.opened",
        interaction: { ...(interaction("i").interaction as object), native } as never,
      },
      {
        ...attention("big"),
        attention: { ...attention("big").attention, diagnostic: { trace: "y".repeat(200_000) } },
      },
    ]);
    const state = foldEach(events);
    expect(state.truncated).toBe(false);
    const view = cloudSessionView(state);
    expect(view.liveAttachment?.native).toBeNull();
    expect(view.interactions.active[0]!.native).toEqual({ id: null, detail: null });
    expect(view.attention.active[0]!.diagnostic).toBeNull();
    expect(state.fold.projection.attachments[0]!.native).toBeNull();
  });

  test("drops every active item as the last resort, counting them", () => {
    const huge = "h".repeat(CLOUD_SESSION_STATE_MAX_BYTES);
    const events = log([
      { kind: "session.created", session: SESSION },
      attention("a-1", huge),
      {
        ...interaction("i-1"),
        interaction: { ...(interaction("i-1").interaction as object), title: huge } as never,
      },
    ]);
    const state = foldCloudSessionState(null, SESSION, events, events.length);
    const view = cloudSessionView(state);
    expect(state.truncated).toBe(true);
    expect(view.attention).toMatchObject({ active: [], primary: null, dropped: 1 });
    expect(view.interactions).toMatchObject({ active: [], dropped: 1 });
    expect(cloudSessionStateBytes(state)).toBeLessThanOrEqual(CLOUD_SESSION_STATE_MAX_BYTES);
  });

  test("refuses a state no trim can bring under its bound", () => {
    const payloads: SessionEventPayload[] = [
      { kind: "session.created", session: SESSION },
      {
        kind: "model.selected",
        selection: {
          providerId: "p".repeat(CLOUD_SESSION_STATE_MAX_BYTES),
          modelId: "m",
          reasoningLevel: "high",
        },
      },
    ];
    let thrown: unknown;
    try {
      foldEach(log(payloads));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(CloudSessionStateTooLargeError);
    expect((thrown as CloudSessionStateTooLargeError).bytes).toBeGreaterThan(
      CLOUD_SESSION_STATE_MAX_BYTES,
    );
  });
});

describe("readCloudSessionState", () => {
  test("reads a state of this fold version and event vocabulary, and nothing else", () => {
    const state = foldEach(log(RICH.slice(0, 2)));
    expect(readCloudSessionState(JSON.parse(JSON.stringify(state)))).toEqual(state);
    expect(readCloudSessionState({ ...state, foldVersion: CLOUD_SESSION_FOLD_VERSION + 1 })).toBe(
      null,
    );
    // A build that knows one more kind refolds what an older one wrote.
    expect(readCloudSessionState({ ...state, compatibility: "session-event-kinds:older" })).toBe(
      null,
    );
    for (const value of [null, "state", [], 3]) expect(readCloudSessionState(value)).toBeNull();
  });

  test("moves its version with the local checkpoint's", () => {
    expect(Math.floor(CLOUD_SESSION_FOLD_VERSION / 100)).toBe(
      SESSION_PROJECTION_CHECKPOINT_VERSION,
    );
  });
});

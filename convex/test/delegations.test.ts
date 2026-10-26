import { createHash, randomUUID } from "node:crypto";
import { makeFunctionReference } from "convex/server";
import { describe, expect, test, vi } from "vite-plus/test";
import {
  assertSessionEvent,
  encodeSessionJson,
  type SessionEvent,
  type SessionEventPayload,
  type SessionOrigin,
  type SubagentNoticeState,
} from "@volli/shared";
import {
  AGENT_TOKEN_ISSUER,
  RUNNER_TOKEN_ISSUER,
  canonicalJson,
  subagentNoticeIds,
  newId,
  parseJobPayload,
} from "@volli/shared/cloud";
import { api, internal } from "../functions/_generated/api";
import {
  boardFixture,
  code,
  createTicket,
  seedRunner,
  seedSession,
  setup,
  signIn,
  type Tester,
} from "./board-helpers";
import { wire, writeSession } from "./sessionFixtures";

const forParent = makeFunctionReference<"query">("delegations:forParent");
const asRunner = (t: Tester, id: string) =>
  t.withIdentity({ issuer: RUNNER_TOKEN_ISSUER, subject: `runner:${id}` });
const accept = (t: Tester, runnerId: string, sessionId: string, events: SessionEvent[]) => {
  for (const event of events) assertSessionEvent(event, "delegation fixture");
  return asRunner(t, runnerId).mutation(api.sessions.accept, {
    sessionId,
    generation: 1,
    events: events.map(wire),
  });
};
const slots = (t: Tester) => t.run((ctx) => ctx.db.query("delegations").collect());
const jobs = (t: Tester, sessionId: string) =>
  t.run((ctx) =>
    ctx.db
      .query("runnerJobs")
      .withIndex("by_session", (q) => q.eq("sessionId", sessionId))
      .collect(),
  );
const session = (t: Tester, id: string) =>
  t.run((ctx) =>
    ctx.db
      .query("sessions")
      .withIndex("by_uuid", (q) => q.eq("id", id))
      .unique(),
  );

function nextFact(history: SessionEvent[], payload: SessionEventPayload): SessionEvent {
  const last = history.at(-1)!;
  const sequence = last.sequence + 1;
  return {
    ...last,
    id: randomUUID(),
    sequence,
    occurredAt: last.occurredAt + 1,
    recordedAt: last.recordedAt + 1,
    commandId: payload.kind === "command.receipt.recorded" ? payload.receipt.commandId : null,
    payload:
      payload.kind === "command.receipt.recorded"
        ? { ...payload, receipt: { ...payload.receipt, sequence, recordedAt: last.recordedAt + 1 } }
        : payload,
  };
}

async function world() {
  const t = setup();
  const a = await boardFixture(t);
  const ticket = await createTicket(a.as, a.projectId);
  const runnerId = await seedRunner(t, a.userId);
  const parent = await writeSession({ projectId: a.projectId, ticketId: ticket.ticketId });
  const end = parent.events.findIndex((fact) => fact.payload.kind === "turn.completed");
  await accept(t, runnerId, parent.sessionId, parent.events.slice(0, end));
  const child = async (toolCallId = "call:1") => {
    const written = await writeSession({
      projectId: a.projectId,
      ticketId: ticket.ticketId,
      parentSessionId: parent.sessionId,
    });
    const first = written.events[0]!.payload;
    if (first.kind !== "command.recorded") throw new Error("No birth command");
    const old = first.command.id;
    const createCommandId = `${parent.sessionId}:${toolCallId}:create`;
    const originalStart = written.events.find(
      (event) =>
        event.payload.kind === "command.recorded" &&
        event.payload.command.intent.kind === "executor.start",
    )!.payload;
    if (originalStart.kind !== "command.recorded") throw new Error("No start command");
    const originalKickoff = written.events.find(
      (event) =>
        event.payload.kind === "command.recorded" &&
        event.payload.command.intent.kind === "message.submit",
    )!.payload;
    if (originalKickoff.kind !== "command.recorded") throw new Error("No kickoff");
    const commandIds = new Map([
      [old, createCommandId],
      [originalStart.command.id, `${parent.sessionId}:${toolCallId}:start`],
      [originalKickoff.command.id, `${parent.sessionId}:${toolCallId}:kickoff`],
    ]);
    const events = written.events.map((event): SessionEvent => {
      const payload = event.payload;
      const commandId = commandIds.get(event.commandId ?? "") ?? event.commandId;
      if (payload.kind === "command.recorded")
        return {
          ...event,
          commandId,
          payload: {
            ...payload,
            command: {
              ...payload.command,
              id: commandIds.get(payload.command.id) ?? payload.command.id,
            },
          },
        };
      if (payload.kind === "command.receipt.recorded")
        return {
          ...event,
          commandId,
          payload: {
            ...payload,
            receipt: {
              ...payload.receipt,
              commandId: commandIds.get(payload.receipt.commandId) ?? payload.receipt.commandId,
            },
          },
        };
      if (payload.kind === "turn.started")
        return { ...event, commandId: `${parent.sessionId}:${toolCallId}:kickoff` };
      return { ...event, commandId };
    });
    // writeSession drives Engine observations, not Runtime's ready-attach
    // receipt. Add the same positive evidence the delegation facade reads.
    const openedAt = events.findIndex((fact) => fact.payload.kind === "attachment.opened");
    events.splice(
      openedAt + 1,
      0,
      nextFact(events.slice(0, openedAt + 1), {
        kind: "command.receipt.recorded",
        receipt: {
          id: randomUUID(),
          commandId: `${parent.sessionId}:${toolCallId}:start`,
          status: "accepted",
          acceptedAt: events[openedAt]!.occurredAt + 1,
          result: { kind: "executor.start.requested", sessionId: written.sessionId },
          sequence: 1,
          recordedAt: 1,
        },
      }),
    );
    for (const [index, event] of events.entries()) {
      event.sequence = index + 1;
      if (event.payload.kind === "command.receipt.recorded")
        event.payload.receipt.sequence = event.sequence;
    }
    const childEnd = events.findIndex((fact) => fact.payload.kind === "turn.completed");
    return {
      ...written,
      events,
      end: childEnd,
      toolCallId,
      createCommandId,
      operationId: `${parent.sessionId}:${toolCallId}`,
    };
  };
  return { t, ...a, ticket, runnerId, parent, end, child };
}

async function stage(t: Tester, sessionId: string, text: string | null) {
  const digest = `sha256:${"b".repeat(64)}`;
  const body =
    text === null
      ? null
      : JSON.stringify({ message: { role: "assistant", parts: [{ type: "text", text }] } });
  await t.run((ctx) =>
    ctx.db.insert("transcriptArtifacts", {
      sessionId,
      digest,
      mediaType: "application/json",
      bytes: body === null ? 100_000 : new TextEncoder().encode(body).length,
      body,
      spillKey: body === null ? "staged-spill" : null,
      firstSequence: null,
      uploadedBy: "runner",
      packedSegmentId: null,
      expiresAt: null,
      createdAt: 0,
    }),
  );
  return digest;
}

function messageFact(
  history: SessionEvent[],
  commandId: string = randomUUID(),
  origin: SessionOrigin | null = { kind: "user" },
): SessionEvent {
  const fact = nextFact(history, {
    kind: "command.recorded",
    command: {
      id: commandId,
      sessionId: history[0]!.sessionId,
      createdAt: history.at(-1)!.occurredAt + 1,
      route: null,
      intent: {
        kind: "message.submit",
        reference: { id: `sha256:${"a".repeat(64)}`, mediaType: "application/json", digest: null },
      },
    },
  });
  return {
    ...fact,
    commandId,
    provenance: {
      ...fact.provenance,
      source: { ...fact.provenance.source, detail: { sessionOrigin: origin } },
    },
  };
}

async function parentAnswerFact(
  t: Tester,
  history: SessionEvent[],
  child: { operationId: string; sessionId: string },
  state: SubagentNoticeState = "failed",
): Promise<SessionEvent> {
  const ids = subagentNoticeIds(child.operationId);
  const body = canonicalJson({
    version: 1,
    threadId: "thread",
    branchId: "branch",
    attemptId: "attempt",
    turnId: null,
    message: {
      id: ids.messageId,
      role: "user",
      parts: [{ type: "text", text: "Delegation outcome" }],
      metadata: {
        kind: "session-host-notice",
        notice: {
          kind: "subagent",
          childSessionId: child.sessionId,
          title: "Task",
          state,
          reason: null,
        },
      },
    },
  });
  const digest = `sha256:${createHash("sha256").update(body).digest("hex")}`;
  await t.run((ctx) =>
    ctx.db.insert("transcriptArtifacts", {
      sessionId: history[0]!.sessionId,
      digest,
      mediaType: "application/vnd.volli.ui-message+json",
      bytes: new TextEncoder().encode(body).length,
      body,
      spillKey: null,
      firstSequence: null,
      uploadedBy: "runner",
      packedSegmentId: null,
      expiresAt: null,
      createdAt: 0,
    }),
  );
  const fact = messageFact(history, ids.commandId, { kind: "volli", reason: "subagent-notice" });
  if (fact.payload.kind !== "command.recorded") throw new Error("No command");
  return {
    ...fact,
    payload: {
      ...fact.payload,
      command: {
        ...fact.payload.command,
        intent: {
          kind: "message.submit",
          reference: { id: digest, digest, mediaType: "application/vnd.volli.ui-message+json" },
        },
      },
    },
  };
}

function referenceFact(history: SessionEvent[], digest: string) {
  const turn = history.findLast((fact) => fact.payload.kind === "turn.started")!.payload;
  if (turn.kind !== "turn.started") throw new Error("No turn");
  return nextFact(history, {
    kind: "transcript.referenced",
    attachmentId: turn.attachmentId,
    turnId: turn.turnId,
    reference: { id: digest, mediaType: "application/json", digest: null },
    digest: { role: "assistant", reply: true },
  });
}

describe("delegation projection and settlement", () => {
  test("projects first accept, inherits privacy, and a duplicate slot raises exactly one alert without rejecting the drain", async () => {
    const w = await world();
    const parentRow = (await session(w.t, w.parent.sessionId))!;
    await w.t.run((ctx) =>
      ctx.db.patch(parentRow._id, {
        visibility: "private",
        visibilityReason: "adhoc",
        sharedAt: null,
      }),
    );
    const first = await w.child();
    await accept(w.t, w.runnerId, first.sessionId, first.events.slice(0, first.end));
    expect(await slots(w.t)).toMatchObject([
      {
        childSessionId: first.sessionId,
        parentSessionId: w.parent.sessionId,
        createCommandId: first.createCommandId,
        toolCallId: "call:1",
        status: "running",
        depth: 1,
        settledAt: null,
      },
    ]);
    expect(await session(w.t, first.sessionId)).toMatchObject({
      visibility: "private",
      visibilityReason: "inherited",
    });
    const duplicate = await w.child();
    const another = await w.child();
    await accept(w.t, w.runnerId, duplicate.sessionId, duplicate.events);
    const alert = (await w.t.run((ctx) => ctx.db.query("attentionItems").collect())).find(
      (row) => row.sourceId === "volli:delegation-slot:call:1",
    )!;
    expect(alert).toMatchObject({ kind: "runner_alert", sessionId: w.parent.sessionId });
    await w.t.run((ctx) => ctx.db.patch(alert._id, { clearedAt: 10, clearedReason: "resolved" }));
    await accept(w.t, w.runnerId, another.sessionId, another.events);
    expect(await slots(w.t)).toHaveLength(1);
    expect(await w.t.run((ctx) => ctx.db.get(alert._id))).toMatchObject({ clearedAt: 10 });
    expect(
      (await jobs(w.t, w.parent.sessionId)).filter((job) => job.kind === "session.notice"),
    ).toEqual([]);
  });

  test("ordinary subagents and non-birth commands do not claim a delegation slot", async () => {
    const w = await world();
    const plain = await writeSession({
      projectId: w.projectId,
      parentSessionId: w.parent.sessionId,
    });
    await accept(w.t, w.runnerId, plain.sessionId, plain.events);
    expect(await slots(w.t)).toEqual([]);
  });

  test.each([false, true])(
    "settles once and routes the frozen answer to the parent's current claim (spilled=%s)",
    async (spilled) => {
      const w = await world();
      const c = await w.child();
      const runnerB = await seedRunner(w.t, w.userId);
      await accept(w.t, runnerB, c.sessionId, c.events.slice(0, c.end));
      const movedRunner = await seedRunner(w.t, w.userId);
      await w.t.run(async (ctx) => {
        const intake = await ctx.db
          .query("sessionIntake")
          .withIndex("by_session", (q) => q.eq("sessionId", w.parent.sessionId))
          .unique();
        await ctx.db.patch(intake!._id, { claim: { runnerId: movedRunner, generation: 2 } });
      });
      const digest = await stage(w.t, c.sessionId, spilled ? null : "x".repeat(17_000));
      const prefix = c.events.slice(0, c.end);
      const reply = referenceFact(prefix, digest);
      const end = nextFact([...prefix, reply], c.events[c.end]!.payload);
      await accept(w.t, runnerB, c.sessionId, [reply, end]);
      const stop = nextFact([...prefix, reply, end], {
        kind: "session.stopped",
        reason: null,
        by: { kind: "session", sessionId: w.parent.sessionId },
      });
      // Runner clocks can disagree. Accepted sequence still preserves completion.
      stop.occurredAt = 1;
      await accept(w.t, runnerB, c.sessionId, [stop]);
      expect(await slots(w.t)).toMatchObject([
        {
          status: "answered",
          settledAt: end.occurredAt,
          answerRef: { digest, chars: spilled ? null : 17_000 },
        },
      ]);
      const notices = (await jobs(w.t, w.parent.sessionId)).filter(
        (job) => job.kind === "session.notice",
      );
      expect(notices).toHaveLength(1);
      expect(notices[0]).toMatchObject({
        id: `${c.operationId}:answer`,
        commandId: `${c.operationId}:answer`,
        runnerId: movedRunner,
        sessionId: w.parent.sessionId,
      });
      const payload = parseJobPayload("session.notice", notices[0]!.payload);
      expect(payload).toMatchObject({
        notice: "subagent",
        state: "completed",
        reason: null,
        childSessionId: c.sessionId,
        answer: spilled
          ? { state: "unread" }
          : { state: "text", message: { text: "x".repeat(16_000), totalChars: 17_000 } },
      });
    },
  );

  test("JSON-escaped prose remains a valid bounded notice", async () => {
    const w = await world();
    const c = await w.child();
    const prefix = c.events.slice(0, c.end);
    await accept(w.t, w.runnerId, c.sessionId, prefix);
    const digest = await stage(w.t, c.sessionId, "\u0001".repeat(16_000));
    const reply = referenceFact(prefix, digest);
    const end = nextFact([...prefix, reply], c.events[c.end]!.payload);
    await accept(w.t, w.runnerId, c.sessionId, [reply, end]);
    const notice = (await jobs(w.t, w.parent.sessionId)).find(
      (job) => job.kind === "session.notice",
    )!;
    expect(() => parseJobPayload("session.notice", notice.payload)).not.toThrow();
    expect(JSON.stringify(notice.payload).length).toBeLessThanOrEqual(65_536);
  });

  test.each(["parent", "user", "interrupted", "failed", "kickoff"] as const)(
    "settles %s outcomes, suppressing only a parent's own earliest stop",
    async (kind) => {
      const w = await world();
      const c = await w.child();
      const prefix = c.events.slice(
        0,
        kind === "kickoff"
          ? c.events.findIndex((event) => event.payload.kind === "turn.started")
          : c.end,
      );
      await accept(w.t, w.runnerId, c.sessionId, prefix);
      const turn = c.events[c.end]!.payload;
      if (turn.kind !== "turn.completed") throw new Error("No turn");
      const payload: SessionEventPayload =
        kind === "interrupted"
          ? { ...turn, kind: "turn.interrupted" }
          : kind === "failed"
            ? { kind: "attachment.closed", attachmentId: turn.attachmentId, outcome: "failed" }
            : kind === "kickoff"
              ? {
                  kind: "command.receipt.recorded",
                  receipt: {
                    id: "refusal",
                    commandId: `${c.operationId}:kickoff`,
                    status: "rejected",
                    code: "not_attached",
                    detail: null,
                    recordedAt: 1,
                    sequence: 1,
                  },
                }
              : {
                  kind: "session.stopped",
                  reason: null,
                  by:
                    kind === "parent"
                      ? { kind: "session", sessionId: w.parent.sessionId }
                      : { kind: "user" },
                };
      const outcome = nextFact(prefix, payload);
      await accept(w.t, w.runnerId, c.sessionId, [outcome]);
      const later = nextFact([...prefix, outcome], {
        kind: "session.stopped",
        reason: null,
        by: { kind: "session", sessionId: w.parent.sessionId },
      });
      await accept(w.t, w.runnerId, c.sessionId, [later]);
      expect((await slots(w.t))[0]).toMatchObject({
        status: kind === "parent" || kind === "user" ? "stopped" : "failed",
        settledAt: outcome.occurredAt,
      });
      expect(
        (await jobs(w.t, w.parent.sessionId)).filter((job) => job.kind === "session.notice"),
      ).toHaveLength(kind === "parent" ? 0 : 1);
    },
  );

  test("a late child cascades only after its original watch is ready at the caught-up head", async () => {
    const w = await world();
    const remoteRunner = await seedRunner(w.t, w.userId);
    const child = await w.child("late-child");
    const stop = nextFact(w.parent.events.slice(0, w.end), {
      kind: "session.stopped",
      reason: null,
      by: { kind: "user" },
    });
    await accept(w.t, w.runnerId, w.parent.sessionId, [stop]);
    await accept(w.t, remoteRunner, child.sessionId, child.events.slice(0, 1));
    expect(await jobs(w.t, child.sessionId)).toEqual([]);
    await accept(w.t, remoteRunner, child.sessionId, child.events.slice(1, child.end));
    expect(
      (await jobs(w.t, child.sessionId)).filter((job) => job.kind === "session.command"),
    ).toHaveLength(1);
  });

  test("a completed late catch-up batch is settled before any parent-stop cascade", async () => {
    const w = await world();
    const remoteRunner = await seedRunner(w.t, w.userId);
    const child = await w.child("late-complete");
    const stop = nextFact(w.parent.events.slice(0, w.end), {
      kind: "session.stopped",
      reason: null,
      by: { kind: "user" },
    });
    await accept(w.t, w.runnerId, w.parent.sessionId, [stop]);
    await accept(w.t, remoteRunner, child.sessionId, child.events);
    expect((await slots(w.t))[0]).toMatchObject({ status: "answered", watch: { active: null } });
    expect(
      (await jobs(w.t, child.sessionId)).filter((job) => job.kind === "session.command"),
    ).toEqual([]);
  });

  test("a stale running projection cannot cascade over an already-accepted completion", async () => {
    vi.useFakeTimers();
    try {
      const w = await world();
      const remoteRunner = await seedRunner(w.t, w.userId);
      const child = await w.child("refolding");
      await accept(w.t, remoteRunner, child.sessionId, child.events.slice(0, child.end));
      await w.t.mutation(internal.sessions.refold, { sessionId: child.sessionId });
      await accept(w.t, remoteRunner, child.sessionId, child.events.slice(child.end));
      const stop = nextFact(w.parent.events.slice(0, w.end), {
        kind: "session.stopped",
        reason: null,
        by: { kind: "user" },
      });
      await accept(w.t, w.runnerId, w.parent.sessionId, [stop]);
      expect((await slots(w.t))[0]?.status).toBe("running");
      expect(await jobs(w.t, child.sessionId)).toEqual([]);
      await w.t.finishAllScheduledFunctions(vi.runAllTimers);
      expect((await slots(w.t))[0]?.status).toBe("answered");
      expect(await jobs(w.t, child.sessionId)).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  test("a failed initial attachment holds no watch or answer id; Retry reports once without a parent cascade", async () => {
    const w = await world();
    const remoteRunner = await seedRunner(w.t, w.userId);
    const c = await w.child("held");
    const openedAt = c.events.findIndex((event) => event.payload.kind === "attachment.opened");
    const opened = c.events[openedAt]!.payload;
    if (opened.kind !== "attachment.opened") throw new Error("No attachment");
    const history = c.events.slice(0, openedAt);
    history.push(
      nextFact(history, {
        kind: "attachment.failed",
        attachment: { ...opened.attachment, native: null },
        failure: { code: "location_unavailable", detail: "Worktree unavailable", diagnostic: null },
      }),
    );
    history.push(
      nextFact(history, {
        kind: "command.receipt.recorded",
        receipt: {
          id: randomUUID(),
          commandId: `${c.operationId}:start`,
          status: "rejected",
          code: "location_unavailable",
          detail: null,
          sequence: 1,
          recordedAt: 1,
        },
      }),
    );
    await accept(w.t, remoteRunner, c.sessionId, history);
    expect((await slots(w.t))[0]).toMatchObject({
      status: "failed",
      settledAt: null,
      watch: { active: null, originalOutcome: false },
    });
    expect(await jobs(w.t, w.parent.sessionId)).toEqual([]);
    // Holding is in the runner's queue; publishing its mirror later must not
    // be required to prevent a premature failure or to prove a negative.
    await w.t.run((ctx) =>
      ctx.db.insert("sessionFollowUpQueues", {
        sessionId: c.sessionId,
        runnerId: remoteRunner,
        generation: 1,
        revision: 1,
        items: [
          {
            messageId: `${c.operationId}:kickoff-message`,
            commandId: `${c.operationId}:kickoff`,
            state: "queued",
            message: "task",
            messageDigest: "digest",
          },
        ],
        updatedAt: 1,
      }),
    );
    const watcher = await seedSession(
      w.t,
      { projectId: w.projectId, ticketId: w.ticket.ticketId },
      w.userId,
    );
    const agent = w.t.withIdentity({
      issuer: AGENT_TOKEN_ISSUER,
      subject: `agent:${watcher.sessionId}`,
      own: w.userId,
      rnr: watcher.runnerId,
      gen: 1,
    });
    await agent.mutation(api.watches.watch, {
      watcherSessionId: watcher.sessionId,
      target: { kind: "session", id: w.parent.sessionId },
      commandId: newId("command"),
    });
    await accept(w.t, w.runnerId, w.parent.sessionId, [w.parent.events[w.end]!]);
    expect(
      (await jobs(w.t, watcher.sessionId)).filter((job) => job.kind === "session.notice"),
    ).toHaveLength(1);
    const parentStop = nextFact(w.parent.events.slice(0, w.end + 1), {
      kind: "session.stopped",
      reason: null,
      by: { kind: "user" },
    });
    await accept(w.t, w.runnerId, w.parent.sessionId, [parentStop]);
    expect(await jobs(w.t, c.sessionId)).toEqual([]);
    const retryAttachment = { ...opened.attachment, id: randomUUID() };
    const retryOpen = nextFact(history, { kind: "attachment.opened", attachment: retryAttachment });
    history.push(retryOpen);
    const retryStart = nextFact(history, {
      kind: "turn.started",
      attachmentId: retryAttachment.id,
      turnId: "retry-turn",
    });
    history.push(retryStart);
    await accept(w.t, remoteRunner, c.sessionId, [retryOpen, retryStart]);
    expect((await slots(w.t))[0]).toMatchObject({
      status: "running",
      watch: { active: { resumed: true, commandId: `${c.operationId}:answer` } },
    });
    expect(await jobs(w.t, c.sessionId)).toEqual([]);
    const staleKickoff = nextFact(history, {
      kind: "command.receipt.recorded",
      receipt: {
        id: randomUUID(),
        commandId: `${c.operationId}:kickoff`,
        status: "rejected",
        code: "not_attached",
        detail: null,
        sequence: 1,
        recordedAt: 1,
      },
    });
    history.push(staleKickoff);
    await accept(w.t, remoteRunner, c.sessionId, [staleKickoff]);
    expect((await slots(w.t))[0]?.status).toBe("running");
    const end = nextFact(history, {
      kind: "turn.completed",
      attachmentId: retryAttachment.id,
      turnId: "retry-turn",
    });
    await accept(w.t, remoteRunner, c.sessionId, [end]);
    const notices = (await jobs(w.t, w.parent.sessionId)).filter(
      (job) => job.kind === "session.notice",
    );
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({
      commandId: `${c.operationId}:answer`,
      payload: { state: "completed" },
    });
  });

  test.each([false, true])(
    "a local pre-intent failure settles its spent original watch and unblocks B2 (parent first=%s)",
    async (parentFirst) => {
      const w = await world();
      const c = await w.child("pre-intent");
      const ready = c.events.slice(
        0,
        c.events.findIndex(
          (event) =>
            event.payload.kind === "command.recorded" &&
            event.payload.command.id === `${c.operationId}:kickoff`,
        ),
      );
      if (!parentFirst) await accept(w.t, w.runnerId, c.sessionId, ready);
      const watcher = await seedSession(
        w.t,
        { projectId: w.projectId, ticketId: w.ticket.ticketId },
        w.userId,
      );
      const agent = w.t.withIdentity({
        issuer: AGENT_TOKEN_ISSUER,
        subject: `agent:${watcher.sessionId}`,
        own: w.userId,
        rnr: watcher.runnerId,
        gen: 1,
      });
      await agent.mutation(api.watches.watch, {
        watcherSessionId: watcher.sessionId,
        target: { kind: "session", id: w.parent.sessionId },
        commandId: newId("command"),
      });
      const parentHistory = w.parent.events.slice(0, w.end);
      if (!parentFirst) {
        parentHistory.push(w.parent.events[w.end]!);
        await accept(w.t, w.runnerId, w.parent.sessionId, [parentHistory.at(-1)!]);
        expect(await jobs(w.t, watcher.sessionId)).toEqual([]);
        expect((await slots(w.t))[0]?.watch?.active).toMatchObject({ resumed: false });
      }
      const told = await parentAnswerFact(w.t, parentHistory, c);
      parentHistory.push(told);
      await accept(w.t, w.runnerId, w.parent.sessionId, [told]);
      if (parentFirst) await accept(w.t, w.runnerId, c.sessionId, ready);
      expect((await slots(w.t))[0]).toMatchObject({
        status: "failed",
        settledAt: told.occurredAt,
        watch: { active: null, originalSettled: true, originalOutcome: true },
      });
      const parentStart = nextFact(parentHistory, {
        kind: "turn.started",
        attachmentId: "parent-a",
        turnId: "notice-turn",
      });
      parentHistory.push(parentStart);
      const parentEnd = nextFact(parentHistory, {
        kind: "turn.completed",
        attachmentId: "parent-a",
        turnId: "notice-turn",
      });
      await accept(w.t, w.runnerId, w.parent.sessionId, [parentStart, parentEnd]);
      expect(
        (await jobs(w.t, watcher.sessionId)).filter((job) => job.kind === "session.notice"),
      ).toHaveLength(1);
      // No child kickoff command/outcome exists. More work really resumes it.
      const command = messageFact(ready);
      const start = nextFact([...ready, command], {
        kind: "turn.started",
        attachmentId: "a",
        turnId: "after-local-failure",
      });
      const end = nextFact([...ready, command, start], {
        kind: "turn.completed",
        attachmentId: "a",
        turnId: "after-local-failure",
      });
      await accept(w.t, w.runnerId, c.sessionId, [command, start, end]);
      expect((await jobs(w.t, w.parent.sessionId)).map((job) => job.commandId)).toEqual([
        `${c.operationId}:resume:after-local-failure:answer`,
      ]);
      const originalCommands = await w.t.run((ctx) =>
        ctx.db
          .query("sessionEvents")
          .withIndex("by_session_command", (q) =>
            q
              .eq("sessionId", w.parent.sessionId)
              .eq("commandId", `${c.operationId}:answer`)
              .eq("kind", "command.recorded"),
          )
          .collect(),
      );
      expect(originalCommands).toHaveLength(1);
    },
  );

  test("a single child batch after parent-first pre-intent failure reports genuine work under resume ids", async () => {
    const w = await world();
    const c = await w.child("pre-intent-one-batch");
    const ready = c.events.slice(
      0,
      c.events.findIndex(
        (event) =>
          event.payload.kind === "command.recorded" &&
          event.payload.command.id === `${c.operationId}:kickoff`,
      ),
    );
    const told = await parentAnswerFact(w.t, w.parent.events.slice(0, w.end), c, "failed");
    await accept(w.t, w.runnerId, w.parent.sessionId, [told]);
    const command = messageFact(ready);
    const turnId = `turn:${command.commandId}`;
    const start = {
      ...nextFact([...ready, command], { kind: "turn.started", attachmentId: "a", turnId }),
      commandId: command.commandId,
    };
    const end = nextFact([...ready, command, start], {
      kind: "turn.completed",
      attachmentId: "a",
      turnId,
    });
    await accept(w.t, w.runnerId, c.sessionId, [...ready, command, start, end]);
    expect((await jobs(w.t, w.parent.sessionId)).map((job) => job.commandId)).toEqual([
      `${c.operationId}:resume:${turnId}:answer`,
    ]);
    expect((await slots(w.t))[0]).toMatchObject({
      status: "answered",
      watch: { active: null, originalSettled: true, originalOutcome: true },
    });
  });

  test.each(["explicit", "frozen"] as const)(
    "delayed kickoff correlation survives interleaved bookkeeping (%s)",
    async (correlation) => {
      const w = await world();
      const c = await w.child("bookkeeping");
      const told = await parentAnswerFact(w.t, w.parent.events.slice(0, w.end), c, "completed");
      await accept(w.t, w.runnerId, w.parent.sessionId, [told]);
      const turnAt = c.events.findIndex((event) => event.payload.kind === "turn.started");
      const original = c.events[turnAt]!.payload;
      if (original.kind !== "turn.started") throw new Error("No turn");
      const history = c.events.slice(0, turnAt);
      for (const intent of [
        { kind: "session.retitle", title: "Renamed" },
        { kind: "session.signal", signal: "done", reason: null },
      ] as const) {
        const commandId = randomUUID();
        history.push({
          ...nextFact(history, {
            kind: "command.recorded",
            command: {
              id: commandId,
              sessionId: c.sessionId,
              createdAt: history.at(-1)!.occurredAt + 1,
              route: null,
              intent,
            },
          }),
          commandId,
        });
      }
      const turnId = correlation === "explicit" ? original.turnId : `turn:${c.operationId}:kickoff`;
      const start = {
        ...nextFact(history, { ...original, turnId }),
        commandId: correlation === "explicit" ? `${c.operationId}:kickoff` : undefined,
      };
      history.push(start);
      await accept(w.t, w.runnerId, c.sessionId, history);
      expect((await slots(w.t))[0]?.watch?.active).toBeNull();
      const end = nextFact(history, {
        kind: "turn.completed",
        attachmentId: original.attachmentId,
        turnId,
      });
      await accept(w.t, w.runnerId, c.sessionId, [end]);
      expect(await jobs(w.t, w.parent.sessionId)).toEqual([]);
    },
  );

  test("a genuine join to the still-active original turn reports after local failure", async () => {
    const w = await world();
    const c = await w.child("joined-original");
    const history = c.events.slice(0, c.end);
    const original = history.find((event) => event.payload.kind === "turn.started")!.payload;
    if (original.kind !== "turn.started") throw new Error("No turn");
    await accept(w.t, w.runnerId, c.sessionId, history);
    const told = await parentAnswerFact(w.t, w.parent.events.slice(0, w.end), c, "failed");
    await accept(w.t, w.runnerId, w.parent.sessionId, [told]);
    expect((await slots(w.t))[0]).toMatchObject({ status: "failed", watch: { active: null } });
    const joined = messageFact(history);
    history.push(joined);
    await accept(w.t, w.runnerId, c.sessionId, [joined]);
    expect((await slots(w.t))[0]?.watch?.active).toMatchObject({
      resumed: true,
      commandId: `${c.operationId}:resume:${original.turnId}:answer`,
    });
    const end = nextFact(history, {
      kind: "turn.completed",
      attachmentId: original.attachmentId,
      turnId: original.turnId,
    });
    await accept(w.t, w.runnerId, c.sessionId, [end]);
    expect((await jobs(w.t, w.parent.sessionId)).map((job) => job.commandId)).toEqual([
      `${c.operationId}:resume:${original.turnId}:answer`,
    ]);
  });

  test.each([false, true])(
    "parent-before-birth delivery does not turn delayed original work into a resumption (split=%s)",
    async (split) => {
      const w = await world();
      const c = await w.child("delayed-original");
      const told = await parentAnswerFact(w.t, w.parent.events.slice(0, w.end), c, "completed");
      await accept(w.t, w.runnerId, w.parent.sessionId, [told]);
      if (split) {
        const kickoffAt = c.events.findIndex(
          (event) =>
            event.payload.kind === "command.recorded" &&
            event.payload.command.id === `${c.operationId}:kickoff`,
        );
        await accept(w.t, w.runnerId, c.sessionId, c.events.slice(0, kickoffAt));
        expect((await slots(w.t))[0]?.watch?.active).toBeNull();
        await accept(w.t, w.runnerId, c.sessionId, c.events.slice(kickoffAt));
      } else await accept(w.t, w.runnerId, c.sessionId, c.events);
      expect((await slots(w.t))[0]).toMatchObject({
        status: "answered",
        watch: { active: null, originalSettled: true },
      });
      expect(await jobs(w.t, w.parent.sessionId)).toEqual([]);
      const command = messageFact(c.events);
      const start = nextFact([...c.events, command], {
        kind: "turn.started",
        attachmentId: "a",
        turnId: "genuine-resumption",
      });
      const end = nextFact([...c.events, command, start], {
        kind: "turn.completed",
        attachmentId: "a",
        turnId: "genuine-resumption",
      });
      await accept(w.t, w.runnerId, c.sessionId, [command, start, end]);
      const resumes = (await jobs(w.t, w.parent.sessionId)).filter(
        (job) => job.commandId !== `${c.operationId}:answer`,
      );
      expect(resumes.map((job) => job.commandId)).toEqual([
        `${c.operationId}:resume:genuine-resumption:answer`,
      ]);
    },
  );

  test("a delayed batch keeps the original spent and uses real resume ids after parent-first delivery", async () => {
    const w = await world();
    const c = await w.child("two-turn-batch");
    const told = await parentAnswerFact(w.t, w.parent.events.slice(0, w.end), c, "completed");
    await accept(w.t, w.runnerId, w.parent.sessionId, [told]);
    const command = messageFact(c.events);
    const start = nextFact([...c.events, command], {
      kind: "turn.started",
      attachmentId: "a",
      turnId: "batched-resumption",
    });
    const end = nextFact([...c.events, command, start], {
      kind: "turn.completed",
      attachmentId: "a",
      turnId: "batched-resumption",
    });
    await accept(w.t, w.runnerId, c.sessionId, [...c.events, command, start, end]);
    expect((await jobs(w.t, w.parent.sessionId)).map((job) => job.commandId)).toEqual([
      `${c.operationId}:resume:batched-resumption:answer`,
    ]);
    expect((await slots(w.t))[0]).toMatchObject({
      status: "answered",
      watch: { active: null, originalSettled: true, originalOutcome: true },
    });
  });

  test.each([false, true])(
    "a rejected kickoff does not hide a genuine first resumption (frozen-looking id=%s)",
    async (frozenLooking) => {
      const w = await world();
      const c = await w.child("rejected-before-turn");
      const history = c.events.slice(
        0,
        c.events.findIndex((event) => event.payload.kind === "turn.started"),
      );
      const rejected = nextFact(history, {
        kind: "command.receipt.recorded",
        receipt: {
          id: randomUUID(),
          commandId: `${c.operationId}:kickoff`,
          status: "rejected",
          code: "not_attached",
          detail: null,
          recordedAt: 1,
          sequence: 1,
        },
      });
      history.push(rejected);
      await accept(w.t, w.runnerId, c.sessionId, history);
      const told = await parentAnswerFact(w.t, w.parent.events.slice(0, w.end), c, "failed");
      await accept(w.t, w.runnerId, w.parent.sessionId, [told]);
      const command = messageFact(history);
      history.push(command);
      const turnId = frozenLooking ? `turn:${c.operationId}:kickoff` : "first-real-resumption";
      const start = {
        ...nextFact(history, {
          kind: "turn.started",
          attachmentId: "a",
          turnId,
        }),
        commandId: frozenLooking ? command.commandId : null,
      };
      history.push(start);
      const end = nextFact(history, { kind: "turn.completed", attachmentId: "a", turnId });
      await accept(w.t, w.runnerId, c.sessionId, [command, start, end]);
      expect((await jobs(w.t, w.parent.sessionId)).map((job) => job.commandId)).toEqual([
        `${c.operationId}:answer`,
        `${c.operationId}:resume:${turnId}:answer`,
      ]);
    },
  );

  test("a local answer never overwrites an already chosen child-ledger outcome", async () => {
    const w = await world();
    const c = await w.child("child-outcome-first");
    await accept(w.t, w.runnerId, c.sessionId, c.events);
    const before = (await slots(w.t))[0]!;
    const notices = await jobs(w.t, w.parent.sessionId);
    const told = await parentAnswerFact(w.t, w.parent.events.slice(0, w.end), c, "failed");
    await accept(w.t, w.runnerId, w.parent.sessionId, [told]);
    expect((await slots(w.t))[0]).toMatchObject({
      status: before.status,
      settledAt: before.settledAt,
      watch: { originalSettled: true, active: null },
    });
    expect(await jobs(w.t, w.parent.sessionId)).toEqual(notices);
  });

  test.each([
    "user",
    "session",
    "other-notice",
    "wrong-child",
    "wrong-command",
    "not-message",
  ] as const)("a %s answer lookalike cannot spend the original watch", async (kind) => {
    const w = await world();
    const c = await w.child("spoof");
    const ready = c.events.slice(
      0,
      c.events.findIndex(
        (event) =>
          event.payload.kind === "command.recorded" &&
          event.payload.command.id === `${c.operationId}:kickoff`,
      ),
    );
    await accept(w.t, w.runnerId, c.sessionId, ready);
    let told = await parentAnswerFact(
      w.t,
      w.parent.events.slice(0, w.end),
      kind === "wrong-child" ? { ...c, sessionId: randomUUID() } : c,
    );
    if (kind === "user" || kind === "session" || kind === "other-notice") {
      const origin: SessionOrigin =
        kind === "user"
          ? { kind: "user" }
          : kind === "session"
            ? { kind: "session", sessionId: c.sessionId }
            : { kind: "volli", reason: "watch-notice" };
      told = {
        ...told,
        provenance: {
          ...told.provenance,
          source: { ...told.provenance.source, detail: { sessionOrigin: origin } },
        },
      };
    }
    if (told.payload.kind !== "command.recorded") throw new Error("No command");
    const recorded = told.payload;
    if (kind === "wrong-command")
      told = {
        ...told,
        payload: {
          ...recorded,
          command: { ...recorded.command, id: `${c.operationId}:resume:not-original:answer` },
        },
      };
    if (kind === "not-message")
      told = {
        ...told,
        payload: {
          ...recorded,
          command: {
            ...recorded.command,
            intent: { kind: "session.signal", signal: "done", reason: null },
          },
        },
      };
    await accept(w.t, w.runnerId, w.parent.sessionId, [told]);
    expect((await slots(w.t))[0]).toMatchObject({
      status: "running",
      settledAt: null,
      watch: {
        originalSettled: false,
        originalOutcome: false,
        active: { resumed: false, commandId: `${c.operationId}:answer` },
      },
    });
    // The indexed fallback must reject it too, not just the live parent hook.
    const activity = nextFact(ready, { kind: "session.signaled", signal: "done", reason: null });
    await accept(w.t, w.runnerId, c.sessionId, [activity]);
    expect((await slots(w.t))[0]?.watch?.active).not.toBeNull();
  });

  test("a packed parent notice still clears the watch from durable origin/id evidence", async () => {
    const w = await world();
    const c = await w.child("packed-notice");
    const ready = c.events.slice(
      0,
      c.events.findIndex(
        (event) =>
          event.payload.kind === "command.recorded" &&
          event.payload.command.id === `${c.operationId}:kickoff`,
      ),
    );
    await accept(w.t, w.runnerId, c.sessionId, ready);
    const told = messageFact(w.parent.events.slice(0, w.end), `${c.operationId}:answer`, {
      kind: "volli",
      reason: "subagent-notice",
    });
    await accept(w.t, w.runnerId, w.parent.sessionId, [told]);
    expect((await slots(w.t))[0]).toMatchObject({
      status: "answered",
      watch: { active: null, originalSettled: true, originalOutcome: true },
    });
  });

  test("a resumed child reports under frozen turn ids and is not stopped with its parent", async () => {
    const w = await world();
    const remoteRunner = await seedRunner(w.t, w.userId);
    const c = await w.child("resume");
    await accept(w.t, remoteRunner, c.sessionId, c.events);
    const told = messageFact(w.parent.events.slice(0, w.end), `${c.operationId}:answer`, {
      kind: "volli",
      reason: "subagent-notice",
    });
    await accept(w.t, w.runnerId, w.parent.sessionId, [told]);
    const command = messageFact(c.events);
    const start = nextFact([...c.events, command], {
      kind: "turn.started",
      attachmentId: "a",
      turnId: "resumed-turn",
    });
    await accept(w.t, remoteRunner, c.sessionId, [command, start]);
    const stop = nextFact([...w.parent.events.slice(0, w.end), told], {
      kind: "session.stopped",
      reason: null,
      by: { kind: "user" },
    });
    await accept(w.t, w.runnerId, w.parent.sessionId, [stop]);
    expect(await jobs(w.t, c.sessionId)).toEqual([]);
    const end = nextFact([...c.events, command, start], {
      kind: "turn.completed",
      attachmentId: "a",
      turnId: "resumed-turn",
    });
    await accept(w.t, remoteRunner, c.sessionId, [end]);
    const notices = (await jobs(w.t, w.parent.sessionId)).filter(
      (job) => job.kind === "session.notice",
    );
    expect(notices.map((job) => job.commandId)).toEqual([
      `${c.operationId}:answer`,
      `${c.operationId}:resume:resumed-turn:answer`,
    ]);
  });

  test("host-notice turns stay silent, but a person joining one re-arms exactly once", async () => {
    const w = await world();
    const c = await w.child("host-turn");
    // The parent's local answer can drain BEFORE the child's first accept.
    const told = messageFact(w.parent.events.slice(0, w.end), `${c.operationId}:answer`, {
      kind: "volli",
      reason: "subagent-notice",
    });
    await accept(w.t, w.runnerId, w.parent.sessionId, [told]);
    await accept(w.t, w.runnerId, c.sessionId, c.events);
    const history = [...c.events];
    for (const reason of [
      "shell-notice",
      "browser-notice",
      "watch-notice",
      "subagent-notice",
      "worktree-notice",
    ] as const) {
      const command = messageFact(history, randomUUID(), { kind: "volli", reason });
      history.push(command);
      const start = nextFact(history, { kind: "turn.started", attachmentId: "a", turnId: reason });
      history.push(start);
      const end = nextFact(history, { kind: "turn.completed", attachmentId: "a", turnId: reason });
      history.push(end);
      await accept(w.t, w.runnerId, c.sessionId, [command, start, end]);
    }
    expect(
      (await jobs(w.t, w.parent.sessionId)).filter((job) => job.kind === "session.notice"),
    ).toHaveLength(0);
    const command = messageFact(history, randomUUID(), { kind: "volli", reason: "shell-notice" });
    history.push(command);
    const start = nextFact(history, { kind: "turn.started", attachmentId: "a", turnId: "joined" });
    history.push(start);
    await accept(w.t, w.runnerId, c.sessionId, [command, start]);
    expect((await slots(w.t))[0]?.watch?.active).toBeNull();
    const joined = messageFact(history, randomUUID(), {
      kind: "session",
      sessionId: w.parent.sessionId,
    });
    history.push(joined);
    const secondJoin = messageFact(history);
    history.push(secondJoin);
    await accept(w.t, w.runnerId, c.sessionId, [joined, secondJoin]);
    const end = nextFact(history, { kind: "turn.completed", attachmentId: "a", turnId: "joined" });
    await accept(w.t, w.runnerId, c.sessionId, [end]);
    const notices = (await jobs(w.t, w.parent.sessionId)).filter(
      (job) => job.kind === "session.notice",
    );
    expect(notices.map((job) => job.commandId)).toEqual([`${c.operationId}:resume:joined:answer`]);
  });

  test("an original parent-stop settles without an answer command and later work uses resume ids", async () => {
    const w = await world();
    const c = await w.child("suppressed");
    const history = c.events.slice(0, c.end);
    await accept(w.t, w.runnerId, c.sessionId, history);
    const stop = nextFact(history, {
      kind: "session.stopped",
      reason: null,
      by: { kind: "session", sessionId: w.parent.sessionId },
    });
    history.push(stop);
    const originalOpen = c.events.find(
      (event) => event.payload.kind === "attachment.opened",
    )!.payload;
    if (originalOpen.kind !== "attachment.opened") throw new Error("No attachment");
    const close = nextFact(history, {
      kind: "attachment.closed",
      attachmentId: originalOpen.attachment.id,
      outcome: "interrupted",
    });
    history.push(close);
    await accept(w.t, w.runnerId, c.sessionId, [stop, close]);
    expect((await slots(w.t))[0]?.watch).toMatchObject({ originalSettled: true, active: null });
    expect(await jobs(w.t, w.parent.sessionId)).toEqual([]);
    const attachment = { ...originalOpen.attachment, id: randomUUID() };
    const open = nextFact(history, { kind: "attachment.opened", attachment });
    history.push(open);
    const command = messageFact(history);
    history.push(command);
    const start = nextFact(history, {
      kind: "turn.started",
      attachmentId: attachment.id,
      turnId: "after-stop",
    });
    history.push(start);
    const end = nextFact(history, {
      kind: "turn.completed",
      attachmentId: attachment.id,
      turnId: "after-stop",
    });
    await accept(w.t, w.runnerId, c.sessionId, [open, command, start, end]);
    const notices = (await jobs(w.t, w.parent.sessionId)).filter(
      (job) => job.kind === "session.notice",
    );
    expect(notices.map((job) => job.commandId)).toEqual([
      `${c.operationId}:resume:after-stop:answer`,
    ]);
  });

  test("an original notice parked on the parent is not replaced by another unanswered turn", async () => {
    const w = await world();
    const c = await w.child("parked");
    await accept(w.t, w.runnerId, c.sessionId, c.events);
    const before = await jobs(w.t, w.parent.sessionId);
    const command = messageFact(c.events, randomUUID(), { kind: "volli", reason: "shell-notice" });
    const start = nextFact([...c.events, command], {
      kind: "turn.started",
      attachmentId: "a",
      turnId: "still-unanswered",
    });
    const end = nextFact([...c.events, command, start], {
      kind: "turn.interrupted",
      attachmentId: "a",
      turnId: "still-unanswered",
    });
    await accept(w.t, w.runnerId, c.sessionId, [command, start, end]);
    expect(await jobs(w.t, w.parent.sessionId)).toEqual(before);
    expect((await slots(w.t))[0]?.watch).toMatchObject({
      originalOutcome: true,
      originalSettled: false,
      active: null,
    });
  });

  test("parent stop cascades only to still-running children claimed on another runner", async () => {
    const w = await world();
    const remoteRunner = await seedRunner(w.t, w.userId);
    const local = await w.child("local");
    const remote = await w.child("remote");
    const settled = await w.child("settled");
    await accept(w.t, w.runnerId, local.sessionId, local.events.slice(0, local.end));
    await accept(w.t, remoteRunner, remote.sessionId, remote.events.slice(0, remote.end));
    await accept(w.t, remoteRunner, settled.sessionId, settled.events);
    const stop = nextFact(w.parent.events.slice(0, w.end), {
      kind: "session.stopped",
      reason: null,
      by: { kind: "user" },
    });
    await accept(w.t, w.runnerId, w.parent.sessionId, [stop]);
    await accept(w.t, w.runnerId, w.parent.sessionId, [stop]);
    expect(
      (await jobs(w.t, local.sessionId)).filter((job) => job.kind === "session.command"),
    ).toEqual([]);
    expect(
      (await jobs(w.t, settled.sessionId)).filter((job) => job.kind === "session.command"),
    ).toEqual([]);
    const stops = (await jobs(w.t, remote.sessionId)).filter(
      (job) => job.kind === "session.command",
    );
    expect(stops).toHaveLength(1);
    expect(
      (await slots(w.t)).find((slot) => slot.childSessionId === remote.sessionId)?.stopCommandId,
    ).toBe(stops[0]!.commandId);
    expect(stops[0]).toMatchObject({
      runnerId: remoteRunner,
      sessionId: remote.sessionId,
      payload: {
        intent: encodeSessionJson({
          kind: "session.stop",
          reason: "Parent Session stopped",
          by: { kind: "session", sessionId: w.parent.sessionId },
        }),
      },
    });
  });

  test("the projected running child makes B2 turn-end deferral effective", async () => {
    const w = await world();
    const watcher = await seedSession(
      w.t,
      { projectId: w.projectId, ticketId: w.ticket.ticketId },
      w.userId,
    );
    const agent = w.t.withIdentity({
      issuer: AGENT_TOKEN_ISSUER,
      subject: `agent:${watcher.sessionId}`,
      own: w.userId,
      rnr: watcher.runnerId,
      gen: 1,
    });
    await agent.mutation(api.watches.watch, {
      watcherSessionId: watcher.sessionId,
      target: { kind: "session", id: w.parent.sessionId },
      commandId: newId("command"),
    });
    const c = await w.child();
    await accept(w.t, w.runnerId, c.sessionId, c.events.slice(0, c.end));
    await accept(w.t, w.runnerId, w.parent.sessionId, [w.parent.events[w.end]!]);
    expect(
      (await jobs(w.t, watcher.sessionId)).filter((job) => job.kind === "session.notice"),
    ).toEqual([]);
    const watches = await w.t.run((ctx) =>
      ctx.db
        .query("watches")
        .withIndex("by_watcher", (q) => q.eq("watcherSessionId", watcher.sessionId))
        .collect(),
    );
    expect(watches[0]?.turnArmed).toBe(true);
  });

  test("forParent requires identity and current parent visibility, and exposes no Convex ids", async () => {
    const w = await world();
    const c = await w.child();
    await accept(w.t, w.runnerId, c.sessionId, c.events.slice(0, c.end));
    await expect(w.t.query(forParent, { sessionId: w.parent.sessionId })).rejects.toThrow();
    const rows = await w.as.query(forParent, { sessionId: w.parent.sessionId });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ childSessionId: c.sessionId, status: "running" });
    expect(rows[0]).not.toHaveProperty("_id");
    const bob = await signIn(w.t, "bob");
    await expect(bob.as.query(forParent, { sessionId: w.parent.sessionId })).rejects.toMatchObject(
      code("not_found"),
    );
    // Give Bob membership, but not private Session visibility.
    await w.t.run((ctx) =>
      ctx.db.insert("workspaceMembers", {
        id: newId("member"),
        workspaceId: w.workspaceId,
        userId: bob.userId,
        role: "member",
        status: "active",
        billingTier: "free",
        joinedAt: 0,
        suspendedAt: null,
        leftAt: null,
        invitedByUserId: null,
      }),
    );
    const parent = (await session(w.t, w.parent.sessionId))!;
    await w.t.run((ctx) =>
      ctx.db.patch(parent._id, {
        visibility: "private",
        visibilityReason: "adhoc",
        sharedAt: null,
      }),
    );
    await expect(bob.as.query(forParent, { sessionId: parent.id })).rejects.toMatchObject(
      code("not_found"),
    );
    expect(await w.as.query(forParent, { sessionId: parent.id })).toHaveLength(1);
  });
});

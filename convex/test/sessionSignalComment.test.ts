/**
 * The todo list a Session's `done` / `blocked` signal leaves on its ticket,
 * derived by the accept fold (`lib/sessionDerived.ts`): written as the
 * `agent` Actor when the signal's facts land, so a signal made offline leaves
 * its comment when the drain catches up, and at most once per signal however
 * often the fold passes it.
 *
 * Histories are written by the real Session Engine and accepted through the
 * real codec, as a runner's drain sends them.
 */

import { createHash, randomUUID } from "node:crypto";

import { convexTest } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vite-plus/test";

import type { SessionEvent, SessionEventProvenance, SessionTodoList } from "@volli/shared";
import { RUNNER_TOKEN_ISSUER, type UserId } from "@volli/shared/cloud";

import { api, internal } from "../functions/_generated/api";
import { seedTestWorld } from "../functions/lib/testWorld";
import schema from "../functions/schema";
import { enrollPreview } from "./preview-fixtures";
import { userProvenance, wire, writeSession } from "./sessionFixtures";

const modules = import.meta.glob("../functions/**/*.ts");
const ISSUER = "https://issuer.test";
const venue = { id: "local", kind: "local" } as const;

type T = ReturnType<typeof convexTest>;

const adapterProvenance: SessionEventProvenance = {
  source: { kind: "adapter", id: "pi", detail: { channel: "rpc" } },
  venue,
};

/** What the local agent socket stamps on `volli session done`: the Session's own act. */
function ownSignalProvenance(sessionId: string): SessionEventProvenance {
  return {
    source: {
      kind: "adapter",
      id: "terminal",
      detail: { sessionOrigin: { kind: "session", sessionId } },
    },
    venue,
  };
}

const LIST: SessionTodoList = [
  { content: "Read the intake", status: "completed" },
  { content: "Write the fold", status: "in_progress" },
  { content: "Ship it", status: "pending" },
];
const LIST_MARKDOWN = "- [x] Read the intake\n- [ ] Write the fold (in progress)\n- [ ] Ship it";

/**
 * The frozen derivation, written out again: a UUID (v8) from the SHA-256 of
 * `session-signal-comment:{sessionId}:{eventId}`. If this test has to change,
 * every signal already accepted will be commented a second time.
 */
function frozenCommentId(sessionId: string, eventId: string): string {
  const bytes = Buffer.from(
    createHash("sha256")
      .update(`session-signal-comment:${sessionId}:${eventId}`)
      .digest()
      .subarray(0, 16),
  );
  bytes[6] = (bytes[6]! & 0x0f) | 0x80;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

async function world() {
  const t = convexTest(schema, modules);
  const alice = (
    await t
      .withIdentity({ subject: "user:alice", issuer: ISSUER })
      .mutation(api.accounts.ensureViewer, {})
  ).userId as UserId;
  // The person and their runner token's owner are the same account: both the
  // accept below and the agent commands later recheck the grant.
  await enrollPreview(t, alice);
  const seeded = await t.run(async (ctx) => {
    const seededWorld = await seedTestWorld(ctx, { ownerUserId: alice, runners: 1 });
    // A project is created with its counter; the seed predates board writes.
    await ctx.db.insert("projectCounters", {
      projectId: seededWorld.projectId,
      nextTicketNumber: 2,
      boardSeq: 0,
    });
    return seededWorld;
  });
  return { t, alice, ...seeded, runner: seeded.runnerIds[0]! };
}

/**
 * A ticket Session (the fixture's history, which ends `blocked` by its
 * person), then one more turn whose transcript digest carries `todoList`,
 * then a signal recorded with `provenance`.
 */
async function signalledSession(script: {
  projectId: string;
  ticketId: string | null;
  todoList: SessionTodoList | null;
  signal: "done" | "blocked";
  own?: boolean;
}): Promise<{ sessionId: string; events: SessionEvent[]; signalled: SessionEvent }> {
  const { sessionId, events, engine } = await writeSession({
    projectId: script.projectId,
    ticketId: script.ticketId,
  });
  const opened = events.find(({ payload }) => payload.kind === "attachment.opened")!;
  if (opened.payload.kind !== "attachment.opened") throw new Error("no attachment");
  const attachmentId = opened.payload.attachment.id;
  let clock = events.at(-1)!.occurredAt + 1;
  const observe = (fields: Record<string, unknown>) =>
    engine.observe({
      id: randomUUID(),
      sessionId,
      occurredAt: clock++,
      provenance: adapterProvenance,
      ...fields,
    } as never);
  await engine.submit({
    commandId: randomUUID(),
    sessionId,
    intent: {
      kind: "message.submit",
      reference: { id: `sha256:${"a".repeat(64)}`, mediaType: "application/json", digest: null },
    },
    provenance: userProvenance,
  });
  const turnId = randomUUID();
  await observe({ kind: "turn.started", attachmentId, turnId });
  await observe({
    kind: "transcript.referenced",
    attachmentId,
    turnId,
    reference: { id: `sha256:${"c".repeat(64)}`, mediaType: "application/json", digest: null },
    digest:
      script.todoList === null
        ? { role: "assistant", reply: true }
        : { role: "assistant", reply: true, todoList: script.todoList },
  });
  await observe({ kind: "turn.completed", attachmentId, turnId });
  await engine.submit({
    commandId: randomUUID(),
    sessionId,
    intent: { kind: "session.signal", signal: script.signal, reason: null },
    provenance: script.own === false ? userProvenance : ownSignalProvenance(sessionId),
  });
  const all = [...(await engine.listEvents({ sessionId }))];
  const signalled = all.findLast(({ payload }) => payload.kind === "session.signaled")!;
  return { sessionId, events: all, signalled };
}

function accept(t: T, runnerId: string, sessionId: string, events: readonly SessionEvent[]) {
  return t
    .withIdentity({ subject: `runner:${runnerId}`, issuer: RUNNER_TOKEN_ISSUER })
    .mutation(api.sessions.accept, { sessionId, generation: 1, events: events.map(wire) });
}

async function drain(t: T, runnerId: string, sessionId: string, events: readonly SessionEvent[]) {
  for (const event of events) await accept(t, runnerId, sessionId, [event]);
}

/** Everything before the last signal's command, and the signal's facts (command, signal, receipt). */
function splitAtSignal(events: readonly SessionEvent[], signalled: SessionEvent) {
  const at = events.findIndex(({ sequence }) => sequence === signalled.sequence) - 1;
  return { before: events.slice(0, at), signal: events.slice(at) };
}

const comments = (t: T) => t.run((ctx) => ctx.db.query("ticketComments").collect());
const commented = (t: T) =>
  t.run(async (ctx) =>
    (await ctx.db.query("boardEvents").collect()).filter(({ kind }) => kind === "commented"),
  );

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("a signal's todo list on its ticket", () => {
  test("done offline: the comment appears when the drain lands, as the agent, once", async () => {
    const { t, alice, runner, projectId, ticketId } = await world();
    const { sessionId, events, signalled } = await signalledSession({
      projectId,
      ticketId,
      todoList: LIST,
      signal: "done",
    });
    const { before, signal } = splitAtSignal(events, signalled);
    expect(signal.map(({ payload }) => payload.kind)).toEqual([
      "command.recorded",
      "session.signaled",
      "command.receipt.recorded",
    ]);
    // The fixture's own `blocked`, signalled by its person, leaves nothing.
    await drain(t, runner, sessionId, before);
    expect(await comments(t)).toEqual([]);

    // The runner was offline: the signal's facts land together later.
    await accept(t, runner, sessionId, signal);
    const actor = { kind: "agent", userId: alice, sessionId, ticketId };
    expect(await comments(t)).toEqual([
      expect.objectContaining({
        id: frozenCommentId(sessionId, signalled.id),
        ticketId,
        projectId,
        sessionId,
        author: actor,
        body: `Todo list at session done:\n\n${LIST_MARKDOWN}`,
        editedAt: null,
        deletedAt: null,
      }),
    ]);
    const [comment] = await comments(t);
    expect(await commented(t)).toEqual([
      expect.objectContaining({
        ticketId,
        actor,
        payload: { kind: "commented", commentId: comment!.id },
      }),
    ]);
    // The board's own read shows it to the owner.
    await expect(
      t
        .withIdentity({ subject: "user:alice", issuer: ISSUER })
        .query(api.board.comments, { ticketId }),
    ).resolves.toEqual([expect.objectContaining({ id: comment!.id })]);

    // A resend of the same facts is a duplicate and derives nothing.
    await expect(accept(t, runner, sessionId, signal)).resolves.toMatchObject({
      duplicates: signal.length,
    });
    expect(await comments(t)).toHaveLength(1);
  });

  test("a missing board counter is typed, logged, and rolls back the signal's derived writes", async () => {
    const { t, runner, projectId, ticketId } = await world();
    const { sessionId, events, signalled } = await signalledSession({
      projectId,
      ticketId,
      todoList: LIST,
      signal: "done",
    });
    const { before, signal } = splitAtSignal(events, signalled);
    await drain(t, runner, sessionId, before);
    const counter = await t.run(async (ctx) => {
      const row = await ctx.db.query("projectCounters").first();
      await ctx.db.delete(row!._id);
      const { _id: _ignoredId, _creationTime: _ignoredTime, ...copy } = row!;
      return copy;
    });
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(accept(t, runner, sessionId, signal)).rejects.toMatchObject({
      data: { code: "corrupt_board", acceptedThrough: before.length },
    });
    expect(log).toHaveBeenCalledTimes(1);
    expect(JSON.parse(log.mock.calls[0]![0])).toMatchObject({
      event: "session_intake_rejected",
      code: "corrupt_board",
      phase: "derive",
      acceptedThrough: before.length,
      sequence: signalled.sequence,
      kind: "session.signaled",
    });
    expect(log.mock.calls[0]![0]).not.toContain("Read the intake");
    expect(await comments(t)).toEqual([]);
    expect(await commented(t)).toEqual([]);
    const rows = await t.run(async (ctx) => ({
      intake: await ctx.db.query("sessionIntake").first(),
      events: await ctx.db.query("sessionEvents").collect(),
    }));
    expect(rows.intake?.acceptedThrough).toBe(before.length);
    expect(rows.events).toHaveLength(before.length);
    // Repair plus the runner's resend replays the retained signal once.
    await t.run((ctx) => ctx.db.insert("projectCounters", counter));
    await accept(t, runner, sessionId, signal);
    expect(await comments(t)).toHaveLength(1);
    expect(log).toHaveBeenCalledTimes(1);
  });

  test("blocked leaves the list too, under its own heading", async () => {
    const { t, runner, projectId, ticketId } = await world();
    const { sessionId, events } = await signalledSession({
      projectId,
      ticketId,
      todoList: LIST,
      signal: "blocked",
    });
    await drain(t, runner, sessionId, events);
    expect((await comments(t)).map(({ body }) => body)).toEqual([
      `Todo list at session blocked:\n\n${LIST_MARKDOWN}`,
    ]);
  });

  test("a refold, even one that derives every fact again, keeps the one comment", async () => {
    vi.useFakeTimers();
    const { t, runner, projectId, ticketId } = await world();
    const { sessionId, events, signalled } = await signalledSession({
      projectId,
      ticketId,
      todoList: LIST,
      signal: "done",
    });
    await drain(t, runner, sessionId, events);
    const first = await comments(t);
    expect(first).toHaveLength(1);

    await expect(t.mutation(internal.sessions.refold, { sessionId })).resolves.toBe(true);
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await comments(t)).toEqual(first);

    // A state that never recorded what it derived (written before
    // `derivedThrough`, or a migrated Session's first fold) derives every
    // fact again: the frozen id finds the comment already there.
    await t.run(async (ctx) => {
      const doc = (await ctx.db.query("sessionStates").first())!;
      await ctx.db.patch(doc._id, { derivedThrough: 0 });
    });
    await t.mutation(internal.sessions.refold, { sessionId });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await comments(t)).toEqual(first);
    expect(first[0]!.id).toBe(frozenCommentId(sessionId, signalled.id));
    expect(await commented(t)).toHaveLength(1);
  });

  test("the local board's own comment, migrated with a minted id, is not left again", async () => {
    const { t, alice, runner, projectId, ticketId } = await world();
    const { sessionId, events, signalled } = await signalledSession({
      projectId,
      ticketId,
      todoList: LIST,
      signal: "done",
    });
    const migrated = randomUUID();
    await t.run((ctx) =>
      ctx.db.insert("ticketComments", {
        id: migrated,
        ticketId,
        projectId,
        sessionId,
        author: { kind: "agent", userId: alice, sessionId, ticketId },
        body: `Todo list at session done:\n\n${LIST_MARKDOWN}`,
        createdAt: signalled.occurredAt + 5,
        editedAt: null,
        deletedAt: null,
      }),
    );
    await drain(t, runner, sessionId, events);
    expect((await comments(t)).map(({ id }) => id)).toEqual([migrated]);
    expect(await commented(t)).toEqual([]);
  });

  test("leaves nothing where the local verb would not, and the accept still lands", async () => {
    const cases: {
      name: string;
      ticket: boolean;
      todoList: SessionTodoList | null;
      own?: boolean;
      archive?: "ticket" | "project";
    }[] = [
      { name: "a person's signal", ticket: true, todoList: LIST, own: false },
      { name: "a Board Session", ticket: false, todoList: LIST },
      { name: "no list ever written", ticket: true, todoList: null },
      { name: "a cleared list", ticket: true, todoList: [] },
      { name: "an archived ticket", ticket: true, todoList: LIST, archive: "ticket" },
      { name: "an archived project", ticket: true, todoList: LIST, archive: "project" },
    ];
    for (const script of cases) {
      const { t, runner, projectId, ticketId } = await world();
      const { sessionId, events, signalled } = await signalledSession({
        projectId,
        ticketId: script.ticket ? ticketId : null,
        todoList: script.todoList,
        signal: "done",
        ...(script.own === undefined ? {} : { own: script.own }),
      });
      const { before, signal } = splitAtSignal(events, signalled);
      await drain(t, runner, sessionId, before);
      if (script.archive !== undefined) {
        await t.run(async (ctx) => {
          if (script.archive === "ticket") {
            const ticket = (await ctx.db.query("tickets").first())!;
            await ctx.db.patch(ticket._id, { archivedAt: Date.now() });
          } else {
            const project = (await ctx.db.query("projects").first())!;
            await ctx.db.patch(project._id, { archivedAt: Date.now() });
          }
        });
      }
      await expect(accept(t, runner, sessionId, signal), script.name).resolves.toMatchObject({
        acceptedThrough: events.length,
      });
      expect(await comments(t), script.name).toEqual([]);
      expect(await commented(t), script.name).toEqual([]);
    }
  });
});

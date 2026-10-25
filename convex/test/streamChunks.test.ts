import { convexTest } from "convex-test";
import type { GenericMutationCtx } from "convex/server";
import { afterEach, describe, expect, test, vi } from "vite-plus/test";

import {
  RUNNER_TOKEN_ISSUER,
  SESSION_VIEWER_TTL_MS,
  STREAM_CHUNK_TTL_MS,
  newId,
  runnerSubject,
  type RunnerId,
  type StreamChunkAppend,
} from "@volli/shared/cloud";

import { api, internal } from "../functions/_generated/api";
import type { DataModel } from "../functions/_generated/dataModel.js";
import { endedTurnsOf, scheduleStreamCleanup } from "../functions/lib/streamChunks";
import { seedTestWorld } from "../functions/lib/testWorld";
import schema from "../functions/schema";
import {
  SETTLE_ATTEMPTS,
  SINCE_DISCOVERY_ROWS,
  SINCE_MAX_STREAMS,
} from "../functions/streamChunks";
import { SESSION_MAX_VIEWERS } from "../functions/sessionViewers";
import { wire, writeSession } from "./sessionFixtures";

const modules = import.meta.glob("../functions/**/*.ts");

type Ctx = GenericMutationCtx<DataModel>;
function setup() {
  return convexTest(schema, modules);
}
type T = ReturnType<typeof setup>;

const ISSUER = "https://issuer.test";
const OWNER = { subject: "user:owner", issuer: ISSUER };
const TEAMMATE = { subject: "user:teammate", issuer: ISSUER };
const OUTSIDER = { subject: "user:outsider", issuer: ISSUER };

afterEach(() => {
  vi.useRealTimers();
});

function code(value: string) {
  return expect.objectContaining({ data: expect.objectContaining({ code: value }) });
}

async function signIn(t: T, identity: typeof OWNER): Promise<string> {
  return (await t.withIdentity(identity).mutation(api.accounts.ensureViewer, {})).userId;
}

function asRunner(t: T, runnerId: string) {
  return t.withIdentity({
    issuer: RUNNER_TOKEN_ISSUER,
    subject: runnerSubject(runnerId as RunnerId),
    gen: 1,
  });
}

async function seedRunner(ctx: Ctx, ownerUserId: string): Promise<string> {
  const id = newId("runner");
  await ctx.db.insert("runners", {
    id,
    ownerUserId,
    kind: "mac",
    name: `mac-${id.slice(0, 6)}`,
    status: "online",
    statusReason: null,
    statusChangedAt: 0,
    version: "0.3.0",
    platform: { os: "darwin", distro: null, kernel: null, arch: "arm64", glibc: null },
    capabilities: {},
    installMode: "app",
    linkedVia: "desktop",
    linkedAt: 0,
    autoUpdate: { enabled: true, channel: "stable", pinnedVersion: null },
    update: null,
    revokedAt: null,
    createdAt: 0,
  });
  return id;
}

/**
 * A Workspace with the owner and a teammate, a project, and a shared Session
 * the owner's runner runs, plus a private one. The runner signs in
 * with a runner token (`asRunner`).
 */
async function world(t: T) {
  const owner = await signIn(t, OWNER);
  const teammate = await signIn(t, TEAMMATE);
  await signIn(t, OUTSIDER);
  const seeded = await t.run(async (ctx) => {
    const workspaceId = newId("workspace");
    await ctx.db.insert("workspaces", {
      id: workspaceId,
      name: "Acme",
      slug: `acme-${workspaceId.slice(0, 8)}`,
      iconKey: null,
      createdByUserId: owner,
      planKey: "free",
      activeMemberCount: 2,
      createdAt: 0,
      deletedAt: null,
      purgeAfter: null,
    });
    for (const userId of [owner, teammate]) {
      await ctx.db.insert("workspaceMembers", {
        id: newId("member"),
        workspaceId,
        userId,
        role: userId === owner ? "owner" : "member",
        status: "active",
        billingTier: "free",
        joinedAt: 0,
        suspendedAt: null,
        leftAt: null,
        invitedByUserId: null,
      });
    }
    const projectId = newId("project");
    await ctx.db.insert("projects", {
      id: projectId,
      workspaceId,
      name: "Volli",
      description: "",
      iconKey: null,
      colorIndex: 0,
      ticketPrefix: "VC",
      origin: "github",
      shipBehaviour: "pr",
      customShipPrompt: null,
      coAuthorDefault: true,
      countsTowardCap: true,
      createdByUserId: owner,
      createdAt: 0,
      updatedAt: 0,
      archivedAt: null,
      deletedAt: null,
      purgeAfter: null,
    });
    const runnerId = await seedRunner(ctx, owner);
    const otherRunnerId = await seedRunner(ctx, owner);
    const session = async (visibility: "shared" | "private") => {
      const id = newId("session");
      await ctx.db.insert("sessions", {
        id,
        projectId,
        ticketId: null,
        role: visibility === "shared" ? "ticket" : "project",
        parentSessionId: null,
        ownerUserId: owner,
        origin: { kind: "person" },
        title: null,
        visibility,
        visibilityReason: visibility === "shared" ? "ticket" : "adhoc",
        sharedAt: null,
        status: "open",
        turnActive: true,
        lastTurnOutcome: null,
        signal: null,
        stopped: null,
        needsUser: false,
        attentionCount: 0,
        placeRunnerId: runnerId,
        model: null,
        usageTotals: {},
        createdAt: 0,
        lastActivityAt: 0,
        deletedAt: null,
        purgeAfter: null,
      });
      return id;
    };
    const sessionId = await session("shared");
    const privateSessionId = await session("private");
    await ctx.db.insert("sessionIntake", {
      sessionId,
      claim: { runnerId, generation: 1 },
      acceptedThrough: 10,
      lastEventId: null,
      lastAcceptedAt: null,
      state: "active",
    });
    return {
      owner,
      teammate,
      sessionId,
      privateSessionId,
      runnerId,
      otherRunnerId,
    };
  });
  return {
    ...seeded,
    runner: asRunner(t, seeded.runnerId),
    otherRunner: asRunner(t, seeded.otherRunnerId),
  };
}

const reset = (text: string) => ({
  op: "reset",
  message: { id: "m1", role: "assistant", parts: [{ key: "t", part: { type: "text", text } }] },
});
const append = (text: string) => ({ op: "part.append", key: "t", text });

type ChunkInput = Pick<StreamChunkAppend, "seq" | "baseline" | "throughSequence" | "ops">;

function chunk(seq: number, ops: object[], throughSequence = 10): ChunkInput {
  return {
    seq,
    baseline: (ops[0] as { op: string }).op === "reset",
    throughSequence,
    ops: JSON.stringify(ops),
  };
}

/** Appends each chunk of one stream in turn, as a runner does. */
async function sendAll(
  w: Awaited<ReturnType<typeof world>>,
  messageId: string,
  turnId: string | null,
  chunks: ChunkInput[],
) {
  for (const input of chunks) {
    await w.runner.mutation(api.streamChunks.append, {
      sessionId: w.sessionId,
      messageId,
      turnId,
      ...input,
    });
  }
}

async function rowsOf(t: T, sessionId: string) {
  return t.run((ctx) =>
    ctx.db
      .query("streamChunks")
      .withIndex("by_session_message_seq", (q) => q.eq("sessionId", sessionId))
      .collect(),
  );
}

describe("streamChunks.append", () => {
  test("stores consecutive chunks once, from the runner that runs the Session", async () => {
    const t = setup();
    const w = await world(t);
    const first = {
      sessionId: w.sessionId,
      messageId: "m1",
      turnId: "turn-1",
      ...chunk(0, [reset("he")]),
    };
    expect(await w.runner.mutation(api.streamChunks.append, first)).toEqual({ written: true });
    // A resend (a retried mutation) writes nothing twice.
    expect(await w.runner.mutation(api.streamChunks.append, first)).toEqual({ written: false });
    await sendAll(w, "m1", "turn-1", [chunk(1, [append("llo")])]);
    const rows = await rowsOf(t, w.sessionId);
    expect(
      rows.map(({ seq, baseline, turnId, throughSequence }) => ({
        seq,
        baseline,
        turnId,
        throughSequence,
      })),
    ).toEqual([
      { seq: 0, baseline: true, turnId: "turn-1", throughSequence: 10 },
      { seq: 1, baseline: false, turnId: "turn-1", throughSequence: 10 },
    ]);
    expect(JSON.parse(rows[1].delta)).toEqual([append("llo")]);
  });

  test("refuses a person, a runner that does not run the Session, and a missing Session", async () => {
    const t = setup();
    const w = await world(t);
    const args = {
      sessionId: w.sessionId,
      messageId: "m1",
      turnId: null,
      ...chunk(0, [reset("a")]),
    };
    await expect(t.withIdentity(OWNER).mutation(api.streamChunks.append, args)).rejects.toThrow();
    await expect(w.otherRunner.mutation(api.streamChunks.append, args)).rejects.toEqual(
      code("not_claimed"),
    );
    await expect(
      w.runner.mutation(api.streamChunks.append, { ...args, sessionId: newId("session") }),
    ).rejects.toEqual(code("not_claimed"));
    await t.run(async (ctx) => {
      const row = await ctx.db
        .query("sessions")
        .withIndex("by_uuid", (q) => q.eq("id", w.sessionId))
        .unique();
      await ctx.db.patch(row!._id, { deletedAt: 1 });
    });
    await expect(w.runner.mutation(api.streamChunks.append, args)).rejects.toEqual(
      code("not_claimed"),
    );
  });

  test("refuses malformed chunks", async () => {
    const t = setup();
    const w = await world(t);
    const base = { sessionId: w.sessionId, messageId: "m1", turnId: null };
    const ok = { ...base, ...chunk(0, [reset("a")]) };
    const refused = [
      { ...ok, messageId: "" },
      { ...ok, messageId: "x".repeat(513) },
      { ...ok, turnId: "x".repeat(513) },
      { ...ok, seq: -1 },
      { ...ok, seq: 0.5 },
      { ...ok, throughSequence: -1 },
      { ...base, ...chunk(0, [append("a")]), baseline: true },
      { ...base, seq: 0, baseline: false, throughSequence: 0, ops: "nope" },
    ];
    for (const args of refused) {
      await expect(w.runner.mutation(api.streamChunks.append, args)).rejects.toEqual(
        code("invalid_chunk"),
      );
    }
    expect(await rowsOf(t, w.sessionId)).toEqual([]);
  });
});

describe("streamChunks.since", () => {
  test("a late joiner starts at the latest baseline; a cursor reads only what follows it", async () => {
    const t = setup();
    const w = await world(t);
    const send = (messageId: string, chunks: ChunkInput[]) =>
      sendAll(w, messageId, "turn-1", chunks);
    await send("m1", [
      chunk(0, [reset("a")]),
      chunk(1, [append("b")]),
      chunk(2, [reset("abc")]),
      chunk(3, [append("d")]),
    ]);
    await send("m2", [chunk(0, [reset("x")])]);
    const teammate = t.withIdentity(TEAMMATE);

    const joined = await teammate.query(api.streamChunks.since, {
      sessionId: w.sessionId,
      cursors: [],
    });
    // Newest stream first.
    expect(joined.streams.map((s) => [s.messageId, s.turnId, s.chunks.map((c) => c.seq)])).toEqual([
      ["m2", "turn-1", [0]],
      ["m1", "turn-1", [2, 3]],
    ]);
    expect(joined.streams[1].chunks[0]).toEqual({
      seq: 2,
      baseline: true,
      throughSequence: 10,
      ops: JSON.stringify([reset("abc")]),
    });

    // Caught up: nothing past the cursors.
    const caughtUp = await teammate.query(api.streamChunks.since, {
      sessionId: w.sessionId,
      cursors: [
        { messageId: "m1", seq: 3 },
        { messageId: "m2", seq: 0 },
      ],
    });
    expect(caughtUp.streams).toEqual([]);
    // Caught up is not ended: both streams still have rows.
    expect(caughtUp.retired).toEqual([]);

    await send("m1", [chunk(4, [append("e")])]);
    const next = await teammate.query(api.streamChunks.since, {
      sessionId: w.sessionId,
      cursors: [{ messageId: "m1", seq: 3 }],
    });
    // m1 after its cursor; m2 has no cursor here, so it comes from its baseline.
    expect(next.streams.map((s) => [s.messageId, s.chunks.map((c) => c.seq)])).toEqual([
      ["m1", [4]],
      ["m2", [0]],
    ]);

    // A cursor a newer baseline has overtaken skips to that baseline.
    const behind = await teammate.query(api.streamChunks.since, {
      sessionId: w.sessionId,
      cursors: [{ messageId: "m1", seq: 0 }],
    });
    expect(behind.streams[0].chunks.map((c) => c.seq)).toEqual([2, 3, 4]);
    // A cursor for a stream that is gone (settled, swept) returns nothing for it.
    const gone = await teammate.query(api.streamChunks.since, {
      sessionId: w.sessionId,
      cursors: [{ messageId: "m9", seq: 4 }],
    });
    expect(gone.streams.map((s) => s.messageId)).toEqual(["m1", "m2"]);
    // …and names it as ended, with the accepted cursor its fact is at or below.
    expect(gone.retired).toEqual([{ messageId: "m9", throughSequence: 10 }]);
    expect(joined.retired).toEqual([]);
  });

  test("a cursor's stream whose rows were all deleted is retired at the accepted cursor", async () => {
    const t = setup();
    const w = await world(t);
    await streamed(w, "m1");
    await streamed(w, "m2");
    const teammate = t.withIdentity(TEAMMATE);
    const cursors = [
      { messageId: "m1", seq: 1 },
      { messageId: "m2", seq: 1 },
    ];
    expect(
      await teammate.query(api.streamChunks.since, { sessionId: w.sessionId, cursors }),
    ).toEqual({ streams: [], retired: [] });
    // m1 settled at 12 and its rows went once 12 was accepted.
    await setAccepted(t, w.sessionId, 12);
    await t.run(async (ctx) => {
      for (const row of await ctx.db
        .query("streamChunks")
        .withIndex("by_session_message_seq", (q) =>
          q.eq("sessionId", w.sessionId).eq("messageId", "m1"),
        )
        .collect()) {
        await ctx.db.delete(row._id);
      }
    });
    expect(
      await teammate.query(api.streamChunks.since, { sessionId: w.sessionId, cursors }),
    ).toEqual({ streams: [], retired: [{ messageId: "m1", throughSequence: 12 }] });
  });

  test("a stream with no baseline yet is read only from a cursor", async () => {
    const t = setup();
    const w = await world(t);
    // The baseline (seq 0) was lost; only an increment arrived.
    await sendAll(w, "m1", null, [chunk(1, [append("b")])]);
    const teammate = t.withIdentity(TEAMMATE);
    expect(
      (await teammate.query(api.streamChunks.since, { sessionId: w.sessionId, cursors: [] }))
        .streams,
    ).toEqual([]);
    const fromCursor = await teammate.query(api.streamChunks.since, {
      sessionId: w.sessionId,
      cursors: [{ messageId: "m1", seq: 0 }],
    });
    expect(fromCursor.streams[0].chunks.map((c) => c.seq)).toEqual([1]);
  });

  test("a stream past the newest rows is found through the reader's cursor, and cursors are capped", async () => {
    const t = setup();
    const w = await world(t);
    await sendAll(w, "old", "turn-1", [chunk(0, [reset("a")]), chunk(1, [append("b")])]);
    await sendAll(
      w,
      "busy",
      "turn-1",
      Array.from({ length: SINCE_DISCOVERY_ROWS }, (_, seq) =>
        chunk(seq, seq === 0 ? [reset("x")] : [append("y")]),
      ),
    );
    const teammate = t.withIdentity(TEAMMATE);
    const fresh = await teammate.query(api.streamChunks.since, {
      sessionId: w.sessionId,
      cursors: [],
    });
    expect(fresh.streams.map((s) => s.messageId)).toEqual(["busy"]);
    const known = await teammate.query(api.streamChunks.since, {
      sessionId: w.sessionId,
      cursors: [{ messageId: "old", seq: 0 }],
    });
    expect(known.streams.map((s) => [s.messageId, s.chunks.map((c) => c.seq)])).toEqual([
      ["busy", Array.from({ length: SINCE_DISCOVERY_ROWS }, (_, seq) => seq)],
      ["old", [1]],
    ]);
    await expect(
      teammate.query(api.streamChunks.since, {
        sessionId: w.sessionId,
        cursors: Array.from({ length: SINCE_MAX_STREAMS + 1 }, (_, index) => ({
          messageId: `m${index}`,
          seq: 0,
        })),
      }),
    ).rejects.toEqual(code("invalid_chunk"));
  });

  test("only someone who can see the Session reads its chunks", async () => {
    const t = setup();
    const w = await world(t);
    await expect(
      t
        .withIdentity(OUTSIDER)
        .query(api.streamChunks.since, { sessionId: w.sessionId, cursors: [] }),
    ).rejects.toEqual(code("not_found"));
    await expect(
      t
        .withIdentity(TEAMMATE)
        .query(api.streamChunks.since, { sessionId: w.privateSessionId, cursors: [] }),
    ).rejects.toEqual(code("not_found"));
  });
});

async function streamed(
  w: Awaited<ReturnType<typeof world>>,
  messageId = "m1",
  turnId: string | null = "turn-1",
) {
  await sendAll(w, messageId, turnId, [chunk(0, [reset("a")]), chunk(1, [append("b")])]);
}

async function setAccepted(t: T, sessionId: string, acceptedThrough: number) {
  await t.run(async (ctx) => {
    const intake = await ctx.db
      .query("sessionIntake")
      .withIndex("by_session", (q) => q.eq("sessionId", sessionId))
      .unique();
    await ctx.db.patch(intake!._id, { acceptedThrough });
  });
}

describe("streamChunks cleanup", () => {
  test("a settle whose fact is accepted deletes the message's chunks at once", async () => {
    const t = setup();
    const w = await world(t);
    await streamed(w, "m1");
    await streamed(w, "m2");
    expect(
      await w.runner.mutation(api.streamChunks.settle, {
        sessionId: w.sessionId,
        messageId: "m1",
        sequence: 10,
      }),
    ).toEqual({ state: "deleted" });
    expect((await rowsOf(t, w.sessionId)).map((row) => row.messageId)).toEqual(["m2", "m2"]);
  });

  test("a settle that arrives before its fact waits for the accept, then deletes", async () => {
    vi.useFakeTimers();
    const t = setup();
    const w = await world(t);
    await streamed(w);
    expect(
      await w.runner.mutation(api.streamChunks.settle, {
        sessionId: w.sessionId,
        messageId: "m1",
        sequence: 12,
      }),
    ).toEqual({ state: "waiting" });
    expect(await rowsOf(t, w.sessionId)).toHaveLength(2);
    await setAccepted(t, w.sessionId, 12);
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await rowsOf(t, w.sessionId)).toEqual([]);
  });

  test("a settle whose fact never arrives gives up, leaving the rows to the turn's end and the sweep", async () => {
    vi.useFakeTimers();
    const t = setup();
    const w = await world(t);
    await streamed(w);
    await w.runner.mutation(api.streamChunks.settle, {
      sessionId: w.sessionId,
      messageId: "m1",
      sequence: 99,
    });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await rowsOf(t, w.sessionId)).toHaveLength(2);
    expect(
      await t.mutation(internal.streamChunks.cleanupMessage, {
        sessionId: w.sessionId,
        messageId: "m1",
        sequence: 99,
        attempt: SETTLE_ATTEMPTS,
      }),
    ).toBe("abandoned");
  });

  test("settle checks its caller and its arguments", async () => {
    const t = setup();
    const w = await world(t);
    await expect(
      w.otherRunner.mutation(api.streamChunks.settle, {
        sessionId: w.sessionId,
        messageId: "m1",
        sequence: 1,
      }),
    ).rejects.toEqual(code("not_claimed"));
    for (const args of [
      { messageId: "", sequence: 1 },
      { messageId: "m1", sequence: 0 },
      { messageId: "m1", sequence: 1.5 },
    ]) {
      await expect(
        w.runner.mutation(api.streamChunks.settle, { sessionId: w.sessionId, ...args }),
      ).rejects.toEqual(code("invalid_chunk"));
    }
  });

  test("a large stream is deleted in batches", async () => {
    vi.useFakeTimers();
    const t = setup();
    const w = await world(t);
    await t.run(async (ctx) => {
      for (let seq = 0; seq < 300; seq += 1) {
        await ctx.db.insert("streamChunks", {
          sessionId: w.sessionId,
          messageId: "m1",
          seq,
          turnId: "turn-1",
          baseline: seq === 0,
          throughSequence: 1,
          delta: "[]",
          createdAt: 0,
        });
      }
    });
    expect(
      await w.runner.mutation(api.streamChunks.settle, {
        sessionId: w.sessionId,
        messageId: "m1",
        sequence: 1,
      }),
    ).toEqual({ state: "deleting" });
    expect(await rowsOf(t, w.sessionId)).toHaveLength(300 - 64);
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await rowsOf(t, w.sessionId)).toEqual([]);
  });

  test("the accept fold's hook deletes an ended turn's rows and leaves a later turn's", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const t = setup();
    const w = await world(t);
    await streamed(w, "m1", "turn-1");
    await streamed(w, "m2", null);
    vi.setSystemTime(2_000);
    await streamed(w, "m3", "turn-2");
    await streamed(w, "m4", null);
    const events = [
      { payload: { kind: "turn.started", turnId: "turn-2" } },
      { payload: { kind: "turn.completed", turnId: "turn-1" } },
      { payload: { kind: "turn.interrupted", turnId: "turn-1" } },
      { payload: { kind: "turn.completed", turnId: null } },
      { payload: null },
    ];
    expect(endedTurnsOf(events)).toEqual(["turn-1"]);
    await t.run((ctx) =>
      scheduleStreamCleanup(
        ctx,
        w.sessionId,
        { turnIds: endedTurnsOf(events), messageIds: [] },
        1_500,
      ),
    );
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect([...new Set((await rowsOf(t, w.sessionId)).map((row) => row.messageId))]).toEqual([
      "m3",
      "m4",
    ]);

    // Settled messages named by the accepted bodies go too.
    await t.run((ctx) =>
      scheduleStreamCleanup(ctx, w.sessionId, { turnIds: [], messageIds: ["m3"] }, 3_000),
    );
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect([...new Set((await rowsOf(t, w.sessionId)).map((row) => row.messageId))]).toEqual([
      "m4",
    ]);
  });

  test("a turn with many rows is deleted in batches", async () => {
    vi.useFakeTimers();
    const t = setup();
    const w = await world(t);
    await t.run(async (ctx) => {
      for (let seq = 0; seq < 300; seq += 1) {
        await ctx.db.insert("streamChunks", {
          sessionId: w.sessionId,
          messageId: `m${seq % 3}`,
          seq,
          turnId: "turn-1",
          baseline: false,
          throughSequence: 1,
          delta: "[]",
          createdAt: 0,
        });
      }
    });
    await t.mutation(internal.streamChunks.cleanupTurn, {
      sessionId: w.sessionId,
      turnId: "turn-1",
      cutoff: 0,
    });
    expect(await rowsOf(t, w.sessionId)).toHaveLength(300 - 64);
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await rowsOf(t, w.sessionId)).toEqual([]);
  });

  test("the sweep removes rows older than the TTL, in batches", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(STREAM_CHUNK_TTL_MS * 2);
    const t = setup();
    const w = await world(t);
    await t.run(async (ctx) => {
      for (let seq = 0; seq < 300; seq += 1) {
        await ctx.db.insert("streamChunks", {
          sessionId: w.sessionId,
          messageId: "old",
          seq,
          turnId: null,
          baseline: false,
          throughSequence: 1,
          delta: "[]",
          createdAt: 0,
        });
      }
    });
    await streamed(w, "fresh");
    expect(await t.mutation(internal.streamChunks.sweep, {})).toBe(64);
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect([...new Set((await rowsOf(t, w.sessionId)).map((row) => row.messageId))]).toEqual([
      "fresh",
    ]);
  });
});

describe("sessionViewers", () => {
  test("a viewer opens, renews and closes; the runner sees the Session watched while it is open", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    const t = setup();
    const w = await world(t);
    const teammate = t.withIdentity(TEAMMATE);
    const viewerId = newId("session");
    expect(await w.runner.query(api.sessionViewers.watched, {})).toEqual({ sessionIds: [] });

    const lease = await teammate.mutation(api.sessionViewers.open, {
      viewerId,
      sessionId: w.sessionId,
      clientSessionId: "desktop-1",
    });
    expect(lease).toEqual({ viewerId, expiresAt: expect.any(Number), heartbeatMs: 20_000 });
    // Expiry is a TTL from now (convex-test's clock may tick a millisecond).
    expect(lease.expiresAt - SESSION_VIEWER_TTL_MS).toBeGreaterThanOrEqual(10_000);
    expect(lease.expiresAt - SESSION_VIEWER_TTL_MS).toBeLessThan(10_100);
    // Opening again (a reconnect) renews the same viewer.
    vi.setSystemTime(15_000);
    await teammate.mutation(api.sessionViewers.open, {
      viewerId,
      sessionId: w.sessionId,
      clientSessionId: "desktop-1",
    });
    // A second viewer on the same Session is one watched Session.
    await t.withIdentity(OWNER).mutation(api.sessionViewers.open, {
      viewerId: newId("session"),
      sessionId: w.sessionId,
      clientSessionId: "desktop-2",
    });
    expect(await w.runner.query(api.sessionViewers.watched, {})).toEqual({
      sessionIds: [w.sessionId],
    });
    expect(await w.otherRunner.query(api.sessionViewers.watched, {})).toEqual({ sessionIds: [] });

    vi.setSystemTime(20_000);
    const renewed = await teammate.mutation(api.sessionViewers.heartbeat, { viewerId });
    expect(renewed).toEqual({
      open: true,
      viewerId,
      expiresAt: expect.any(Number),
      heartbeatMs: 20_000,
    });
    expect(renewed.open && renewed.expiresAt - SESSION_VIEWER_TTL_MS).toBeGreaterThanOrEqual(
      20_000,
    );
    // Someone else's viewer is not theirs to renew or close.
    expect(
      await t.withIdentity(OWNER).mutation(api.sessionViewers.heartbeat, { viewerId }),
    ).toEqual({ open: false });
    await t.withIdentity(OWNER).mutation(api.sessionViewers.close, { viewerId });
    expect(await teammate.mutation(api.sessionViewers.heartbeat, { viewerId })).toMatchObject({
      open: true,
    });

    expect(await teammate.mutation(api.sessionViewers.close, { viewerId })).toBeNull();
    expect(await teammate.mutation(api.sessionViewers.close, { viewerId })).toBeNull();
    expect(await teammate.mutation(api.sessionViewers.heartbeat, { viewerId })).toEqual({
      open: false,
    });
    const beats = await t.run((ctx) => ctx.db.query("sessionViewerHeartbeats").collect());
    expect(beats).toHaveLength(1);
  });

  test("open checks the caller can see the Session, and the ids", async () => {
    const t = setup();
    const w = await world(t);
    const viewerId = newId("session");
    const args = { viewerId, sessionId: w.privateSessionId, clientSessionId: "desktop-1" };
    await expect(t.withIdentity(TEAMMATE).mutation(api.sessionViewers.open, args)).rejects.toEqual(
      code("not_found"),
    );
    await expect(
      t
        .withIdentity(OUTSIDER)
        .mutation(api.sessionViewers.open, { ...args, sessionId: w.sessionId }),
    ).rejects.toEqual(code("not_found"));
    const teammate = t.withIdentity(TEAMMATE);
    await expect(
      teammate.mutation(api.sessionViewers.open, {
        ...args,
        sessionId: w.sessionId,
        viewerId: "not-a-uuid",
      }),
    ).rejects.toEqual(code("invalid_viewer"));
    for (const clientSessionId of ["", "x".repeat(201)]) {
      await expect(
        teammate.mutation(api.sessionViewers.open, {
          ...args,
          sessionId: w.sessionId,
          clientSessionId,
        }),
      ).rejects.toEqual(code("invalid_viewer"));
    }
    await t.withIdentity(OWNER).mutation(api.sessionViewers.open, args);
    // The id is the owner's viewer of another Session now.
    await expect(
      teammate.mutation(api.sessionViewers.open, { ...args, sessionId: w.sessionId }),
    ).rejects.toEqual(code("id_taken"));
    await expect(
      t.withIdentity(OWNER).mutation(api.sessionViewers.open, { ...args, sessionId: w.sessionId }),
    ).rejects.toEqual(code("id_taken"));
    await expect(w.runner.query(api.sessionViewers.watched, {})).resolves.toEqual({
      sessionIds: [w.privateSessionId],
    });
    await expect(t.withIdentity(OWNER).query(api.sessionViewers.watched, {})).rejects.toThrow();
  });

  test("a Session has at most a bounded number of viewers open", async () => {
    const t = setup();
    const w = await world(t);
    const teammate = t.withIdentity(TEAMMATE);
    for (let index = 0; index < SESSION_MAX_VIEWERS; index += 1) {
      await teammate.mutation(api.sessionViewers.open, {
        viewerId: newId("session"),
        sessionId: w.sessionId,
        clientSessionId: "d",
      });
    }
    await expect(
      teammate.mutation(api.sessionViewers.open, {
        viewerId: newId("session"),
        sessionId: w.sessionId,
        clientSessionId: "d",
      }),
    ).rejects.toEqual(code("too_many_viewers"));
  });

  test("a Session that stops being visible ends its viewer at the next heartbeat", async () => {
    const t = setup();
    const w = await world(t);
    const viewerId = newId("session");
    const teammate = t.withIdentity(TEAMMATE);
    await teammate.mutation(api.sessionViewers.open, {
      viewerId,
      sessionId: w.sessionId,
      clientSessionId: "d",
    });
    await t.run(async (ctx) => {
      const row = await ctx.db
        .query("sessions")
        .withIndex("by_uuid", (q) => q.eq("id", w.sessionId))
        .unique();
      await ctx.db.patch(row!._id, { visibility: "private" });
    });
    expect(await teammate.mutation(api.sessionViewers.heartbeat, { viewerId })).toEqual({
      open: false,
    });
    expect(await w.runner.query(api.sessionViewers.watched, {})).toEqual({ sessionIds: [] });
  });

  test("the sweep removes lapsed viewers in batches, and only those", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const t = setup();
    const w = await world(t);
    await t.run(async (ctx) => {
      for (let index = 0; index < 300; index += 1) {
        const id = newId("session");
        await ctx.db.insert("sessionViewers", {
          id,
          sessionId: w.privateSessionId,
          runnerId: w.runnerId,
          userId: w.teammate,
          clientSessionId: "d",
          openedAt: 0,
        });
        await ctx.db.insert("sessionViewerHeartbeats", { viewerId: id, expiresAt: 1_000 });
      }
      // A heartbeat whose viewer is already gone is swept too.
      await ctx.db.insert("sessionViewerHeartbeats", {
        viewerId: newId("session"),
        expiresAt: 1_000,
      });
    });
    vi.setSystemTime(500);
    const live = newId("session");
    await t.withIdentity(OWNER).mutation(api.sessionViewers.open, {
      viewerId: live,
      sessionId: w.sessionId,
      clientSessionId: "d",
    });
    vi.setSystemTime(2_000);
    expect(await t.mutation(internal.sessionViewers.sweepExpired, {})).toBe(256);
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const viewers = await t.run((ctx) => ctx.db.query("sessionViewers").collect());
    expect(viewers.map((viewer) => viewer.id)).toEqual([live]);
    expect(await t.run((ctx) => ctx.db.query("sessionViewerHeartbeats").collect())).toHaveLength(1);
  });
});

describe("sessions.accept ends a turn's streams", () => {
  test("accepting a turn's end deletes that turn's chunk rows and leaves the next turn's", async () => {
    vi.useFakeTimers();
    const t = setup();
    const alice = await signIn(t, OWNER);
    const seeded = await t.run((ctx) => seedTestWorld(ctx, { ownerUserId: alice, runners: 1 }));
    const runnerId = seeded.runnerIds[0]!;
    const { sessionId, events } = await writeSession({
      projectId: seeded.projectId,
      ticketId: seeded.ticketId,
    });
    const end = events.findIndex(({ payload }) => payload.kind === "turn.completed");
    const ended = events[end]!.payload as { turnId: string };
    const runner = asRunner(t, runnerId);
    for (const event of events.slice(0, end)) {
      await runner.mutation(api.sessions.accept, {
        sessionId,
        generation: 1,
        events: [wire(event)],
      });
    }
    for (const [messageId, turnId] of [
      ["m1", ended.turnId],
      ["m2", "turn-next"],
    ] as const) {
      await runner.mutation(api.streamChunks.append, {
        sessionId,
        messageId,
        turnId,
        ...chunk(0, [reset("a")]),
      });
    }
    await runner.mutation(api.sessions.accept, {
      sessionId,
      generation: 1,
      events: [wire(events[end]!)],
    });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect((await rowsOf(t, sessionId)).map((row) => row.messageId)).toEqual(["m2"]);
  });
});

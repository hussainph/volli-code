/**
 * A moved Session readable, not only stored (`projectImportHistory.ts`): its
 * events stored the intake's way (JSON text, `$`-keyed and oversized payloads
 * included), its transcript packs and Pi log ranges committed through the
 * import's own doors while the project is hidden, and its first fold after
 * the commit, which rebuilds the state and listing row and replays nothing
 * the old facts derived. The read-back through the window's own transport is
 * `apps/desktop/src/main/cloud-move-history.live.test.ts`.
 */

import { randomUUID } from "node:crypto";

import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";

import { parseRendererSessionEvent, type SessionEvent } from "@volli/shared";
import { RUNNER_TOKEN_ISSUER, piLogSegmentKey, transcriptPackKey } from "@volli/shared/cloud";

// How the move client sends an exported event (host-core; the dry run's own).
import { sessionEventImportRecord } from "../../packages/host-core/src/migration-export/session-event-record";

import { api, internal } from "../functions/_generated/api";
import { seedTestRunner } from "../functions/lib/testWorld";
import { code } from "./board-helpers";
import {
  MANIFEST_SHA,
  MOVED,
  beginArgs,
  expectedFor,
  importAll,
  importWorld,
  type ImportWorld,
} from "./projectImport-fixtures";
import { S3StandIn } from "./s3-standin";
import { userProvenance, wire, writeSession } from "./sessionFixtures";

const SHA = "ab".repeat(32);
/** Larger than one fact `sessions.accept` takes (256 KB); a document holds it. */
const OVERSIZED_TEXT = "r".repeat(300 * 1024);

beforeEach(() => {
  vi.useFakeTimers({ now: Date.UTC(2026, 9, 28, 12) });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

/**
 * The fixture move, with a real history for the moved Session: written by
 * the Session Engine (attention, an interaction, turns, a blocked signal, a
 * `$schema` key and a non-ASCII key), plus one fact larger than an accept
 * takes; every event hot, sent as the move client sends them.
 */
async function historyWorld(options: { sentAsUnknown?: boolean } = {}) {
  const world = await importWorld();
  const { engine, sessionId } = await writeSession({
    sessionId: MOVED.sessionId,
    projectId: MOVED.projectId,
    ticketId: MOVED.ticketId,
    dollarKeys: true,
    turns: 2,
  });
  await engine.getOrRecordSessionInput({
    sessionId,
    input: { kind: "prompt-resources", resources: [{ name: "AGENTS.md", text: OVERSIZED_TEXT }] },
    provenance: userProvenance,
  });
  const events = [...(await engine.listEvents({ sessionId }))];
  const created = events.find(({ payload }) => payload.kind === "session.created")!;
  const born = (created.payload as Extract<SessionEvent["payload"], { kind: "session.created" }>)
    .session;
  world.records.sessions[0] = {
    ...world.records.sessions[0],
    createdAt: born.createdAt,
    lastActivityAt: events.at(-1)!.occurredAt,
    lastSequence: events.length,
    eventCount: events.length,
  };
  world.records.sessionEvents = events.map((event) => {
    const record = sessionEventImportRecord(event as unknown as Record<string, unknown>);
    // A client whose build did not know these kinds (an older desktop).
    return options.sentAsUnknown === true ? { ...record, kindKnown: false } : record;
  });
  world.records.sessionIntake = [
    { sessionId, acceptedThrough: events.length, lastEventId: events.at(-1)!.id },
  ];
  // Every moved event is hot: nothing reads an archive back yet.
  world.records.eventArchives = [];
  world.expected = expectedFor(world.records, world.target);
  await world.alice.as.mutation(api.projectImports.begin, beginArgs(world));
  const results = await importAll(world.alice.as, world.moveId, world.records);
  for (const [stream, result] of Object.entries(results)) {
    expect(result.conflicts, stream).toEqual([]);
    expect(result.rejected, stream).toEqual([]);
  }
  return { ...world, events, last: events.length, engine };
}

const claimOf = (world: ImportWorld) => ({ runnerId: world.runnerId, generation: 1 });

function segmentArgs(world: ImportWorld, last: number, overrides: Record<string, unknown> = {}) {
  return {
    moveId: world.moveId,
    sessionId: MOVED.sessionId,
    claim: claimOf(world),
    segmentId: randomUUID(),
    firstSequence: 1,
    lastSequence: last,
    turnIds: [],
    key: transcriptPackKey({
      projectId: MOVED.projectId,
      sessionId: MOVED.sessionId,
      firstSequence: 1,
      lastSequence: last,
    }),
    bytes: 10,
    sha256: SHA,
    artifactCount: 0,
    digests: [],
    ...overrides,
  };
}

function piArgs(world: ImportWorld, overrides: Record<string, unknown> = {}) {
  return {
    moveId: world.moveId,
    sessionId: MOVED.sessionId,
    claim: claimOf(world),
    attachmentId: "attachment-1",
    piFileId: "2026-01-01_pi",
    startOffset: 0,
    endOffset: 120,
    key: piLogSegmentKey({
      projectId: MOVED.projectId,
      sessionId: MOVED.sessionId,
      attachmentId: "attachment-1",
      piFileId: "2026-01-01_pi",
      offset: 0,
    }),
    bytes: 40,
    sha256: SHA,
    ...overrides,
  };
}

function commit(world: ImportWorld) {
  return world.alice.as.mutation(api.projectImports.commit, {
    moveId: world.moveId,
    manifestSha256: MANIFEST_SHA,
  });
}

async function foldProgress(world: ImportWorld) {
  return world.alice.as.query(api.projectImportHistory.foldProgress, {
    moveId: world.moveId,
    cursor: null,
  });
}

describe("moved events, stored the intake's way", () => {
  test("payloads and provenance are JSON text, `$` keys and an oversized fact included", async () => {
    const world = await historyWorld();
    const rows = await world.t.run((ctx) =>
      ctx.db
        .query("sessionEvents")
        .withIndex("by_session_sequence", (q) => q.eq("sessionId", MOVED.sessionId))
        .collect(),
    );
    expect(rows).toHaveLength(world.last);
    for (const row of rows) {
      expect(typeof row.payload, `${row.sequence}`).toBe("string");
      expect(typeof row.provenance, `${row.sequence}`).toBe("string");
      expect(row.quarantine, `${row.sequence}`).toBeNull();
      expect(row.kindKnown, `${row.sequence}`).toBe(true);
    }
    expect(rows.some((row) => (row.payload as string).includes('"$schema"'))).toBe(true);
    expect(rows.some((row) => (row.payload as string).includes(OVERSIZED_TEXT))).toBe(true);
  });
});

describe("the import's history doors", () => {
  test("a moved Session's packs and Pi ranges commit while its project is hidden", async () => {
    const world = await historyWorld();
    const head = () =>
      world.alice.as.query(api.projectImportHistory.uploadHead, {
        moveId: world.moveId,
        sessionId: MOVED.sessionId,
        claim: claimOf(world),
        piFileIds: ["2026-01-01_pi"],
      });
    expect(await head()).toEqual({ transcriptThrough: 0, piLogs: { "2026-01-01_pi": 0 } });

    const pack = segmentArgs(world, world.last);
    expect(await world.alice.as.mutation(api.projectImportHistory.commitSegment, pack)).toEqual({
      status: "committed",
    });
    // The runner's rule: the same object again is a duplicate.
    expect(
      await world.alice.as.mutation(api.projectImportHistory.commitSegment, {
        ...pack,
        segmentId: randomUUID(),
      }),
    ).toEqual({ status: "duplicate" });
    expect(
      await world.alice.as.mutation(api.projectImportHistory.commitPiLogSegment, piArgs(world)),
    ).toEqual({ status: "committed" });
    expect(await head()).toEqual({
      transcriptThrough: world.last,
      piLogs: { "2026-01-01_pi": 120 },
    });

    // The runner's own doors still refuse the hidden project's Session.
    await expect(
      world.alice.as.query(api.transcripts.head, {
        sessionId: MOVED.sessionId,
        claim: claimOf(world),
        piFileIds: [],
      }),
    ).rejects.toThrow(code("not_found"));
  });

  test("the runner's commit rules hold: contiguous ranges, only what the intake holds", async () => {
    const world = await historyWorld();
    await expect(
      world.alice.as.mutation(
        api.projectImportHistory.commitSegment,
        segmentArgs(world, world.last + 1),
      ),
    ).rejects.toThrow(code("beyond_accepted"));
    await expect(
      world.alice.as.mutation(
        api.projectImportHistory.commitSegment,
        segmentArgs(world, 3, { key: "v1/elsewhere" }),
      ),
    ).rejects.toThrow(code("invalid_argument"));
    await expect(
      world.alice.as.mutation(
        api.projectImportHistory.commitPiLogSegment,
        piArgs(world, {
          startOffset: 5,
          key: piLogSegmentKey({
            projectId: MOVED.projectId,
            sessionId: MOVED.sessionId,
            attachmentId: "attachment-1",
            piFileId: "2026-01-01_pi",
            offset: 5,
          }),
        }),
      ),
    ).rejects.toThrow(code("gap"));
  });

  test("only the importer, for this move's own Sessions, under the claim the import gave", async () => {
    const world = await historyWorld();
    await expect(
      world.bob.as.mutation(api.projectImportHistory.commitSegment, segmentArgs(world, 2)),
    ).rejects.toThrow(code("not_found"));
    await expect(
      world.alice.as.mutation(
        api.projectImportHistory.commitSegment,
        segmentArgs(world, 2, { sessionId: world.visible.sessionId }),
      ),
    ).rejects.toThrow(code("not_found"));
    await expect(
      world.alice.as.mutation(
        api.projectImportHistory.commitSegment,
        segmentArgs(world, 2, { claim: { runnerId: world.runnerId, generation: 2 } }),
      ),
    ).rejects.toThrow(code("stale_claim"));
    // A runner token is not the importer.
    await expect(
      world.t
        .withIdentity({ subject: `runner:${world.runnerId}`, issuer: RUNNER_TOKEN_ISSUER })
        .mutation(api.projectImportHistory.commitSegment, segmentArgs(world, 2)),
    ).rejects.toThrow();
    // Closed once committed: the Session's runner (or its owner) packs from then on,
    // and still after a roll back hides the project again.
    await commit(world);
    await expect(
      world.alice.as.mutation(api.projectImportHistory.commitSegment, segmentArgs(world, 2)),
    ).rejects.toThrow(code("import_closed"));
    await world.alice.as.mutation(api.projectImports.uncommit, { moveId: world.moveId });
    await expect(
      world.alice.as.mutation(api.projectImportHistory.commitSegment, segmentArgs(world, 2)),
    ).rejects.toThrow(code("import_closed"));
  });
});

describe("a move handed to another driver", () => {
  test("the new driver uses the doors under the import's own claim; the old one cannot", async () => {
    new S3StandIn().install();
    const world = await historyWorld();
    await world.t.run(async (ctx) => {
      const member = await ctx.db
        .query("workspaceMembers")
        .withIndex("by_workspace_user", (q) =>
          q.eq("workspaceId", world.workspaceId).eq("userId", world.bob.userId),
        )
        .unique();
      await ctx.db.patch(member!._id, { role: "admin" });
    });
    const bobRunner = await world.t.run((ctx) =>
      seedTestRunner(ctx, world.bob.userId, "bob-runner"),
    );
    await world.t.mutation(internal.projectImports.rescue, {
      moveId: world.moveId,
      action: { kind: "reassign", userId: world.bob.userId, runnerId: bobRunner },
    });
    const pack = segmentArgs(world, world.last);
    // The claim is still the import's (Alice's runner, generation 1).
    const grant = await world.bob.as.action(api.projectImportHistory.presignPut, {
      moveId: world.moveId,
      sessionId: MOVED.sessionId,
      claim: claimOf(world),
      key: pack.key,
      bytes: pack.bytes,
      sha256: pack.sha256,
    });
    expect(grant.status).toBe("sign");
    await expect(
      world.bob.as.mutation(api.projectImportHistory.commitSegment, pack),
    ).resolves.toEqual({ status: "committed" });
    await expect(
      world.bob.as.mutation(
        api.projectImportHistory.commitSegment,
        segmentArgs(world, world.last, { claim: { runnerId: bobRunner, generation: 1 } }),
      ),
    ).rejects.toThrow(code("stale_claim"));
    await expect(
      world.alice.as.query(api.projectImportHistory.uploadHead, {
        moveId: world.moveId,
        sessionId: MOVED.sessionId,
        claim: claimOf(world),
        piFileIds: [],
      }),
    ).rejects.toThrow(code("not_found"));
  });
});

describe("the history door's object PUTs", () => {
  test("replaceable until a row commits the key, as the runner's are, and only this Session's keys", async () => {
    new S3StandIn().install();
    const world = await historyWorld();
    const pack = segmentArgs(world, world.last);
    const presign = (overrides: Record<string, unknown> = {}, as = world.alice.as) =>
      as.action(api.projectImportHistory.presignPut, {
        moveId: world.moveId,
        sessionId: MOVED.sessionId,
        claim: claimOf(world),
        key: pack.key,
        bytes: pack.bytes,
        sha256: pack.sha256,
        ...overrides,
      });
    const grant = await presign();
    expect(grant.status).toBe("sign");
    const signed = new URL((grant as { request: { url: string } }).request.url);
    expect(signed.searchParams.get("X-Amz-SignedHeaders")).toBe(
      "content-length;host;x-amz-checksum-sha256",
    );
    await world.alice.as.mutation(api.projectImportHistory.commitSegment, pack);
    expect(await presign()).toEqual({ status: "committed" });

    await expect(presign({ key: `v1/p/${MOVED.projectId}/b/${SHA}` })).rejects.toThrow(
      code("invalid_argument"),
    );
    await expect(presign({ sessionId: world.visible.sessionId })).rejects.toThrow(
      code("not_found"),
    );
    await expect(presign({}, world.bob.as)).rejects.toThrow(code("not_found"));
  });
});

describe("the first fold of a moved Session", () => {
  test("starts at the commit, reaches the head, and replays nothing the history derived", async () => {
    const world = await historyWorld();
    // Nothing folds a hidden project.
    expect(
      await world.t.run((ctx) =>
        ctx.db
          .query("sessionStates")
          .withIndex("by_session", (q) => q.eq("sessionId", MOVED.sessionId))
          .unique(),
      ),
    ).toBeNull();
    await commit(world);
    expect((await foldProgress(world)).behind).toEqual([
      {
        sessionId: MOVED.sessionId,
        foldedThrough: 0,
        acceptedThrough: world.last,
        // Not even scheduled: the chain has not reached it.
        scheduledAt: null,
      },
    ]);
    await world.t.finishAllScheduledFunctions(vi.runAllTimers);

    expect(await foldProgress(world)).toMatchObject({
      status: "committed",
      sessions: 2,
      folded: 2,
      behind: [],
      isDone: true,
    });
    const snapshot = await world.bob.as.query(api.sessions.snapshot, {
      sessionId: MOVED.sessionId,
    });
    expect(snapshot).toMatchObject({ foldedThrough: world.last, catchingUp: false });
    const state = JSON.parse(snapshot.state!);
    expect(state.signal).toMatchObject({ signal: "blocked", reason: "Need a key" });
    expect(state.turnActive).toBe(false);
    // The listing row is the fold's.
    expect(snapshot.session).toMatchObject({
      signal: { signal: "blocked", reason: "Need a key" },
      usageTotals: expect.objectContaining({ inputTokens: 300 }),
    });

    // Every fact reads back, the `$`-keyed and the oversized ones included.
    const history = await world.bob.as.query(api.sessions.history, {
      sessionId: MOVED.sessionId,
      limit: 200,
    });
    expect(history.events.map(({ sequence }) => sequence)).toEqual(
      world.events.map(({ sequence }) => sequence),
    );
    expect(history.events.filter(({ status }) => status !== "ok")).toEqual([]);
    const texts = history.events.map(({ event }) => event!);
    for (const text of texts) {
      expect(parseRendererSessionEvent(JSON.parse(text), "event")).toMatchObject({ ok: true });
    }
    expect(texts.some((text) => text.includes(OVERSIZED_TEXT))).toBe(true);
    // The `$`-keyed fact is among them ("ok"); the renderer's scrub drops its diagnostic.

    // Copied, not replayed: no turns, attention, todo comments or notices from history.
    const derived = await world.t.run(async (ctx) => ({
      turns: await ctx.db
        .query("sessionTurns")
        .withIndex("by_session_started", (q) => q.eq("sessionId", MOVED.sessionId))
        .collect(),
      attention: await ctx.db
        .query("attentionItems")
        .withIndex("by_session", (q) => q.eq("sessionId", MOVED.sessionId))
        .collect(),
      comments: await ctx.db
        .query("ticketComments")
        .withIndex("by_ticket", (q) => q.eq("ticketId", MOVED.ticketId))
        .collect(),
      jobs: await ctx.db.query("runnerJobs").collect(),
    }));
    expect(derived.turns).toEqual([]);
    expect(derived.attention).toEqual([]);
    expect(derived.comments).toHaveLength(world.records.ticketComments.length);
    expect(derived.jobs.filter((job) => job.sessionId === MOVED.sessionId)).toEqual([]);

    // A fact after the move derives as usual.
    const last = world.events.at(-1)!;
    const turnId = randomUUID();
    const opened = world.events.findLast(({ payload }) => payload.kind === "attachment.opened")!;
    const next: SessionEvent = {
      id: randomUUID(),
      sessionId: MOVED.sessionId,
      sequence: last.sequence + 1,
      occurredAt: last.occurredAt + 1,
      recordedAt: last.recordedAt + 1,
      provenance: {
        source: { kind: "adapter", id: "pi", detail: null },
        venue: last.provenance.venue,
      },
      attachmentId: (opened.payload as { attachment: { id: string } }).attachment.id,
      commandId: null,
      payload: {
        kind: "turn.started",
        attachmentId: (opened.payload as { attachment: { id: string } }).attachment.id,
        turnId,
      },
    };
    await world.t
      .withIdentity({ subject: `runner:${world.runnerId}`, issuer: RUNNER_TOKEN_ISSUER })
      .mutation(api.sessions.accept, {
        sessionId: MOVED.sessionId,
        generation: 1,
        events: [wire(next)],
      });
    const turns = await world.t.run((ctx) =>
      ctx.db
        .query("sessionTurns")
        .withIndex("by_session_started", (q) => q.eq("sessionId", MOVED.sessionId))
        .collect(),
    );
    expect(turns.map((turn) => turn.turnId)).toEqual([turnId]);
  });

  test("an accept that reaches the Session first still derives only what is new", async () => {
    const world = await historyWorld();
    await commit(world);
    const last = world.events.at(-1)!;
    const next: SessionEvent = {
      id: randomUUID(),
      sessionId: MOVED.sessionId,
      sequence: last.sequence + 1,
      occurredAt: last.occurredAt + 1,
      recordedAt: last.recordedAt + 1,
      provenance: {
        source: { kind: "user", id: "desktop", detail: null },
        venue: last.provenance.venue,
      },
      attachmentId: null,
      commandId: null,
      payload: { kind: "session.retitled", title: "Moved and resumed" },
    };
    // Before the fold chain runs: the accept finds no state and asks for a catch-up.
    await world.t
      .withIdentity({ subject: `runner:${world.runnerId}`, issuer: RUNNER_TOKEN_ISSUER })
      .mutation(api.sessions.accept, {
        sessionId: MOVED.sessionId,
        generation: 1,
        events: [wire(next)],
      });
    const state = await world.t.run((ctx) =>
      ctx.db
        .query("sessionStates")
        .withIndex("by_session", (q) => q.eq("sessionId", MOVED.sessionId))
        .unique(),
    );
    expect(state).toMatchObject({ throughSequence: 0, derivedThrough: world.last });
    await world.t.finishAllScheduledFunctions(vi.runAllTimers);
    const snapshot = await world.alice.as.query(api.sessions.snapshot, {
      sessionId: MOVED.sessionId,
    });
    expect(snapshot.foldedThrough).toBe(world.last + 1);
    expect(snapshot.session.title).toBe("Moved and resumed");
    const attention = await world.t.run((ctx) =>
      ctx.db
        .query("attentionItems")
        .withIndex("by_session", (q) => q.eq("sessionId", MOVED.sessionId))
        .collect(),
    );
    expect(attention).toEqual([]);
  });

  test("a roll back stops the chain, and a commit after it starts nothing twice", async () => {
    const world = await historyWorld();
    await commit(world);
    await world.alice.as.mutation(api.projectImports.uncommit, { moveId: world.moveId });
    await world.t.finishAllScheduledFunctions(vi.runAllTimers);
    const states = () =>
      world.t.run((ctx) =>
        ctx.db
          .query("sessionStates")
          .withIndex("by_session", (q) => q.eq("sessionId", MOVED.sessionId))
          .collect(),
      );
    expect(await states()).toEqual([]);
    await commit(world);
    await world.t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await states()).toHaveLength(1);
    // The fold changes nothing a roll back counts as changed since the commit.
    await world.alice.as.mutation(api.projectImports.uncommit, { moveId: world.moveId });
    await commit(world);
    await world.t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await states()).toMatchObject([{ throughSequence: world.last, catchUpAt: null }]);
  });

  test("its progress is the importer's alone", async () => {
    const world = await historyWorld();
    await expect(
      world.bob.as.query(api.projectImportHistory.foldProgress, {
        moveId: world.moveId,
        cursor: null,
      }),
    ).rejects.toThrow(code("not_found"));
  });

  test("a fact the client sent as unknown, but this build reads, derives nothing either", async () => {
    const world = await historyWorld({ sentAsUnknown: true });
    await commit(world);
    await world.t.finishAllScheduledFunctions(vi.runAllTimers);
    const snapshot = await world.alice.as.query(api.sessions.snapshot, {
      sessionId: MOVED.sessionId,
    });
    expect(snapshot.foldedThrough).toBe(world.last);
    expect(JSON.parse(snapshot.state!).signal).toMatchObject({ signal: "blocked" });
    const derived = await world.t.run(async (ctx) => ({
      turns: await ctx.db
        .query("sessionTurns")
        .withIndex("by_session_started", (q) => q.eq("sessionId", MOVED.sessionId))
        .collect(),
      attention: await ctx.db
        .query("attentionItems")
        .withIndex("by_session", (q) => q.eq("sessionId", MOVED.sessionId))
        .collect(),
    }));
    expect(derived).toEqual({ turns: [], attention: [] });
  });

  test("a fold that stopped short is started again by a commit sent again", async () => {
    const world = await historyWorld();
    await commit(world);
    await world.t.finishAllScheduledFunctions(vi.runAllTimers);
    // A step that failed for good leaves the fold behind, scheduled long ago.
    await world.t.run(async (ctx) => {
      const doc = await ctx.db
        .query("sessionStates")
        .withIndex("by_session", (q) => q.eq("sessionId", MOVED.sessionId))
        .unique();
      await ctx.db.patch(doc!._id, {
        throughSequence: 0,
        foldVersion: 0,
        state: null,
        catchUpAt: Date.now() - 10 * 60_000,
      });
    });
    expect((await foldProgress(world)).behind).toEqual([
      expect.objectContaining({ sessionId: MOVED.sessionId, foldedThrough: 0 }),
    ]);
    expect(await commit(world)).toEqual({ status: "committed" });
    await world.t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await foldProgress(world)).toMatchObject({ behind: [], folded: 2 });
    const attention = await world.t.run((ctx) =>
      ctx.db
        .query("attentionItems")
        .withIndex("by_session", (q) => q.eq("sessionId", MOVED.sessionId))
        .collect(),
    );
    expect(attention).toEqual([]);
  });
});

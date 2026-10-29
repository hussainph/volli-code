/**
 * The move engine against the real person-authorized import (`convex-test`):
 * one project of a synthetic local profile moved end to end, and every way a
 * move is interrupted, refused, rolled back or taken back. The kill/resume
 * matrix itself is `moveEngine.matrix.test.ts` (ci-extended).
 */
import { appendFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, test, vi } from "vite-plus/test";

import { createFactDrain } from "../../packages/host-core/src/cloud-runner/drain";
import { sqliteDrainCursorStore } from "../../packages/host-core/src/cloud-runner/sqlite-stores";
import { localSessionRow } from "../../packages/host-core/src/db/local-product";
import { sqliteDrainLedger } from "../../packages/host-core/src/session-control/sqlite-ledger";
import {
  bindCloudSessionOwner,
  projectFreeze,
} from "../../packages/host-core/src/cloud-move/freeze";
import { createCloudSessionOwner } from "../../packages/host-core/src/cloud-store/owner";
import { createHostSessionServices } from "../../packages/host-core/src/session-services";
import { MigrationExportError } from "../../packages/host-core/src/migration-export/errors";
import { exportMigrationSnapshot } from "../../packages/host-core/src/migration-export/exporter";
import { api } from "../functions/_generated/api";
import { windowReadCheck } from "../../packages/host-core/src/cloud-move/real-paths";
import {
  cloudBorn,
  cursorOf,
  finalDigests,
  moveWorld,
  type MoveWorld,
} from "./move-engine-harness";

// Each case writes, migrates, exports and moves a whole profile: on a cold CI
// runner the first one alone can pass the default 5 s.
vi.setConfig({ testTimeout: 60_000 });

let world: MoveWorld | undefined;
afterEach(() => {
  world?.cleanup();
  world = undefined;
});

const alice = { subject: "user:alice", issuer: "https://issuer.test" };

/** The mover's drain cursors (the profile holds others: a drained cloud Session's). */
function movedCursors(w: MoveWorld) {
  return w.db
    .prepare("SELECT COUNT(*) AS n FROM session_drain_cursors WHERE owner_user_id = ?")
    .get(w.userId);
}

function enqueue(w: MoveWorld, engine = w.engine(), stopAtFirstProblem = false) {
  const { queue, moves } = engine.enqueue({
    projectIds: [w.projectId],
    target: { userId: w.userId, workspaceId: w.workspaceId, runnerId: w.runnerId },
    stopAtFirstProblem,
  });
  return { engine, queueId: queue.queueId, moveId: moves[0]!.moveId };
}

describe("a move, start to finish", () => {
  test("moves the project, verified three ways, and waits for the person", async () => {
    world = await moveWorld();
    const backup = {
      path: join(world.root, "pre-cloud-move.tar.gz"),
      bytes: 123,
      sha256: "a".repeat(64),
    };
    let backupWrites = 0;
    const { engine, queueId, moveId } = enqueue(
      world,
      world.engine({
        ports: {
          backup: {
            async write() {
              backupWrites++;
              return backup;
            },
          },
        },
      }),
    );
    expect(await engine.run(queueId)).toEqual({ kind: "done" });
    expect(engine.journal.queue(queueId)!.backup).toMatchObject(backup);
    expect(await world.engine().run(queueId)).toEqual({ kind: "done" });
    expect(backupWrites).toBe(1);

    const move = engine.journal.move(moveId)!;
    expect(move.state).toBe("checked");
    expect(move.failure).toBeNull();
    expect(move.report).toMatchObject({ verify: { ok: true } });
    // Every window read matches the export, every moved Session folded.
    expect(move.report).toMatchObject({ ok: true, realPath: { ok: true } });
    const realPath = move.report!.realPath as { checks: Record<string, { checked: number }> };
    expect(realPath.checks.allSessionsFolded!.checked).toBe(1);
    expect(realPath.checks.sessionHistory!.checked).toBeGreaterThan(0);
    // Still read-only here until the person finishes the move.
    expect(projectFreeze(world.db, world.projectId)).toBe("checked");

    const final = await finalDigests(world, moveId);
    expect(final.status).toBe("committed");
    const shown = await world.t
      .withIdentity(alice)
      .query(api.projects.get, { projectId: world.projectId });
    expect(shown.name).toBe("Alpha");

    // The handover: the folder and every moved Session belong to this runner.
    const cursors = world.db
      .prepare("SELECT session_id, accepted_through FROM session_drain_cursors")
      .all();
    expect(cursors.length).toBeGreaterThan(0);
    const checkouts = world.db
      .prepare("SELECT project_id FROM project_checkout_paths WHERE runner_id = ?")
      .all(world.runnerId);
    expect(checkouts).toEqual([{ project_id: world.projectId }]);
    // The profile step carried the person's own settings, once.
    const personal = await world.t.run((ctx) =>
      ctx.db
        .query("configEntries")
        .withIndex("by_scope_kind_name", (q) => q.eq("scopeKey", `u:${world!.userId}`))
        .collect(),
    );
    expect(personal.length).toBeGreaterThan(0);
    const profile = JSON.parse(
      readFileSync(join(world.root, "cloud-moves", `profile-${queueId}`, "report.json"), "utf8"),
    );
    expect(profile).toMatchObject({ inserted: personal.length, kept: 0, refused: {} });
    // The staging record: the manifest, its chunks and the report.
    const staged = [...world.objects.objects.keys()].filter((key) =>
      key.startsWith(`v1/m/${moveId}/`),
    );
    expect(staged).toContain(`v1/m/${moveId}/manifest.json`);
    expect(staged.some((key) => key.includes("/report-"))).toBe(true);
    // No raw transcript, Pi log or machine path was staged.
    const manifest = JSON.parse(
      Buffer.from(world.objects.objects.get(`v1/m/${moveId}/manifest.json`)!).toString("utf8"),
    );
    expect(JSON.stringify(manifest)).not.toContain(world.root);
  });

  test("a second run is a no-op", async () => {
    world = await moveWorld();
    const { engine, queueId, moveId } = enqueue(world);
    await engine.run(queueId);
    const before = await finalDigests(world, moveId);
    const calls = new Map(world.calls);
    expect(await world.engine().run(queueId)).toEqual({ kind: "done" });
    expect(world.calls.get("projectImports:importRows")).toBe(
      calls.get("projectImports:importRows"),
    );
    expect(await finalDigests(world, moveId)).toEqual(before);
  });

  test("Finish move archives the local copy read-only and drops the export", async () => {
    world = await moveWorld();
    const { engine, queueId, moveId } = enqueue(world);
    await engine.run(queueId);
    await engine.confirm(moveId);
    expect(engine.journal.move(moveId)!.state).toBe("confirmed");
    expect(projectFreeze(world.db, world.projectId)).toBe("confirmed");
    expect(existsSync(join(world.root, "cloud-moves", moveId, "export"))).toBe(false);
    expect(existsSync(join(world.root, "cloud-moves", moveId, "plan.json"))).toBe(true);
  });
});

/**
 * Cursors no release on the moved project may touch: the mover's on another
 * project's Session, and someone else's on one of the moved project's.
 */
/** The mover's cursors on the moved project's Sessions. */
function projectCursors(w: MoveWorld) {
  return w.db
    .prepare(
      `SELECT COUNT(*) AS n FROM session_drain_cursors WHERE owner_user_id = ?
        AND session_id IN (SELECT id FROM sessions WHERE project_id = ?)`,
    )
    .get(w.userId, w.projectId);
}

function strangerCursors(w: MoveWorld): string[] {
  const elsewhere = w.db
    .prepare("SELECT id FROM sessions WHERE project_id != ? ORDER BY id LIMIT 1")
    .get(w.projectId) as { id: string };
  const theirs = w.db
    .prepare(
      `SELECT id FROM sessions WHERE project_id = ?
        AND id NOT IN (SELECT session_id FROM session_drain_cursors) ORDER BY id LIMIT 1`,
    )
    .get(w.projectId) as { id: string } | undefined;
  const theirsId =
    theirs?.id ??
    (
      w.db
        .prepare("SELECT id FROM sessions WHERE project_id = ? ORDER BY id DESC LIMIT 1")
        .get(w.projectId) as { id: string }
    ).id;
  const plant = w.db.prepare(
    `INSERT OR REPLACE INTO session_drain_cursors
       (session_id, owner_user_id, claim_generation, accepted_through, updated_at)
     VALUES (?, ?, 1, 0, 1)`,
  );
  plant.run(elsewhere.id, w.userId);
  plant.run(theirsId, "someone-else");
  return [elsewhere.id, theirsId];
}

describe("a Session born in Volli Cloud's copy", () => {
  test("Go back to local takes its cursor back too", async () => {
    world = await moveWorld();
    const { engine, queueId, moveId } = enqueue(world);
    await engine.run(queueId);
    await engine.confirm(moveId);
    const born = await cloudBorn(world);
    expect(cursorOf(world, born)).toEqual({ n: 1 });
    const strangers = strangerCursors(world);
    await engine.goBackToLocal(moveId);
    expect(cursorOf(world, born)).toEqual({ n: 0 });
    for (const sessionId of strangers) expect(cursorOf(world, sessionId)).toEqual({ n: 1 });
    expect(projectCursors(world)).toEqual({ n: 0 });
  });

  test("Go back to local from a commit the handover never followed takes it back", async () => {
    world = await moveWorld();
    const { queueId, moveId } = enqueue(world);
    let killed!: () => void;
    const stopped = new Promise<void>((resolve) => (killed = resolve));
    void world
      .engine({ kill: { point: "handing_over", hit: 1, onKilled: () => killed() } })
      .run(queueId);
    await stopped;
    const engine = world.engine();
    // The crash came after the commit and before the handover wrote anything.
    expect(engine.journal.move(moveId)!.state).toBe("committed");
    const born = await cloudBorn(world);
    engine.journal.patch(moveId, { journal: { handover: undefined } });
    expect((await engine.goBackToLocal(moveId)).state).toBe("returned");
    expect(cursorOf(world, born)).toEqual({ n: 0 });
  });

  test("a roll back after the commit takes it back and names it", async () => {
    world = await moveWorld();
    const { engine, queueId, moveId } = enqueue(world);
    await engine.run(queueId);
    const born = await cloudBorn(world);
    const strangers = strangerCursors(world);
    const rolled = await engine.rollBack(moveId, { confirmChanged: true });
    expect(rolled.state).toBe("rolled_back");
    expect(cursorOf(world, born)).toEqual({ n: 0 });
    for (const sessionId of strangers) expect(cursorOf(world, sessionId)).toEqual({ n: 1 });
    expect(projectCursors(world)).toEqual({ n: 0 });
    const named = (rolled.failure!.detail as { cursorsTakenBack: string[] }).cursorsTakenBack;
    expect(named).toContain(born);
    for (const sessionId of strangers) expect(named).not.toContain(sessionId);
  });
});

/**
 * A cloud launch's drain over the moved profile, with one moved Session's
 * last fact left to send and its send held until `answer`.
 */
async function drainMidSend(w: MoveWorld) {
  const { session_id: sessionId, accepted_through: through } = w.db
    .prepare(
      `SELECT session_id, accepted_through FROM session_drain_cursors
        WHERE owner_user_id = ? AND accepted_through > 0 ORDER BY session_id LIMIT 1`,
    )
    .get(w.userId) as { session_id: string; accepted_through: number };
  w.db
    .prepare("UPDATE session_drain_cursors SET accepted_through = ? WHERE session_id = ?")
    .run(through - 1, sessionId);
  let answer!: (outcome: Error | null) => void;
  const answered = new Promise<Error | null>((resolve) => (answer = resolve));
  let sent!: () => void;
  const sending = new Promise<void>((resolve) => (sent = resolve));
  const drain = createFactDrain({
    ownerUserId: w.userId,
    ledger: sqliteDrainLedger(w.db),
    cursors: sqliteDrainCursorStore(w.db),
    accept: async () => {
      sent();
      const outcome = await answered;
      if (outcome !== null) throw outcome;
      return { acceptedThrough: through, duplicates: 0, quarantined: 0 };
    },
  });
  drain.start();
  await sending;
  return { sessionId, drain, answer };
}

/** The local copy lists this Session (no cursor hides it). */
const listedLocally = (w: MoveWorld, sessionId: string) =>
  w.db
    .prepare(`SELECT 1 AS listed FROM sessions WHERE id = ? AND ${localSessionRow("sessions.id")}`)
    .get(sessionId) !== undefined;

describe("a cloud drain mid-send while the project goes back (VC-1013)", () => {
  test("Go back to local: the answer writes no cursor back; the local copy lists the Session", async () => {
    world = await moveWorld();
    const { engine, queueId, moveId } = enqueue(world);
    await engine.run(queueId);
    await engine.confirm(moveId);
    const { sessionId, drain, answer } = await drainMidSend(world);
    expect(listedLocally(world, sessionId)).toBe(false);
    const released: string[] = [];
    await world
      .engine({ ports: { cursorsReleased: (ids) => (released.push(...ids), drain.forget(ids)) } })
      .goBackToLocal(moveId);
    expect(released).toContain(sessionId);
    answer(null);
    await drain.idle();
    // Forgotten: the drain holds, counts and waits on nothing of the Session.
    expect(drain.status()).toEqual({ sessions: 0, waiting: 0, blocked: 0 });
    drain.stop();
    expect(cursorOf(world, sessionId)).toEqual({ n: 0 });
    expect(listedLocally(world, sessionId)).toBe(true);
  });

  test("a roll back after the commit: a refusal from the purged copy writes no cursor back", async () => {
    world = await moveWorld();
    const { engine, queueId, moveId } = enqueue(world);
    await engine.run(queueId);
    const { sessionId, drain, answer } = await drainMidSend(world);
    const released: string[] = [];
    const rolled = await world
      .engine({ ports: { cursorsReleased: (ids) => (released.push(...ids), drain.forget(ids)) } })
      .rollBack(moveId, { confirmChanged: true });
    expect(rolled.state).toBe("rolled_back");
    expect(released).toEqual(
      (rolled.failure!.detail as { cursorsTakenBack: string[] }).cursorsTakenBack,
    );
    expect(released).toContain(sessionId);
    answer(
      Object.assign(new Error("not_your_runner"), {
        data: { code: "not_your_runner", message: "gone", acceptedThrough: null },
      }),
    );
    await drain.idle();
    drain.stop();
    expect(cursorOf(world, sessionId)).toEqual({ n: 0 });
    expect(listedLocally(world, sessionId)).toBe(true);
  });
});

describe("Session history", () => {
  test("uploads transcripts and Pi logs, then checks them once the last upload URL expired", async () => {
    world = await moveWorld();
    const { queueId, moveId } = enqueue(world);
    const waits: number[] = [];
    const engine = world.engine({ ports: { sleep: async (ms) => void waits.push(ms) } });
    expect(await engine.run(queueId)).toEqual({ kind: "done" });
    const history = [...world.objects.objects.keys()].filter((key) => key.includes("/s/"));
    expect(history.some((key) => key.includes("/tx/"))).toBe(true);
    expect(history.some((key) => key.includes("/pi/"))).toBe(true);
    // Verification waited out every upload URL before reading the objects back.
    expect(Math.max(...waits)).toBeGreaterThan(5 * 60_000);
    const verify = engine.journal.move(moveId)!.report!.verify as { objects: { checked: number } };
    expect(verify.objects.checked).toBeGreaterThanOrEqual(history.length);
  });

  test("a write landing while the check waits out the last URL is caught", async () => {
    world = await moveWorld();
    const { queueId, moveId } = enqueue(world);
    const engine = world.engine({
      ports: {
        // The wait before the check: a stale URL's upload lands during it.
        sleep: async (ms) => {
          if (ms < 5 * 60_000) return;
          const key = [...world!.objects.objects.keys()].find((k) => k.includes("/pi/"));
          world!.objects.objects.set(key!, new TextEncoder().encode("late"));
        },
      },
    });
    await engine.run(queueId);
    expect(engine.journal.move(moveId)).toMatchObject({
      state: "rolled_back",
      failure: { code: "verification_failed" },
    });
  });

  test("a URL signed and never used, and a journal line a crash tore, do not fail the move", async () => {
    world = await moveWorld();
    const { queueId, moveId } = enqueue(world);
    const engine = world.engine({
      ports: {
        faults: async (point) => {
          if (point !== "history.session") return;
          const file = join(world!.root, "cloud-moves", moveId, "history-signed.ndjson");
          appendFileSync(
            file,
            `${JSON.stringify({
              key: `v1/p/${world!.projectId}/s/${"7a1f0c2e-0000-4000-8000-000000000031"}/tx/000000000001-000000000002.pack.zst`,
              bytes: 1,
              sha256: "a".repeat(64),
              at: Date.now(),
            })}\n{"key":"v1/p/torn`,
          );
        },
      },
    });
    expect(await engine.run(queueId)).toEqual({ kind: "done" });
    const move = engine.journal.move(moveId)!;
    expect(move.state).toBe("checked");
    expect(move.report).toMatchObject({ verify: { objects: { signedNotStored: 1 } } });
  });

  test("folds that never finish end the check in a clear failure, and a recheck resumes it", async () => {
    world = await moveWorld();
    const { queueId, moveId } = enqueue(world);
    // A clock the check's own waits move, and a backend whose folds stay behind.
    let clock = 0;
    let stuck = true;
    const backend = world.backend();
    const stalled = {
      ...backend,
      query: async (path: string, args: Record<string, unknown>) => {
        const answer = await backend.query(path, args);
        if (path !== "projectImportHistory:foldProgress" || !stuck) return answer;
        return { ...(answer as object), behind: [{ sessionId: "s", foldedThrough: 0 }] };
      },
    };
    const sleeps: number[] = [];
    const realPath = windowReadCheck({
      backend: stalled,
      now: () => clock,
      foldTimeoutMs: 60_000,
      sleep: async (ms) => {
        sleeps.push(ms);
        clock += ms;
      },
    });
    const engine = world.engine({ ports: { realPath } });
    expect(await engine.run(queueId)).toEqual({ kind: "done" });
    const failed = engine.journal.move(moveId)!;
    // Not a hang, not a pass: the move waits for the person, the folds named.
    expect(failed.state).toBe("checked");
    expect(failed.report).toMatchObject({
      ok: false,
      realPath: { ok: false, checks: { allSessionsFolded: { checked: 1, failed: 1 } } },
    });
    expect(clock).toBeLessThanOrEqual(60_000);
    expect(sleeps.length).toBeGreaterThan(0);

    // The folds catch up; checking again passes.
    stuck = false;
    const again = world.engine({ ports: { realPath } });
    again.recheck(moveId);
    expect(await again.run(queueId)).toEqual({ kind: "done" });
    expect(again.journal.move(moveId)!.report).toMatchObject({ ok: true, realPath: { ok: true } });
  });

  test("a history object changed after its upload fails the check and rolls the move back", async () => {
    world = await moveWorld();
    const { queueId, moveId } = enqueue(world);
    const engine = world.engine({
      ports: {
        faults: async (point) => {
          if (point !== "history.session") return;
          const key = [...world!.objects.objects.keys()].find((k) => k.includes("/tx/"));
          if (key !== undefined) world!.objects.objects.set(key, new TextEncoder().encode("late"));
        },
      },
    });
    await engine.run(queueId);
    expect(engine.journal.move(moveId)).toMatchObject({
      state: "rolled_back",
      failure: { code: "verification_failed" },
    });
  });
});

describe("interruptions resume", () => {
  test("a network that drops every third call", async () => {
    world = await moveWorld();
    const { queueId, moveId } = enqueue(world);
    expect(await world.engine({ flaps: { every: 3 } }).run(queueId)).toEqual({ kind: "done" });
    expect(world.engine().journal.move(moveId)!.state).toBe("checked");
  });

  test("a network that stays down pauses the move, which resumes", async () => {
    world = await moveWorld();
    const { queueId, moveId } = enqueue(world);
    const down = world.engine({ flaps: { every: 1 } });
    expect(await down.run(queueId)).toMatchObject({ kind: "waiting", reason: "network" });
    // Nothing is undone while it waits.
    expect(down.journal.move(moveId)!.failure).toBeNull();
    expect(await world.engine().run(queueId)).toEqual({ kind: "done" });
    expect(world.engine().journal.move(moveId)!.state).toBe("checked");
  });

  test("a full disk pauses the export, which resumes", async () => {
    world = await moveWorld();
    const { queueId, moveId } = enqueue(world);
    const full = world.engine({
      ports: {
        exportProject: (options) =>
          options.profileStep === true
            ? exportMigrationSnapshot(options)
            : Promise.reject(new MigrationExportError("disk_full", "full")),
      },
    });
    expect(await full.run(queueId)).toMatchObject({ kind: "waiting", reason: "disk_full" });
    expect(full.journal.move(moveId)!.state).toBe("frozen");
    expect(
      await world.engine({ ports: { exportProject: exportMigrationSnapshot } }).run(queueId),
    ).toEqual({ kind: "done" });
  });

  test("a project with a live turn waits, unfrozen", async () => {
    world = await moveWorld();
    const { queueId, moveId } = enqueue(world);
    const busy = world.engine({
      ports: {
        liveWork: { busySessionIds: () => new Set(["7a1f0c2e-0000-4000-8000-000000000031"]) },
      },
    });
    expect(await busy.run(queueId)).toMatchObject({ kind: "waiting", reason: "not_idle" });
    expect(projectFreeze(world.db, world.projectId)).toBeNull();
    expect(busy.journal.move(moveId)!.state).toBe("queued");
    expect(await world.engine().run(queueId)).toEqual({ kind: "done" });
  });

  test("stops at the first problem by default on the profile's first Move all", async () => {
    world = await moveWorld();
    const engine = world.engine();
    const target = {
      userId: world.userId,
      workspaceId: world.workspaceId,
      runnerId: world.runnerId,
    };
    const first = engine.enqueue({
      projectIds: [world.projectId, "7a1f0c2e-0000-4000-8000-000000000002"],
      target,
      includeRemoved: true,
    });
    expect(first.queue.stopAtFirstProblem).toBe(true);
  });

  test("a project that waits goes after the rest of the queue", async () => {
    world = await moveWorld();
    const removed = "7a1f0c2e-0000-4000-8000-000000000002";
    const engine = world.engine({
      ports: {
        liveWork: { busySessionIds: () => new Set(["7a1f0c2e-0000-4000-8000-000000000031"]) },
      },
    });
    const { queue, moves } = engine.enqueue({
      projectIds: [world.projectId, removed],
      target: { userId: world.userId, workspaceId: world.workspaceId, runnerId: world.runnerId },
      includeRemoved: true,
      stopAtFirstProblem: false,
    });
    const busy = moves.find((m) => m.projectId === world!.projectId)!;
    expect(await engine.run(queue.queueId)).toEqual({
      kind: "waiting",
      moveId: busy.moveId,
      reason: "not_idle",
    });
    const other = engine.journal.moves(queue.queueId).find((m) => m.projectId === removed)!;
    expect(other.state).toBe("checked");
    expect(engine.journal.move(busy.moveId)!.state).toBe("queued");
  });

  test("signed out, the move waits for the same person", async () => {
    world = await moveWorld();
    const { queueId } = enqueue(world);
    const out = world.engine({ ports: { identity: { current: async () => null } } });
    expect(await out.run(queueId)).toMatchObject({ kind: "waiting", reason: "signed_out" });
    const someoneElse = world.engine({
      ports: {
        identity: { current: async () => ({ userId: "other", runnerId: world!.runnerId }) },
      },
    });
    expect(await someoneElse.run(queueId)).toMatchObject({ reason: "signed_out" });
    expect(await world.engine().run(queueId)).toEqual({ kind: "done" });
  });
});

describe("problems roll back", () => {
  test("a row Volli Cloud refuses rolls the project back, unchanged and writable here", async () => {
    world = await moveWorld();
    // Another of Alice's projects already holds one of the moved ticket ids.
    const ticketId = "7a1f0c2e-0000-4000-8000-000000000021";
    await world.t.run(async (ctx) => {
      const ticket = await ctx.db.query("tickets").first();
      await ctx.db.patch(ticket!._id, { id: ticketId });
    });
    const { engine, queueId, moveId } = enqueue(world, undefined, true);
    expect(await engine.run(queueId)).toEqual({ kind: "stopped", moveId });
    const move = engine.journal.move(moveId)!;
    expect(move.state).toBe("rolled_back");
    expect(move.failure).toMatchObject({ code: "rows_refused", step: "objects" });
    expect(projectFreeze(world.db, world.projectId)).toBeNull();
    expect(existsSync(join(world.root, "cloud-moves", moveId))).toBe(false);
    expect((await finalDigests(world, moveId)).status).toBe("aborting");
  });
});

describe("a project already in Volli Cloud", () => {
  test("a project the backend already holds is not moved twice", async () => {
    world = await moveWorld();
    const first = enqueue(world);
    await first.engine.run(first.queueId);
    await first.engine.confirm(first.moveId);
    await first.engine.goBackToLocal(first.moveId);
    const again = enqueue(world);
    expect(await again.engine.run(again.queueId)).toEqual({ kind: "done" });
    expect(again.engine.journal.move(again.moveId)!.state).toBe("rolled_back");
    expect(again.engine.journal.move(again.moveId)!.failure?.code).toBe("already_migrated");
  });
});

describe("problems with this Mac's own files", () => {
  test.each(["ENOSPC", "verification"])(
    "a failed backup (%s) never freezes or exports a project",
    async (code) => {
      world = await moveWorld();
      const { engine, queueId, moveId } = enqueue(
        world,
        world.engine({
          ports: {
            backup: {
              async write() {
                throw Object.assign(new Error("Backup refused"), { code });
              },
            },
            exportProject: async () => {
              throw new Error("must never export");
            },
          },
        }),
      );
      expect(await engine.run(queueId)).toEqual({
        kind: "waiting",
        moveId,
        reason: code === "ENOSPC" ? "disk_full" : "paused",
      });
      expect(engine.journal.queue(queueId)!.backup).toBeNull();
      expect(engine.journal.move(moveId)!.state).toBe("queued");
      expect(projectFreeze(world.db, world.projectId)).toBeNull();
      expect(world.calls.size).toBe(0);
    },
  );
  test("journals a backup published during cancellation without freezing or writing it twice", async () => {
    world = await moveWorld();
    const abort = new AbortController();
    const backup = {
      path: join(world.root, "pre-cloud-move.tar.gz"),
      bytes: 123,
      sha256: "b".repeat(64),
    };
    let writes = 0;
    const { engine, queueId, moveId } = enqueue(
      world,
      world.engine({
        ports: {
          backup: {
            async write() {
              writes++;
              abort.abort();
              return backup;
            },
          },
        },
      }),
    );
    expect(await engine.run(queueId, abort.signal)).toEqual({
      kind: "waiting",
      moveId,
      reason: "paused",
    });
    expect(engine.journal.queue(queueId)!.backup).toMatchObject(backup);
    expect(engine.journal.move(moveId)!.state).toBe("queued");
    expect(projectFreeze(world.db, world.projectId)).toBeNull();
    expect(await engine.run(queueId)).toEqual({ kind: "done" });
    expect(writes).toBe(1);
  });

  test("an attachment gone from disk mid-move rolls the project back, never waits on the network", async () => {
    world = await moveWorld();
    const { queueId, moveId } = enqueue(world);
    const engine = world.engine({
      ports: {
        faults: async (point) => {
          if (point === "reserved")
            rmSync(join(world!.root, "profile", "blobs"), { recursive: true });
        },
      },
    });
    await engine.run(queueId);
    expect(engine.journal.move(moveId)).toMatchObject({
      state: "rolled_back",
      failure: { code: "local_file_unreadable" },
    });
  });
});

describe("the person's decisions", () => {
  test("Roll back after the commit uncommits, aborts and unfreezes", async () => {
    world = await moveWorld();
    const { engine, queueId, moveId } = enqueue(world);
    await engine.run(queueId);
    const rolled = await engine.rollBack(moveId);
    expect(rolled.state).toBe("rolled_back");
    expect(projectFreeze(world.db, world.projectId)).toBeNull();
    expect(movedCursors(world)).toEqual({
      n: 0,
    });
    expect(world.db.prepare("SELECT COUNT(*) AS n FROM project_checkout_paths").get()).toEqual({
      n: 0,
    });
    expect((await finalDigests(world, moveId)).status).toBe("aborting");
  });

  test("a commit that landed unheard is rolled back from the backend's own answer", async () => {
    world = await moveWorld();
    const { queueId, moveId } = enqueue(world);
    let killed!: () => void;
    const stopped = new Promise<void>((resolve) => (killed = resolve));
    void world
      .engine({
        kill: {
          point: "call:projectImports:commit",
          hit: 1,
          after: true,
          onKilled: () => killed(),
        },
      })
      .run(queueId);
    await stopped;
    const engine = world.engine();
    expect(engine.journal.move(moveId)!.state).toBe("verified");
    expect((await engine.rollBack(moveId)).state).toBe("rolled_back");
    expect((await finalDigests(world, moveId)).status).toBe("aborting");
  });

  test("a roll back of an interrupted handover takes back everything it may have written", async () => {
    world = await moveWorld();
    const { queueId, moveId } = enqueue(world);
    let killed!: () => void;
    const stopped = new Promise<void>((resolve) => (killed = resolve));
    void world
      .engine({ kill: { point: "handed_over", hit: 1, onKilled: () => killed() } })
      .run(queueId);
    await stopped;
    expect(movedCursors(world)).not.toEqual({
      n: 0,
    });
    expect((await world.engine().rollBack(moveId)).state).toBe("rolled_back");
    expect(movedCursors(world)).toEqual({
      n: 0,
    });
    expect(world.db.prepare("SELECT COUNT(*) AS n FROM project_checkout_paths").get()).toEqual({
      n: 0,
    });
  });

  test("after Finish move, a moved Session resumes and takes a message, and a new cloud Session starts", async () => {
    world = await moveWorld();
    const { engine, queueId, moveId } = enqueue(world);
    await engine.run(queueId);
    await engine.confirm(moveId);
    expect(projectFreeze(world.db, world.projectId)).toBe("confirmed");
    // A cloud launch on this Mac: the one writer, scoped to the signed-in owner.
    const services = createHostSessionServices(world.db, {
      log: { error: () => {}, warn: () => {} },
      events: { publish: () => {} },
      attention: {
        deliver: () => ({ delivered: true as const }),
        focusedSessionIds: () => new Set<string>(),
      },
    });
    try {
      const owner = world.userId;
      const moved = "7a1f0c2e-0000-4000-8000-000000000032";
      const message = () => ({
        commandId: crypto.randomUUID(),
        sessionId: moved,
        intent: {
          kind: "message.submit" as const,
          reference: { id: crypto.randomUUID(), mediaType: null, digest: null },
        },
        provenance: {
          source: { kind: "system" as const, id: "local-launch", detail: null },
          venue: { id: "local", kind: "local" as const },
        },
      });
      // A local launch: the archived copy takes no message, not even to a moved Session.
      await expect(services.sessionEngine.submit(message())).rejects.toMatchObject({
        code: "project_moving",
      });
      // A cloud launch for the mover, as the cloud product store binds it.
      bindCloudSessionOwner(world.db, owner);
      const cloud = createCloudSessionOwner({
        db: world.db,
        engine: services.sessionEngine,
        ownerUserId: owner,
        adopt: (sessionId) =>
          sqliteDrainCursorStore(world!.db).save({
            sessionId,
            ownerUserId: owner,
            generation: 1,
            acceptedThrough: 0,
            blocked: null,
          }),
      });
      const provenance = {
        source: { kind: "system" as const, id: "cloud-launch", detail: null },
        venue: { id: world.runnerId, kind: "remote" as const },
      };
      // A moved Session (the fixture's quieter one: the busy one carries a
      // deliberately malformed fact this build cannot fold either way).
      expect(cloud.owns(moved)).toBe(true);
      await expect(
        cloud.engine.submit({
          commandId: crypto.randomUUID(),
          sessionId: moved,
          intent: {
            kind: "message.submit",
            reference: { id: crypto.randomUUID(), mediaType: null, digest: null },
          },
          provenance,
        }),
      ).resolves.toMatchObject({ receipt: { status: expect.any(String) } });
      const started = await cloud.engine.createSession({
        commandId: crypto.randomUUID(),
        projectId: world.projectId,
        ticketId: null,
        role: "project",
        parentSessionId: null,
        title: "Started in Volli Cloud",
        provenance,
      });
      expect(cloud.owns(started.session.id)).toBe(true);
      // The archived local copy still takes nothing.
      await expect(
        services.sessionEngine.createSession({
          commandId: crypto.randomUUID(),
          projectId: world.projectId,
          ticketId: null,
          role: "project",
          parentSessionId: null,
          title: null,
          provenance: { ...provenance, venue: { id: "local", kind: "local" as const } },
        }),
      ).rejects.toMatchObject({ code: "project_moving" });
    } finally {
      bindCloudSessionOwner(world.db, null);
      services.sessionActivityWatch.stop();
    }
  });

  test("a cloud change since the commit needs the person's confirmation to roll back", async () => {
    world = await moveWorld();
    const { engine, queueId, moveId } = enqueue(world);
    await engine.run(queueId);
    await world.t.withIdentity(alice).mutation(api.board.createComment, {
      commandId: crypto.randomUUID(),
      ticketId: "7a1f0c2e-0000-4000-8000-000000000021",
      commentId: crypto.randomUUID(),
      body: "written in Volli Cloud",
    });
    await expect(engine.rollBack(moveId)).rejects.toMatchObject({ code: "changed_since_commit" });
    expect(engine.journal.move(moveId)!.state).toBe("checked");
    expect((await engine.rollBack(moveId, { confirmChanged: true })).state).toBe("rolled_back");
  });

  test("Go back to local saves the cloud's changes and unlocks the local copy", async () => {
    world = await moveWorld();
    const { engine, queueId, moveId } = enqueue(world);
    await engine.run(queueId);
    await engine.confirm(moveId);
    await world.t.withIdentity(alice).mutation(api.board.createComment, {
      commandId: crypto.randomUUID(),
      ticketId: "7a1f0c2e-0000-4000-8000-000000000021",
      commentId: crypto.randomUUID(),
      body: "written in Volli Cloud",
    });
    const returned = await engine.goBackToLocal(moveId);
    expect(returned.state).toBe("returned");
    expect(projectFreeze(world.db, world.projectId)).toBeNull();
    expect(movedCursors(world)).toEqual({
      n: 0,
    });
    const saved = JSON.parse(
      readFileSync(join(returned.journal.returnedExport!, "cloud-changes.json"), "utf8"),
    );
    expect(JSON.stringify(saved.tickets)).toContain("written in Volli Cloud");
    expect(
      readFileSync(join(returned.journal.returnedExport!, "cloud-changes.md"), "utf8"),
    ).toContain("written in Volli Cloud");
    // Volli Cloud keeps its copy.
    expect((await finalDigests(world, moveId)).status).toBe("committed");
  });

  test("Go back to local keeps every local fact of a Session drained past the move", async () => {
    world = await moveWorld();
    const { engine, queueId, moveId } = enqueue(world);
    await engine.run(queueId);
    const hot = "7a1f0c2e-0000-4000-8000-000000000031";
    const head = (
      world.db
        .prepare("SELECT MAX(sequence) AS last FROM session_events WHERE session_id = ?")
        .get(hot) as {
        last: number;
      }
    ).last;
    // In Volli Cloud the Session went on here: a new local fact, drained past the move.
    world.db
      .prepare(
        `INSERT INTO session_events (id, session_id, sequence, occurred_at, recorded_at,
           provenance_id, attachment_id, command_id, payload)
         VALUES (?, ?, ?, 2, 2, 1, NULL, NULL, ?)`,
      )
      .run(
        `event:${hot}:after`,
        hot,
        head + 1,
        JSON.stringify({ kind: "session.signaled", signal: "done", reason: null }),
      );
    world.db
      .prepare("UPDATE session_drain_cursors SET accepted_through = ? WHERE session_id = ?")
      .run(head + 1, hot);
    const before = world.db
      .prepare("SELECT * FROM session_events WHERE session_id = ? ORDER BY sequence")
      .all(hot);

    await engine.confirm(moveId);
    expect((await engine.goBackToLocal(moveId)).state).toBe("returned");

    // The local ledger is the Session's whole history again: every fact kept,
    // the one past the move included, and no cursor left to drain it anywhere.
    expect(
      world.db
        .prepare("SELECT * FROM session_events WHERE session_id = ? ORDER BY sequence")
        .all(hot),
    ).toEqual(before);
    expect(before).toHaveLength(head + 1);
    expect(
      world.db
        .prepare("SELECT COUNT(*) AS n FROM session_drain_cursors WHERE session_id = ?")
        .get(hot),
    ).toEqual({ n: 0 });
  });

  test("a runner replaced mid-move starts the project over under a new move", async () => {
    world = await moveWorld();
    const { queueId, moveId } = enqueue(world);
    let runner = world.runnerId;
    const replacedAfterReserve = world.engine({
      ports: {
        identity: { current: async () => ({ userId: world!.userId, runnerId: runner }) },
        faults: async (point) => {
          if (point === "reserved") runner = world!.otherRunnerId;
        },
      },
    });
    const outcome = await replacedAfterReserve.run(queueId);
    const moves = replacedAfterReserve.journal.moves(queueId);
    expect(moves.find((m) => m.moveId === moveId)!.state).toBe("superseded");
    const next = moves.find((m) => m.supersedes === moveId)!;
    // It moves again onto the new runner, up to the reservation: the old move
    // holds the project id until its purge finishes.
    expect(next).toMatchObject({
      state: "exported",
      runnerId: runner,
      paused: "waiting_for_purge",
    });
    expect(outcome).toMatchObject({ kind: "waiting", reason: "waiting_for_purge" });
    expect((await finalDigests(world, moveId)).status).toBe("aborting");
  });
});

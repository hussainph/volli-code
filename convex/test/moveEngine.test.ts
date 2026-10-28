/**
 * The move engine against the real person-authorized import (`convex-test`):
 * one project of a synthetic local profile moved end to end, and every way a
 * move is interrupted, refused, rolled back or taken back. The kill/resume
 * matrix itself is `moveEngine.matrix.test.ts` (ci-extended).
 */
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "vite-plus/test";

import { projectFreeze } from "../../packages/host-core/src/cloud-move/freeze";
import { MigrationExportError } from "../../packages/host-core/src/migration-export/errors";
import { exportMigrationSnapshot } from "../../packages/host-core/src/migration-export/exporter";
import { api } from "../functions/_generated/api";
import { finalDigests, moveWorld, type MoveWorld } from "./move-engine-harness";

let world: MoveWorld | undefined;
afterEach(() => {
  world?.cleanup();
  world = undefined;
});

const alice = { subject: "user:alice", issuer: "https://issuer.test" };

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
    // Every window read matches the export. Until moved Sessions are folded after the commit (VC-990), the the first
    // fold of a moved Session, the fold wait is the one check that cannot pass.
    const realPath = move.report!.realPath as { checks: Record<string, { failed: number }> };
    for (const [name, { failed }] of Object.entries(realPath.checks)) {
      expect({ name, failed }).toEqual({ name, failed: name === "sessionFolded" ? failed : 0 });
    }
    expect(realPath.checks.boardTicket!.failed).toBe(0);
    expect(realPath.checks.sessionHistory!.failed).toBe(0);
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
    expect(world.db.prepare("SELECT COUNT(*) AS n FROM session_drain_cursors").get()).toEqual({
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
    expect(world.db.prepare("SELECT COUNT(*) AS n FROM session_drain_cursors").get()).toEqual({
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

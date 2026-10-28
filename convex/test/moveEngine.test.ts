/**
 * The move engine against the real person-authorized import (`convex-test`):
 * one project of a synthetic local profile moved end to end, and every way a
 * move is interrupted, refused, rolled back or taken back. The kill/resume
 * matrix itself is `moveEngine.matrix.test.ts` (ci-extended).
 */
import { existsSync, rmSync } from "node:fs";
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
    expect(move.state).toBe("committed");
    expect(move.failure).toBeNull();
    expect(move.report).toMatchObject({ verify: { ok: true } });
    // Still read-only here: the project is shown in Volli Cloud.
    expect(projectFreeze(world.db, world.projectId)).toBe("committed");

    const final = await finalDigests(world, moveId);
    expect(final.status).toBe("committed");
    const shown = await world.t
      .withIdentity(alice)
      .query(api.projects.get, { projectId: world.projectId });
    expect(shown.name).toBe("Alpha");
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
});

describe("interruptions resume", () => {
  test("a network that drops every third call", async () => {
    world = await moveWorld();
    const { queueId, moveId } = enqueue(world);
    expect(await world.engine({ flaps: { every: 3 } }).run(queueId)).toEqual({ kind: "done" });
    expect(world.engine().journal.move(moveId)!.state).toBe("committed");
  });

  test("a network that stays down pauses the move, which resumes", async () => {
    world = await moveWorld();
    const { queueId, moveId } = enqueue(world);
    const down = world.engine({ flaps: { every: 1 } });
    expect(await down.run(queueId)).toMatchObject({ kind: "waiting", reason: "network" });
    // Frozen while it waits: nothing is undone.
    expect(projectFreeze(world.db, world.projectId)).not.toBeNull();
    expect(await world.engine().run(queueId)).toEqual({ kind: "done" });
    expect(world.engine().journal.move(moveId)!.state).toBe("committed");
  });

  test("a full disk pauses the export, which resumes", async () => {
    world = await moveWorld();
    const { queueId, moveId } = enqueue(world);
    const full = world.engine({
      ports: {
        exportProject: () => Promise.reject(new MigrationExportError("disk_full", "full")),
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
    });
    expect(queue.stopAtFirstProblem).toBe(true);
    const busy = moves.find((m) => m.projectId === world!.projectId)!;
    expect(await engine.run(queue.queueId)).toEqual({
      kind: "waiting",
      moveId: busy.moveId,
      reason: "not_idle",
    });
    const other = engine.journal.moves(queue.queueId).find((m) => m.projectId === removed)!;
    expect(other.state).toBe("committed");
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
    expect(engine.journal.move(moveId)!.state).toBe("committed");
    expect((await engine.rollBack(moveId, { confirmChanged: true })).state).toBe("rolled_back");
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

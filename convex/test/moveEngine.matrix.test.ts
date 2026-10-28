/**
 * The kill/resume matrix: the engine stopped dead at every step
 * boundary and mid-step, before and after a backend call lands, then a fresh
 * engine (what a relaunch builds) resumes the same queue. Every case must end
 * where an uninterrupted move ends: committed, verified, with the backend
 * holding exactly the plan's rows (the accumulators only grow on insert, so
 * a row landing twice would show) and every object staged once.
 *
 * Heavy for the PR lane: it runs in ci-extended's `Move to Volli Cloud` job
 * (`pnpm -C convex test:matrix`).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "vite-plus/test";

import { finalDigests, moveWorld, type Kill, type MoveWorld } from "./move-engine-harness";

let world: MoveWorld | undefined;
afterEach(() => {
  world?.cleanup();
  world = undefined;
});

const STEP_BOUNDARIES = ["freeze", "exported", "reserve", "reserved", "verified", "committed"];
const MID_STEP = [
  "stage.chunk",
  "objects.batch",
  "rows.projects",
  "rows.tickets",
  "rows.boardEvents",
  "rows.sessions",
  "rows.sessionEvents",
  "rows.sessionIntake",
  "rows.readMarkers",
  "history.session",
  "handing_over",
];
const CALLS: Array<Omit<Kill, "onKilled">> = [
  { point: "call:projectImports:begin", hit: 1 },
  { point: "call:projectImports:begin", hit: 1, after: true },
  { point: "call:projectImports:presignPut", hit: 1, after: true },
  { point: "call:projectImports:importRows", hit: 1, after: true },
  { point: "call:projectImports:importRows", hit: 3, after: true },
  { point: "call:projectImports:importRows", hit: 3 },
  { point: "call:projectImports:status", hit: 1 },
  { point: "call:projectImports:readRows", hit: 4 },
  { point: "call:projectImports:commit", hit: 1 },
  { point: "call:projectImports:commit", hit: 1, after: true },
];

const CASES: Array<Omit<Kill, "onKilled">> = [
  ...STEP_BOUNDARIES.map((point) => ({ point, hit: 1 })),
  ...MID_STEP.map((point) => ({ point, hit: 1 })),
  // presignPut is the production object store's; the stand-in does not call it.
  ...CALLS.filter((kill) => kill.point !== "call:projectImports:presignPut"),
];

/** Runs until the engine stops at `kill`, then abandons it, as a crash would. */
async function killedAt(w: MoveWorld, queueId: string, kill: Omit<Kill, "onKilled">) {
  let killed!: () => void;
  const stopped = new Promise<void>((resolve) => (killed = resolve));
  const run = w.engine({ kill: { ...kill, onKilled: () => killed() } }).run(queueId);
  await Promise.race([
    stopped,
    run.then((outcome) => {
      throw new Error(`the engine never reached ${kill.point}: ${JSON.stringify(outcome)}`);
    }),
  ]);
}

describe("kill at any point, resume, same end", () => {
  test.each(
    CASES.map((kill) => [`${kill.point}#${kill.hit}${kill.after ? " (landed)" : ""}`, kill]),
  )("%s", async (_name, kill) => {
    world = await moveWorld();
    const engine = world.engine();
    const { queue, moves } = engine.enqueue({
      projectIds: [world.projectId],
      target: { userId: world.userId, workspaceId: world.workspaceId, runnerId: world.runnerId },
      stopAtFirstProblem: false,
    });
    const moveId = moves[0]!.moveId;
    await killedAt(world, queue.queueId, kill);

    expect(await world.engine().run(queue.queueId)).toEqual({ kind: "done" });
    const move = world.engine().journal.move(moveId)!;
    expect(move.state).toBe("checked");
    expect(move.failure).toBeNull();
    expect(move.report).toMatchObject({ verify: { ok: true } });

    const plan = JSON.parse(
      readFileSync(join(world.root, "cloud-moves", moveId, "plan.json"), "utf8"),
    ) as { expected: Array<{ stream: string; count: number; digest: string }> };
    const final = await finalDigests(world, moveId);
    expect(final.status).toBe("committed");
    expect(final.streams).toEqual(
      Object.fromEntries(
        plan.expected.map(({ stream, count, digest }) => [stream, { count, digest }]),
      ),
    );
    // Exactly the plan's rows in the tables, none twice.
    for (const stream of ["tickets", "ticketComments", "boardEvents"] as const) {
      expect(final.scanned[stream]!.count).toBeGreaterThanOrEqual(final.streams[stream]!.count);
    }
    // A second resume changes nothing.
    const importRows = world.calls.get("projectImports:importRows");
    expect(await world.engine().run(queue.queueId)).toEqual({ kind: "done" });
    expect(world.calls.get("projectImports:importRows")).toBe(importRows);
  });
});

describe("kill while rolling back or going back, resume, same end", () => {
  test.each([["rollback.uncommitted"], ["rollback.aborted"]])("%s", async (point) => {
    world = await moveWorld();
    const engine = world.engine();
    const { queue, moves } = engine.enqueue({
      projectIds: [world.projectId],
      target: { userId: world.userId, workspaceId: world.workspaceId, runnerId: world.runnerId },
      stopAtFirstProblem: false,
    });
    await engine.run(queue.queueId);
    let killed!: () => void;
    const stopped = new Promise<void>((resolve) => (killed = resolve));
    void world
      .engine({ kill: { point, hit: 1, onKilled: () => killed() } })
      .rollBack(moves[0]!.moveId);
    await stopped;
    expect(world.engine().journal.move(moves[0]!.moveId)!.state).toBe("rolling_back");
    // A relaunch finishes the roll back where it stopped, even in a queue that
    // stopped at a problem.
    world.engine().journal.setQueue(queue.queueId, { state: "stopped" });
    await world.engine().resume();
    expect(world.engine().journal.move(moves[0]!.moveId)!.state).toBe("rolled_back");
    expect((await finalDigests(world, moves[0]!.moveId)).status).toBe("aborting");
  });

  test("returning.saved", async () => {
    world = await moveWorld();
    const engine = world.engine();
    const { queue, moves } = engine.enqueue({
      projectIds: [world.projectId],
      target: { userId: world.userId, workspaceId: world.workspaceId, runnerId: world.runnerId },
      stopAtFirstProblem: false,
    });
    await engine.run(queue.queueId);
    let killed!: () => void;
    const stopped = new Promise<void>((resolve) => (killed = resolve));
    void world
      .engine({ kill: { point: "returning.saved", hit: 1, onKilled: () => killed() } })
      .goBackToLocal(moves[0]!.moveId);
    await stopped;
    const returned = await world.engine().goBackToLocal(moves[0]!.moveId);
    expect(returned.state).toBe("returned");
  });
});

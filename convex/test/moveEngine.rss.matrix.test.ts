/**
 * The move engine's memory budget: at most 500 MB above where it started,
 * moving the large fixture (2,048 transcript bodies, more than 50 MiB of
 * them, mixed plain and gzip, a 105 KiB largest, and a multi-slice Pi log)
 * end to end, its Pi log holding one line as long as a move carries
 * (`PI_MOVE_LINE_MAX_BYTES`, VC-1030): exported and verified in pieces,
 * uploaded whole by the runner's spool, redacted by a redactor that knows a
 * credential (as a person with stored keys has). The process's whole RSS is sampled
 * while it runs, and it holds the in-process backend and the object stand-in
 * too, so the engine's own share is below what this measures. ci-extended
 * (`test:matrix`).
 */
import { afterEach, expect, test, vi } from "vite-plus/test";

import { PI_MOVE_LINE_MAX_BYTES } from "../../packages/host-core/src/migration-export/records";
import { moveWorld, type MoveWorld } from "./move-engine-harness";

vi.setConfig({ testTimeout: 600_000 });

const BUDGET_BYTES = 500 * 1024 * 1024;

let world: MoveWorld | undefined;
afterEach(() => {
  world?.cleanup();
  world = undefined;
});

test("moves the large fixture within 500 MB of extra memory", async () => {
  world = await moveWorld({
    artifacts: 2048,
    piLongLineBytes: PI_MOVE_LINE_MAX_BYTES,
    secrets: ["sk-test-0123456789abcdef"],
  });
  const engine = world.engine();
  const { queue, moves } = engine.enqueue({
    projectIds: [world.projectId],
    target: { userId: world.userId, workspaceId: world.workspaceId, runnerId: world.runnerId },
    stopAtFirstProblem: false,
  });
  globalThis.gc?.();
  const baseline = process.memoryUsage().rss;
  let peak = baseline;
  const sampler = setInterval(() => {
    peak = Math.max(peak, process.memoryUsage().rss);
  }, 25);
  try {
    expect(await engine.run(queue.queueId)).toEqual({ kind: "done" });
  } finally {
    clearInterval(sampler);
  }
  peak = Math.max(peak, process.memoryUsage().rss);
  const move = engine.journal.move(moves[0]!.moveId)!;
  expect(move.state).toBe("checked");
  expect(move.report).toMatchObject({ ok: true });
  console.log(
    `move RSS: baseline ${Math.round(baseline / 2 ** 20)} MiB, peak ${Math.round(peak / 2 ** 20)} MiB, extra ${Math.round((peak - baseline) / 2 ** 20)} MiB`,
  );
  expect(peak - baseline).toBeLessThanOrEqual(BUDGET_BYTES);
});

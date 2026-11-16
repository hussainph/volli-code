/**
 * Node flags for the vitest worker processes, spread into a test config beside
 * `SHARED_MACHINE_TEST_WORKERS` (VC-1209).
 *
 * Today the only flag is `--no-wasm-code-gc` on Node 24, for nodejs/node#66366:
 * why, and when to remove it, is in `wasm-code-gc-workaround.ts`. In CI the
 * abort killed a vitest fork in the middle of a shard: "Worker exited
 * unexpectedly" while every reported test passed, in desktop and host-core
 * tests that start and stop worker threads; `docs/development/ci.md` lists the
 * evidence the shards keep. For one test file's fork the flag costs nothing
 * that matters.
 *
 * Decided by major version, because V8's version is what carries the bug.
 * Node 22 predates per-process wrappers and Node 26 has the fix, so neither
 * gets the flag.
 */
import { NO_WASM_CODE_GC } from "./wasm-code-gc-workaround.ts";

/** The flags a vitest worker on this Node takes. */
export function testWorkerExecArgv(nodeVersion: string = process.versions.node): string[] {
  return nodeVersion.split(".")[0] === "24" ? [NO_WASM_CODE_GC] : [];
}

/** Spread into a vitest `test` block, or into a project that does not extend one. */
export const TEST_WORKER_NODE_FLAGS = { execArgv: testWorkerExecArgv() } as const;

/**
 * The per-test timeout on a CI runner, for the lanes whose tests do durable
 * SQLite and filesystem work on the runner's disk (VC-1233).
 *
 * GitHub's Linux runners stall on disk for a few seconds at a time, a few
 * times a week. Where the shard kept `runner-health.log`, the samples over the
 * stall read 49–55% I/O wait, where healthy jobs stay at 25% or less, and in
 * each stall checked, tests in the shard's other forks ran 10 to 60 times slower over
 * the same seconds. A test caught inside a synchronous better-sqlite3 or `fs`
 * call then overruns Vitest's 5 s default though nothing is wrong with it.
 * Of the 25 failed CI runs read for this ticket, host-core failed that way six
 * times, at 5,010 to 7,023 ms (runs 43526276245, 43483112383, 42889537731,
 * 43520094984, 43409019716, 43255337027), and twice more at 5,062 and
 * 5,196 ms when its tests still ran in `Test (packages)` (not read further). The longest stalled
 * window seen was about 8 s: in run 43409019716 a test with its own longer
 * bound took 7,908 ms, against 1,215 ms in a healthy run, beside the 7,023 ms
 * failure. The desktop shards and today's `Test (packages)` showed no failure
 * of this kind, so they keep the default.
 *
 * 15 s is that worst window with roughly 2x margin, and still short enough
 * that a genuinely hung test fails well inside a shard's 15-minute job. It
 * applies only when `CI` is set: at a desk the default 5 s still flags a slow
 * test. A test or file that sets its own timeout keeps it either way.
 */
const CI_RUNNER_STALL_TEST_TIMEOUT_MS = 15_000;

/** The `testTimeout` a lane on this runner takes: CI's, or Vitest's own default. */
export function runnerStallTestTimeout(env: Record<string, string | undefined> = process.env): {
  testTimeout?: number;
} {
  const ci = env["CI"];
  return ci && ci !== "false" && ci !== "0" ? { testTimeout: CI_RUNNER_STALL_TEST_TIMEOUT_MS } : {};
}

/** Spread into the `test` block of a lane that does durable disk work in CI. */
export const RUNNER_STALL_TEST_TIMEOUT = runnerStallTestTimeout();

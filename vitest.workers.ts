/**
 * How many vitest workers ONE `vp test` invocation may take on a shared
 * machine (VC-339), spelled once and spread into every package's own test
 * config.
 *
 * Vitest defaults `maxWorkers` to the core count per invocation, and this
 * repository is developed by several agent Sessions at a time on one laptop:
 * a load audit on an 8-core, 16 GB M1 measured three concurrent `vp test`
 * runs holding 19 live workers (~850 MB) beside a `--coverage` runner at 1.5
 * GB, on a machine whose Sessions, app and browsers already exceed physical
 * RAM. Two is what a single invocation may take for granted; the machine's
 * remaining cores are the other Sessions'.
 *
 * It lives in its own module rather than in the root `vite.config.ts` because
 * a package's config does NOT inherit the root one — measured, not assumed:
 * `vp test run` in `packages/shared` resolves its own config, and the root's
 * `test` block never reaches it. A value written only at the root would look
 * like a repository-wide cap and would in fact apply to nothing anyone runs.
 *
 * ## The budget may lower this cap; it may never raise it
 *
 * `VITEST_MAX_WORKERS` is the vitest entry of the Session concurrency budget
 * (`apps/desktop/src/main/session-concurrency.ts`), and vitest re-reads it
 * AFTER config resolution, assigning it over whatever a config said — over a
 * `--maxWorkers` flag too. Left alone, that inverts the point of this file: a
 * Session alone on an 8-core laptop is budgeted 8, and 8 would then overwrite a
 * cap of 2 (measured in review: 6 workers with the variable at 6, even under
 * `--maxWorkers=2`).
 *
 * So the variable is resolved HERE, at config load, in the same process vitest
 * resolves its config in, and rewritten to the resolved value before vitest
 * reads it:
 *
 * - **Budget below the cap** — a busy machine — wins: `VITEST_MAX_WORKERS=1`
 *   yields one worker. That is the whole feature.
 * - **Budget above the cap** is clamped to the cap: `VITEST_MAX_WORKERS=8`
 *   yields two, and the environment is rewritten so vitest's own late read
 *   cannot undo it.
 * - **An explicit `--maxWorkers` flag** outranks both, so the ambient variable
 *   is removed rather than clamped and the flag governs alone. That is CI's
 *   door: it has the runner to itself and asks for `$(nproc)` in
 *   `.github/workflows/ci.yml`. It is also any human's or agent's door for one
 *   deliberate invocation.
 *
 * Mutating `process.env` from a config module is unusual and is the point:
 * vitest's post-resolution read is not otherwise reachable, and a cap that any
 * ambient variable can raise is not a cap.
 */
import {
  loweredParallelism,
  namesWorkerCountExplicitly,
} from "./packages/shared/src/concurrency-budget";

/** What one invocation may take for granted on a machine shared with Sessions. */
const SHARED_MACHINE_CAP = 2;

function resolveMaxWorkers(): number {
  if (namesWorkerCountExplicitly(process.argv)) {
    // The flag is the whole answer; the ambient hint must not be applied over
    // it after config resolution.
    delete process.env["VITEST_MAX_WORKERS"];
    return SHARED_MACHINE_CAP;
  }
  const resolved = loweredParallelism(SHARED_MACHINE_CAP, process.env["VITEST_MAX_WORKERS"]);
  // Only when the variable is actually set: writing it unconditionally would
  // export a cap to every child process of every test run that never had one.
  if (process.env["VITEST_MAX_WORKERS"] !== undefined) {
    process.env["VITEST_MAX_WORKERS"] = String(resolved);
  }
  return resolved;
}

export const SHARED_MACHINE_TEST_WORKERS = {
  maxWorkers: resolveMaxWorkers(),
  minWorkers: 1,
} as const;

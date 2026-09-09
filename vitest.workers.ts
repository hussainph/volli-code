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
 * Two overrides stay open, and CI takes the second:
 *
 * - `--maxWorkers <n>` on the command line.
 * - `VITEST_MAX_WORKERS` in the environment, which vitest applies AFTER config
 *   resolution and which therefore beats both this value and the flag. That is
 *   the vitest entry of the Session concurrency budget
 *   (`apps/desktop/src/main/session-concurrency.ts`): a Session on a busy
 *   machine drops BELOW two without any config here knowing about it, and CI —
 *   which has the box to itself — raises it back to the core count in
 *   `.github/workflows/ci.yml`.
 */
export const SHARED_MACHINE_TEST_WORKERS = {
  maxWorkers: 2,
  minWorkers: 1,
} as const;

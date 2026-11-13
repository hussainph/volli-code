/**
 * Two environment-only seams that let a smoke take a small profile through a
 * large one's launch (VC-1203): the database check off main, the app's window
 * opened on the check's page, and the app loaded into that same window. Every
 * smoke profile is far under the size that sends the check off main, and a
 * small check answers long before the window's 400 ms, so without them no
 * lane would ever take that path.
 *
 * Neither changes what is checked. One moves the size from which the check
 * runs in the worker; the other holds the launch, after the worker has
 * answered, until the smoke releases it from main. Both are inert unless set,
 * in the style of `VOLLI_SKIP_CLOSE_CONFIRM`.
 */

/** The size, in bytes, from which the check runs off main; `0` sends every existing file. */
export const SMOKE_DATABASE_CHECK_OFF_MAIN_BYTES_ENV = "VOLLI_SMOKE_DATABASE_CHECK_OFF_MAIN_BYTES";

/** `1` holds the launch after the check answers, until the smoke releases it. */
export const SMOKE_HOLD_DATABASE_CHECK_ENV = "VOLLI_SMOKE_HOLD_DATABASE_CHECK";

/** What a held launch exposes on main's global object for the smoke to call. */
export interface DatabaseCheckSmokeGlobal {
  volliSmokeReleaseDatabaseCheck?: () => void;
}

/** The smoke's off-main size, or `undefined` (the shipped default) unless set to a whole number. */
export function smokeDatabaseCheckOffMainBytes(env: NodeJS.ProcessEnv): number | undefined {
  const value = env[SMOKE_DATABASE_CHECK_OFF_MAIN_BYTES_ENV];
  if (value === undefined || !/^\d+$/.test(value)) return undefined;
  return Number(value);
}

/**
 * Resolves at once unless the smoke asked for a hold; then it resolves when
 * the smoke calls `volliSmokeReleaseDatabaseCheck` on `target`, which is
 * removed again once called.
 */
export function holdDatabaseCheckForSmoke(
  env: NodeJS.ProcessEnv,
  target: DatabaseCheckSmokeGlobal = globalThis as DatabaseCheckSmokeGlobal,
): Promise<void> {
  if (env[SMOKE_HOLD_DATABASE_CHECK_ENV] !== "1") return Promise.resolve();
  return new Promise((resolve) => {
    target.volliSmokeReleaseDatabaseCheck = () => {
      delete target.volliSmokeReleaseDatabaseCheck;
      resolve();
    };
  });
}

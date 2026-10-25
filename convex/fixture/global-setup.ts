/**
 * Vitest global setup for `test:backend`: one pinned backend for the run, the
 * test issuer trusted, `functions/` pushed. The connection reaches test workers
 * through the same environment `with-backend.ts --deploy` sets, so
 * `connectBackend()` from `fixture/testing.ts` works under either.
 */

import { assertConvexNpmPinned, deployForTests, startBackend } from "./backend.ts";
import { TEST_GITHUB_ENV } from "./github.ts";
import { createTestIssuer } from "./jwt.ts";

export default async function setup(): Promise<() => Promise<void>> {
  assertConvexNpmPinned();
  const backend = await startBackend({ log: (line) => console.error(`[convex-fixture] ${line}`) });
  try {
    Object.assign(process.env, await deployForTests(backend, createTestIssuer(), TEST_GITHUB_ENV));
  } catch (error) {
    await backend.stop();
    throw error;
  }
  return () => backend.stop();
}

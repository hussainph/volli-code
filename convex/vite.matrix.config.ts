import "vite-plus/test/config";
import { defineConfig } from "vite-plus";

import { SHARED_MACHINE_TEST_WORKERS } from "../vitest.workers";

// The move engine's kill/resume matrix (`test/*.matrix.test.ts`): under
// `convex-test` like the unit suite, but too long for the PR lane. ci-extended's
// `Move to Volli Cloud` job runs it.
export default defineConfig({
  test: {
    ...SHARED_MACHINE_TEST_WORKERS,
    include: ["test/**/*.matrix.test.ts"],
  },
});

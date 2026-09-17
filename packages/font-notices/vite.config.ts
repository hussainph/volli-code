import "vite-plus/test/config";
import { defineConfig } from "vite-plus";

import { SHARED_MACHINE_TEST_WORKERS } from "../../vitest.workers";

// Coverage gate only — discovery and environment stay on vitest defaults, so
// `vp test run` behaves as it would with no config at all.
//
// `src/` is pure domain code with no Node imports (CLAUDE.md's convention for
// this package shape), so it is held at 100% rather than letting an untested
// branch of a RELEASE COMPLIANCE surface land quietly. `bin/` and
// `check-dist.mjs` are the Node-side build gate: they are covered by
// `check-dist.test.mjs` but excluded from the threshold, because a CLI's
// argv/exit plumbing is not domain logic.
export default defineConfig({
  test: {
    // One `vp test` invocation's share of a shared machine (VC-339).
    ...SHARED_MACHINE_TEST_WORKERS,
    coverage: {
      include: ["src/**"],
      thresholds: { statements: 100, branches: 100, functions: 100, lines: 100 },
    },
  },
});

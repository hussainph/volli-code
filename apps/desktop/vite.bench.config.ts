import "vite-plus/test/config";
import { defineConfig } from "vite-plus";

// VC-353's fixture integration test creates tens of thousands of durable rows
// more than once to prove byte-for-byte determinism. Keep that intentional
// benchmark cost out of the default unit/coverage lane and run the files in
// isolation so shared-machine load does not make their timing budget flaky.
export default defineConfig({
  test: {
    include: ["e2e/bench/performance/*.test.mjs"],
    testTimeout: 600_000,
    hookTimeout: 600_000,
    fileParallelism: false,
    maxWorkers: 1,
    minWorkers: 1,
  },
});

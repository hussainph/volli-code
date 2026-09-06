import "vite-plus/test/config";
import { defineConfig } from "vite-plus";

// The VC-245 live batch-rate lane talks to a real provider through the
// developer's own Pi credentials and spends money, so it gets no coverage gate
// and never runs by default — the test body is skipped unless PI_LIVE_BENCH=1.
export default defineConfig({
  test: {
    include: ["bench/**/*.live.test.ts"],
    testTimeout: 1_800_000,
    fileParallelism: false,
    maxWorkers: 1,
    minWorkers: 1,
  },
});

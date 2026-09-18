import "vite-plus/test/config";
import { defineConfig } from "vite-plus";

// The VC-245 bench sleeps for real time to measure a scheduler, so it is out
// of the default lane. It reaches no provider and no network, so unlike the
// live smoke it costs nothing and is safe to run anywhere.
export default defineConfig({
  test: {
    include: ["bench/**/*.bench.test.ts"],
    testTimeout: 600_000,
    // Timing measurements do not survive being run beside each other. This is
    // deliberately one worker even when VOLLI_CONCURRENCY_HINT is higher: the
    // benchmark measures runtime work rather than throughput under test load.
    fileParallelism: false,
    maxWorkers: 1,
    minWorkers: 1,
  },
});

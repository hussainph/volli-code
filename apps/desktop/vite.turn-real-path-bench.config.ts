import "vite-plus/test/config";
import { defineConfig } from "vite-plus";

// VC-456's real-path turn bench drives the Session runtime, the Pi adapter and
// agent loop, the authority gate and a disposable SQLite profile for minutes of
// real time, so it stays out of the default unit and coverage lanes. It reaches
// no provider and no network. One worker, no file parallelism: timing waves
// must not run beside each other.
export default defineConfig({
  test: {
    include: ["e2e/bench/turn-real-path/*.bench.test.ts"],
    environment: "node",
    testTimeout: 1_800_000,
    hookTimeout: 120_000,
    fileParallelism: false,
    maxWorkers: 1,
  },
});

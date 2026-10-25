import "vite-plus/test/config";
import { defineConfig } from "vite-plus";

// Integration tests against ONE real pinned local backend, started by the
// global setup for the whole run and stopped after it. Files share that
// backend, so each test uses its own user/ids rather than a clean database.
export default defineConfig({
  test: {
    include: ["test/**/*.backend.test.ts"],
    globalSetup: ["fixture/global-setup.ts"],
    maxWorkers: 1,
    // A first exec of the ~190 MB binary can take seconds on macOS.
    hookTimeout: 60_000,
  },
});

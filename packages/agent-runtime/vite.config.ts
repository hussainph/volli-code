import "vite-plus/test/config";
import { defineConfig } from "vite-plus";

// `smoke/` holds the manual live-model test and must never run by default, so
// discovery is pinned to src. Thresholds only evaluate under `--coverage`.
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    setupFiles: ["./vitest.setup.ts"],
    coverage: {
      include: ["src/**/*.ts"],
      thresholds: { statements: 100, branches: 100, functions: 100, lines: 100 },
    },
  },
});

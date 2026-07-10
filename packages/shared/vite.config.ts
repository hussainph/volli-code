import "vite-plus/test/config";
import { defineConfig } from "vite-plus";

// This config exists solely for the coverage gate — test discovery and
// environment stay on vitest defaults, so the plain `vp test run` script
// behaves exactly as it did without a config file. Thresholds only evaluate
// under `--coverage` (the `test:coverage` script / CI).
export default defineConfig({
  test: {
    coverage: {
      include: ["src/**"],
      // The whole package is pure, unit-tested domain code (CLAUDE.md
      // convention) — hold the line at 100 rather than letting new untested
      // modules erode it silently.
      thresholds: { statements: 100, branches: 100, functions: 100, lines: 100 },
    },
  },
});

import "vite-plus/test/config";
import { defineConfig } from "vite-plus";

// Astro owns the site build (astro.config.mjs); this config exists solely so
// `vp test run` covers src/lib — the pure, unit-tested release-feed logic
// behind the download page. Thresholds only evaluate under `--coverage`.
export default defineConfig({
  test: {
    environment: "node",
    coverage: {
      include: ["src/lib/**"],
      // src/lib is pure domain code (same convention as @volli/shared) —
      // hold it at 100 rather than letting untested branches erode it.
      thresholds: { statements: 100, branches: 100, functions: 100, lines: 100 },
    },
  },
});

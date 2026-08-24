import "vite-plus/test/config";
import { defineConfig } from "vite-plus";

export default defineConfig({
  test: {
    coverage: {
      // The gate travelled here with the modules from apps/desktop's vite
      // config (VC-169) and keeps its bar: these files are the pure logic
      // layer of the Session Presentation Contract, at 100% since they were
      // extracted. client.ts and registry.ts followed in slice 2, with the
      // session-slice write-model and the surface store cut out beside them.
      // context-usage.ts and composer-stack.ts were outside the desktop gate
      // and stay outside; index.ts is re-exports only.
      include: [
        "src/activity.ts",
        "src/client.ts",
        "src/compaction-boundary.ts",
        "src/composer-effort.ts",
        "src/interaction.ts",
        "src/markdown-source.ts",
        "src/message-projection.ts",
        "src/registry.ts",
        "src/session-model.ts",
        "src/session-slice.ts",
        "src/surface-store.ts",
        "src/transcript.ts",
        "src/wire.ts",
      ],
      thresholds: { statements: 100, branches: 100, functions: 100, lines: 100 },
    },
  },
});

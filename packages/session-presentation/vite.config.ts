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
        // The Activity Island's projection contract and grammar (VC-256): when
        // there is an island at all, which clusters it draws, and the two
        // registers every announcement keeps apart. Pure precisely so the gate
        // can reach the empty rule — a pill drawn over the composer with
        // nothing to say is the failure that rule exists to refuse.
        "src/activity-island.ts",
        "src/client.ts",
        "src/compaction-boundary.ts",
        "src/composer-effort.ts",
        "src/interaction.ts",
        "src/markdown-source.ts",
        "src/message-projection.ts",
        "src/registry.ts",
        "src/session-model.ts",
        "src/session-slice.ts",
        "src/session-source.ts",
        "src/surface-store.ts",
        // What a CLOSED terminal's saved record says, and which controls it
        // makes meaningful (VC-290). In the gate because every branch here is a
        // refusal to guess: an exit nobody observed must not read as success, a
        // deleted ticket must not read as a project session, and a scope that
        // no longer exists must offer no recreation. A missed branch is a
        // confident sentence about a Session nothing actually observed.
        "src/terminal-history.ts",
        "src/transcript.ts",
        "src/wire.ts",
      ],
      thresholds: { statements: 100, branches: 100, functions: 100, lines: 100 },
    },
  },
});

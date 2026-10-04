import "vite-plus/test/config";
import { defineConfig } from "vite-plus";

import { SHARED_MACHINE_TEST_WORKERS } from "../../vitest.workers";

export default defineConfig({
  test: {
    // One `vp test` invocation's share of a shared machine (VC-339).
    ...SHARED_MACHINE_TEST_WORKERS,
    // Plain Node: this package runs in the Linux host lane, never in Electron.
    environment: "node",
    coverage: {
      // The protected surface moved here from apps/desktop's gate with the
      // modules it names, plus the composition entry. A module whose covering
      // test still needs desktop code (db/export.ts) stays enrolled in
      // apps/desktop/vite.config.ts until that test can move.
      include: [
        "src/index.ts",
        // The Session concurrency budget (VC-339). In the gate because every
        // branch of it is a rule about a machine nobody watches: a miscount
        // hands one Session the whole box while three others build, and a
        // missed no-clobber branch overwrites what a person put in their own
        // login shell. Neither is visible anywhere until the laptop swaps.
        "src/session-concurrency.ts",
        "src/session-control/activity-watch.ts",
        // The turn boundary that decides unread (VC-30), beside the watch it
        // decorates: main is the only process that knows both that a turn ended
        // and whether anyone was looking, so every branch of this is one nobody
        // else can check. The peek's fold rides here too — it is the whole of
        // what a card is allowed to say about a Session it never adopted.
        "src/session-control/session-read-watch.ts",
        "src/session-control/peek-content.ts",
        // The orphan process sweep's ledger storage (VC-341): a row it hands
        // back wrong is what the decision to signal a process is made from.
        "src/db/spawn-ledger-repo.ts",
        "src/db/theme-repo.ts",
        // Where "unread" is written down (VC-30): a receipt read or written
        // wrong is work a person never sees they have, and nothing on screen
        // says the dot was the part that was broken.
        "src/db/session-read-repo.ts",
      ],
      thresholds: { statements: 100, branches: 100, functions: 100, lines: 100 },
    },
  },
});

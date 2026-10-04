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
        // The per-repository ordering of worktree CHANGES (VC-389). Enrolled
        // for the reason the process modules above are: it is a concurrency
        // guard, so its branches are the ones no screenshot and no manual pass
        // can show. An uncovered branch here is a `worktree add` and a
        // `worktree prune` nobody watched decide whether to run against one
        // repository at the same time, which is a race git's own documentation
        // names. Its sibling `worktree/git.ts` is deliberately NOT enrolled:
        // one defensive fallback in it (a child-process failure carrying no
        // `message`) is not reachable from a test without exporting an
        // internal purely to satisfy the gate, and a contrived test is worth
        // less than an honest gap.
        "src/worktree/repository-turn.ts",
        // The ports every moved service asks its host through (VC-554), and
        // what a headless host answers with: a refusal that reads wrong is
        // what a person on a server sees instead of their link opening.
        "src/ports/*.ts",
        // The Session concurrency budget (VC-339). In the gate because every
        // branch of it is a rule about a machine nobody watches: a miscount
        // hands one Session the whole box while three others build, and a
        // missed no-clobber branch overwrites what a person put in their own
        // login shell. Neither is visible anywhere until the laptop swaps.
        "src/session-concurrency.ts",
        "src/session-runtime/boot-recovery.ts",
        "src/session-runtime/sessions.ts",
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
        // The downgrade guard (VC-602): a branch read wrong either opens a
        // database this build cannot use or locks a person out of their own.
        "src/db/schema-compatibility.ts",
        // The headless secret key (VC-559), beside its port under src/ports:
        // every branch is a refusal that stands between a person's credentials
        // and another user, a lost key or a silent re-key, and none of it shows
        // anywhere until it is wrong.
        "src/secrets/file-key.ts",
      ],
      thresholds: { statements: 100, branches: 100, functions: 100, lines: 100 },
    },
  },
});

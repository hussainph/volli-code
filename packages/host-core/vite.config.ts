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
      // The protected surface moved here from apps/desktop's gate with its
      // covering tests, plus the composition entry. project-roots.ts remains
      // in desktop's gate until this package covers every registry branch.
      include: [
        "src/index.ts",
        // One lifecycle, its maintenance loops and detached-work join (VC-627).
        "src/host-lifecycle.ts",
        "src/host-shutdown.ts",
        "src/maintenance-services.ts",
        "src/detached-work.ts",
        "src/automation-services.ts",
        "src/agent-services.ts",
        // The host's one handler map and the socket's projection of it
        // (VC-668): every door reaches a command through these, so a branch
        // nobody drove is a door that behaves differently from the others.
        "src/handlers/host-handlers.ts",
        // The Board module (VC-565): its commands, receipts, feed and resources.
        "src/board/*.ts",
        // Its one invocation path and the catalog doors' policies: a branch
        // nobody drove is a way to a handler no policy judged.
        "src/handlers/handler-map.ts",
        "src/handlers/policies.ts",
        "src/agent-dispatch/projection.ts",
        // File/blob/template services moved with their tests at unchanged 100% (VC-557).
        "src/blob-attach.ts",
        "src/blob-collect.ts",
        "src/blob-protocol.ts",
        "src/turn-attachments.ts",
        "src/prompt-templates.ts",
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
        // Relinking a project to the folder it moved to (VC-430). In the gate
        // because every branch of it is a rule about a filesystem nobody is
        // watching: the refusal that stops two projects tracking one checkout,
        // and the container move that keeps a renamed project's worktrees
        // inside the set this database recognises as its own. Both are silent
        // when wrong — one duplicates a project, the other strands checkouts
        // that no cleanup surface will ever list again.
        "src/project-relink.ts",
        // Registering a folder as a project (VC-623), lifted out of desktop's
        // IPC handler so the operator's `volli project add` on a headless host
        // applies the same rules. A branch wrong here is a second project for
        // one folder, or two projects sharing one ticket prefix.
        "src/project-create.ts",
        // The ports every moved service asks its host through (VC-554), and
        // what a headless host answers with: a refusal that reads wrong is
        // what a person on a server sees instead of their link opening.
        "src/ports/*.ts",
        // The structured log (VC-699): its redaction is a merge gate, and a
        // branch nobody drove is a field that reaches a line unredacted or a
        // line that loses its trace. The file sink's disk-failure callbacks
        // stay out, for the reason `worktree/git.ts` does.
        "src/log/logger.ts",
        "src/log/context.ts",
        "src/log/root.ts",
        "src/log/sinks.ts",
        "src/log/ring.ts",
        "src/log/steps.ts",
        "src/log/correlation.ts",
        "src/session-runtime/correlated-executor.ts",
        // The Session concurrency budget (VC-339). In the gate because every
        // branch of it is a rule about a machine nobody watches: a miscount
        // hands one Session the whole box while three others build, and a
        // missed no-clobber branch overwrites what a person put in their own
        // login shell. Neither is visible anywhere until the laptop swaps.
        "src/session-concurrency.ts",
        "src/session-runtime/boot-recovery.ts",
        // Recovery-before-consumers and a single drain are now executable port
        // contracts, replacing desktop's source scans (VC-622).
        "src/session-runtime/lifecycle.ts",
        "src/session-runtime/facade.ts",
        "src/session-runtime/agents.ts",
        "src/session-runtime/context.ts",
        // The automation assembly over the ready Session facade (VC-622). Every
        // branch is a decision made once at boot on a machine nobody watches:
        // which degraded capability drops which port, and the two failures a
        // timer fires into an unattended log. A branch read wrong is a
        // scheduler that silently never starts, or a recovery error that
        // reaches no one.
        "src/session-runtime/automations.ts",
        "src/session-control/suspend-clock.ts",
        // Birth-frozen membership must never name an absent host capability (VC-622).
        "src/session-runtime/host-capabilities.ts",
        "src/session-runtime/sessions.ts",
        "src/session-control/activity-watch.ts",
        // The turn boundary that decides unread (VC-30), beside the watch it
        // decorates: main is the only process that knows both that a turn ended
        // and whether anyone was looking, so every branch of this is one nobody
        // else can check. The peek's fold rides here too — it is the whole of
        // what a card is allowed to say about a Session it never adopted.
        "src/session-control/session-read-watch.ts",
        // The synchronous live-work read a desktop quit decides on (VC-577).
        "src/session-control/live-work.ts",
        "src/session-control/peek-content.ts",
        // The orphan process sweep's ledger storage (VC-341): a row it hands
        // back wrong is what the decision to signal a process is made from.
        "src/db/spawn-ledger-repo.ts",
        "src/db/theme-repo.ts",
        // The export's table/column envelope stays at the same 100% bar as
        // desktop's gate, now proved here beside the ledgers it exports.
        "src/db/export.ts",
        // Where "unread" is written down (VC-30): a receipt read or written
        // wrong is work a person never sees they have, and nothing on screen
        // says the dot was the part that was broken.
        "src/db/session-read-repo.ts",
        // The downgrade guard (VC-602): a branch read wrong either opens a
        // database this build cannot use or locks a person out of their own.
        "src/db/schema-compatibility.ts",
        // The applied-migration history and the free-space preflight before a
        // migration's safety copy (VC-633): every branch is a decision made
        // once, at an upgrade nobody watches, about a file nobody can redo.
        "src/db/migration-history.ts",
        "src/db/disk-preflight.ts",
        // The headless secret key (VC-559), beside its port under src/ports:
        // every branch is a refusal that stands between a person's credentials
        // and another user, a lost key or a silent re-key, and none of it shows
        // anywhere until it is wrong.
        "src/secrets/file-key.ts",
        // Credential status (VC-641): which key failures lock credentials,
        // which refuse an unsafe key, and the reset that sets a sealed file
        // aside rather than deleting it. A branch read wrong here bricks a
        // host or overwrites what a lost key still opens.
        "src/secrets/credential-state.ts",
        // The typed sealed credential module (VC-642): the lock every process
        // sharing a store takes, the durable write that never tears or
        // overwrites a file it did not authenticate, the key-id format and the
        // typed inventory. A branch wrong here is a lost revocation, a torn
        // store, or a save sealed over credentials a lost key still opens.
        "src/secrets/credential-lock.ts",
        "src/secrets/credential-wait.ts",
        "src/secrets/durable-file.ts",
        "src/secrets/sealed-document.ts",
        "src/secrets/credential-key-id.ts",
        "src/secrets/credential-families.ts",
        "src/secrets/sealed-envelope.ts",
        "src/secrets/inventory.ts",
        // The Session-secrets store, now on the module above (VC-642): every
        // branch decides whether a revoked secret is injected, a value is
        // scrubbed, or a locked store is sealed over.
        "src/secrets/store.ts",
        // Step E for the web search keys (VC-643): desktop's keychain-wrapped
        // keyring, the sealed mirror reconciled from `secrets`, and the
        // migration that counts every write to it. A branch wrong here is a
        // cleared key kept in the mirror, a save reported sealed that is not,
        // or a key made over credentials a locked keychain still opens.
        "src/secrets/keychain-keyring.ts",
        "src/web/credential-mirror.ts",
        "src/db/web-credential-migration.ts",
        // The terminal supervisor's process-tree signalling (moved from
        // desktop's gate with its test, VC-560), and the output pipeline that
        // carries the stream contract's flow control and attach resync: a
        // branch wrong here is a frozen shell or a client that never resumes.
        "src/pty/park.ts",
        "src/pty/output.ts",
        // The orphan process sweep (VC-341, moved with its tests in VC-618).
        // Every branch decides whether to signal a stranger's process; the
        // ledger's storage above is held to the same unchanged 100% bar.
        "src/process/**",
        // The agent-observability export boundary (VC-119, moved from desktop's
        // gate with its tests in VC-622). The mapping module is the ONLY place
        // Volli's metadata-only vocabulary becomes somebody else's attribute
        // names, and the sink is the bound that stops a collector from reaching
        // a turn — both are enrolled for the same reason the IPC handlers are:
        // a missed branch is a privacy or a liveness failure, not a cosmetic
        // one. `otlp.ts` stays outside, as it was in desktop's gate: it is
        // transport bootstrap around an SDK.
        "src/observability/genai.ts",
        "src/observability/settings.ts",
        "src/observability/sink.ts",
      ],
      thresholds: { statements: 100, branches: 100, functions: 100, lines: 100 },
    },
  },
});

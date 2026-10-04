# @volli/host-core

The host's services, composed without Electron. Volli Cloud
([ruling](../../docs/plans/volli-cloud.md)) runs one host program everywhere:
Electron main today, `apps/hostd` next. Both call `createHostCore` and wire
what it returns. Electron main keeps only window-only work.

```ts
import { createHostCore, throwTransactionViolation, type HostCorePorts } from "@volli/host-core";

// The host supplies its event bus, attention delivery, power, connectivity,
// optional client capabilities and runtime readers (see "Ports" below).
declare const ports: HostCorePorts;

const host = createHostCore(
  ports, // what host-core asks of its process
  {
    // options: how this host behaves
    dataDir: "/var/lib/volli",
    onTransactionViolation: throwTransactionViolation,
    devDiagnostics: false,
  },
);
if (!host.database.ok) console.error(host.database.error);
```

## Rules

- **No `electron`, directly or through a relative import.**
  `node scripts/check-host-electron-imports.mjs` gates every `packages/*`.
- **Node only, and it runs on Linux.** `Test (packages)` runs this package's
  `test:coverage` under plain Node in CI's Linux host lane.
- **Ports in, services out.** `createHostCore(ports, options)` returns
  services. It never reaches for a global the host owns.
  - **Options** are policy: data directory, overrides, handler choices. Policy
    has no defaults; every host states it. `userData` is the `dataDir`
    option, and `app.isPackaged` decisions are options.
  - **Ports** are what host-core asks its process to do. They are listed under
    [Ports](#ports). Desktop passes Electron-backed adapters; `hostd` passes
    its own.
- **Composition stays thin in the host.** `apps/desktop/src/main/index.ts`
  resolves Electron facts (`app.getPath("userData")`, `app.isPackaged`,
  `VOLLI_DB_PATH` in dev), calls `createHostCore`, and wires the result
  exactly as it wired the inline construction before.

## What is here

| Path                     | Exports                                                                                                                     | Moved in |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------- | -------- |
| `src/index.ts`           | `createHostCore`, `defaultDatabasePath`, `DbHandle`, the guard handlers                                                     | VC-553   |
| `src/db/`                | `@volli/host-core/db` (`openVolliDb`), `@volli/host-core/db/<file>` (migrations, repos, `transaction-gate`, `test-helpers`) | VC-553   |
| `src/db-open-failure.ts` | (internal) classifies a failed open for its reader                                                                          | VC-553   |
| `src/ports/`             | `@volli/host-core/ports`: the event bus, attention delivery, power and client-capability ports, with their headless answers | VC-554   |
| `scripts/`               | `pnpm --filter @volli/host-core migrations:lock`                                                                            | VC-553   |

VC-612 adds `src/session-control/` (`@volli/host-core/session-control` and
`@volli/host-core/session-control/*`), `src/session-wake.ts`,
`src/session-concurrency.ts` and the outbox/resumption adapters under
`src/session-runtime/` (`@volli/host-core/session-runtime/*`).

## Ports

A port is what host-core asks of the process hosting it. Each port lives in
`src/ports/` (`@volli/host-core/ports`, re-exported from the root). Desktop's
Electron adapter does exactly what desktop did before the port existed.

| Port (`HostCorePorts`)                             | Asks for                                                                                          | Desktop adapter                                                                                    | Headless host passes                                                                |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `events: HostEventBus`                             | Announce a fact to every client: `publish(topic, payload)`, topics in `HostEventMap`              | `windowEventBus` (`main/broadcast.ts`): `volli:<topic>` to every live window                       | Its protocol's broadcast                                                            |
| `attention`                                        | Raise an alert with a person (`deliver`), and which Sessions a focused client shows               | `notifications/runtime.ts`: native notification, preferences, focused-target suppression           | `HEADLESS_ATTENTION`: every alert `unsupported`, nothing focused                    |
| `power: PowerPort`                                 | Sleep and wake (`suspend`, `resume`, `unlock-screen`, `user-did-become-active`)                   | Electron's `powerMonitor` itself                                                                   | `NO_POWER_EVENTS`                                                                   |
| `connectivity`                                     | The network, for retry policy. This is `ConnectivityPort` from `@volli/agent-runtime`, not a copy | `createConnectivityPort({ net, powerMonitor })`                                                    | `ALWAYS_ONLINE` from `@volli/agent-runtime`                                         |
| `client?`                                          | Open a link, reveal a file, the clipboard, menus (`ClientCapabilityPort`)                         | `createElectronClientCapabilities()` (`main/client-capabilities.ts`): `shell`, `clipboard`, `Menu` | Nothing. `host.client` refuses each request with `ClientCapabilityUnavailableError` |
| `log`                                              | Errors and warnings                                                                               | `console`                                                                                          | Its logger                                                                          |
| `listOpenNativeBindings`, `observeScheduledResume` | The live runtime's bindings and the scheduled-resume host, bound after the runtime exists         | Late-bound closures in `index.ts`                                                                  | Its runtime's                                                                       |

**How a moved service asks for a port.** Its `create<Cluster>(ports, options)`
takes only the ports it uses, as a `Pick<HostCorePorts, …>`.
`createHostCore` hands them over. A service never imports an adapter, and
never reaches for `BrowserWindow`, `powerMonitor` or `shell`.

- **Announcing something.** Add the topic to `HostEventMap`, with its payload
  type in `@volli/shared` (`host-events.ts`). Add its channel to
  `windowEventBus` in desktop's `broadcast.ts`; the mapped type fails to
  compile until you do. Desktop code that has not moved yet keeps calling the
  `broadcastX` functions, which publish through the same bus.
- **One client's stream** (a watched worktree, terminal output, a file
  watch) is not a broadcast. The first move that needs one (VC-556, VC-557 or
  VC-560) adds an addressed sink beside the bus, over the same topic map.
- **Alerts** go through `ports.attention.deliver`. A background observer
  ignores the outcome; a person's own request reports it.
- **Client work** goes through `clientCapabilities(ports.client)`, or
  `host.client`. Never test whether a client is present. With no client,
  `openExternal`, the clipboard and `showMenu` reject, and `revealInFolder`
  throws, a `ClientCapabilityUnavailableError`. It carries `capability` and a
  message a person can read ("Opening a link needs the Volli desktop app, and
  this host is running without one."). Let it reach the caller as a refusal;
  `isClientCapabilityUnavailable` tells it apart from a real failure.

Window-only work stays in desktop and never becomes a port: the OS
appearance broadcast, the updater state, notification Settings pushes,
Ghostty appearance (`ghostty-config.ts`), the application menu, dialogs and
pickers.

### Session composition

`createHostCore` returns `sessionLedger`, `hostNoticeOutbox`, `sessionWakeBus`,
`sessionReadWatch`, `sessionActivityWatch` and `sessionEngine`. They are all
`null` when the database is degraded. The outbox shares the engine's one
transaction writer. The wake bus decorates the engine inside the activity
watch: committed facts fan out before a listing row becomes dirty. Resumption
history, unattended Run notifications and read receipts observe in their
original order, before the row is built.

`HostCorePorts` extends `HostSessionPorts`, which holds the ports Session
composition uses: `events`, `attention`, `log`, `listOpenNativeBindings` and
`observeScheduledResume`. Its adapters are captured, not called during
construction, so desktop can bind notifications and the runtime
after the database is known. Desktop wires `onFocusedSessionsChanged` to the
returned read watch, and supplies the runtime-dependent scheduled-resume
observer after the runtime exists. `createDesktopSessionEngine` retains its
name for existing callers but is now the single engine construction site in
host-core; host composition passes the shared ledger into it.

Coverage entries for the activity/read/peek watches and concurrency budget
move with their tests at the unchanged 100% thresholds. `db/export.ts` remains
in desktop's gate: its test still composes the desktop delegation store. The
cross-ledger transaction test and full host-notice integration test also stay
in desktop until their remaining desktop dependencies move.

### Persistence

- **Database.** `createHostCore` opens `<dataDir>/volli.db` (or
  `options.databasePath`), creating the directory and running migrations. A
  failed open does not throw. It is classified once, logged through
  `ports.log`, and returned as `{ ok: false, error }`. A host keeps serving in
  degraded mode.
- **Migrations.** Shipped migrations are frozen in
  `src/db/migrations.lock.json`. Append a migration, then run
  `pnpm --filter @volli/host-core migrations:lock`. See
  [BOUNDARIES](../../docs/BOUNDARIES.md#shipped-sqlite-migrations).
- **Transaction ownership (VC-551).** No transaction spans an `await`. Use
  `withTransaction` / `settleTransaction` from `db/transaction-gate`.
  `openVolliDb` installs the ownership guard after migrations, with the handler
  the host passed as `onTransactionViolation`:
  - Desktop passes `throwTransactionViolation` in dev and tests, and
    `logTransactionViolation` when `app.isPackaged`.
  - **A headless host passes `throwTransactionViolation`.** Nobody is watching
    its log while a bug corrupts a transaction.
  - Tests use `openTestDb()` from `@volli/host-core/db/test-helpers`, which
    installs the throwing handler.
- **The boot-window rule.** Before the guard is installed, migrations and open
  checks run on the raw handle. No statement handle created in that window
  may outlive boot. When the guard installs, it wraps the statements already
  in the `prepared` cache. Any other early statement would escape it.
- **Native module.** `better-sqlite3` 13 is N-API and loads its bundled
  prebuild under both Node and Electron, with no rebuild step. Desktop keeps
  its own `better-sqlite3` dependency. `@volli/*` packages are bundled into
  `dist-electron/main.cjs` (`apps/desktop/vite.config.ts`, `alwaysBundle`), so
  host-core's `require("better-sqlite3")` resolves against the package
  electron-builder ships with the app. A new native or path-reading
  dependency here must also be a desktop dependency, whitelisted for
  packaging. `verify-packed-requires.mjs` fails the build otherwise.

## Moving a service cluster in

This is the pattern for every later move (VC-554 onward). A move is a **pure
move**: no behavior change, no migration, and the app is identical with the
`cloud` flag off.

1. **Measure the cluster's edges.** List every import that leaves it.
   - Everything it imports must already be in host-core, `@volli/shared`
     or `@volli/session-engine`.
   - Otherwise the import becomes a port, an option, or a type moved to
     `@volli/shared`. For example, `FirstPaintHint` moved out of the IPC
     contract, and `contract.ts` re-exports it.
   - Never import from `apps/*`.
   - Past roughly 1,500 changed lines (renames excluded), split at a
     service boundary and file the rest as a follow-up ticket.
2. **`git mv` the files** to `src/<cluster>/`, keeping file names. Change only
   import paths; don't restyle. `git diff -M --stat origin/main...HEAD`
   should read as renames, so that open PRs touching the old paths can
   re-sync.
3. **Export the cluster** as `./<cluster>` and `./<cluster>/*` in
   `package.json`, then rewrite importers mechanically: `./<cluster>/x`
   becomes `@volli/host-core/<cluster>/x`. Leave no re-export shims at the
   old paths. A shim turns the rename into an add.
4. **Move construction.** The cluster's construction leaves the
   `app.whenReady` closure for `createHostCore`, or for a
   `create<Cluster>(ports, options)` that `createHostCore` calls, and appears
   on `HostCore`.
   - Electron facts become options.
   - Calls back into Electron become ports.
   - `index.ts` passes them and wires the result where the inline value used
     to go, in the same order.
5. **Tests move with the code.**
   - A test whose imports all land in host-core moves with `git mv`.
   - A test that still composes desktop modules stays in desktop at its old
     path and imports from `@volli/host-core`. It moves in the ticket that
     moves its last desktop dependency. Examples: `apps/desktop/src/main/db/*.test.ts`
     and `transaction-gate-ledgers.test.ts`.
6. **Coverage moves with the test.** A protected entry in
   `apps/desktop/vite.config.ts` moves to this package's `vite.config.ts`
   when host-core's own tests hold it at 100%. Check that with
   `vp test run <test> --coverage --coverage.include=<file>`. If its test
   must stay in desktop, re-point the desktop entry to
   `**/packages/host-core/src/<path>`, as `db/export.ts` is.
7. **Fix every path reference.** `rg` the old directory across:
   - e2e and bench scripts (`ssrLoadModule("/apps/desktop/src/main/...")`, `load("src/main/...")`);
   - `apps/desktop/scripts`;
   - docs (`BOUNDARIES.md`, `CLAUDE.md`/`AGENTS.md`, the cloud plans).
8. **Lockfile.** A new dependency here uses the same specifier desktop
   already resolves. The `pnpm-lock.yaml` diff is importer entries only, with
   no version changes.
9. **Prove it.**
   - `node scripts/check-host-electron-imports.mjs`;
   - `vp run --filter @volli/host-core typecheck` and the desktop typecheck;
   - the moved test files locally;
   - in CI: `Test (packages)` (Linux), the desktop shards and coverage,
     `Check + Build` (packaging, `verify-packed-requires`) and core e2e.

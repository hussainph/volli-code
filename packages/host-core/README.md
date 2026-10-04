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

| Path                     | Exports                                                                                                                                        | Moved in |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| `src/index.ts`           | `createHostCore`, `defaultDatabasePath`, `DbHandle`, the guard handlers                                                                        | VC-553   |
| `src/db/`                | `@volli/host-core/db` (`openVolliDb`), `@volli/host-core/db/<file>` (migrations, repos, `transaction-gate`, `test-helpers`)                    | VC-553   |
| `src/db-open-failure.ts` | `DbOpenFailure` (typed, on `HostCore.databaseFailure`); the sentence a failed open is answered with                                            | VC-553   |
| `src/ports/`             | `@volli/host-core/ports`: the event bus, attention delivery, power, client-capability, trash and secret-key ports, with their headless answers | VC-554   |
| `src/pty/`               | `@volli/host-core/pty/*`: the terminal supervisor and its stream contract ([Terminals](#terminals))                                            | VC-560   |
| `scripts/`               | `pnpm --filter @volli/host-core migrations:lock`                                                                                               | VC-553   |

VC-612 adds `src/session-control/` (`@volli/host-core/session-control` and
`@volli/host-core/session-control/*`), `src/session-control/session-wake.ts`,
`src/session-concurrency.ts` and the outbox/resumption adapters under
`src/session-runtime/` (`@volli/host-core/session-runtime/*`).

VC-557 adds the file services under `src/`, mirroring their former desktop
paths: `volli-fs.ts`, `file-search.ts`, `blob-{attach,collect,import,protocol}.ts`,
`turn-attachments.ts`, `prompt-templates.ts` and `skills.ts`. Their named subpath
exports are `@volli/host-core/<file>`. `createHostCore` composes `fileServices`
(the watch managers and client/trash adapters). The desktop IPC door is
`main/volli-fs-ipc.ts`; protocol registration, native external-app launch and
pickers also remain desktop-owned. The file-boundary tests run here against
real directories and symlinks; desktop IPC integration tests stay with the door.
Protected blob/template coverage moves with its tests at the same 100% gates.
`blob-store.ts` and `blob-materialize.ts` belong to VC-556, not this move.
VC-556 adds `src/worktree/` (`@volli/host-core/worktree` and
`@volli/host-core/worktree/*`), `worktree-runtime`, `project-base-branch`,
`project-relink`, `project-roots`, `blob-store`, `blob-materialize`,
`ticket-commands` and `credential-helper-diagnostics` at matching subpath
exports. `host.worktrees.deps(db)` captures the host's event bus and `dataDir`;
desktop callers not yet moved pass those same facts through `worktree-host.ts`.
`repository-turn.ts` is byte-identical: its per-process ordering has not changed.
Repository-turn and project-relink coverage run here at 100%, beside their
tests. The ensure test also runs here, including its host-core blob importer.
Project roots remain in desktop's 100% gate: host-core tests reach the registry,
but desktop's IPC/PTY tests still cover branches this package does not.

VC-559 adds `src/secrets/` (`@volli/host-core/secrets`): `SecretStore`, moved
from desktop, and the headless file-key adapter. The secret-key port it seals
through is `src/ports/secret-key.ts`.

VC-555 completes `src/session-runtime/` (`@volli/host-core/session-runtime`
and `/*`), and moves the agent runtime wiring, agent tools, Session environment
and tokens, Pi sidecar/tool-output cleanup, harness installation and login-shell
PATH helpers. `src/mcp/`, `src/codemode/`, `src/web/`, `src/decision/` and the
model sign-in service are exported as `@volli/host-core/<cluster>/*`;
`verb-input` is exported directly. IPC adapters and their integration tests,
Web Access's legacy `safeStorage` migration, and Pi tests that compose desktop
secret services stay in desktop.

VC-561 adds `src/browser/` (`@volli/host-core/browser/*`): the agent browser's
engine-agnostic half. `cdp-controller`, `snapshot-format`, `agent-coordinator`,
the picture and trace stores and their disks, and `trace-steps` moved
byte-identical; `agent-port` moved without its Electron wire. See
[Browser backend](#browser-backend).

`host.runtimeServices` holds staged constructors for model access, decisions,
MCP, Web Access and model sign-in. Desktop invokes them in its original boot
order, so legacy web keys migrate before any store reads them, and sign-in
keeps the same Pi collection as the runtime. Session locations take `events`
and `dataDir`, using that same event bus and user-data directory for worktree
materialization and publication; they never import desktop's broadcast adapter.
The retained
`createDesktop*` names are compatibility names, not Electron dependencies.

Code Mode's worker and `quickjs.wasm` paths still come from the host's injected
app/resources directories, never the moved module's directory. Desktop keeps
its packaging dependencies and `asarUnpack` entries. The moved sandbox test
copies the real packages into the flat unpacked layout and runs a program;
CI also checks both files in the unsigned packaged app before core e2e.

MCP credentials retain their standalone mode-0600 `mcp-credentials.json` file
and format. They do not use `SecretStore`; changing that storage would not be a
pure move. Pi's secret-wait publisher type is exported by `secrets`, and its
turn-attachment type lives in `session-runtime/turn-attachments`.

VC-558 (slice 1) adds `src/automations/`, `src/agent-dispatch/`,
`agent-commands`, `agent-tool-door`, `agent-socket`, `agent-watch`, `watches`,
`ticket-wake` and the Electron-free `harness-registry`, all at matching subpath
exports. Tests move with them except the Automation IPC and harness-runtime
integration tests, which still compose desktop modules.

`host.automations` stages engine, service, runner, armed-arrival and scheduler
construction in the original boot order. `host.agentServices` stages the verb
and tool doors and watches over the same event and attention ports. The scheduler
reads host facts and Node timers only; it never asks whether a window exists.
`createHostAgentSocket` (`@volli/host-core/agent-services`) composes the early
socket lifecycle before database boot. Its caller still supplies the unchanged
`<dataDir>/volli.sock` path; mode 0600, v1 NDJSON, request limits, shutdown drain
and the verb table are unchanged. Desktop retains `automations/ipc.ts` and the
socket's app-quit adapter (`agent-socket-quit.ts`); host-core never holds an app
lifecycle. Backup, recovery and maintenance remain for VC-618 (slice 2).

VC-560 adds `src/pty/` (`@volli/host-core/pty/*`): the terminal supervisor
(`manager.ts`, `PtyManager`), its output pipeline, warm park (`park.ts`,
`park-controller.ts`), launch scope, launch line and offered-command run. The
Electron IPC adapter (`apps/desktop/src/main/pty/ipc.ts`) stays in desktop and
constructs the supervisor; see [Terminals](#terminals). `park.ts` moves into
this gate with its test.

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
| `trash?`                                           | Move a host file to recoverable Trash (`TrashPort`)                                               | `(path) => shell.trashItem(path)`, unchanged                                                       | Nothing. Requests reject with `TrashUnavailableError`; never permanent deletion     |
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
  watch) is not a broadcast. `HostClientEventTopic` is excluded from
  `HostBroadcastEventTopic`, so the broadcast adapter cannot carry a
  subscription event by accident. `HostClientEventSink` (VC-556) uses the same topic
  map as the bus, with a stable connection-scoped `id`, `publish`, `isClosed`,
  `onceClosed` and `removeCloseListener`. Desktop's `clientEventSink` adapts
  exactly the requesting WebContents: its channels and `destroyed` hooks are
  unchanged. A headless host supplies its client's connection and disconnect
  hooks. Unsubscribing removes only that subscription's hook; disconnect tears
  it down immediately. VC-557 uses the same port; the terminal supervisor
  (VC-560) streams through it, with `terminal-data`, `terminal-exit` and
  `terminal-park-state` on the topic map.
- **Alerts** go through `ports.attention.deliver`. A background observer
  ignores the outcome; a person's own request reports it.
- **Client work** goes through `clientCapabilities(ports.client)`, or
  `host.client`. Never test whether a client is present. With no client,
  `openExternal`, the clipboard and `showMenu` reject, and `revealInFolder`
  throws, a `ClientCapabilityUnavailableError`. It carries `capability` and a
  message a person can read ("Opening a link needs the Volli desktop app, and
  this host is running without one."). Let it reach the caller as a refusal;
  `isClientCapabilityUnavailable` tells it apart from a real failure.

Trash is a **host-side filesystem operation**, not a client capability. A moved
service asks through `trashCapabilities(ports.trash)`. With no adapter, it rejects
with `TrashUnavailableError` (`code: "trash-unavailable"`), stating that nothing
was deleted. There is no unlink/rm fallback. Desktop's adapter calls the same
`shell.trashItem` as before.

Window-only work stays in desktop and never becomes a port: the OS
appearance broadcast, the updater state, notification Settings pushes,
Ghostty appearance (`ghostty-config.ts`), the application menu, dialogs and
pickers.

The secret key (`SecretKeyPort`, `src/ports/secret-key.ts`) is a port in the
same sense, with a desktop adapter and a headless one, but the host hands it
to the `SecretStore` it builds rather than to `createHostCore`. See
[Secrets](#secrets).

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
observer after the runtime exists. Engine construction is private to the
Sessions module (`src/sessions/engine.ts`, not a package export). It requires
the shared ledger; terminal, data and runtime consumers must receive the
composed engine and never construct a fallback. The wake decorator lives beside
the activity watch in `src/session-control/`.

Coverage entries for the activity/read/peek watches, concurrency budget and
`db/export.ts` run here at unchanged 100% thresholds. The export test and
`db/transaction-gate-ledgers.test.ts` compose host-core ledgers and run in the
Linux packages lane. The full host-notice integration test stays in desktop
until its remaining desktop dependencies move.

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
- **A database from a newer build (VC-602).** Before anything opens the
  file for writing, `openVolliDb` reads its `user_version` and minimum reader
  version on the read-only preflight handle (`src/db/schema-compatibility.ts`).
  - At or below this build's head: migrate as usual.
  - Newer, and the floor is at or below the head: open it, log once, run no
    migration, never lower `user_version`.
  - Newer, and the floor is above the head (or unreadable): throw
    `DatabaseFromNewerVersionError` with the file byte-identical.
    `createHostCore` classifies it as `databaseFailure.kind === "newer-version"`;
    desktop shows its named recovery screen, and a headless host refuses to
    serve with the same typed reason.
  - The floor lives in `app_state` under `volli:min-reader-version`, which
    every schema has. A missing marker reads as the baseline, 58: the head the
    guard shipped at, and the oldest head that can safely back up a v58 file.
    Only a migration declared `raisesMinReader: true` writes it, in its own
    transaction. **Read "Breaking an older reader" above `MIGRATIONS` before
    adding a migration.**
  - A backup of a newer, compatible database is stamped with this build's
    head and carries only this build's columns, so a newer build can restore
    it and migrate it up. Bundles never carry the floor; a restore's
    migrations derive it.
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

### Secrets

`SecretStore` keeps persistent Session secrets in `session-secrets.enc` beside
the database, and seals the file through a `SecretKeyPort` that the host passes
to its constructor. It is not on `HostCorePorts`, because the store is built by
the host, next to the services that use it.

| Host    | Passes                                                     | Envelope |
| ------- | ---------------------------------------------------------- | -------- |
| Desktop | `keychainSecretCodec(safeStorage)`, unchanged since VC-481 | `VSC1`   |
| `hostd` | `fileSecretKey({ path: secretKeyFilePath(dataDir) })`      | `VSF1`   |

The file key is `<dataDir>/session-secrets.key`, or the absolute path in
`VOLLI_SECRET_KEY_FILE`. It is created atomically with mode 0600 the first
time a secret is saved. A key file other users can read, or one owned by
another user, is refused, as ssh refuses such a private key. Sealed secrets
whose key is missing or different are refused, never re-keyed. Each refusal is
a `SecretKeyUnavailableError` whose message names the fix and never a key byte;
the store passes it through and keeps every other failure generic.
`inspectSecretKeyFile(path)` raises the same refusals for an existing key
without creating one, so `hostd` can refuse to boot on a bad key instead of
finding it at the first save. A filesystem without hard links is its own
refusal, `no-hard-links`, naming the manual `openssl rand` fallback.

**Threat model, in one breath.** The file key protects stored secrets from
other local users and from copies of the data directory made without the key,
such as backup bundles (which carry neither file). It does not protect them
from root, from the host's own user and its Sessions, or from anyone who can
read both the data directory and the key file. The full paragraph, cross-machine
restore, and where Pi's `auth.json` lives for `hostd` are in
[docs/secrets.md](../../docs/secrets.md#headless-hosts).

### Terminals

`PtyManager` (`src/pty/manager.ts`) supervises every live PTY. It is built by
the host with a `PtyHost` (the event bus, the worktree bundle, and the
harness-file writer whose module is still desktop's) plus
the runtime pieces the host composes: the agent runtime environment, spawn
ledger and concurrency reader. Desktop builds it in `registerTerminalIpcHandlers`
with `desktopPtyHost()`; `hostd` will build it with its own. A degraded
database still yields a supervisor whose `create` answers with the open error.

**The stream contract.** M2's terminal ticket (VC-568) exposes this over the
host protocol's [binary framing](../../docs/plans/host-protocol.md#binary-framing);
the supervisor is shaped for it but ships no transport.

- **One client per terminal.** A terminal's stream is attached to at most one
  `HostClientEventSink`. Only that client receives its output, exit and park
  state, and only it may write, resize, ack, park, wake, keep awake, detach or
  close it. Ownership is the sink's `id`; any of those from another client is
  answered exactly as an unknown session's (VC-509). `attach` is the one door
  a non-holder uses, and the protocol authorizes it before it gets here.
- **Create attaches.** `create(client, request, onDisconnect = "close")` starts
  the process with `client` attached at the requested size.
- **Close vs detach** (VC-320 C07). `kill` is the explicit close: the process
  dies. `detach` is the explicit detach: output already batched goes to the
  departing client, then nobody owns the terminal and the process keeps
  running. A client's disconnect does what its attach said: `close` (a desktop
  window, today's behavior) or `detach` (a remote client that will reconnect).
- **Attach resumes.** `attach(client, sessionId, { cols, rows, onDisconnect })`
  succeeds on a detached terminal, or for its current holder (a fresh
  attachment). Another holder's terminal is refused with "Terminal is attached
  to another client"; takeover is a later, explicit act. The client's size
  becomes the PTY's: resize ownership travels with the stream.
- **Resync, not replay.** While detached, output is not delivered but is kept
  in the bounded retained tail (`OBSERVATION_TAIL_MAX_CHARS`, the same tail the
  CLI's peek reads). An attachment opens with that tail as its first
  `terminal-data` batch, then the current park state; the client resets its
  screen and writes what it receives in order. Input is never retained or
  replayed: a write reaches the PTY once, at call time, from the holder, and
  the launch line is written once at spawn. The tail is raw bytes cut at a
  character bound, so a resync may start inside an escape sequence; a screen
  serializer is VC-568's call.
- **Flow control per attachment.** The holder acks consumed characters; past
  100,000 unacked the PTY's reads pause until acks bring it under 5,000. A
  detach or a new attachment forgets the previous client's unacked count and
  resumes the PTY, so a vanished client never freezes the process. A detached
  terminal keeps running and its tail keeps the newest output.
- **Ordered, lossless within an attachment.** Batches are published in order,
  at most `BATCH_MAX_CHARS` (256,000) characters each. The binary channel
  numbers frames from 1 per attachment and splits a batch into frames of at
  most 64 KiB; a client concatenates frames in sequence. Nothing is durable:
  a terminal that exits while detached is gone, and its attachment's close is
  in the Session ledger.

**node-pty.** `node-pty` 1.1.0 is N-API and loads lazily, when a terminal is
created. One build loads under both Electron and plain Node: on macOS the
package's darwin prebuild, or the build desktop's `rebuild:native`
(`electron-rebuild`) makes; Linux has no prebuild, so it compiles from source.
Desktop keeps its own `node-pty` dependency for packaging, exactly like
`better-sqlite3`. CI's `Test (packages)` lane rebuilds it for its Node and
runs `scripts/probe-node-pty.mjs` before `manager.pty.test.ts` drives real
shells (see `docs/development/host-linux.md`).

## Browser backend

Agent browser tools speak CDP through a `BrowserTabController`
(`browser/cdp-controller.ts`) over an injected `CdpTransport`. Everything else
they need, they ask of a `BrowserBackend` (`browser/backend.ts`), so the engine
is the one thing that changes between hosts:

| Backend                                               | Engine and CDP wire                                                                      |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Desktop `BrowserTabHost` (`main/browser/tab-host.ts`) | `WebContentsView`s; each tab's app-private `webContents.debugger` (`webcontents-cdp.ts`) |
| Headless host                                         | Standalone Chromium over a CDP pipe (VC-619)                                             |

- **The interface.** Tab lifecycle with the VC-238 ownership fields
  (`BrowserTabState`, now in `@volli/shared`), a `CdpTransport` per tab
  (`transportFor`), the load wait, viewport (`setBounds`), pictures and
  screenshots, the wake hold (`holdAwake`), console capture (`consoleOf`), the
  VC-239 holds and presentation. Window work (attaching a page to a person's
  window, DevTools, the cursor overlay) is not on it and stays in desktop.
- **Shared policy.** `BrowserTabRegistry` (`browser/tab-registry.ts`) is the
  abstract base every backend extends: tab ids, ownership at birth, the
  per-Project and per-Session caps, holds and their colours, console bounds,
  pictures, traces, presentation and wake leases. A backend answers its
  engine through the abstract members (`open`, `close`, navigation,
  `liveChrome`, `applyWakePolicy`, `goOffScreen`, `transportFor`,
  `waitForLoad`, `capturePicture`, `setBounds`, `closeAll`). One
  implementation of the policy is what keeps refs, generations and refusals
  identical across engines.
- **The port.** `browserAgentPort({ backend, scope, session, cursorFor })`
  (`browser/agent-port.ts`) binds the backend's wire, load wait and wake hold
  into the one agent port every caller builds.
- **The security stance (VC-110).** A backend's CDP wire is private to the
  engine it drives. Never `--remote-debugging-port`: no loopback endpoint
  through which another local process could reach a tab.

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
     moves its last desktop dependency. For example,
     `apps/desktop/src/main/volli-fs-ipc.test.ts` still composes the desktop
     IPC adapter.
6. **Coverage moves with the test.** A protected entry in
   `apps/desktop/vite.config.ts` moves to this package's `vite.config.ts`
   when host-core's own tests hold it at 100%. Check that with
   `vp test run <test> --coverage --coverage.include=<file>`. If its test
   must stay in desktop, re-point the desktop entry to
   `**/packages/host-core/src/<path>`, as `project-roots.ts` is.
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

# @volli/host-core

The host's services, composed without Electron. Volli Cloud
([ruling](../../docs/plans/volli-cloud.md)) runs one host program everywhere:
Electron main and `apps/hostd` both call `createHostCore`, `start()` and
`stop(reason)`. Electron main keeps the quit gates, deadline and native exit.

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
    processReaders: { liveSessionIds: () => [], openTerminalCwds: () => [] },
  },
);
if (host.kind === "degraded") console.error(host.database.error);
await host.start();
await host.stop("shutdown");
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

host-core's interface is its `exports` map: the root, one entry per cluster,
and `./testing`. Each cluster entry (`src/entries/<cluster>.ts`) is an
explicit list of re-exports: a name is public because a client (desktop,
`hostd`, a bench) or a client's test imports it as that cluster's API.
Everything else is an implementation detail.

| Entry                              | Owns (under `src/`)                                                                                                                                                                                                                                                                                                                                                                                                         | What a client takes from it                                                                                                                                      |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@volli/host-core`                 | `index.ts`, `host-lifecycle.ts`, `db-open-failure.ts`, `runtime-services.ts`, `session-services.ts`                                                                                                                                                                                                                                                                                                                         | `createHostCore`, `HostCore`/`LiveHostCore`, `HostCorePorts`, `defaultDatabasePath`, `DbHandle`, the transaction-guard handlers                                  |
| `@volli/host-core/ports`           | `ports/`                                                                                                                                                                                                                                                                                                                                                                                                                    | The [ports](#ports) and their headless answers (`HEADLESS_ATTENTION`, `NO_POWER_EVENTS`)                                                                         |
| `@volli/host-core/db`              | `db/`                                                                                                                                                                                                                                                                                                                                                                                                                       | `openVolliDb`, migrations, the transaction gate, the repositories ([Persistence](#persistence))                                                                  |
| `@volli/host-core/secrets`         | `secrets/`                                                                                                                                                                                                                                                                                                                                                                                                                  | `SecretStore`, `SecretService`, the file key and the sealed credential module ([Secrets](#secrets))                                                              |
| `@volli/host-core/sessions`        | `session-control/`, `sessions/`, `session-concurrency.ts`, `session-tokens.ts`                                                                                                                                                                                                                                                                                                                                              | Listing rows, peek content, the concurrency env reader, Session tokens. Never a Session writer ([Session composition](#session-composition))                     |
| `@volli/host-core/session-runtime` | `session-runtime/`, `shell/`, `model-access/`, `decision/`, `session-env.ts`, `pi-session-orphans.ts`, `pi-tool-output.ts`, `verb-input.ts`                                                                                                                                                                                                                                                                                 | The staged runtime: assembly, facade, agents, Automations adapter, lifecycle; model access preferences; background shells                                        |
| `@volli/host-core/integrations`    | `mcp/`, `codemode/`, `web/`, `observability/`                                                                                                                                                                                                                                                                                                                                                                               | MCP settings and dispatch, Code Mode config and sandbox assets, Web Access, the observability sink and exporters                                                 |
| `@volli/host-core/log`             | `log/`                                                                                                                                                                                                                                                                                                                                                                                                                      | The structured log: `hostLogger`, `installHostLog`, the trace context (`withTrace`, `withLogContext`) and the sinks ([The log](#the-log))                        |
| `@volli/host-core/files`           | `volli-fs.ts`, `file-search.ts`, `file-services.ts`, `blob-*.ts`, `turn-attachments.ts`, `prompt-templates.ts`, `skills.ts`                                                                                                                                                                                                                                                                                                 | File reads/writes/watches, search, blobs, templates, skills. Their result types are `@volli/shared` wire types                                                   |
| `@volli/host-core/worktree`        | `worktree/`, `worktree-runtime.ts`, `credential-helper-diagnostics.ts`                                                                                                                                                                                                                                                                                                                                                      | Git, ensure/trim/remove, snapshots, activity, the cleanup engine and leases                                                                                      |
| `@volli/host-core/board`           | `board/`, `project-*.ts`, `ticket-*.ts`, `detached-work.ts`                                                                                                                                                                                                                                                                                                                                                                 | Project create/relink/roots, ticket commands, [ticket moves](#ticket-moves) and wakes, [the Board module](#the-board-module)'s feed and receipts                 |
| `@volli/host-core/handlers`        | `handlers/`                                                                                                                                                                                                                                                                                                                                                                                                                 | `createHostHandlers`, `invokeHandler`, `admittedHandlers`, the door policies: the [one handler map](#the-handler-map) every door projects                        |
| `@volli/host-core/pty`             | `pty/`                                                                                                                                                                                                                                                                                                                                                                                                                      | `PtyManager` and the warm park ([Terminals](#terminals))                                                                                                         |
| `@volli/host-core/browser`         | `browser/`                                                                                                                                                                                                                                                                                                                                                                                                                  | The backend interface, `BrowserTabRegistry`, the CDP controller, picture and trace stores ([Browser backend](#browser-backend))                                  |
| `@volli/host-core/automations`     | `automations/`, `automation-services.ts`                                                                                                                                                                                                                                                                                                                                                                                    | The Automation service and its types                                                                                                                             |
| `@volli/host-core/agents`          | `agent-*.ts`, `agent-dispatch/`, `watches.ts`, `harness-*.ts`, `host-profile.ts`                                                                                                                                                                                                                                                                                                                                            | The agent socket, its verb door, the CLI shim and app profile lock, harness registry and installs                                                                |
| `@volli/host-core/maintenance`     | `backup/`, `process/`, `maintenance-services.ts`, `database-recovery.ts`, `retention-runtime.ts`, `orphan-scan.ts`, `quiet-windows.ts`, `login-*.ts`, `host-shutdown.ts`, `shutdown-deadline.ts`                                                                                                                                                                                                                            | Backup documents, database recovery, process reaping, retention, quiet windows, login PATH, the shutdown deadline                                                |
| `@volli/host-core/testing`         | `testing/`, `db/test-helpers.ts`, `session-control/test-support.ts`, `backup/test-fixture.ts`, `secrets/test-support/`; it also re-exports test-only names of production modules: `db/recovery-pending.ts`, `session-control/sqlite-ledger.ts`, `session-control/checkpoint-diagnostics.ts`, and the `*ForTest` resets of `worktree/deletion-lease.ts`, `worktree/snapshot.ts`, `orphan-scan.ts` and `retention-runtime.ts` | Test fixtures, the standalone Session ledger and test engine, the database-recovery marker, the checkpoint failure reporter, module-state resets. **Tests only** |

`scripts/` holds `pnpm --filter @volli/host-core migrations:lock` and the N-1
compatibility driver.

**The interface rules** (`src/package-interface.test.ts` enforces each). Every
import guard here, and desktop's and hostd's, finds module edges with
`scripts/module-edges.mjs`: static and dynamic imports, re-exports, `require`
and `vi.mock`, in `'`, `"` and backtick quoting.

- Inside the package, files import each other by relative path, never
  `@volli/host-core/...`, and never through an entry. An entry is the
  outside's view.
- An entry holds only `export { … } from` lines: no `export *`, no
  declarations, no wildcard subpath in `package.json`.
- A client needs a name an entry does not list: add it to that entry.
- An entry may list a name that only tests import when the name is that
  cluster's public API (a repository, a service, a type a test drives the
  cluster through). Pure test support (fixtures, standalone constructors,
  `*ForTest` resets of module state) goes in `./testing`, even when it lives in
  a production module.
- Test support never reaches production code. Inside host-core no non-test
  file imports it; desktop and `hostd` each guard their own sources
  (`host-core-testing-boundary.test.ts`).
- The Session writer's constructors (`createSqliteSessionLedger`,
  `SqliteSessionLedger`, `createSessionEngine`, `createHostSessionEngine`,
  `createTestSessionEngine`) are in no production entry. The guard reads
  every entry `package.json` serves except `./testing`, the root included,
  and follows aliases, `export *` and namespace re-exports to the declared
  name. A running host's one writer comes from `createHostCore`; a test that
  needs a standalone one takes `createTestSessionEngine` or the ledger from
  `./testing`. This closes the typed, accidental second writer. A deliberate
  one is still possible: raw SQL through `LiveHostCore.database` is outside
  what an interface can fence, and out of this rule's scope.
- A client's wire types live in `@volli/shared`, not here: desktop's IPC
  contract, preload and renderer import nothing from host-core
  (`apps/desktop/src/main/client-wire-boundary.test.ts`).
- A test that mocks or spies on a host-core module names that module's file
  (`vi.mock("…/packages/host-core/src/worktree/index", …)`), not its entry:
  mocking the entry would leave host-core's own importers on the real module.
- A script run by plain `node` imports its one Node-loadable file by path
  (`db/session-storage-digest.ts`, `db/session-event-provenance.ts`), since an
  entry's extensionless re-exports need a bundler's resolver.

### Naming

One convention for what a module asks for and what it is (VC-632):

- **`…Port`** is one capability host-core asks for, which a host or another
  module implements (`PowerPort`, `TrashPort`, `SecretKeyPort`).
  **`…Ports`** is the set of them a constructor takes (`HostCorePorts`,
  `PtyManagerPorts`, `WorktreePorts`). `Deps` and `Dependencies` are retired
  for `Ports`.
- **`…Options`** is policy and configuration: values, and hooks with a
  default (`HostCoreOptions`, `PtyManagerOptions`).
- **`…Host`** is a host-core service that owns live resources and serves them
  (`BackgroundShellHost`, `McpSessionHost`, `PiRuntimeHost`,
  `ScheduledResumeHost`). It is never what something asks of its host; that is
  a `Ports`.
- **`…Backend`** is one engine behind an interface that has more than one
  (`BrowserBackend`, its agent-facing slice `AgentBrowserBackend`,
  `CredentialKeyBackend`).
- **No `Desktop` in host-core names.** host-core runs under desktop and
  `hostd` alike. A host-specific adapter is named in its host (desktop's
  `desktopPtyPorts`, hostd's `headlessPorts`); host-core's own constructors
  are `create…`/`createHost…`, and per-host policy is `Host…`
  (`HostMcpDispatch`, `HostCodeMode`, `HostDecisions`).
- **No file named after another package.** The single-instance profile lock,
  runtime paths and CLI shim are `host-profile.ts`, not `agent-runtime.ts`
  beside `@volli/agent-runtime`.
- **Door** keeps its glossary meaning (`CONTEXT.md`): one entrance a caller
  reaches host behavior through (an IPC handler, a socket verb, an agent
  tool), never the behavior itself.

### Lifecycle and maintenance

- **Stop.** `host.stop` has one interface and two policies. Both disarm
  producers and maintenance, join the existing runtime and socket drains
  (concurrent on desktop, sequential on `hostd`), and stop the activity
  timer. The default `drain-and-close` policy also joins in-flight start,
  maintenance and detached Done-trims, then checkpoints and closes SQLite.
  Desktop explicitly selects `desktop-quit`: no new writer joins,
  background-shell close, Automation settlement, checkpoint or DB close;
  process exit keeps main's historical behavior. Deadlines stay at the
  process edge: desktop 15 s with an Immediate native exit, `hostd` 30 s.
- **The live host** owns `maintenance` (one spawn ledger, the orphan-process
  service, retention and automatic reap), `secretStore`, `worktreeDeps`, and a
  lazy `terminals.manager` when a terminal port exists (otherwise an explicit
  unavailable variant). A degraded host carries its classified failure, not
  nullable live services; recovery stays available for it. Desktop starts
  maintenance after first paint and triggers retention on focus; `hostd`
  starts it at readiness. The retention watch is shared per database with
  IPC, keeping dismissal state and read-only behavior.
- **Backup.** Formats, redactions, credential exclusions and the
  minimum-reader marker guard are as shipped. Migration rollback backups and
  backup retention run through the shared open/migration path; there is no
  periodic bundle scheduler.
- **Desktop keeps** the recovery screens, dialogs, restart and `app.quit`
  (recovery's IPC door is `main/database-recovery-ipc.ts`), and
  `main/quit-gate.ts`: synchronous refusals, the accepted-update latch, the
  microtask verdict and the Immediate before native exit. Host shutdown stops
  watches and notices, drains both Session owners, closes every MCP process
  group, and only then flushes observability; its 15-second aggregate deadline
  is `shutdown-deadline.ts`. `quiet-windows.ts` is Node-only policy over
  injected structural interfaces; native windows and activation stay desktop's.

### The Session runtime

- **Staged constructors.** `session-runtime/assembly` builds the inert Pi
  attachment over the host's one engine, model access, MCP/Code Mode/Web Access
  owners, secret service and attachment identities. Browser and shell ports
  are construction inputs, and birth membership derives from those
  capabilities in desktop's shipped tool order. Venue and sandbox assets are
  explicit options. The runtime and peek share one transcript artifact store.
  `session-runtime/context` resolves attach-time briefs and frozen inputs.
  `session-runtime/facade` and `session-runtime/agents` add skills, model,
  Sessions, titler, peek, the kickoff submit and delegation recovery staging.
  Desktop and `hostd` use the same constructors; their adapters supply
  host-owned ports and pre-execution hooks, never separate executors.
- **Recovery before consumers.** `session-runtime/lifecycle` installs the
  quit hold synchronously, then recovers stale attachments, delegations,
  durable shell notices and scheduled resume. Only `await lifecycle.ready()`
  issues `RecoveredSessionServices`, the opaque proof that public tool/watch
  doors, CLI Session ports, the renderer's listing/peek/stop hooks, the
  Session RPC edge and runtime Automations require. One idempotent `close()`
  stops producers, releases power listeners and drains notices, RPC, runtime,
  MCP and observability; it also waits for an in-flight recovery sweep. Quit
  cancellation is a typed outcome, and the boot sweep stops at async
  boundaries, leaving unswept bindings for the next launch.
- **`host.runtimeServices`** holds the staged constructors for model access,
  decisions, MCP, Web Access and model sign-in. Desktop invokes them in its
  original boot order, so legacy web keys migrate before any store reads
  them, and sign-in keeps the runtime's Pi collection. Code Mode's worker and
  `quickjs.wasm` paths come from the host's injected directories; desktop
  keeps their packaging (`asarUnpack`), and CI checks both files in the
  unsigned packaged app before core e2e.
- MCP credentials keep their standalone mode-0600 `mcp-credentials.json`, not
  `SecretStore`.

### Automations and the agent socket

`createHostAutomations` owns one engine/service, its runner, armed arrivals
and scheduler, started at recovered readiness. Execution is an explicit
idle/unavailable/ready variant. After timer producers stop, `settled()` joins
recovery, attempts and Run boots before SQLite closes.
`createHostAgentCommands` builds the socket verb door over the host's
[handler map](#the-handler-map); `session-runtime/agents`
owns the lazy tool door and watches. `createHostAgentSocket` composes the
early socket lifecycle before database boot, on the caller's
`<dataDir>/volli.sock`: mode 0600, v1 NDJSON, request limits, shutdown drain.
Desktop keeps `automations/ipc.ts` and its socket app-quit adapter; host-core
never holds an app lifecycle.

### Files, worktrees and secrets

- `createHostCore` composes `fileServices` (the watch managers and the
  client/trash adapters). File-boundary tests run here against real
  directories and symlinks.
- `host.worktrees.deps(db)` captures the host's event bus and `dataDir`;
  desktop callers not yet moved pass the same facts through `worktree-host.ts`.
  Session locations take `events` and `dataDir` for worktree materialization
  and publication, and never import desktop's broadcast adapter.
  `worktree/repository-turn.ts` keeps its per-process ordering. Project roots
  stay in desktop's 100% gate: desktop's IPC/PTY tests cover branches this
  package's do not.
- `secrets/` holds `SecretStore`, the headless file key, and the typed sealed
  credential module: the credential lock, the durable file contract, the key
  id and `VHC1` envelope over the keyring port (`ports/credential-keyring.ts`)
  and the typed inventory. See
  [docs/secrets.md](../../docs/secrets.md#the-typed-credential-module-vc-642).
  Pi's secret-wait publisher type is exported by `secrets`, and its
  turn-attachment type lives in `session-runtime/turn-attachments`.

### What stays in desktop

IPC doors and their integration tests (`main/volli-fs-ipc.ts`,
`main/pty/ipc.ts` with the warm-park quit/confirm door, `automations/ipc.ts`),
protocol registration, native external-app launch, pickers and dialogs, and
Web Access's legacy `safeStorage` migration. A desktop test that still composes
desktop modules stays in desktop and imports host-core's entries.

## The log

One structured, correlated log (VC-699; HP § Tracing and logs). A module
takes a logger for its component at module scope and writes identifiers and
counts:

```ts
import { hostLogger } from "../log/root";

const log = hostLogger("publish");
log.info("branch pushed", { ticketId, branch }); // never a payload, a prompt or a secret
```

- **The host installs the destination, once** (`installHostLog({ level, sink })`):
  hostd's JSON lines on stdout, the desktop's rotating files. Before any
  install (tests, benches, scripts) lines go to the console at `warn`, or
  `VOLLI_LOG_LEVEL`.
- **Every line is redacted** (`redactLogFields`, `@volli/shared`): credential-named
  fields lose any value but a count, and strings lose credential-shaped text.
- **Correlation is ambient, for a request's own chain.** A door opens
  `withTrace(peerTrace, { door, … }, handle)` per request; code deeper in adds
  what it knows with `withLogContext({ sessionId })`. Lines carry both without a
  parameter threaded through.
- **Background work never inherits it.** Anything long-lived a request starts
  (an executor's attachment, a listener, an interval) starts detached with
  `withRootLogContext({ sessionId, … })`, and joins a trace only by identifier
  (`log/correlation`: a command's trace, a turn's trace). The Session runtime's
  executor is wrapped so (`correlatedExecutor`). A line with no such join
  carries its ids and no trace.
- **Generic doors log error summaries** (`logErrorSummary`: class name and
  code), never an error's message.
- **Cheap, and never fatal.** The level check runs before anything is built;
  the file sink only queues on the caller's stack, and a disk failure disables
  it with one warning.
- **No bare console.** Production code in host-core and Electron main logs only
  through a host logger; `src/log/no-console.test.ts` (and its twin in
  `apps/desktop/src/main/log/`) fails on a `console.*` call outside tests and
  the log module itself. A seam that takes a log function takes the logger's
  `(msg, fields)` shape, never `Pick<Console, …>`.

## Ports

A port is what host-core asks of the process hosting it. Each port lives in
`src/ports/` (`@volli/host-core/ports`). Desktop's
Electron adapter does exactly what desktop did before the port existed.

| Port (`HostCorePorts`) | Asks for                                                                                          | Desktop adapter                                                                                    | Headless host passes                                                                |
| ---------------------- | ------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `events: HostEventBus` | Announce a fact to every client: `publish(topic, payload)`, topics in `HostEventMap`              | `windowEventBus` (`main/broadcast.ts`): `volli:<topic>` to every live window                       | Its protocol's broadcast                                                            |
| `attention`            | Raise an alert with a person (`deliver`), and which Sessions a focused client shows               | `notifications/runtime.ts`: native notification, preferences, focused-target suppression           | `HEADLESS_ATTENTION`: every alert `unsupported`, nothing focused                    |
| `power: PowerPort`     | Sleep and wake (`suspend`, `resume`, `unlock-screen`, `user-did-become-active`)                   | Electron's `powerMonitor` itself                                                                   | `NO_POWER_EVENTS`                                                                   |
| `connectivity`         | The network, for retry policy. This is `ConnectivityPort` from `@volli/agent-runtime`, not a copy | `createConnectivityPort({ net, powerMonitor })`                                                    | `ALWAYS_ONLINE` from `@volli/agent-runtime`                                         |
| `trash?`               | Move a host file to recoverable Trash (`TrashPort`)                                               | `(path) => shell.trashItem(path)`, unchanged                                                       | Nothing. Requests reject with `TrashUnavailableError`; never permanent deletion     |
| `client?`              | Open a link, reveal a file, the clipboard, menus (`ClientCapabilityPort`)                         | `createElectronClientCapabilities()` (`main/client-capabilities.ts`): `shell`, `clipboard`, `Menu` | Nothing. `host.client` refuses each request with `ClientCapabilityUnavailableError` |
| `log`                  | Errors and warnings                                                                               | `console`                                                                                          | Its logger                                                                          |

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
`sessionReadWatch`, `sessionActivityWatch` and `sessionEngine` on the live
host; a degraded host has none of them. The outbox shares the engine's one
transaction writer. The wake bus decorates the engine inside the activity
watch: committed facts fan out before a listing row becomes dirty. Resumption
history, unattended Run notifications, scheduled resume and read receipts
observe in their original order, before the row is built.

`HostCorePorts` extends `HostSessionPorts`, which holds the ports Session
composition uses: `events`, `attention` and `log`. Its adapters are captured,
not called during construction, so desktop can bind notifications after the
database is known. Desktop wires `onFocusedSessionsChanged` to the returned
read watch.

The live-work watch (`liveWork`, `session-control/live-work.ts`, VC-577) is
fed by the activity watch's `observeEvent` port: every committed turn fact,
synchronously as its write resolves, never the 60 ms coalesced fold (which
only seeds a Session no fact has reached yet). It counts Sessions with a turn
open on a binding this process holds, Sessions with work the runtime accepted
but whose turn has not opened (`HostedSessionRuntime.pendingTurnStarts`:
admitted messages, retries, compactions, follow-up drains), and running
background shells, which the composition root feeds from the shell host's
state feed. Desktop's menu-bar quit decision reads it synchronously, and
`tryBeginIdleExit()` takes the runtime's start latch (`holdTurnStarts`) in the
same call when nothing is live: new starts are then refused before any effect
and queued follow-ups wait, durable, for the next launch. Armed Automations
are deliberately not live work.

Two facts arrive later and are not ports, because host-core answers both
itself: which executor bindings are open (a listing row is live only while one
is) and each folded projection for scheduled resume. They are
`SessionRuntimeWiring` (`session-services.ts`). The runtime assembly wires the
open bindings when it builds the Session runtime, and the lifecycle wires
scheduled resume when it is built, each into the services that own the engine
it was given. Until then nothing is open and nothing is scheduled. (They were
ports, `listOpenNativeBindings` and `observeScheduledResume`, that desktop and
`hostd` late-bound to those same host-core objects; VC-632 removed them.)

Engine construction is private to the Sessions module (`src/sessions/engine.ts`,
in no entry). It requires the shared ledger; terminal, data and runtime
consumers receive the composed engine and never construct a fallback. The wake
decorator lives beside the activity watch in `src/session-control/`.

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
- **Applied-migration history (VC-633, migration 060).** `migration_history`
  records each version the file ran with its `migrations.lock.json`
  fingerprint, in the transaction that applied it. Versions run before 060
  are backfilled with no fingerprint. Every open compares the history with
  this build's lock (`src/db/migration-history.ts`). If another lineage ran a
  different migration under a number this build ships, or stamped a version
  past 060 without recording it, the open **warns and never refuses**: one
  `[volli] migration history` log line, and a `Migration history:` line in
  About's support report. It needs no floor raise, because older builds never
  apply a migration to a newer file, so they can't leave it wrong. Bundles
  don't carry it; a restore's migrations write the new file's own.
- **Free space before a migration (VC-633).** `migrate` checks `statfs` on the
  database's directory before the safety copy: twice the database (WAL
  included) plus 64 MiB. It refuses with `InsufficientDiskSpaceError`, which
  names what it needs and what is free, before anything is written
  (`src/db/disk-preflight.ts`). `openVolliDb` measures before it opens a
  writable handle, so a refusal at startup leaves the db and its WAL
  byte-identical. Only a measurement that worked can refuse: when `statfs`
  fails (ENOSYS, EIO, an unsupported filesystem) it logs one warning and the
  migration goes ahead. The budget assumes `temp_store = MEMORY`, which
  startup and a restore's staging handle both set; with file-backed temp
  storage VACUUM needs a third copy on disk. A box's rollback is to that safety copy:
  [hostd README](../../apps/hostd/README.md#upgrading-and-rolling-back).
- **N-1 compatibility (VC-633).** CI's `N-1 compatibility` lanes run a
  previous build, from its own shipped sources, against a profile this build
  migrated to head (`src/db/n1-compatibility.test.ts`, driven by
  `scripts/n1/`): the newest `vX.Y.Z` release, the newest `vX.Y.Z-canary.N`
  canary (what a canary tester drops back to) and the PR's base. N-1 must
  open the profile, save and clear a credential, create and move a ticket,
  create a Session and make a bundle, and this build must read and back up
  what it left; or, when the floor is above N-1's head, N-1 must refuse with
  the db and WAL byte-identical. A release or canary from before the guard
  cannot refuse, so no `raisesMinReader` migration may land while it is the
  latest of its channel: cut a release (or canary) containing VC-602 first. A shipped build's known fault is listed, by commit, in
  `KNOWN_HAZARDS` and asserted exactly. Run it locally with
  `node scripts/n1/prepare.mjs --release --out ../../.scratch/n1` (or
  `--canary`, or `--ref <commit>`), then
  `VOLLI_N1_MANIFEST=<printed path> vp test run src/db/n1-compatibility.test.ts`.
- **Transaction ownership (VC-551).** No transaction spans an `await`. Use
  `withTransaction` / `settleTransaction` from `db/transaction-gate`.
  `openVolliDb` installs the ownership guard after migrations, with the handler
  the host passed as `onTransactionViolation`:
  - Desktop passes `throwTransactionViolation` in dev and tests, and
    `logTransactionViolation` when `app.isPackaged`.
  - **A headless host passes `throwTransactionViolation`.** Nobody is watching
    its log while a bug corrupts a transaction.
  - Tests use `openTestDb()` from `@volli/host-core/testing`, which
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
the host with a `PtyManagerPorts` (the event bus, the worktree bundle, and the
harness-file writer whose module is still desktop's) plus
the runtime pieces the host composes: the agent runtime environment, spawn
ledger and concurrency reader. Desktop builds it in `registerTerminalIpcHandlers`
with `desktopPtyPorts()`; `hostd` will build it with its own. A degraded
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

| Backend                                                  | Engine and CDP wire                                                                                 |
| -------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Desktop `BrowserTabHost` (`main/browser/tab-host.ts`)    | `WebContentsView`s; each tab's app-private `webContents.debugger` (`webcontents-cdp.ts`)            |
| `ChromiumBrowserBackend` (`browser/chromium-backend.ts`) | Standalone Chromium; one CDP connection over `--remote-debugging-pipe`, flattened sessions (VC-619) |

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
- **The parity suite.** `browser/test-support/backend-suite.ts` drives the real
  port and the agent-runtime browser tools against a loopback fixture: every
  verb, its result shape, refusals, holds, caps, cancellation and dispose.
  A backend passes it unchanged. `chromium-backend.test.ts` runs it against
  Chromium, in CI's Linux `Test (packages)` lane.

### Chromium

`new ChromiumBrowserBackend(ports, options)` launches its browser on the first
tab and keeps it until `dispose()`. Every option is the host's to state:

- **`executablePath`.** host-core finds and downloads nothing. The recommended
  build is Playwright's Chrome for Testing, pinned by the lockfile's
  `playwright-core` (a devDependency here, never imported at runtime) and
  installed with `playwright-core install chromium --no-shell`: the full
  build, which runs new headless. Never `chromium-headless-shell`, the old
  headless. The same revision runs on dev Macs, CI and a Linux box, where
  Ubuntu ships Chromium only as a snap.
- **`profileRoot`.** Each launch makes a private 0700 profile directory under
  it (`volli-chromium-<host pid>-<random>`) and removes it however the browser
  ends. Nothing a page stores outlives the browser. A host killed outright
  leaves its directory; the next backend on the same root sweeps every
  profile whose host is gone.
- **`noSandbox`.** `false` everywhere a host can provide user namespaces,
  which is every host Volli ships for: the hostd systemd unit allows the three
  Chromium's sandbox makes, and on Ubuntu 23.10+ the binary needs the AppArmor
  profile in `apps/hostd/packaging/volli-chromium.apparmor`
  (`apps/hostd/README.md`, "Running under systemd"). `true` only in a
  container that cannot, and a launch without the sandbox logs a warning
  every time. CI runs sandboxed.

- **`deviceScaleFactor`**: device pixels per CSS pixel every page is drawn
  at (`--force-device-scale-factor`). 2 makes a high-DPI viewer's screencast
  sharp, at four times the pixels for every tab and agent screenshots at 2×
  (as a Retina desktop's are); 1 on a host no high-DPI viewer looks at.
- **`screencastQuality`**: the JPEG quality of screencast frames.

What the backend owns, beyond the registry's policy:

- **One shutdown, however the browser ends.** The browser leads its own
  process group and starts with an allowlisted environment (no host
  secrets). A close, a failed launch, an exit or crash, and a pipe that fails
  or overflows all run the same finalization: every waiting command rejects,
  the streams close, the whole group gets SIGTERM, a grace, then SIGKILL
  (survivors of the leader included), the child is reaped and the profile
  removed. The backend forgets the browser's tabs, and the next tab launches
  another. A host that runs browsers relies on no service manager for this.
- **A bounded pipe.** Inbound frames, pending commands, unsent output bytes
  (the writable's own buffer is the only queue) and every command's time are
  bounded (`CdpPipeLimits`); a withdrawn or timed-out command leaves the
  pending map at once. An oversized frame is a broken browser: the pipe
  closes, which finalizes it.
- **Ids are ours.** `open` returns synchronously; Chromium's target is created
  behind the entry's `ready` promise, and every engine call waits on it.
- **Contexts by `browserSessionPartition`.** A Session's tabs share their
  Ticket's (or Project's) browser context and nobody else's; the person's tabs
  use the default one. Downloads and every permission are denied per context.
- **Chrome facts from events.** url, title, loading and history are tracked
  for the synchronous `liveChrome`; the generation bumps on main-frame
  navigation start. A read refreshes the title first, because Chromium reports
  a script's title change late; that read is bounded and follows the caller's
  withdrawal. An empty title is a real title.
- **Page-driven navigation is HTTP(S)-only, with one residual.** Every
  document request and redirect hop is checked before it is sent (`Fetch`),
  on the page's session and on every out-of-process iframe's, which attaches
  paused and runs only once its guard is installed. A main frame the page
  sends anywhere else (its own `blob:`, an external scheme) is refused when
  it asks (`Page.frameRequestedNavigation`, before commit) and stays put, as
  desktop's `will-navigate` keeps it; a commit that slips past is sent to
  `about:blank`. Chromium itself refuses `file:`, `chrome:` and top-level
  `data:`.

  **The residual (not desktop parity):** same-process `data:`, `blob:` and
  `srcdoc` iframes make no network request, so no `Fetch` guard sees them,
  and CDP has no per-frame pre-commit refusal; they run, where desktop's
  `will-frame-navigate` refuses them. None gains a privilege the page lacks
  (`blob:` and `srcdoc` share its origin, `data:` is opaque). The candidates
  were rejected: injecting a `frame-src` CSP through `Fetch` response
  interception rewrites every document's headers, is visible to the page
  (`securitypolicyviolation`) and still misses `srcdoc`; removing the frame
  element races the commit and changes the page's DOM. A test pins the
  behavior (`chromium-backend.test.ts`, "guards frames"). **VC-571 must
  enforce it, or keep the lent-view fallback, before persons use hostd's
  browser** (`docs/plans/host-protocol.md`, parity bar).

- **Popups never run.** Every new page is attached paused; one with an opener
  is closed, and its URL becomes a product tab under the opener's provenance
  and caps.
- **Dialogs nobody can answer get the safe answer, said aloud.** An alert is
  acknowledged; a confirm or prompt is declined (`false`, `null`); a
  leave-page prompt (`beforeunload`) is declined, so the tab stays, as
  desktop's does — Volli never approves leaving a page that guards unsaved
  work. Each is recorded in the console with its outcome, and a refused
  departure also sets the tab's error, which every agent answer carries.
  Closing a tab runs no unload veto.
- **A frame source for viewers** (`attachScreencast`, `browser/screencast.ts`),
  by host-protocol.md § Binary framing; VC-571 carries it over the binary
  channel, never the event bus or a tRPC subscription. Per-tab attach and
  detach; JPEG, with encoding, viewport and device scale factor as attach
  metadata (re-stated when they change); latest wins, at most one unsent frame
  per attachment, stale frames dropped whole before they are numbered;
  Chromium's frames acked on arrival; `next(signal)` cancels, and the tab
  closing or going headless ends every attachment. A viewer asks for a scale
  (2 on Retina) and gets the highest any attachment asked for, up to the
  browser's own. Each tab's cast is reconfigured by one serial, coalescing
  worker: from a request (attach, detach, resize, scale) no frame is offered
  until a cast of the new shape has started, and only then do attachments
  hear the new metadata; every frame's real JPEG size is checked against the
  live cast, and one from before (or of another scale) is dropped, though
  every frame is still acked. A zero-viewer stop is always the last word. The
  person's input arrives through `viewerInput` (pointer with the DOM
  `buttons` mask, so a drag is a drag; wheel, keys, committed text and IME
  composition) and closes the transcript camera for desktop's quiet window;
  it never takes or moves the agent hold. A shown tab's JavaScript dialog,
  while a viewer is attached, waits for the person: `pendingDialog`,
  `respondToDialog` and each attachment's `onDialog` carry it, and nobody
  answering within `CHROMIUM_DIALOG_ANSWER_TIMEOUT_MS` (or the last viewer
  leaving) gets the safe answer. These are optional `BrowserBackend`
  members, refused for a headless tab: the seam stays open to capabilities
  one engine has and another does not.
- **The parity bench** (`chromium-parity.test.ts`) measures, at 1× and 2×,
  input-to-frame latency (p50, p95) for a click and for typing and frames per
  second while scrolling and animating, at the frame-source level on loopback.
  It always prints `[volli] chromium parity`; `VOLLI_CHROMIUM_PARITY_ASSERT=1`
  holds it to the bar (p95 ≤ 100 ms, ≥ 30 fps).
- **No wake policy.** Each tab is its own window, never occluded, and the
  launch turns background throttling off.

## Ticket moves

`executeTicketMove` (`ticket-move.ts`, VC-629; since VC-668 reachable only through the handler map) is the whole
Deliberate move: atomic single/group write, post-commit Ticket wakes, immediate
background Done trim, armed arrivals, non-user Doing notification, and backward
Session interrupts. IPC and `ticket.move` only resolve/map their inputs and
replies. An omitted drop index means column-only intent (same-column no-op);
indexed drops retain renderer reorder semantics. The reply remains synchronous
unless interrupt delivery is asynchronous, and never waits for trim.

The socket intentionally gains the renderer's immediate trim, including on
hostd without a retention poll. Both reuse the trim primitive's busy/dirty/Keep/
opt-out refusals, durable `worktree_trimmed` event, snapshot invalidation and
worktree change notice. Desktop wires the same busy supplier to both doors.
The renderer still receives the board projection in its reply, not a new
`data-changed` push; detached trims push as before. NDJSON receives its existing
agent projection and targeted invalidation. There is no new receipt ledger or
migration; backward-interrupt receipts remain Session evidence.

Since VC-668 the move is the host's `ticket.move` handler: `createHostHandlers`
assembles its ports once (the busy supplier, interrupts, the armed arrival,
attention and the event bus), so neither door wires them. The desktop window's
call carries `origin: "desktop-window"`, which keeps the reply-carries-the-board
rule above; every other caller's change is published. No production entry
serves `executeTicketMove`, and `package-interface.test.ts` refuses any
production importer of it but the handler map.

## The Board module

`src/board/` (VC-565) is the board's commands and feed. `createBoardHandlers`
(`commands.ts`) builds every `board.*` handler, and `ticket.move`, for the
handler map: each is the whole command (T13), owning its clock, attribution,
transaction and receipt, ticket wakes, the worktree materialization of a
switch into worktree scope, its rows on the Workspace change feed (naming the
Client's `commandId`) and its `data-changed` announcement, which it never
echoes to the desktop window that asked unless the change moved a checkout.
Doors hold no repository: desktop's legacy board channels, the board router
and the socket's `ticket.move` all invoke the map.

- `receipts.ts`: `board_command_receipts` (migration 062), written in the
  effect's own transaction (a move's through `TicketMoveSeam`). Same
  `commandId` and intent replays: the recorded outcome with the resource as it
  stands now; another intent is a branded `CommandIntentConflict`. Seven days
  is a hard expiry (an expired receipt never answers); excluded from backups.
- `change-feed.ts`: `BoardChangeFeed`, one in-memory feed per Workspace with an
  opaque `epoch:instance:seq` cursor, a compacted 2,048-entity window, and
  resume-or-resnapshot. The epoch is read on every use: a changed epoch, or a
  removed Workspace (`dispose`), ends the feed and tells its followers to
  resnapshot. A root makes one, hands it to `createHostHandlers`
  (`boardFeed`) and feeds it every `data-changed` its bus carries
  (`noteDataChanged`): desktop through `tapDataChanged` (`broadcast.ts`), hostd
  through `headlessPorts`.
- `resources.ts`: `boardResourceWorkspace(db)`, the board's half of a root's
  `resourceWorkspace` port.

The contract: HP § Command catalog, "The board (VC-565)", and § Workspace
change feed.

## The handler map

`createHostHandlers(ports, services)` (`@volli/host-core/handlers`, VC-668)
builds the host's one map from key to the whole command: every public
catalog key and every desktop-only key (`DESKTOP_ENTRIES`, VC-608), whose
policy is its channel's VC-574 placement. A
composition root calls it once with the recovered services (database, runtime,
Sessions facade, Model Access, Automations, busy-worktree guard, and
desktop's experiments and interrupts) and hands the same object to every door:
the routers' `ctx.handlers`, the socket's `handlers` option (whose
`AGENT_VERB_TABLE` binds a catalog key only through `projectHandler`), and
any legacy IPC channel that still serves a catalog command. `HostHandlers` is
total over both tiers' keys, so a missing handler fails `pnpm typecheck`; a
service a host lacks makes its handlers throw `OperationUnavailableError`
rather than leaving a hole.

Desktop main also passes `remoteHosts` (`RemoteHostsPort`,
`handlers/remote-hosts-port.ts`, VC-700): its registry of hosts added over
SSH, behind the desktop-only `hosts.*` and `hostAdd.*` keys. hostd passes
none, so those answer unavailable there.

The map it returns is sealed (`HostHandlerMap`, `handlers/handler-map.ts`):
no entry is callable. A door reaches one only through
`invokeHandler(map, policy, …)` or the `admittedHandlers(map, policy)` view,
and the door's `HandlerPolicy` runs first; a refusal throws
`HandlerRefusedError` and the handler never runs. The policies:
`ROUTER_POLICY` for a router's context, `DESKTOP_WINDOW_POLICY` for a legacy
desktop IPC channel (`handlers/policies.ts`), and the socket's per-request
`socketHandlerPolicy`, its coordination policy judged again at the map
(`agent-dispatch/admission.ts`). Tests build the real map over a test
database with `testHostHandlers`, or seal their own entries with
`sealTestHandlers` (`./testing`). The contract: HP § Command catalog, "One
handler map".

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
3. **Rewrite importers by relative path.** Inside host-core, a moved file and
   everything that imports it use relative paths (`../<cluster>/x`), never
   the package's own name and never an entry: a self-name import makes `x`
   impossible to stop exporting. `src/package-interface.test.ts` fails on
   one, and `node scripts/codemods/host-core-relative-imports.mjs` rewrites
   it. Importers outside the package (desktop, `hostd`) import from the
   cluster's entry, `@volli/host-core/<cluster>`: add each name they use to
   `src/entries/<cluster>.ts`, or a new entry and its `package.json` export
   for a new cluster. Test support goes in `src/testing/index.ts`. Leave no
   re-export shims at the old paths. A shim turns the rename into an add.
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
     path and imports from host-core's entries. It moves in the ticket that
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

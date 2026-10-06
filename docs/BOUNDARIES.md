# Process and API boundaries

**Decision (2026-08-14): Electron main is a host, not the product API.**

The product is the durable core — commands as persisted intent, idempotent
acceptance with receipts, immutable events, projections over them. Electron
main is one process that *hosts* that core and exposes it through one
transport (Electron IPC) to one client (the renderer). Nothing about the core
is allowed to know it is being hosted by Electron. The second host is now
chosen: **`hostd`, serving the host protocol** to desktop, web/phone and CLI
clients. The [Volli Cloud ruling](plans/volli-cloud.md) (VC-486, 2026-10-03)
chooses one authority per workspace; this is direction, not built behavior.

Two corollaries that settle recurring questions:

- **Clients talk to hosts, never to databases.** Each host's SQLite is a
  private materialization of the ledger it owns; it is an implementation
  detail behind the host's API, not a sync surface. A future server's store
  is a greenfield choice invisible to every client, and the local `volli.db`
  never migrates — it is the local cache layer of the story, not the thing
  that must become Postgres.
- **`@volli/shared` carries domain vocabulary, not transport.** The Electron
  channel catalog and its runtime validators are desktop-owned: the transport
  contract belongs to the host that owns the transport. A future non-desktop
  client imports `@volli/shared` for domain types and speaks to a host's API;
  it must never inherit the desktop's Electron channel catalog by importing the
  domain package.

## Standing rules (review criteria)

These keep the multiplayer door open at near-zero cost. They are rules for
review, not a project to execute — none of them asks anyone to build sync.

1. **Every new durable id is a UUID, a content hash, or a string scoped by a
   session/attachment UUID.** Never a bare local counter, never anything
   machine-local (hostname, pid, path). Durable id derivations are frozen the
   moment they ship (see CLAUDE.md), so this is the one rule that cannot be
   retrofitted: cross-writer string equality must always mean "same logical
   fact", and today's ids all pass — keep it true.

2. **Per-session `sequence` is provisional local order.** It is enforced
   single-writer at exactly one append gate (`appendEvent` in
   `packages/host-core/src/session-control/sqlite-ledger.ts`). No writer or
   reducer may depend on cross-session global order, and none may treat
   adjacency — "immediately preceded by event X" — as an implicit position. A
   future authority assigns final order and local logs rebase onto it; code
   that quietly assumed local order was final is the code that breaks.
   The Workspace change-feed cursor is not such a sequence and sits outside
   this rule (VC-630; `docs/plans/host-protocol.md`, "Workspace change
   feed"). Under the one-authority ruling it is that authority's delivery
   order for one Workspace and epoch, used only to resume a subscription. Its
   changes name state, never a delta, so no reducer reads meaning from their
   order or adjacency either.

3. **RPC payloads stay JSON-safe.** The Electron transport carries `Date`,
   `Map`, and `undefined` by structured clone; an HTTP transport would mangle
   all three. `IsJsonSafe` and `JsonUnsafeProcedures` live in
   `@volli/host-protocol` (`packages/host-protocol/src/json-safe.ts`); assert
   the latter is `never` at every router seam, including subscription yields.
   `SessionRouterJsonSafety` in `packages/session-rpc/src/index.ts` is the
   existing example, and session-rpc re-exports the types for compatibility.
   See `docs/plans/host-protocol.md` for the opaque-type/runtime-validation limit.

4. **A receipt is local acceptance, not eternal finality.** UI code may
   render "accepted" from a receipt; it may not be written so that a remote
   authority reordering or rejecting the command later is unrepresentable.
   Leave reconciliation semantics undecided rather than assumed absent.

5. **No new raw IPC for new domain surfaces.** New features take the command
   → event → projection shape with IPC as a dumb transport, the way Sessions
   already work. From VC-564 on, a new domain command is one entry in the
   command catalog: a Verb Registry entry with a `catalog` declaration, bound
   to one router procedure built by its area's `createCatalogBuilders`
   family (VC-630; `docs/plans/host-protocol.md`, "Command catalog"), whose
   handler calls a context port the composition root wires to host-core. IPC, the agent
   socket, tools and the WebSocket project it and carry no behavior of their
   own. A command only the desktop's own window calls is a desktop-only
   entry instead (`DESKTOP_ENTRIES`, VC-608): no public ceremony, policy from
   its channel's VC-574 placement, additive-only, served over the generic IPC
   bridge from the same handler map (`docs/plans/host-protocol.md`, "Both
   tiers"; the template is `packages/session-rpc/src/desktop-router.ts`). The
   existing raw channels migrate
   opportunistically when a surface is touched — never as a big-bang rewrite;
   under the `cloud` flag, an area's channels are deleted when that area moves.

6. **Host code never imports `electron`.** This applies to
   `packages/host-core`, `packages/host-protocol` and `apps/hostd`. They host
   the same core without depending on Electron.

7. **No new shared/business state in `app_state`.** Every new key must be
   classified as client-local, host, or workspace state (mixed keys name both
   halves as `split`). Host is host-level state shared by every workspace on
   that host, in the host-level file defined by `plans/host-identity.md`.
   Workspace state belongs behind the workspace authority, not in the
   client-local catch-all. The typed inventory is
   `packages/shared/src/app-state-keys.ts`, enforced by
   `packages/shared/src/app-state-keys.test.ts` and the typed repo writers;
   channel placements live in `apps/desktop/src/ipc/placement.ts`, enforced by
   `apps/desktop/src/ipc/placement.test.ts`.

## Shipped SQLite migrations

SQL and original TypeScript `apply` source (including referenced helpers) are frozen in `packages/host-core/src/db/migrations.lock.json`; edits to shipped entries require a new migration, never a rewritten lock. Keep frozen helpers/constants byte-identical (including shared runtime helpers); new behavior gets new names, leaving old applies bound to the original implementations. Formatter/tool upgrades must preserve these source slices, not regenerate shipped hashes.
Append the next contiguous version to `MIGRATIONS`, then run `pnpm --filter @volli/host-core migrations:lock` and commit its single new version line; the script refuses to rewrite existing entries, and concurrent claims on the same number conflict on that line.
Tests enforce versions 1..N with no exceptions (023/024 reconcile historical lineages, not numbering gaps); schema-head consumers derive the last version from `MIGRATIONS` (`SCHEMA_HEAD`).
**A migration that breaks older readers says so (VC-602).** An older build opens a database newer than its head without migrating it unless the file's minimum reader version (`app_state` key `volli:min-reader-version`) is above that head, in which case it refuses before writing anything. A migration declares `raisesMinReader: true` when a build that does not know it could no longer read, write or back up the file safely; additive migrations leave it off. The declaration is part of the migration's lock fingerprint. Unique constraints over older-written columns and derived state without a rebuild path count as breaking. The rule for what counts as breaking is above `MIGRATIONS` in `packages/host-core/src/db/migrations.ts`. CI's `N-1 compatibility` lanes hold the classification to a real previous build (the latest release, the latest canary and the PR's base, VC-633): it writes to a compatible head profile, or refuses a floor-raised one byte-identically, and no floor raise lands while the latest release or canary predates the guard.

## SQLite transaction ownership

**No SQLite transaction spans an `await` (VC-551).** One host owns the handle
on one JavaScript thread. `withTransaction(db, work)` in
`packages/host-core/src/db/transaction-gate.ts` runs a synchronous body between
`BEGIN IMMEDIATE` and COMMIT/ROLLBACK; nested work uses a savepoint. The Session,
Automation and orphan-cleanup ledger ports use `settleTransaction`: the same
synchronous work, with its outcome delivered as a promise. Their transaction
methods and bodies are synchronous by type; host/filesystem/network work runs
before or after the atomic boundary. Re-read mutable state after async host work
before deciding what to commit.

Independent synchronous repo writes are SQLite autocommit transactions. A
consistent multi-statement read or compound write uses `withTransaction`;
repo work deliberately inside a transaction remains direct. Existing native
`db.transaction` callbacks are safe only with synchronous bodies. No separate
queue or isolated connection is needed to protect ordinary repo calls: nothing
can interleave while an owned transaction is open. Multiple clients still enter
one event loop, not multiple concurrent owners of the handle.

**The cooperative-gate limit (VC-511) is closed.** The old gate held a transaction
open across promises and allowed an unrelated repo write to join its rollback.
None of the three ledger adapters needed interactive async transactions: the
Automation/cleanup bodies awaited only synchronous ledger operations, and the
Session engine already used synchronous bodies. Removing that await, rather
than gating every caller, makes independent reads/writes structurally safe.
Isolated synchronous connections were rejected: `busy_timeout` could block the
same event loop an async owner needed to commit.

`openVolliDb` installs an execution-time ownership guard after migrations.
`openTestDb` selects its throwing handler. The handler is a required
`createHostCore` option, chosen at each host's composition root: desktop
explicitly selects throwing for development and **logging only for
`app.isPackaged`**, never based on `NODE_ENV`; a headless host selects
throwing. It checks `exec` and statement execution, including statements
already in the repo cache, and tracks native synchronous transaction callbacks.
A raw BEGIN/SAVEPOINT left open between calls fails synchronously in tests/dev,
with rollback before another command can join. Ending an owned transaction
inside its callback also fails the guard and blocks subsequent writes in that
callback. Promise-returning transaction
bodies are rejected and rolled back by the transaction helper (native
better-sqlite3 also rejects them). The packaged ownership guard neither throws
nor rolls back; it only logs, preserving release behavior on a programming bug.
Its row readers stay native to avoid read-path overhead; transaction-opening
statements and non-reader writes are still diagnosed. Tests/dev instrument
all reads, including cached readers and lazy iterator stepping.

Boot-time sole-owner migrations, recovery and backup/restore connections remain
direct and are not runtime shared-handle exceptions. No runtime allowlist is
needed. See [the write-path inventory](research/sqlite-ownership-vc551.md).
**The boot window is the only unguarded time, and nothing from it outlives
boot:** a statement handle created on the runtime handle before the guard is
installed must not be retained past `openVolliDb`. The guard re-wraps the
statements in the repo cache (`prepared`) when it installs; any other early
statement would escape it.
`packages/host-core/src/db/transaction-gate.test.ts` proves that the former
ungated-write rollback hazard cannot happen, and covers cached statements,
raw transaction controls, nesting and the packaged handler. Cross-ledger work
is proved by `packages/host-core/src/db/transaction-gate-ledgers.test.ts`, which
composes the Session, Automation and cleanup ledgers in the Linux packages lane.

## The chosen path, for context

The [Volli Cloud ruling](plans/volli-cloud.md) chooses **one authority per
workspace**. Single-host workspaces need no relay; multiplayer is membership,
per-actor capabilities and presence on that one authority over the host
protocol. Plain local Volli stays offline; a remote workspace is read-only
while its host is unavailable, unless the workspace is moved by fenced
promotion.

### History — relay superseded for single-host workspaces

The earlier path, retained here as history, was a
**server-authoritative event relay**: the local ledger is unchanged, a server
becomes the sole sequencer for shared history, clients pull–rebase–push.
Single-player is untouched and never requires the network. CRDT-everywhere
was evaluated and rejected for this domain — every production system with a
reachable server (Linear, Figma, Zulip, LiveStore) converged on
server-assigned order, and machine-bound resources (terminals, worktrees,
executors) get supervised or streamed, never multiplayed. The research record
and the claim-by-claim validation live in
`.volli/artifacts/multiplayer-readiness/`.

The earlier deferral, also historical, was: until a multiplayer product shape
is chosen, sync protocol, CRDTs, tenancy/identity, presence, cloud infrastructure
and schema pre-reservation are **not** being built (a nullable scope column plus
one constant backfill is free whenever a server actually exists). The ruling
now sets that product shape and its milestones; this is not a standing ban on
the chosen identity, presence or cloud work.

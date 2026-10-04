# Process and API boundaries

**Decision (2026-08-14): Electron main is a host, not the product API.**

The product is the durable core — commands as persisted intent, idempotent
acceptance with receipts, immutable events, projections over them. Electron
main is one process that *hosts* that core and exposes it through one
transport (Electron IPC) to one client (the renderer). Nothing about the core
is allowed to know it is being hosted by Electron, because the paid product's
future shape is a second host — a daemon or a workspace server — serving the
same core over a network transport to clients that are not this renderer.

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
   `apps/desktop/src/main/session-control/sqlite-ledger.ts`). No writer or
   reducer may depend on cross-session global order, and none may treat
   adjacency — "immediately preceded by event X" — as an implicit position. A
   future authority assigns final order and local logs rebase onto it; code
   that quietly assumed local order was final is the code that breaks.

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
   already work. The existing raw channels migrate opportunistically when a
   surface is touched — never as a big-bang rewrite.

## SQLite transaction ownership

The desktop's Session, Automation and orphan-cleanup ledgers share **one async
transaction gate per SQLite handle** (`apps/desktop/src/main/db/transaction-gate.ts`).
It owns `BEGIN IMMEDIATE` through COMMIT/ROLLBACK, including while host work is
awaited. New ledger adapters must use `getTransactionGate(db).transaction(work)`;
a private promise queue is not sufficient on a shared handle. Separate handles
have separate gates; SQLite, not this in-process queue, arbitrates their locks.

**Known limit (VC-511): this gate is cooperative.** Existing synchronous repo
calls, `db.transaction`, prepared statements and direct `db.exec` calls do not
implicitly acquire it. An independent repo write on a handle with an open async
transaction silently joins that transaction and is lost if it rolls back; a
read can see uncommitted state. This change does not migrate those legacy
callers or make the entire desktop a single safe writer. Before a second
host/client is introduced, independent writes and consistent reads must enter
the gate (for example, `await getTransactionGate(db).transaction(() =>
insertProject(db, project))`) or use an appropriately isolated connection.
Repo work intentionally part of an existing transaction remains direct; never
await another ledger/gate transaction on the same handle from inside its work,
since it queues behind itself. Host work that needs another ledger transaction
must be split at the commit boundary.

`apps/desktop/src/main/db/transaction-gate.test.ts` reproduces both cross-ledger
serialization and the remaining ungated-write rollback hazard.

## The chosen path, for context

When multiplayer becomes a product decision, the path is a
**server-authoritative event relay**: the local ledger is unchanged, a server
becomes the sole sequencer for shared history, clients pull–rebase–push.
Single-player is untouched and never requires the network. CRDT-everywhere
was evaluated and rejected for this domain — every production system with a
reachable server (Linear, Figma, Zulip, LiveStore) converged on
server-assigned order, and machine-bound resources (terminals, worktrees,
executors) get supervised or streamed, never multiplayed. The research record
and the claim-by-claim validation live in
`.volli/artifacts/multiplayer-readiness/`.

Until a multiplayer product shape is chosen, the following are explicitly
**not** being built, and none of it gets harder by waiting: sync protocol,
CRDTs, tenancy/identity, presence, cloud infrastructure, schema
pre-reservation (a nullable scope column plus one constant backfill is free
whenever a server actually exists).

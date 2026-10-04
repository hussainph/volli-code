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
   `apps/desktop/src/main/session-control/sqlite-ledger.ts`). No writer or
   reducer may depend on cross-session global order, and none may treat
   adjacency — "immediately preceded by event X" — as an implicit position. A
   future authority assigns final order and local logs rebase onto it; code
   that quietly assumed local order was final is the code that breaks.

3. **RPC payloads stay JSON-safe.** The Electron transport carries `Date`,
   `Map`, and `undefined` by structured clone; an HTTP transport would mangle
   all three. `SessionRouterJsonSafety` in
   `packages/session-rpc/src/index.ts` applies `IsJsonSafe` to every raw
   procedure input and output at the router seam, so an unsafe payload fails
   type-checking before any transport can expose it.

4. **A receipt is local acceptance, not eternal finality.** UI code may
   render "accepted" from a receipt; it may not be written so that a remote
   authority reordering or rejecting the command later is unrepresentable.
   Leave reconciliation semantics undecided rather than assumed absent.

5. **No new raw IPC for new domain surfaces.** New features take the command
   → event → projection shape with IPC as a dumb transport, the way Sessions
   already work. The existing raw channels migrate opportunistically when a
   surface is touched — never as a big-bang rewrite.

6. **Host code never imports `electron`.** This applies to
   `packages/host-core`, `packages/host-protocol` and `apps/hostd`. They host
   the same core without depending on Electron.

7. **No new shared/business state in `app_state`.** Every new key must be
   classified as device-local or workspace state. Workspace state belongs
   behind the workspace authority, not in the device-local catch-all.

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

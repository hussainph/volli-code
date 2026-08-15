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
  it must never inherit 109 Electron channel names by importing the domain
  package.

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
   all three. The trap is documented at
   `apps/desktop/src/renderer/src/lib/session-rpc-ipc-link.ts`; when the
   session-rpc contract is next touched, enforce JSON-serializable payloads
   at the type level rather than by convention.

4. **A receipt is local acceptance, not eternal finality.** UI code may
   render "accepted" from a receipt; it may not be written so that a remote
   authority reordering or rejecting the command later is unrepresentable.
   Leave reconciliation semantics undecided rather than assumed absent.

5. **No new raw IPC for new domain surfaces.** New features take the command
   → event → projection shape with IPC as a dumb transport, the way Sessions
   already work. The existing raw channels migrate opportunistically when a
   surface is touched — never as a big-bang rewrite.

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

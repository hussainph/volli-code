# Host, workspace and execution identity

**Status:** VC-550 contract, pending owner review in the PR. Companion to the
[Volli Cloud ruling](volli-cloud.md) and [host protocol](host-protocol.md)
(VC-549). These are the names later host, pairing, lease and promotion tickets
must share. Migration 058 only reserves empty tables; none of the behavior
below is activated by this PR.

**Revised by VC-630** (architecture review, 2026-10-04, lens A candidate E),
finding **F5**: host, device and worker names are bound to keys before VC-575
pairs any device. See [Keys](#keys-proof-behind-the-names).

## Identity table

UUIDs are UUID v4 strings, allocated once with `randomUUID()` or its platform
equivalent, never derived from a hostname, PID, address, path or display name.
An address locates a host; it does not identify one. Names are editable labels.
Revocation never makes an id available for reuse.

| Name / wire field | Type | Lifetime | Allocator | Reason / storage |
|---|---|---|---|---|
| Host / `hostId` | UUID v4 | One host install; survives process restarts, not a profile restore or copy | Host, lazily on first host use with the flag on | Distinguish authorities, including two hosts claiming the same epoch. `host_identity.host_id`; host-level, excluded from backups. |
| Workspace / `workspaceId` | UUID v4 | One project's board, including moves, replicas and restores | Existing project creation | Portable logical identity, not a checkout path. **Existing `projects.id`**, not a second id. |
| Workspace epoch / `workspaceEpoch` | Non-negative safe integer on the wire; stored rows start at 1 | Workspace authority generations; never decreases | Host taking authority, with promotion fencing | Scoped by workspace UUID; 0 means no recorded cloud authority. `workspace_epochs`; included in backups. |
| Worker / `workerId` | UUID v4 | One worker install registered with one host; restart keeps it, wiped local execution state or re-registration after revocation does not | Host at worker registration | Executor identity independent of transport and checkout. `workers.id`; host-level, excluded from backups. |
| Checkout grant / `leaseEpoch` | Positive safe integer, scoped by ticket UUID; token is `(workspaceEpoch, leaseEpoch)` | One grant, unchanged by renewal, incremented for every new grant | Workspace authority | Fence stale checkout writes. `checkout_leases.epoch`; workspace-level, excluded from backup bundles. No separate lease UUID. |
| Device / `deviceId` | UUID v4 | One client install paired to one host; retained after revocation for attribution | Host at pairing | Authenticated client principal, not a hardware fingerprint. `devices.id`; host-level, excluded from backups. |
| Host key / `hostKey` (F5) | P-256 public key; fingerprint = SHA-256 of its SPKI DER | Same as `hostId`, minted with it | Host | Proves `hostId`. Public half in host-level storage (VC-575) and in every paired device's pin; private half never in SQLite or a backup. |
| Device / worker key (F5) | P-256 public key | Same as its `deviceId` / `workerId` | The device or worker, at pairing / registration | Proves the principal. Public half on `devices` (VC-575) / `workers` (VC-580); private half stays on its holder. |
| Session / `sessionId` | Existing UUID | Durable Session, across attachments and execution moves | Existing Session creation | Session lifetime belongs to the ledger, not a worker. Existing `sessions.id`. |
| Attachment / `attachmentId` | Existing UUID | One historical association of a Session with an executor | Session runtime / authority | Identifies the execution association, not ownership of the checkout. Existing attachment ledger. |
| Ticket / `ticketId` | Existing UUID | Durable ticket | Workspace authority | Lease scope and permanent identity. Existing `tickets.id`. |
| Display number / `ticketNumber` | Positive integer scoped by workspace | Permanent human handle of a ticket | **Only the workspace authority** | Presentation, not identity. Existing `projects.next_ticket_number` and `tickets.ticket_number`. |

This follows [BOUNDARIES rule 1](../BOUNDARIES.md): every new entity identity is
a UUID. Epochs are scoped generations, never bare durable ids; compare them
only with their workspace/ticket UUID. `host_identity.id = 1` is a private
singleton slot, not a host id and never a wire value. Display numbers likewise
remain presentation. Every counter on the wire must pass `Number.isSafeInteger`;
overflow fails closed rather than rounding or wrapping. SQL `INTEGER` and the
migration's lower-bound checks alone do not enforce the wire constraints or
UUID syntax; future writers and protocol validators must do so.

## Host is not installation, workspace or process

`apps/desktop/src/main/installation-id.ts` (VC-469) deliberately carries
`volli:installation-id` in `app_state` backups. Pi's ChatGPT sign-in sees a
restored profile as **the same installation, moved**. Keep that behavior. It is
not an authority credential and must not be reused as `hostId`.

The host mints `hostId` lazily and persists it in the host-level singleton.
An app update, process restart, address change or new worker leaves it alone.
A host can serve more than one workspace. Moving one workspace does **not**
change the source host's id (it may still serve the others), and does not copy
it to the destination. The destination uses its own existing host id, or mints
one if it is a new host. The workspace id stays the same and its epoch rises.
Even promotion on the same host must raise the epoch: host identity is not an
ownership generation.

A profile restored from a Volli backup is a new host: the bundle excludes
`host_identity`, `workers`, `checkout_leases` and `devices`. Pair clients and
register workers again before granting execution. Workspace epoch history is
included. A raw filesystem copy of the entire profile would copy the singleton;
**this migration does not detect that**. Raw-copy detection/re-enrolment is an
open implementation requirement, not a guarantee of the schema. Never serve a
copied host identity concurrently as if the copy were the original.

## Workspace and its authority epoch

Today a workspace is **one project's board**, not a git worktree, a window or
the entire multi-project profile. VC-588 will split that profile into one SQLite
file per workspace plus a host-level file. `projects.id` already supplies its
identity: current main-process project creators mint `randomUUID()`, and the
pre-SQLite renderer did too (c1b5565ca); legacy import preserves those ids.
VC-550's real-profile inspection found all six project ids to be UUIDs (see
VC-550's checkpoint and migration-verification comments for the evidence). No
backfill, rekey or path-based identity is needed. Two projects can point at the
same checkout and still be different workspaces.

`workspace_epochs(workspace_id, epoch, host_id, created_at)` records which host
held authority at each generation. The primary key is `(workspace_id, epoch)`.
The current epoch is `MAX(epoch)` for that workspace; no row means **0**, local
and never served under the flag. Before first serving under the flag, insert
1. Every later promotion inserts a strictly larger epoch (normally max + 1)
and retains history. A routine restart of the same authority does not promote.
Timestamps are epoch milliseconds for audit, never the ordering mechanism.

The history is append-only in the domain. SQL rejects updates and inserts at
or below the recorded maximum; project deletion cascades the history. There
is deliberately no general DELETE guard in 058. Later authority code must not
delete history while its workspace survives, or erase it with `REPLACE`.

### Fence shared by hello and every write

A client or worker retains the highest accepted `(workspaceEpoch, hostId)`
**per workspace UUID**. Epoch is ordered; host UUID is compared for equality,
not sorted to choose a winner:

- Lower epoch: stale authority, refuse.
- Same epoch, same host id: reconnect to the same authority.
- Same epoch, different host id: split brain, refuse both pending explicit
  recovery; do not select by arrival time or UUID ordering.
- Higher epoch: accept only after authenticated promotion/authority validation,
  then retain that pair and fence the old authority.

This pin must survive reconnects and restarts. A hello is not a one-time waiver:
commands and worker execution must remain tied to the accepted generation.
UUIDs are names, not proof of authority: the host key is the proof (F5). A
client compares only a `hostId` whose welcome verified against the key it
pinned for that id; authorization still applies. VC-549 owns the wire aliases and errors; this PR adds no TS identity
types to `@volli/shared` or a new package.

A replica may lag. `MAX(epoch) + 1` in a stale restored file is **not** sufficient
to prove global exclusivity: independent promotions could pick the same epoch.
VC-591's move/recovery flow must establish authority against the latest known
fence and quarantine the unreplicated tail, never merge it. Control-plane
compare-and-swap and self-hosted/offline promotion arbitration remain to be
specified before enabling promotion. Nor does 058 decide that an ordinary
backup restore automatically promotes. A restored workspace may not serve
writes until that fenced authority decision has completed.

## Workers and capabilities

`workers(id, name, kind, capabilities, created_at, revoked_at)` lives with the
host. One host assigns a registration to one worker install. A reconnect keeps
that id only if its local checkout state and registration survive; a wiped
sandbox gets a new id. The host's co-located executor is a worker too, not the
host's own id. The same worker install registered to another host has another
registration/id. Revoked rows are retained; new registration gets a fresh UUID.

The `kind` names who owns the executor process, **not proximity to the client**:

| Kind | Meaning |
|---|---|
| `local` | This authority host's co-located worker, even when the client is on another machine |
| `remote` | A user-owned worker connected outbound to the host |
| `cloud` | A Volli-managed sandbox worker |

`capabilities` is a JSON object advertised at registration and refreshed by
VC-580. It describes executable facilities (platform, agent runtime, git,
terminal, browser and supported protocol features), not a model/provider
registry, authorization grant or proof that a checkout is writable. Match job
requirements to verified supported capabilities; unknown keys grant nothing.
VC-580 owns the versioned key vocabulary, negotiation and limits. 058 only
stores JSON text (default `{}`) and checks `json_valid`; it does not validate
object shape, authorize a worker, schedule it or contact one.

## Checkout leases: one ticket, one worker

`checkout_leases` has one current row per ticket:

| Column | Meaning |
|---|---|
| `ticket_id` | Ticket UUID and primary key; deletion of the ticket cascades the row |
| `worker_id` | Registered holder UUID |
| `epoch` | Per-ticket lease generation, exposed as `leaseEpoch` |
| `workspace_epoch` | Authority generation under which this grant was made |
| `granted_at` | Time of the grant, fixed for that generation |
| `renewed_at` | Last successful renewal; initially equal to `granted_at` |
| `expires_at` | Host-clock expiry, strictly after `renewed_at` |
| `released_at` | Null while unreleased; terminal release time otherwise |

The authority grants 1 on first use; every transfer, re-grant after expiry,
release or revocation, or resumed execution under a promoted authority raises
the lease epoch. Renewal keeps the worker, grant time and both epochs, changing
only renewal/expiry times. Release ends the grant in place. Retain the row
while the ticket exists; deleting it to grant again would forget the counter.
After a backup restore (which omits leases), raising the **workspace epoch**
before any new grant makes a restarted lease counter safe.

The write fence is `(workspaceId, ticketId, workspaceEpoch, leaseEpoch)` plus
the authenticated `workerId`; compare generations lexicographically,
workspace epoch first. Acceptance requires exact equality with the authority's
current live, unexpired grant, not just a token greater than a caller's last
one. A newer lease alone cannot rescue a write from an older workspace epoch.
A worker id or Session id alone never confers checkout ownership.

The SQL UPDATE trigger rejects decreasing either epoch, changing ticket id,
or changing holder, workspace epoch or grant time without raising lease epoch;
a released grant cannot be revived in place. SQL cannot police filesystem
writes, credential scope, expiry, renew-time monotonicity or worker liveness.
VC-581 must enforce those, clear `released_at` on every new grant, validate
the workspace's current epoch and worker registration, and serialize grant
changes through the authority transaction gate. Direct DELETE/INSERT or `REPLACE` can bypass the UPDATE trigger; they are
not valid renewal/transfer operations. This is an additive storage foundation,
not an already-operational distributed lock.

VC-582's move is stop writes → checkpoint ref → raise lease epoch → restore at
the destination. A partitioned old worker may still change its private files;
its stale publications, tool effects through the host and accepted writes must
be refused. Processes/browser sockets do not migrate. Expiry duration, heartbeat
cadence and worker shutdown/checkpoint policy belong to VC-581/VC-582.

## Session attachment, execution venue and location

The durable Session outlives a checkout grant or process. A ticket may have
many Sessions (including subagents) sharing the worker's current checkout
lease; the lease is **not per Session or attachment**. The Session ledger still
permits at most one live executor attachment for each Session.

With the flag on, `SessionAttachment.venue` in
`packages/shared/src/session-ledger.ts` records
`SessionExecutionVenue { id: workerId, kind: local | remote | cloud }` at attach.
`unknown` remains a read-side/history representation, never a worker kind or a
valid new execution target. A historical attachment's venue is not rewritten
when execution moves. A replacement executor gets a new attachment UUID for
the same Session, with its destination worker venue.

VC-581 must durably bind each ticket executor attachment to its grant:
`(ticketId, workerId, workspaceEpoch, leaseEpoch)`, scoped by the Session's
workspace. Check it before attaching, resuming or publishing executor facts;
renewal keeps the binding, a new grant makes it stale. Worker-to-host messages
must carry the binding, not recover it by looking up whatever lease happens to
be current. Closing a stale attachment records its outcome; it does not delete
the Session or turn earlier accepted history into current execution. **058
adds no attachment columns or events**: the binding's event/storage extension
belongs to the lease implementation, with tolerant reads of older history.

`SessionLocation` lives in `packages/session-engine/src/session-runtime.ts`:
`{ directory, venue }`. `directory` is a worker-local locator, never durable
entity identity and never a path a remote client should execute against. Today
`packages/host-core/src/session-runtime/location.ts` resolves the project or
worktree path; `prepare` materializes it and refuses failure rather than falling
back to the main checkout; `reaffirm` verifies the already-bound directory.
The runtime snapshots `location.venue` into the attachment and wraps the
prepared directory in its native recovery reference. With workers, the worker
materializes the leased checkout and supplies its own local directory. An old
worker's recovery path must never be treated as a path on a new worker.

With the flag **off**, `{ id: "local", kind: "local" }` remains unchanged.
Existing attachments and provenance keep that frozen historical literal; no
backfill reinterprets it as a new worker UUID.

Keep this distinct from `VenueKind` / `VenueSnapshot` in
`packages/shared/src/session-venue.ts`: `main-checkout | worktree` describes
**what checkout** the Session stands in, plus git measurements; execution
venue describes **which worker** executes it. Neither checkout kind implies a
worker kind. The current path-based worktree *start lease* in `location.ts`
serializes materialization against deletion; it is not this checkout ownership
lease or a distributed fence.

Board Sessions and tickets configured without worktrees use the main checkout
today. 058's ticket-keyed lease does not yet express shared main-checkout
ownership. VC-581 must settle that case before enabling worker execution there;
never mint a durable checkout id from its path. VC-583 owns venue-label snapshots
for history (renaming/revoking a worker must not relabel past execution).
Restored history may name excluded worker registrations: retain the recorded
venue id/kind, render its snapshot label or an unavailable-worker fallback, and
never require a current worker row to read history or infer a live grant.

## Devices and pairing

A device is a **client install paired to one host**, not a user, machine serial
number, push token or account. Pairing creates a host-assigned `deviceId` and
human-readable name. Reconnect/credential rotation retains that identity;
revocation invalidates its access and retains the record for audit. Pairing
again after revocation, to a restored host or to another host creates a fresh
UUID. One phone can have separate registrations with several hosts.

`devices(id, name, created_at, revoked_at)` stores only attribution in 058.
VC-575 owns approval, credential issuance/storage/rotation, revocation and
workspace access, under the key contract below (F5): a device credential is
short-lived and proved by the device key, never a long-lived bearer secret. A credential is bound to `(deviceId, workspaceId)` and the
issuing host; a host-level device record does not authorize all its workspaces.
Actors are derived from authenticated credentials, never claimed by a hello.
Device → `deviceId`, worker → `workerId`, Session → existing `sessionId`.
No token, secret or hardware fingerprint is added by this migration. A managed
control-plane device/account registry must reference these public identities,
not introduce another identity for the same paired principal.

## Keys: proof behind the names (F5)

`hostId` is a UUID the host claims, and device credentials would otherwise be
bearer secrets. VC-575 binds both to keys before any device pairs, as Syncthing
device ids (a hash of the device certificate) and Tailscale node keys do.
Workers follow the same contract at registration (VC-580).

- **Names stay UUIDs.** `hostId`, `deviceId` and `workerId` remain the UUIDs
  above (BOUNDARIES rule 1; 058 shipped them). A key binds a name; it does not
  replace it. A host key never identifies a workspace and never moves with one.
- **Algorithm.** ECDSA P-256: the curve Secure Enclave, Android Keystore and
  WebCrypto can all hold non-exportably. Keys and proofs carry an algorithm id,
  so a later algorithm is additive.
- **Custody.**
  - The host's private key lives beside the host secret key: the keychain on
    desktop, a mode-0600 file on hostd, refused when other users can read it,
    as ssh refuses such a key. It is never in SQLite and never in a backup
    bundle, so a restore mints a new id and key together.
  - A device's private key is non-exportable wherever the platform allows.
  - A worker's private key is local state: wiping it is a new worker, as now.
- **Pairing pins the host key.** The pairing code or QR carries the host key
  fingerprint out of band, like an ssh known-hosts entry or a Syncthing device
  id. The device keeps `(hostId, fingerprint)` beside its fence. Trust on first
  use over the network alone is not pairing.
- **The welcome proves the host.** The hello carries a client nonce. The host
  signs the nonce, negotiated version, host id, workspace id and epoch, actor
  and granted features, and the client verifies that signature against the key
  pinned for `hostId` before it applies the fence.
  - A different key for a pinned `hostId` is refused, as a changed ssh host
    key is. Only an explicit re-pair replaces the pin.
  - A workspace moved to a host this device never paired with needs that
    pairing first: credentials already bind the issuing host.
- **Devices and workers prove theirs.** A device or worker signs a
  host-issued challenge bound to the host id, its own id, the workspace and a
  purpose. In return it gets a short-lived connection credential (minutes),
  which it presents as the hello's `credential` and refreshes with a new proof.
  Revocation drops the public key and is checked at dispatch, so a phone holds
  nothing long-lived worth stealing. Session credentials (per-attachment
  tokens, VC-163) stay host-issued and attachment-scoped, and never leave the
  worker.
- **Rotation.** A key rotates by a statement signed with the old key. A lost
  private key is a new identity (new id, pair again), as a restore is.
- **What keys do not settle.**
  - A raw profile copy copies the private key with the id, so the copy proves
    the same key. Copy detection stays open.
  - The proof binds the handshake, not the channel, so WSS stays required.
    Where hostd terminates TLS itself, VC-575 binds the proof to the TLS
    exporter.
  - Tailscale identity (WhoIs) stays an extra signal, never authorization.

## Ticket display numbers: authority only

`projects.next_ticket_number` is allocated by
`nextTicketNumberForProject` in `packages/host-core/src/db/tickets-repo.ts`.
Only the workspace authority calls the allocator and creates the ticket;
clients, workers and replicas request creation, never reserve number ranges or
mint display ids while disconnected. UUID identity, command idempotency and
receipts remain separate from number allocation.

Promotion must raise the next number beyond both existing tickets and the
quarantined, unreplicated tail, and beyond existing
`volli/<PREFIX>-<n>[-<slug>]` branch handles. Do not recycle an abandoned number merely because the replica did not
see its ticket: humans and git refs may already refer to it. VC-591 owns that
recovery scan. A prefix change affects presentation, not ticket or workspace
identity.

## Migration 058 and implementation boundaries

- Five empty tables and three triggers, every statement `IF NOT EXISTS`.
  No existing table, index, trigger or row is altered. Registration in
  `migrations.ts` is additive; no shipped migration changes.
- The migration runs at ordinary database boot even with the flag off, through
  the existing safety-copy/verification runner. No new boot work beyond that
  migration: no identity allocation, epoch backfill, lease acquisition, network
  traffic or reads of these tables. This PR adds no active host implementation.
- Workspace-level tables: `workspace_epochs`, `checkout_leases`. Host-level:
  `host_identity`, `workers`, `devices`. No foreign key crosses that future
  file boundary (VC-588): epoch host ids and lease worker ids are UUID values;
  future services validate them. Workspace/ticket foreign keys cascade only
  within the workspace.
- Backup **bundles** include epoch history after `projects`, exclude the four
  host/live-grant tables. WAL replicas of the workspace may carry lease rows;
  they are stale on promotion and confer no right to resume execution.
- Re-running SQL preserves populated tables and all triggers. Older v57
  code can still read/write its unchanged tables in a v58 database; do not
  downgrade `user_version` or contract this schema for stable/canary switching.
  This proves ordinary open/read/write compatibility, **not backup support by
  the older writer**: v57's table list omits epoch history while its backup
  header stamps the actual schema (58). A v58 reader refuses that incomplete
  bundle; it must never infer missing epoch history is empty. Back up with the
  v58-capable build, or retain the verified pre-upgrade backup. VC-602 settled
  the downgrade/backup policy for builds from then on: a minimum reader version
  (baseline 58) refuses older-than-floor builds, and a build backing up a newer
  compatible database stamps its own head and table set. When VC-588 or
  replication moves workspace state between hosts on different builds, the
  replicated state must heal or carry the floor, exactly as bundles do under
  that rule. 058 adds no new refusal on ordinary boot
  and does not loosen restore validation to disguise a missing fence.

Open decisions are explicit: raw-profile-copy detection (host keys do not
settle it, F5); whether/how a restore
requests promotion; main-checkout lease scope; attachment lease-binding storage
and historical venue-label snapshots; control-plane CAS and offline promotion
arbitration. None is permission to enable unsafe behavior. The owner reviews
this naming contract in VC-550's PR; the implementing tickets resolve these
flows before using it.

## Open decisions for the owner

- **Key-bound identity in M2** (F5, VC-575). Keys before any device pairs, as
  specified above, or bearer device tokens for M2 and keys before M5, at the
  cost of pairing every device again. The protocol spec's
  [open decisions](host-protocol.md#open-decisions-for-the-owner) list it with
  the others from VC-630.

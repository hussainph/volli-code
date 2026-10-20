# Host, workspace and execution identity

These identity and storage contracts accompany the [host protocol](host-protocol.md).
They distinguish durable names from local locators, authority generations and
live execution. Some worker/lease storage is an additive foundation, not an
operational distributed scheduler. Code and transport tests determine which
features a host currently serves; absent capabilities grant nothing.

## Identity table

Entity ids are UUIDv4 strings allocated once, never derived from hostname, PID,
address, path or display name. Addresses locate hosts; editable names label them.
Revocation never makes an id available for reuse.

| Name / wire field | Lifetime and allocation | Storage / role |
|---|---|---|
| Host / `hostId` | One install; survives restart, not bundle restore; allocated on host use | `host_identity.host_id`; host-local, excluded from bundles |
| Workspace / `workspaceId` | One project's board, including moves/restores | Existing `projects.id`, never a second id or checkout path |
| Workspace epoch / `workspaceEpoch` | Nonnegative safe integer, never decreases | `workspace_epochs`; included in bundles; zero means no recorded authority |
| Worker / `workerId` | One registration with one host; new after wipe/revoke | `workers.id`; host-local, excluded from bundles |
| Checkout grant / `leaseEpoch` | Positive safe integer scoped by ticket; raised on each new grant, not renewal | `checkout_leases.epoch`; live grant, excluded from bundles |
| Device / `deviceId` | One client installation paired to one host; revoked record retained | `devices.id`; attribution, excluded from bundles |
| Host key / `hostKey` | P-256 key tied to host id; fingerprint is SHA-256 of SPKI DER | Public pin separate from private key; private key never in SQLite/bundles |
| Device / worker key | P-256 key tied to that registration | Private half remains on its holder |
| Session / `sessionId` | Durable Session across attachments/moves | Existing `sessions.id` |
| Attachment / `attachmentId` | One historical executor association | Attachment ledger, not checkout ownership |
| Ticket / `ticketId` | Durable ticket | Existing `tickets.id`; lease scope |
| Display number / `ticketNumber` | Permanent positive handle scoped by Workspace | Allocated only by authority; presentation, not identity |

Epochs are scoped generations, never bare durable ids. Compare them only with
their Workspace/ticket UUIDs. The singleton `host_identity.id = 1` is private,
never a wire host id. Every wire counter must pass `Number.isSafeInteger`;
overflow fails closed. SQL `INTEGER` alone does not enforce wire syntax/bounds.
See [BOUNDARIES rule 1](BOUNDARIES.md#standing-rules-review-criteria).

## Host is not installation, workspace or process

`volli:installation-id` is preserved in `app_state` bundles for provider sign-in
installation semantics. It is not an authority credential or a host id.
An update, restart, address change or new worker does not change the host id.
Moving a Workspace neither changes the source host's id nor copies it to the
destination. Workspace identity stays; its authority epoch rises, even when
promotion targets the same host.

A bundle excludes `host_identity`, `workers`, `checkout_leases` and `devices`.
Restore is a new host: pair/register again before granting execution. Epoch
history is included. A raw profile copy can duplicate host identity and key;
copy detection is not supplied by the schema. Never serve both copies as the
same host or treat successful key proof as exclusive authority.

## Workspace authority epoch

A Workspace is one project's board, not a worktree, window or multi-project
profile. Two projects may point at the same checkout and remain distinct.
`workspace_epochs(workspace_id, epoch, host_id, created_at)` has primary key
`(workspace_id, epoch)`. The current epoch is `MAX(epoch)`; no row means zero.
First validated serve records one; promotion records a strictly larger epoch
and retains history. Routine restart is not promotion. Timestamps are audit
metadata, never ordering.

History is append-only in the domain. SQL rejects updates and inserts at/below
the recorded maximum, but does not provide a general DELETE guard. Never erase
history with DELETE/REPLACE while its Workspace survives.

### Fence shared by hello and every write

Clients/workers retain the highest accepted `(workspaceEpoch, hostId)` per
Workspace UUID across reconnects and restarts:

- Lower epoch: stale authority, refuse.
- Equal epoch, equal host: reconnect to that authority.
- Equal epoch, different host: split brain, refuse both and retain conflict.
  Never choose by arrival time or UUID sorting.
- Higher epoch: accept only after authenticated authority/promotion validation,
  then retain the pair and fence the previous authority.

The host-key proof must validate against the pin before applying the fence.
A hello is not a permanent authorization waiver. A lagging replica's local
`MAX(epoch)+1` proves no global exclusivity. Promotion needs arbitration against
the latest fence and quarantines any unreplicated tail, never merges it.
Restore alone does not authorize promotion or writes. The typed fence helper is
not a control-plane compare-and-swap or durable conflict store.

## Workers and capabilities

`workers(id, name, kind, capabilities, created_at, revoked_at)` is host-level.
Reconnect keeps registration only while its local state survives. Registration
to another host has a different id; the host's co-located executor is also a
worker, not the host's id. Revoked records remain; re-registration gets a fresh id.

`kind` names process ownership, not client proximity: `local` is this authority's
co-located worker; `remote` is a user-owned outbound worker; `cloud` is a managed
sandbox worker. Advertised capabilities describe platform/runtime/git/terminal/
browser/protocol facilities, not a model registry, authorization or writable
checkout. Unknown keys grant nothing. JSON storage alone neither validates the
capability vocabulary nor schedules or authorizes workers.

## Checkout leases: one ticket, one worker

| `checkout_leases` column | Meaning |
|---|---|
| `ticket_id` | Ticket UUID / primary key; cascades on ticket deletion |
| `worker_id` | Registered holder |
| `epoch` | Per-ticket generation (`leaseEpoch`) |
| `workspace_epoch` | Authority generation granting it |
| `granted_at` | Fixed for this generation |
| `renewed_at` | Last renewal; initially grant time |
| `expires_at` | Host-clock expiry, strictly after renewal |
| `released_at` | Null while active, otherwise terminal release time |

First grant is one. Transfer, re-grant after expiry/release/revocation or a
promoted authority increments it. Renewal changes only renewal/expiry times.
Release ends it in place; deleting then granting would forget the counter.
Restore omits leases, so raising Workspace epoch before a new grant fences any
old per-ticket counter.

A write carries `(workspaceId, ticketId, workspaceEpoch, leaseEpoch)` plus the
authenticated worker id. Generations compare lexicographically, Workspace first,
and must exactly equal the live, unexpired grant. A higher claimed token is not
authorization; a Session/worker id alone grants no checkout ownership.

The UPDATE trigger rejects decreasing either epoch, changing ticket id, or
changing holder/Workspace epoch/grant time without raising lease epoch. Released
grants cannot revive in place. DELETE/INSERT and REPLACE bypass this protection
and are not valid renewal/transfer. Runtime enforcement must additionally
validate expiry, renewal monotonicity, current authority, registration and
filesystem effects, serialized through the authority transaction gate.

Execution movement requires stop writes → checkpoint reference → new lease
→ restore destination. Processes/browser sockets do not migrate. A partitioned
old worker may alter its private files, but stale publications and host effects
must be refused. Main-checkout sharing and attachment lease bindings require
explicit enforcement before worker execution uses them; a path is never a
durable checkout identity.

## Session attachment, execution venue and location

Session lifetime belongs to the ledger; at most one live executor attachment
exists per Session. Several Sessions/subagents on one ticket may share a lease;
the lease is not per Session or attachment. Attach/resume/publication must be
bound to the grant recorded for that execution, not whatever grant is current
when a message arrives. Closing a stale attachment retains Session history.

`SessionExecutionVenue {id, kind: local | remote | cloud}` identifies the worker.
Historical `unknown` is a read representation, not a valid new target.
Replacement execution has a new attachment UUID; historical venues are immutable.
With `cloud` off, `{id:"local", kind:"local"}` stays frozen in historical records.

`VenueKind` / `VenueSnapshot` (`main-checkout | worktree`) instead describes the
checkout plus git measurements. Neither implies a worker kind. `SessionLocation`
is `{directory, venue}`: directory is a worker-local locator. `prepare` refuses
materialization failure rather than falling back to the main checkout; `reaffirm`
checks the already-bound directory. Never execute a new worker against an old
worker's recovery path. The local start lease serializes materialization versus
deletion; it is not distributed ownership.

History remains readable when worker registrations were excluded by restore:
use recorded venue label or unavailable-worker fallback, never a current worker
row as evidence of historical identity or a live grant.

## Devices and pairing

A device is a client installation paired to one host, not user identity, hardware
serial, push token or account. Pairing creates a host-assigned UUID and label.
Reconnect/credential rotation retains it; pairing after revoke/restore or to
another host creates a new registration. Actors are credential-derived, never
claimed by a hello. A public device row alone grants no Workspace access.

## Keys: proof behind the names

Names remain UUIDs; keys bind names, never replace them. P-256 supports platform
non-exportable keys. Algorithm ids permit additive alternatives. Host private
keys are local, excluded from SQLite/bundles; device keys are non-exportable
where supported; wiping a worker key creates a new identity.

Pairing pins `(hostId, fingerprint)` out of band. Network-only trust-on-first-use
is not pairing. A welcome signs the client nonce, negotiated version, host id,
Workspace/epoch, actor and granted features. Verify against the pin first.
A changed key requires explicit re-pair. A Workspace moved to an unpaired host
requires pairing before access; credentials bind the issuing host.

Device/worker proof is a host challenge bound to host, principal, Workspace and
purpose, exchanged for short-lived credentials. Revocation is checked at dispatch.
Session tokens stay host-issued and attachment-scoped. Rotation needs an old-key
signed statement; lost private keys require new identity and pairing. Proof binds
a handshake, not the channel: WSS remains required outside loopback. Network
routing identity is not authorization, and copied keys do not solve copy detection.

## Operator token

No token is unauthenticated, never implicitly the person. Session-token or
`VOLLI_SESSION` evidence prevents the CLI/door from substituting operator proof.
Only hostd issues/verifies operator tokens; desktop does neither.

Root issues a 256-bit token into the operator login's own mode-0600 file. Hostd
holds a root-owned verifier (SHA-256), constant-time compared. A valid token maps
to user policy; no project policy can extend person-only verbs to a Session.
The service account cannot read the plaintext, alter the verifier/ancestors or
run the issuer. CLI sends it only to a socket name controlled by root/operator.
Removing the verifier revokes at the next request. It is a local-admin bearer
credential, not a device id. A single-user foreground deployment cannot separate
operator and Session uids. See `apps/hostd/README.md`, "Operators".

## Ticket display numbers

Only the Workspace authority calls `nextTicketNumberForProject` and creates
tickets. Clients/workers/replicas do not reserve ranges or mint disconnected
handles. Promotion advances beyond existing tickets, unreplicated tail and
`volli/<PREFIX>-<n>[-<slug>]` refs; never recycle an unseen abandoned number.
Prefix changes alter presentation, not UUID identity.

## Storage compatibility

Migration 058 added five tables and three triggers without changing existing
rows. Workspace tables are `workspace_epochs` and `checkout_leases`; host tables
are `host_identity`, `workers` and `devices`. Foreign keys stay within their
storage scope; cross-scope ids require runtime validation. Storage is not proof
of implemented promotion, scheduling, key issuance or distributed locking.

Bundles include epoch history and exclude host/live-grant tables. Replicated
lease rows confer no authority after promotion. Schema-57 backup writers omit
epoch history while stamping schema 58; readers must refuse those incomplete
bundles, never infer absent history is empty. Guarded writers instead stamp their
own supported head/table set. Preserve the minimum reader floor across backup,
restore and replication; never lower `user_version` or loosen restore validation
to conceal a missing fence.

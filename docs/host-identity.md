# Host, workspace and execution identity (maintenance)

The host model is superseded, not the Runner architecture. Do not extend it.
[CONTEXT](../CONTEXT.md#retired-terms) names the replacements;
[hostd operations](../apps/hostd/README.md) covers the remaining installs.
In this compatibility code, `workspaceId` means **project id**, not today's
team Workspace. Persisted names must not be renamed in place.

## Identity table

[Wire aliases](../packages/host-protocol/src/identity.ts) name ids;
[the identity migration](../packages/host-core/src/db/cloud-identity-migration.ts)
defines their storage. Entity ids are allocated UUIDv4s, never hostnames, paths,
PIDs or display numbers. Epochs are scoped safe integers, not identities.
The singleton SQLite row id is not the wire host id.

## Host is not installation, workspace or process

An update/restart/address change does not change host identity. Provider
installation identity (`volli:installation-id`) is separate from authority.
Bundles exclude host identity, workers, live leases and devices; restore requires
new pairing/registration. Epoch history travels with the project. A raw profile
copy can duplicate identity/key: never serve both copies as the same host or
interpret a matching key as proof of exclusive authority.

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

## Workers and checkout leases

[Migration 058](../packages/host-core/src/db/cloud-identity-migration.ts) retains
worker/lease tables and monotonic guards for old readers. Those tables are not
an implemented distributed scheduler, promotion arbiter or filesystem fence.
Do not revive the retired lease/checkpoint transfer design. A path or Session
attachment never grants checkout ownership.

## Session attachment, runner identity and location

[SessionAttachment](../packages/shared/src/session-ledger.ts) records historical
Runner provenance; its durable field is still `venue`. `LOCAL_RUNNER` stays
`{id:"local", kind:"local"}` for existing history. Historical unknown provenance
is readable, not a new execution target. A replacement attachment keeps the
Session's identity; it does not execute another Runner's recovery path.
[Session location](../packages/host-core/src/session-runtime/location.ts) refuses
failed worktree preparation rather than falling back to the main checkout.

## Keys: proof behind the names

Keys bind names; they do not replace ids or prove sole authority. SSH pinning,
short-lived device credentials, their store permissions and the current
null-welcome-proof limitation are documented under
[Enrollment over SSH](host-protocol.md#enrollment-over-ssh-vc-700).
[device-credential.ts](../packages/host-protocol/src/device-credential.ts) defines
the signed claims; [enrolled-devices.ts](../apps/hostd/src/enrolled-devices.ts)
defines verification and revocation. A changed host key needs explicit trust
recovery, never network-only silent replacement.

## Operator token

An operator token is a local-admin bearer credential, not a device id or agent
grant. Only hostd issues/verifies it. Root owns the verifier; removing it revokes
at the next request. A Session's token/environment cannot be substituted with
operator proof. Single-uid foreground installs cannot separate operator from
agent authority. Provisioning and recovery: [Operators](../apps/hostd/README.md#operators).

## Ticket display numbers

Only the project authority allocates numbers with `nextTicketNumberForProject`;
clients do not reserve disconnected ranges. Promotion must advance beyond
existing tickets, any unreplicated tail and `volli/<PREFIX>-<n>[-<slug>]` refs;
never recycle an unseen abandoned number. Prefix changes alter presentation,
not UUID identity. This is a compatibility rule, not an implemented promotion
arbiter.

## Storage compatibility

Keep the compatibility floor and shipped schema intact. Schema-57 backup
writers can omit epoch history while stamping schema 58; readers refuse that
incomplete bundle rather than infer empty history. Current guarded writers
stamp their own supported head/table set. Never lower `user_version` or loosen
restore checks to hide missing fences. Inclusion/exclusion and refusal evidence
live in [backup decisions](../packages/host-core/src/backup/decisions.ts) and
[restore](../packages/host-core/src/backup/restore.ts).

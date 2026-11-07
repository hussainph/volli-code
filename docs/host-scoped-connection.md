# Host-scoped connection (maintenance)

Superseded host transport; do not extend. Current outbound setup is in
[apps/runner](../apps/runner/README.md). This reference retains the scope,
resource and recovery boundaries of SSH-installed hostd.

## Contract

HOST hello/welcome and device credentials carry `scope: "host"`, no Workspace
id/epoch/fence. Only host-scoped device grants qualify, never Sessions or workers.
The additive `protocol.hostWelcome` bootstrap does not widen the frozen
Workspace `protocol.welcome`. Host operations refuse Workspace actors; Workspace
operations refuse HOST actors **before parsing input**. Sign-ins/callbacks/logs
are intentionally available on both scopes. Complete grammar and feature sets:
[handshake](../packages/host-protocol/src/handshake.ts),
[features](../packages/host-protocol/src/features.ts),
[workspaces router](../packages/session-rpc/src/workspaces-router.ts).

## Bootstrap and retention

A validated HOST welcome determines readiness, independently of opened projects.
Modern unavailable/ungranted operations fail closed, not through SSH. Only a
recognized older-peer handshake refusal permits the legacy path; an older user
install offers Re-add to update. Missing operations, credential failures and
network loss are not older-peer evidence. The frozen pre-host-scope exchange is
[recorded separately](../packages/host-protocol/fixtures/pre-vc722-provenance.md).

Project creation is owned by the process, not the connection: disconnecting does
not cancel accepted work. Running retries answer `still-running`; settled retries
replay their answer. Changed intent under one id is `command-conflict`. After
one hour or host restart outcomes are forgotten: re-list after `target-exists`,
never assume a retry cloned again. Registering an already tracked path returns
its existing project. Listing reports `omitted`, never clips a locator into
another path. Source, bounds and retention:
[host-workspaces.ts](../apps/hostd/src/host-workspaces.ts).

## Execution policies

The hostd process owns one service, independent of client connections. It uses
shared host-core project registration, canonical readable folder paths and the
same repository URL admission as the SSH path. User roots are created on first
clone with mode 0700, system roots with 0755; an existing root is not chmodded.
An exclusive 0700 target reservation prevents competing clones. Failed clones
remove only their still-owned target, never a replacement directory. Shared
registration announces `data-changed` after a new insert, stamping the same
board feed as `volli project add`; existing registrations and retries do not.
An announcement failure is logged without private error text; it cannot turn a
committed host registration into a retained failure or remove its clone.

- Retain at most **1,000 command outcomes**; lazily prune settled entries after
  **one hour** on create admission. Refuse new commands with `capacity` while
  the retained/running map is full. Unexpired commands remain replayable.
- Run at most **four creates** and **one coalesced catalog read** at once,
  hence at most five Git children. Over-capacity creates are not accepted or
  retained and may be retried. A connection drop does not cancel accepted work.
- Clone deadline: **10 minutes**, with **64 KiB combined child output**.
  Git receives argument arrays, disables prompts and ambient Git configuration,
  resets credential helpers, and installs only Volli's supplied stored-token
  helper for HTTPS. SSH intentionally retains the person's own `SSH_AUTH_SOCK`
  and uses `StrictHostKeyChecking=accept-new`, matching VC-710's SSH path; it is
  not limited to stored tokens. Production permits HTTPS/SSH only; file transport
  is an internal test seam. Branch Git reads have a 10-second deadline. Catalogs
  have a **10-second overall deadline** and **1-second soft row deadlines**;
  slow/unreadable rows and unvisited rows are counted as omitted. Late filesystem
  reads cannot start Git; a previous row's terminating Git child prevents another
  catalog child from starting. Create slots release in `finally`.
- Shutdown fences new work and database writes, sends process groups SIGTERM,
  escalates to SIGKILL after **250 ms**, and waits at most **3 seconds** before
  returning to runtime shutdown. A filesystem operation finishing later cannot
  register a project. The service closes before the database-owning host drains.
  Its detached-work handle observes that bounded ownership, so a hung filesystem
  promise cannot re-block the host's subsequent detached-work drain.

Capacity and shutdown values are implementation defaults, not new durable
guarantees. No schema migration or persistent outcome map is added.

## Compatibility and resource bounds

The client shares 24 physical permits across HOST + Workspace + Add links,
including retiring sockets. Permits release only on physical close; reconnects
cannot overlap their own retiring socket. Hostd's 32-connection limit and
544 MiB worst-case queue envelope are unchanged; see
[Enrollment bounds](host-protocol.md#enrollment-over-ssh-vc-700).

## Desktop routing

[Main's relay](../apps/desktop/src/main/host-link-relay.ts) addresses `hostId`,
checks procedure kind, validates source admission before forwarding, and
validates every public answer/yield before IPC. Invalid output fails whole;
unsafe names/paths are not truncated into new identities. Sign-ins remain
connection-owned and outside generic relays. Catalog readiness is not Session
readiness: chat creation requires the project's Workspace `sessions` grant.

Models/defaults use a separate closed-output `host.model-defaults` feature;
see [model maintenance](host-model-defaults.md). Public compatibility checks and
recorded old-peer provenance remain required; these desktop relays are
bundle-scoped, not frozen public features.

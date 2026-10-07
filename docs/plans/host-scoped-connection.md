# Host-scoped connection (VC-722)

PR A extends protocol v1 without changing a Workspace hello, welcome, actor,
credential serialization or frozen feature. PR B owns the desktop lifetime and
routing and is gated on VC-719 and VC-720.

## Contract

A host hello is `{scope:"host", protocol, client, features, credential, nonce}`.
It has neither `workspaceId` nor `lastSeen` (even null is invalid). Only a
host-scoped device grant admits it. Its welcome is
`{scope:"host", protocolVersion, host, actor, features, proof}`, with actor
`{kind:"device", deviceId, scope:"host"}`. There is no Workspace authority,
epoch or fence. Version, feature subset and host-key proof validation still
apply. A Session or worker cannot get host scope.

The additive `vdc1` claims are `{scope:"host", hostId, deviceId, iat, exp, jti}`,
with no `workspaceId`, signed identically to Workspace claims. Enrollment,
revocation, lifetime, single-use jti and restart replay rules are unchanged.
The enrollment-neutral verifier port accepts both presentations. The current
SSH enrollment grants every Workspace on the host and hence host scope.

Only host catalog entries are reachable, still under their own actor policy.
A Workspace operation is `FORBIDDEN` / `workspace-scope-required` before input
parsing or handler invocation. Host-scope feature grants are restricted to
`sign-ins`, `auth.callback`, `host.logs`, `host.workspaces`.

The new frozen `host.workspaces` feature grants exactly:

- `workspaces.list()` → `{workspaces, omitted}`. Rows are
  `{id, name, path, gitRemoteUrl}`; remote URL is sanitized or null. At most
  500 rows; name 512, path 4096, remote URL 2048 characters. Id is UUIDv4;
  omitted is a nonnegative safe integer.
- `workspaces.create({commandId, source, name?})`, with UUIDv4 command id and
  strict source `{path}` or `{gitUrl}` → `{ok:true, workspace}` or
  `{ok:false, failure:{code, message}}`. Message is sanitized and at most
  512 characters. Every result enum and union is closed. Failure codes are
  `invalid-source`, `path-unreadable`, `target-exists`, `clone-failed`,
  `clone-timeout`, `registration-failed`, `still-running`, `interrupted`,
  `capacity`. A different intent under the same command id is
  `CONFLICT` / `command-conflict`.

## Decisions confirmed (owner, 2026-10-07)

- **Bootstrap:** host scope reads `protocol.hostWelcome`, a new door-local
  query. The existing `protocol.welcome` has a frozen Workspace-only output
  schema; broadening that output would break the additive gate and its N−1
  parser. Keep the old operation and Workspace bootstrap set untouched,
  rather than weaken the gate or introduce a dummy Workspace. A host
  connection gets the new bootstrap regardless of requested features.
- **User projects root:** `~/volli`; system installs retain `/srv/volli`.
- **Listing:** report `omitted` rather than hide a truncated catalog. An
  unrepresentable locator is omitted, not clipped into a different path.

- **Command outcomes:** a bounded process-owned map; no migration. A running
  clone reports `still-running`, and a completed retry answers the exact same
  result. Reusing a command id with another intent is `command-conflict`.
  Outcomes do not survive a hostd restart: retrying a clone then finds its
  existing target and answers `target-exists`; the client re-lists, never
  silently clones again. Registration of an already tracked path returns its
  existing Workspace through the shared host-core path.

## Execution policies (for owner review)

The hostd process owns one service, independent of client connections. It uses
shared host-core project registration, canonical readable folder paths and the
same repository URL admission as the SSH path. User roots are created on first
clone with mode 0700, system roots with 0755; an existing root is not chmodded.
An exclusive 0700 target reservation prevents competing clones. Failed clones
remove only their still-owned target, never a replacement directory.

- Retain at most **1,000 command outcomes**, without eviction; refuse new
  commands with `capacity` at the limit. Existing commands remain replayable.
- Run at most **four creates** and **one coalesced catalog read** at once,
  hence at most five Git children. Over-capacity creates are not accepted or
  retained and may be retried. A connection drop does not cancel accepted work.
- Clone deadline: **10 minutes**, with **64 KiB combined child output**.
  Git receives argument arrays, disables prompts and ambient Git configuration,
  resets credential helpers, and installs only Volli's supplied stored-token
  helper. Production permits HTTPS/SSH only; file transport is an internal
  test seam. Catalog/branch Git reads each have a 10-second deadline.
- Shutdown fences new work and database writes, sends process groups SIGTERM,
  escalates to SIGKILL after **250 ms**, and waits at most **3 seconds** before
  returning to runtime shutdown. A filesystem operation finishing later cannot
  register a project. The service closes before the database-owning host drains.
  Its detached-work handle observes that bounded ownership, so a hung filesystem
  promise cannot re-block the host's subsequent detached-work drain.

Capacity and shutdown values are implementation defaults for owner review, not
new durable guarantees. No schema migration or persistent outcome map is added.

## Stack and verification

PR A is draft [#838](https://github.com/hussainph/volli-code/pull/838). The owner
approved the additive contract at `bb272ad5b` while GitHub refused pushes
repository-wide. Hostd execution and signed-device real-link acceptance are now
implemented; final coverage, CI/CodeQL and security review remain merge gates.
PR B is not pushed until the owner confirms VC-719 (#836) and VC-720 (#835) have
merged.

N−1 refuses the new hello (`hello-invalid`); the client classifies this only
while attempting host scope and keeps the SSH catalog/create path and
Workspace-borrowed sign-ins/logs. An older user install says
“Update <host> to create projects from here”, recovered through Re-add.

One host link consumes the same budgets as a Workspace link: for H connected
hosts and W Workspace links the desktop uses H + W ≤ 24 sockets. On a box,
every Mac's host link and Workspace links together use ≤ 32 listener sockets.
The listener's worst-case 32 × 17 MiB = 544 MiB queue envelope is unchanged.

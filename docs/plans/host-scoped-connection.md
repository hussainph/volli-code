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
`sign-ins`, `auth.callback`, `host.logs`, `host.workspaces`. Conversely,
`host.workspaces` is never offered/granted to Workspace connections, and
`workspaces.*` refuses Workspace actors before input parsing. Sign-ins, logs
and callbacks intentionally remain available on both connection scopes.
Host bootstrap proof fields alone are bounded to scheme 128 / value 8192 UTF-16
code units; scheme is an open reserved vocabulary. Workspace proofs are unchanged.

The new frozen `host.workspaces` feature grants exactly:

- `workspaces.list()` → `{workspaces, omitted}`. Rows are
  `{id, name, path, gitRemoteUrl}`; remote URL is sanitized or null. At most
  500 rows; name 512, path 4096, remote URL 2048 characters. Id is UUIDv4;
  omitted is a nonnegative safe integer. Whole-row selection also caps the
  UTF-8 JSON answer at 2 MiB minus 64 KiB of framing headroom; every excluded
  row counts toward omitted. Equal sort orders use creation time then id.
  Names reject control and Unicode line/paragraph separators; unsafe catalog
  names/paths are omitted.
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
  Settled outcomes expire one hour after settlement; running commands never
  expire. Outcomes also do not survive a hostd restart. Outside that retention
  horizon, an expired/unknown id reruns naturally: retrying a clone finds its
  existing target and answers `target-exists`; the client re-lists, never
  silently clones again. Registration of an already tracked path returns its
  existing Workspace through the shared host-core path.

## Execution policies (for owner review)

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

Capacity and shutdown values are implementation defaults for owner review, not
new durable guarantees. No schema migration or persistent outcome map is added.

## Stack and verification

PR A is draft [#838](https://github.com/hussainph/volli-code/pull/838). The owner
approved the additive contract at `bb272ad5b` while GitHub refused pushes
repository-wide. Hostd execution and signed-device real-link acceptance are now
implemented; final coverage, CI/CodeQL and security review remain merge gates.
VC-719 (#836) and VC-720 (#835) have merged. PR B stays paused/unpushed until
PR A merges and the owner permits resumption.

The actual pre-VC-722 main listener at `2323b19dac96eea3a9d77e512c1fadbccdc8f34c`
returned `BAD_REQUEST / hello-invalid`, then closed 4400 / `hello-invalid`.
Its unmodified recordings and actual old Workspace-client/new-host evidence
are documented in `packages/host-protocol/fixtures/pre-vc722-provenance.md`.
The grammar-only fixture is not an independent peer exchange. New exchange
recordings at the canary tag are T6's separate ceremony, not PR A evidence.
The client classifies the frozen named refusal only
while attempting host scope and keeps the SSH catalog/create path and
Workspace-borrowed sign-ins/logs. An older user install says
“Update <host> to create projects from here”, recovered through Re-add.

One host link consumes the same budgets as a Workspace link: for H connected
hosts and W Workspace links the desktop uses H + W ≤ 24 sockets. On a box,
every Mac's host link and Workspace links together use ≤ 32 listener sockets.
The listener's worst-case 32 × 17 MiB = 544 MiB queue envelope is unchanged.

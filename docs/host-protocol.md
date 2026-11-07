# Host protocol v1 (maintenance)

The SSH-installed hostd transport remains behind `cloud`, but is superseded by
outbound Runners calling the backend. Do not extend host installation,
enrollment, leases or transport. Current runner setup is in
[apps/runner](../apps/runner/README.md); the remaining hostd install, rollback,
operator and device-revocation procedures are in
[apps/hostd](../apps/hostd/README.md) and the [box runbook](runbooks/hostd-box.md).
Code and tests define what is implemented, not an old transport design.

## Handshake and capabilities

[handshake.ts](../packages/host-protocol/src/handshake.ts) defines the supported
breaking version range. [features.ts](../packages/host-protocol/src/features.ts)
is the complete feature/operation table: a shipped feature's membership is
frozen; additive operations require new names. A capability advertises transport
support, never actor authority. Missing features grant nothing.

Every reconnect sends a fresh nonce and credential and validates its welcome
before making calls or resuming subscriptions. Workspace identity, granted
feature subset and [authority fence](host-identity.md#workspace-authority-epoch)
are checked. Host-key proof is reserved (`null`) in this deployment; the SSH
tunnel authenticates the host. A claimed UUID or loopback address is not proof.
See [welcome validation](../packages/host-protocol/src/welcome.ts) and
[client link](../packages/host-protocol/src/client-link/index.ts).

### The listener (VC-663)

The [WebSocket listener](../packages/session-rpc/src/websocket-server.ts) authenticates
before dispatch and checks admission again after awaited authorization and
before returning a successful answer. Revocation ends streams. Invalid
credentials never become a user; unavailable services fail explicitly.
[hostd's composition](../apps/hostd/src/host-protocol.ts) owns its smaller bounds;
the generic listener's defaults are not hostd's memory budget.

### The client host link (VC-670)

Calls while disconnected fail; an in-flight mutation lost with its connection
has an unknown outcome and is **not resent**. Explicit retries use the same
`commandId`. Aborting a call is not rollback. Subscriptions resume only after a
validated welcome. `subscription-resnapshot-required` means re-read the snapshot
and subscribe from its cursor; it is not clean completion.

| Link state | Recovery |
| --- | --- |
| `connecting` | Handshake in flight. |
| `ready` | Validated welcome; calls and streams flow. |
| `unreachable` | Transient failure; link retries, or wake/retry reconnects. |
| `refused` | Credential, version or welcome refused; explicit recovery/reconnect. |
| `fenced` | Authority moved or split brain; retain the conflict, do not choose a host by arrival order. |
| `closed` | Final; the caller closed it. |

During handshake, 4401 means `credential-invalid`; 4400 names the refusal
(`workspace-epoch-fenced` / `workspace-split-brain` becomes `fenced`). After
readiness, 4401 reconnects with a fresh credential. 4413 means
`response-too-large`; other lost connections mean `host-unreachable`.
A stalled handshake can close 4408. The connection UI keeps last-known data
readable but disables writes for offline/incompatible projects; it never uses
another project's readiness as authority. Mapping and timing live in
[host connection store](../apps/desktop/src/renderer/src/stores/host-connection.ts).

### Tracing and logs (VC-699)

Logs are redacted diagnostics, not Session history. `logs.tail` returns a bounded
page and cursor; `logs.follow` resumes from it. `gap: true` means eviction,
restart or byte-budget omission, never a complete history. The ring holds at
most 10,000 lines / 8 MiB. Remote access is person-only (`host.logs`), never an
agent tool or CLI verb. Bounds, trace propagation and redaction are defined by
[host-core/log](../packages/host-core/src/log/) and
[the log router](../packages/session-rpc/src/index.ts).

## Host-owned Session follow-ups (VC-675)

Queue intent is durable before delivery, distinct from a device's unsent draft.
`expectedRevision` conflicts change nothing; already-accepted command ids replay
their original reply. Edit refuses a releasing row; withdrawal cannot undo proven
delivery. Queued Steer claims the canonical payload, never cancel-then-send.

Recovery automatically dispatches at most once. If intent exists without
conclusive acceptance, the host retains it and asks: **“This follow-up may have
been delivered. Check the transcript before resending.”** Withdrawal after
inspection never automatically resends. A current-build backup preserves the
queue; an older guarded writer omits newer tables. Use a current-build backup
when pending follow-ups matter. Legacy renderer-held messages recover as visible
unsent rows, never silently sent. The implementation and evidence rules are in
[session-follow-ups](../packages/session-engine/src/session-follow-ups.ts).
Recovery refuses more than one releasing entry rather than guessing. Pending
rows can still release after an N−1 downgrade: older writers leave no last-writer
marker, so timestamps cannot establish that a pending row is unsent.

## Host-scoped connection (VC-722)

A HOST connection has no Workspace authority. Its additive hello and bootstrap
never widen the frozen Workspace grammar. See the
[scope and compatibility reference](host-scoped-connection.md).
The desktop shares 24 physical permits across HOST, Workspace and Add links,
including sockets still closing; hostd allows 32 across all clients. A project's
“Too many projects open” is a capacity refusal, not lost project data.

## Auth and workspace authorization

Actors are credential-derived, never chosen by a hello or supplied Session id.
A paired device maps to user policy; workers are refused by current catalog
policy. The desktop's local device identity cannot be minted by a network
verifier. Every resource lookup checks Workspace ownership; absent and foreign
ids both answer `NOT_FOUND` / `workspace-unknown`. Policy refusal is
`FORBIDDEN` / `verb-refused`. Runtime validation is not authorization. See
[catalog actor policy](../packages/shared/src/catalog-actor.ts) and
[catalog middleware](../packages/session-rpc/src/catalog.ts).

### Enrollment over SSH (VC-700)

The user-facing [Cloud threat model](../SECURITY.md#cloud-threat-model) describes the trust boundaries for a compromised box, a compromised renderer, and an agent on the box.

The first accepting verifier. A host added over SSH (VC-615 flow 1) is paired over the same SSH channel the desktop installed it through: no code is shown. Pairing by code (VC-575) stays the path for hosts installed another way and for phones; a hosted control plane's account-issued key is a third. All three write the same fact (a device's public key, trusted by this host) and are read by verifiers behind the same enrollment-neutral port.

- **Enrollment.** The desktop runs `volli-hostd enroll --system|--user --public-key <P-256 SPKI, base64url> --name <label>` on the box: `--system` **as root** (sudo), `--user` as the login hostd runs as. It adds the key to the host's enrolled-devices store under a host-allocated UUIDv4 `deviceId` (public keys only, host-level, never in a backup, every update under a lock beside the store) and answers `{hostId, deviceId, fingerprint}`. Idempotent per key; a revoked key enrolled again is a new device. `volli-hostd devices list` shows the store without keys; `devices revoke <deviceId>` sets `revokedAt` (as root on a system install). VC-575 may fold the store into the `devices` table; the verifier port is the seam.
- **Where the store lives is the trust boundary.** An enrolled device acts as the person (`user`), so whoever can write the store can mint a person, the operators file's rule (VC-623):
  - *System install:* hostd and every Session run as `volli`, so the store is root's `/etc/volli-hostd-devices` (0644, beside `/etc/volli-hostd-operators` and outside the data directory `volli` owns). The managed unit passes it as `--devices`; hostd only reads it, believes it only while it is root's and writable by no one else in a directory chain only root controls (else boot is refused, `devices`, and a store that turns unsafe later admits no one), and `enroll --system` refuses anyone but root. An agent can neither enroll itself nor plant a key.
  - *User install:* hostd and its agents run as the person's own login (the desktop says "agents share your account"), so the store is `<dataDir>/enrolled-devices.json` (0600). That login is the person.
- **Why SSH access is enough** (the trust argument):
  1. *The box is authenticated.* The desktop's ssh checks the box's SSH host key against the person's known_hosts with `StrictHostKeyChecking=yes`; an unknown key is shown by fingerprint and trusted only when the person accepts it (never `accept-new`). So the `hostId` that comes back is this box's, and the key that goes in reaches this box unaltered. The desktop pins that `hostId` as it would pin a host key from a pairing code.
  2. *Only the person can enroll.* On a system install, enrolling needs root on the box: authority the person holds (they just installed hostd with it) and no agent does, since agents run as `volli`. On a user install it needs the login hostd runs as, which is the person's own: enrolling as it grants nothing that login did not hold, as it could already add an SSH key for itself. Either way, being able to act as the account agents run as is never enough on a system install.
  3. *Only a public key crosses.* The device's private key never leaves it; the credential it signs is short-lived and single-use, so a transcript of the channel admits no one.
  Until VC-575 signs the welcome (`proof` stays `null`), the client's assurance that it reached this host comes from the transport: the default route is an `ssh -L` tunnel to the host's loopback listener, which the same host key authenticates.
- **The credential** (`vdc1`, `@volli/host-protocol` `device-credential.ts`): `vdc1.<base64url(JSON {hostId, deviceId, workspaceId, iat, exp, jti})>.<base64url(ECDSA P-256 SHA-256, IEEE P1363)>`, signed over the ASCII of `vdc1.<claims>`. The device mints one per handshake (the link asks its credential provider on every connect). The verifier (`apps/hostd/src/enrolled-devices.ts`) admits it only when it names this host and the hello's Workspace, `exp - iat ≤ 300 s` and now is inside it (60 s skew), it was issued no earlier than the verifier started (`iat` ≥ start: the `jti`s it remembers live in the process, so a credential from before a restart is refused rather than replayable; the client mints a fresh one, and a client clock behind the host's waits out the difference), the `jti` was never seen (remembered until it would have expired; past 10,000 live ones it refuses rather than forgets), the device is enrolled and not revoked, and the signature verifies under the enrolled key. The grant's actor is `{kind: "device", deviceId, workspaceId}` and its `current()` stays true while the device stays enrolled, so revocation (the entry removed or `revokedAt` set) closes its connections at the door's next check. Example: `vdc1.eyJob3N0SWQiOiIwZjZh…In0.MEUCIQ…` admits device `1f6a…` into Workspace `2f6a…` on host `0f6a…`, once.
- **Scope.** An SSH-enrolled device is the operator's own Mac, so it may connect to every Workspace on the host, one authorized connection per Workspace (the credential binds the one it is for). It is a paired device for policy: `user`.
- **Listener bounds** while this is hostd's only verifier (`HOSTD_LISTENER_LIMITS`, `apps/hostd/src/host-protocol.ts`): at most **32 active client connections per host, including host-scope connections** (host-wide, across every Mac: a client holds one per Workspace, and the desktop opens every project a host serves), a burst of 32 handshakes then 16 a second, 4 streams each, 2 MiB frames, 1.5 MiB / 4,096-event resumes, 4 MiB unsent per connection, 1 MiB inbound frames. Worst case, every connection full at once: 32 × (4 MiB + 4 × 2 × 1.5 MiB staged + 1 MiB) = **544 MiB** of listener queues, replays and inbound frames (not the whole process heap), against the defaults' theoretical ~260 GiB. A host-wide byte budget in place of the per-connection bounds is deferred (VC-575, VC-705). A larger answer is refused whole (`response-too-large`; `session.history` pages) and a larger resume re-reads its snapshot. The bind is a **literal** loopback address (`127.x.y.z`, `::1`; not `localhost`, which a resolver could point elsewhere): `--listen` and hostd's composition of this verifier each refuse anything else, and the listener itself refuses any non-loopback address. A test names each.
- **Mac managed hosts start at login, not at boot.** A Mac's host is the person's launchd agent (`user/<uid>`), so after the Mac restarts it is down until that account logs in. hostd's `status --json` reports `startsAt: "login"` (`"boot"` for a system unit or a lingering user unit), and the add-a-host checklist says "Starts when you log in to <host>" (`describeStartup`). No-login startup is not provided by this user-agent layout. Sessions on a Mac host run git with every credential helper reset and prompts off, so the login keychain is never asked.
- **Accepted exception: commit-boundary revocation (restricted deployments only).** A revocation closes a device's connections at the door's next check and refuses any call not yet past the resolver, but a call already inside a facade (a `sessions.create` awaiting skill resolution) can still commit after the device is revoked. Until commit-boundary revocation is enforced, deployment is restricted to a single-user host behind `cloud`, bound to loopback and reached through that user's SSH tunnel. Do not expose this verifier off loopback or to other users while that limitation exists.


### Remote hosts on the desktop (VC-700)

[host-install](../packages/host-install/README.md) owns SSH provisioning and
recovery. Re-add enrolls a new device; revoke the old device on the host. Volli
never replaces a changed SSH host key. An unreadable/newer remote-host registry
is read-only rather than overwritten. Cancel wins until the registry commit;
after that, use Forget. Quitting cancels flows and reaps owned SSH processes
under the engine's bounded shutdown.

Only the precisely classified older-peer handshake refusal enables SSH project
fallback. Generic network/auth failures or missing modern grants fail closed;
an older user install offers Re-add to update. Host readiness is a validated
HOST welcome, not an SSH probe or another Workspace's connection.

### The Workspace link relay (VC-711)

The renderer borrows main's link; it receives no credential or device key.
Queries/mutations are sent once, never queued. The relay validates operation
kind and public outputs before IPC. Sign-ins/callbacks have a dedicated flow,
not generic forwarding. Per-link stream bounds (four), global relay bounds
(256) and priority/yield recovery are enforced in
[host-link-relay.ts](../apps/desktop/src/main/host-link-relay.ts); a log source
can fall back to bounded tail reads when a stream is unavailable.

### The HOST link relay (VC-722)

The analogous [HOST relay](../apps/desktop/src/main/host-link-relay.ts) addresses
`hostId`, never fabricates a Workspace, and checks kind, source admission and
output schemas. Modern unavailability does not silently select SSH.

## Command catalog (F3)

The catalog and sealed handler map also serve **flag-off local desktop**; they
are not retired with this network transport. [BOUNDARIES](BOUNDARIES.md) carries
the standing rules. Definitions and rationale live beside the code:

- [Verb Registry](../packages/shared/src/verb-registry.ts): catalog, actor,
  resource scope and idempotency declarations.
- [Catalog builders](../packages/session-rpc/src/catalog.ts): authorization
  before parsing/resolving, response validation and JSON-safe payloads.
- [Handler map](../packages/host-core/src/handlers/host-handlers.ts): one command
  behind every door, invoked only through a policy-checked map.
- [Desktop entries](../packages/shared/src/desktop-entries.ts) and
  [desktop router](../packages/session-rpc/src/desktop-router.ts): host commands
  retain additive compatibility; client-local entries ship with their caller.
- [JSON safety](../packages/host-protocol/src/json-safe.ts): compile-time checks
  cannot prove opaque classes/`unknown` safe; runtime validators still apply.

### Committed schema and compatibility gate (VC-669)

Regenerate with `pnpm generate:protocol-schema`; check with
`pnpm check:protocol-schema -- --base origin/main` (or the actual PR base SHA).
The [generator](../scripts/protocol-schema/generate.mjs) and
[compatibility checker](../scripts/protocol-schema/compatibility.mjs) define the
gate. Public and desktop host-command changes are additive only; client-local
changes are report-only, not a way to reclassify a frozen host command.
Output enums are closed unless their existing reader explicitly tolerates
unknowns. Mark that scalar open **before publication**, not alongside expansion.
A breaking version bump alone is not a waiver: exact paths and explanations go
in the [compatibility allowlist](protocol/compatibility-allowlist.json).

## Workspace change feed (F1)

The superseded protocol calls a project a Workspace. Its cursor is delivery
order, not cross-Session ledger order. Changes name state, never deltas; resume
from the cursor or resnapshot explicitly on a gap. The stamp/resume/byte-bound
contract is defined in [board/change-feed.ts](../packages/host-core/src/board/change-feed.ts).
Session snapshot/history and tracked subscriptions are defined in
[session-engine](../packages/session-engine/src/) and
[the Session router](../packages/session-rpc/src/index.ts).

## Binary framing

Bulk bytes must stay separate from JSON control traffic, never base64-expanded
into it. No generic binary codec/listener or `VLB1` wire ships. Current screencast rules
are [screencast.ts](../packages/host-core/src/browser/screencast.ts): latest whole
frame wins, sequence is attachment-local, encoding/dimensions are attach
metadata, never embedded in image bytes. Terminal retained tails are not a
serialized emulator screen or a claim of resumable live processes. Do not infer
implemented bulk transports from a transport design.

## Host operations vs client-local

Classify by effect ownership, not which machine called. Durable state and
runner-owned resources follow their authority; native presentation stays on the
viewing client. There is no generic “execute on client” RPC. The typed inventory
is [IPC placement](../apps/desktop/src/ipc/placement.ts) and
[app-state keys](../packages/shared/src/app-state-keys.ts).

| Surface | Client-local | Host operation |
| --- | --- | --- |
| Theme | Appearance resolution and CSS | No theme-rendering RPC; shared preference requires explicit classification. |
| Update | Desktop updater/install/relaunch | Hostd version/capabilities; SSH installs an exact-match artifact. |
| Reveal | Finder only for an actual local locator | Resolve metadata; never send a remote path blindly to Finder. |

Reveal's same-machine assurance cannot come from a loopback peer address: an SSH
tunnel can terminate there. Current client capability ports and their limitations
are in [ports/client.ts](../packages/host-core/src/ports/client.ts); a future
per-connection API is not evidence that it exists today.

### Sign-ins on a host (VC-702)

Keys and Git credentials travel Client → host **write-only**; status returns
availability, never values. Subscription login runs on the host and is approved
in the person's browser. Never copy OAuth grants across machines: rotating
refresh tokens would sign one out. [Host sign-ins](../packages/host-core/src/host-sign-ins/)
and [desktop flows](../apps/desktop/src/main/host-sign-ins/) define this path.

A flow belongs to its starting physical connection, is undiscoverable from
another, and ends on connection loss; it never resumes after reconnect. Cancel
ends the local run immediately and cancels remotely when its id is known.
Replacement waits for the old flow to end. A callback grant is single-use,
flow/connection/path-bound and replays only to that flow's loopback listener;
the client learns a status, not a token. No callback grant means pasted-code
recovery. Relay binding is bounded to ten minutes, a run to thirty minutes.
Old peers without the features cannot be probed into supporting them.

File modes protect against **other uids**, not Sessions running as hostd's uid.
Structured read guards are not a shell sandbox: an agent can read what Git can.
The command-scoped Git helper answers for any repository/operation on the stored
HTTPS host, not just push; use a repository-scoped token for that restriction.
Nothing writes credentials to remote URLs or repository Git config. An expired
sign-in raises `auth_required`; re-sign-in is explicit recovery. See
[credential storage and redaction](secrets.md).

## Contract harness

[host-protocol/testing](../packages/host-protocol/src/testing/index.ts) and desktop
`session-rpc-contract.test.ts` exercise the real IPC codec and WebSocket
listener. Test both skew directions, command replay/conflict, scope denial,
tracked resume/resnapshot and refusal envelopes; a direct-router fake is not
transport proof. The handler projection tests cover every door's policy path.

### N−1 public wire recordings (VC-669)

`apps/desktop/src/main/session-rpc-wire-fixtures/n-minus-one.json` and `current.json` pin application-wire requests/responses (transport-local request ids are omitted): `session.projection` and `session.snapshot` queries, `session.command` with a stable command id/retry, tracked `session.subscribe` frames with a resume cursor, and a `workspace-unknown` reason envelope. `session-rpc-wire-compatibility.test.ts` runs **old client × new host** and **new client × old host** over both the real Electron IPC bridge/client link and loopback WebSocket adapters. The old peer's parser/router is frozen separately in `session-rpc-n-minus-one.test-support.ts`; it never imports today's catalog builders, output validators or renderer codec. New-client cases validate old-host output with today's published schemas; old-client cases use the frozen consumer parser.

Initial provenance is the pre-VC-669 HP-capable main revision `4c712841ae777dcc178d10552e7b0052fa905b81`, not a claim that the released v0.2.1 hostd serves HP. The frozen peer is a reconstructed representative four-operation subset, not a historical hostd binary. Pre-HP releases cannot participate. `handshake.test.ts` covers all four old/new desktop × hostd cells, negotiated feature subsets and incompatible protocol ranges in both skew directions; DB skew stays in VC-633's separate lanes.

**The first distributed HP peer is `v0.3.0-canary.1` (VC-727).** From canary.2 onward, canary.1 is N−1 until the support window explicitly advances. Before its bundle exists, skew tests retain the reconstruction above; that fallback is not evidence about a distributed canary. Pre-HP releases are not wire peers.

**Capture at the release commit:** `node scripts/record-canary-peer.mjs --tag <release-tag> --commit <full-commit> --out <bundle-path>` captures the committed public protocol schema, including output validators, and representative board, queue, history, sign-in and Session listing exchanges through real transport adapters over deterministic host fixtures. It never reconstructs a release later from today's router, copies expected outputs into a live host, or freezes client-local desktop entries. The bundle and each recording identify the tag, exact commit and production path used to produce it. Host-scoped recordings are included: the bundle also records `protocol.hostWelcome`, `workspaces.list` and `workspaces.create` through a real host-scoped handshake and listener, including a same-command create retry and list after create. A missing or incomplete host-scope recording fails capture rather than silently omitting that surface. These exchanges are WebSocket-only, not new desktop IPC exposure.

The release workflow's **advisory** capture job checks out the same resolved commit as hostd packaging. Every dry run exercises capture and retains `canary-peer.json` as an Actions artifact (90 days), with a `dry-run-<commit>` provenance label, without publishing. Dry-run bundles prove capture wiring; they are not distributed N−1 releases. A real prerelease attaches the bundle to its existing GitHub Release **after** desktop artifact publication. Capture/attachment failure never gates or changes release cutting; inspect the advisory step and recover a failed capture at that same tag before admitting its successor. Release re-runs preserve a previously attached peer asset, never replacing an immutable tag's bundle; attempt-specific Actions artifacts prevent re-run name collisions. The packaged desktop separately has a failing gate against any `e2e/` path, inside `app.asar` or alongside it, so volli-drive's fake provider and sshd fixture cannot ship merely because a whitelist used to exclude them. The same gate runs on ordinary PR CI's unsigned packaged app before core e2e, proving the actual artifact path before any signed canary cut.

**Adopt the peer before the successor:** download `canary-peer.json` from the canary release, review its provenance, and commit it at `apps/desktop/src/main/session-rpc-wire-fixtures/canary-peer.json` in a dedicated PR; `VOLLI_CANARY_PEER_BUNDLE` can select a bundle for a focused check. Desktop and board skew tests prefer that recorded peer when present and fall back only when absent; an invalid present bundle fails rather than silently using the reconstruction. Run both desktop × hostd skew directions through both adapters, board skew, and `pnpm check:protocol-schema --base <release-commit>`. Never overwrite an old bundle to make a breaking change green. Keep command ids and resume cursors stable; add a fixture before promoting another public operation/feature. Sign-ins (VC-702) have their own pair, `apps/desktop/src/main/sign-ins-wire-fixtures/{current,n-minus-one}.json`, run by `sign-ins-wire-compatibility.test.ts`: the operations are WebSocket-only, so it records through the production listener alone. `current.json` holds status, a key sent write-only, a device-code flow, a relayed browser flow with its delivery, a refusal, and what an older Client is granted. `n-minus-one.json` remains the bootstrap pre-VC-702 reconstruction, not a distributed release: it offers neither feature, and VC-669's frozen peer answers an operation it never had with `NOT_FOUND`. The Session listing (VC-713) has its pair too, `apps/desktop/src/main/session-listing-wire-fixtures/{current,n-minus-one}.json`, run by `session-listing-wire-compatibility.test.ts` through the production listener over host-core's real handler map: a Workspace's rows (a Session waiting on a question, an idle chat with its model, a terminal companion), one ticket's, a foreign ticket refused, and what an older Client is granted; `n-minus-one.json` is a representative pre-feature peer (main before VC-713, not a shipped release; the frozen VC-669 router answers the unknown operation, and the old peer's welcome is synthesized), which offers no `sessions.listing`. These legacy pairs remain fallback coverage until the recorded release bundle is adopted. Never refresh old fixtures just to make a breaking PR green: a supported peer remains frozen until the declared support window moves. Desktop-only bridge entries receive the schema diff, not this public-tier fixture ceremony.

## Host/browser compatibility requirements

The desktop provisions and upgrades an exact-match hostd over SSH. Handshake
version negotiation is a compatibility safety net, not artifact discovery.
The Mac desktop hosts in Electron main and retains its native browser backend;
remote hostd uses standalone Chromium behind the `BrowserBackend` seam.

**Parity bar.** Remote browser capabilities must preserve tool results and refusals
across backends. Backend-parameterized tests cover the shared tools. A person-facing
remote view must support pointer, scroll, keyboard/text/IME, clipboard,
navigation and browser-hold handoff, with effect-frame p95 at most 100 ms and
at least 30 frames/s while the page changes. Do not enable a viewer that cannot
meet its interaction contract; a same-machine lent desktop view requires an
explicit attachment, not a silent executor fallback.

**Known Chromium frame limit:** same-process `data:`, `blob:` and `srcdoc`
iframes can run because they issue no intercepted network request. Document
requests and redirects, including out-of-process frames, are guarded before
HTTP(S) navigation; main-frame external schemes are refused. These inner frames
gain no privilege beyond the page (`blob:`/`srcdoc` share its origin, `data:` is
opaque), but differ from desktop's stricter navigation guard. Preserve the
`chromium-backend.test.ts` frame cases. Before people use hostd’s browser, enforce
the iframe-navigation rule or retain the explicitly attached lent-view fallback.
Never claim a network
interceptor refuses an in-process document it cannot observe.

# Host protocol v1

**Status:** owner-review draft, VC-549 (M0); production transport is VC-564. The first listener is VC-663's ([The listener](#the-listener-vc-663)): `@volli/session-rpc/websocket`, which hostd serves on loopback behind `cloud`, refusing every credential until VC-575/VC-577 supply verifiers. [Volli Cloud](volli-cloud.md) is the ruling; [host identity](host-identity.md) (VC-550) owns identity lifetimes and persistence. With `cloud` off, today's app is unchanged.

**Revised by VC-630** (architecture review, 2026-10-04: lens A, industry comparison; lens C, the composition root), before VC-564 sets the router pattern the M2 areas copy. Tags name the finding each change answers:

- **F1** a resumable Workspace change feed;
- **F2** a Client scoped to its connection;
- **F3** one command catalog, many projections;
- **F4** complete, workspace-addressed host events;
- **F5** host and device identity bound to keys ([host identity](host-identity.md#keys-proof-behind-the-names));
- **F6** terminal resync.

## Decisions

| Decision | Choice | Reason | Precedent / code reused |
|---|---|---|---|
| Control transport | tRPC v11 over WebSocket, default JSON, no transformer | One router and typed client for commands, queries and events; loopback exercises the remote path | `packages/session-rpc/src/index.ts`; stock `applyWSSHandler`; a configured `wsClient` inside the [client host link](#the-client-host-link-vc-670) (VC-670), never stock `wsLink` defaults |
| `ws` dependency | A production dependency of `@volli/session-rpc`, imported only by its `/websocket` entry (the listener, VC-663); dev-only in `@volli/host-protocol`, for `/testing` | The listener sits beside the tRPC projection it serves; host-core takes no `@trpc/server` (D2), and the renderer never loads `ws` | `applyWSSHandler`, as the contract harness uses it |
| Bulk transport | Separate binary WebSocket; content-addressed HTTP for blobs | No base64 expansion (~33%); bulk bytes cannot head-of-line block command/event frames | Existing terminal bytes and CDP screencast; framing below |
| Handshake | Integer breaking version range; highest intersection; additive feature names | Explicit compatibility refusal; old clients ignore unknown capabilities rather than infer support from app version | `handshake.ts`; T3 environment descriptor (not its transport) |
| Identity / fencing | Welcome names host, workspace, epoch, signed by the host key the client pinned at pairing; both peers fence (F5) | Reconnect is not promotion; stale hosts cannot resume authority silently; a claimed UUID is not proof | VC-550; `checkWorkspaceFence`; Syncthing device ids, Tailscale node keys |
| Actors | Credential-derived `device \| session \| worker`, one workspace per connection | Client labels cannot claim authority; invalid auth never becomes a user | VC-163 socket honesty; VC-92 actor/verb policy |
| Workspace isolation | Authorize before resolving ids; cross-workspace = `NOT_FOUND` | Guessed UUIDs must neither access nor reveal another workspace | VC-320 C01 |
| Commands | Client-minted `commandId`, durable intent and receipt; `accepted` ≠ `completed` | Retries cannot duplicate intent; acceptance is not an applied effect | Session engine command/receipt model; BOUNDARIES rule 4 |
| Subscriptions | Tracked event ids, resume, bounded queue, explicit terminal error; a snapshot is a checkpoint plus a byte-bounded tail, with paged history | A silent gap cannot look like clean completion; opening a resource costs the same at any age | Session RPC `lastEventId`, `AsyncQueue` (4096), `SESSION_HISTORY_WINDOW` |
| Errors | `HostError { code, message, reason? }`; tRPC codes | Same branchable failure on either link, no thrown strings | IPC registry's result envelope + Session RPC's code/message |
| JSON seams | `IsJsonSafe` on every raw input/output, subscription yield included | Structured-clone success must not conceal JSON data loss | BOUNDARIES rule 3; moved checker, Session RPC re-export |
| Operation placement | Authority/resource ownership, not the caller's machine | One host API, no remote tools routed back to the desktop | Cloud rulings 1–3; classification below |
| Command catalog (F3) | One Verb Registry entry per domain command, bound to exactly one handler in host-core's one handler map; area routers, IPC, the agent socket and tools are projections of it | Three door vocabularies diverge unless one table drives them; VC-92 policy is checked once | Verb Registry `catalog` (VC-564), `@volli/session-rpc` `catalog.ts`, `@volli/host-core/handlers` (VC-668), `AGENT_VERB_TABLE` |
| Board delivery (F1) | One change feed per Workspace: tracked cursor, resume or resnapshot | Fire-and-forget `data-changed` pings vanish with no listener and cannot resume after a lid-close | Session stream contract below |
| Host events (F4) | Every host fact is a `HostEventMap` topic with a Workspace scope and a delivery class; cadence in host-core | Two topics bypass the bus; coalescing lives in an adapter; `publish` names no Workspace | `ports/events.ts` |
| Client capabilities (F2) | Requests to the one connection that asked; per-connection focus and presence; auth-callback relay | A process-wide `client` means nothing with N Clients; remote OAuth fails | `HostClientEventSink`; VS Code `asExternalUri` |

## Handshake and capabilities

`HOST_PROTOCOL_VERSION = HOST_PROTOCOL_MIN_VERSION = 1`. A breaking semantic or wire change raises the integer; supported ranges must describe versions actually implemented. Additive procedures/optional fields use named features (`sessions`, `terminals.stream`, etc.; lowercase dotted words, ≤128 characters, ≤256 requested features). Names have fixed semantics; incompatible semantics need a new name or protocol version. Absent means unsupported; unknown names are ignored. The welcome grants the deduplicated intersection of requested features and those the host serves. Capability advertisement is not authorization: **a feature advertises that this host's transport serves those operations, not that this actor may call them.** The offer is listener-wide, the same for every actor, and each operation's actor policy (the catalog's `catalog.actor`, judged at every dispatch, [Auth and workspace authorization](#auth-and-workspace-authorization)) stays independent of it and is the enforcement: a Session granted `session.read` is still refused `session.list`, a person-only read (`FORBIDDEN` / `verb-refused`, pinned by a listener test). Feature membership never encodes an actor difference; a per-actor offer, if one is ever wanted, filters which names are offered and changes no feature's operations (VC-663 decision, security review N1). Features under `client.` run the other way (F2): requesting `client.open-external` declares that this Client performs the intent, and the grant means this host may send it ([The Client is a connection](#the-client-is-a-connection-f2)).

**A feature is a fixed set of operations** (VC-669's rule). Its membership is data, `HOST_FEATURE_OPERATIONS` in `@volli/host-protocol`, and once shipped it never widens or narrows: a new command joins a new feature name, never an old one. A connection may reach exactly the base operations plus the operations of the features its welcome granted (`operationsGrantedBy`); the catalog refuses any other key with `FORBIDDEN` / `verb-refused` before its input is read (`CatalogCallerContext.operations`). `SessionRouterFeatureBinding` fails `pnpm typecheck` if a feature names a key no router serves, and a session-rpc test names every `hostApi` entry no feature grants. The v1 names:

| Feature | Operations | From |
|---|---|---|
| (base) | `protocol.welcome` | VC-663; every authenticated connection, in no feature |
| `sessions` | `sessions.create`, `sessions.attach`, `session.snapshot`, `session.projection`, `session.command`, `session.cancelInteraction`, `session.reconcile` | VC-663 |
| `sessions.subscribe` | `session.subscribe` | VC-663 |
| `sessions.queue` | `session.cancelQueued`, `session.editQueued`, `session.subscribeQueue` | VC-675; queue-aware stream preserves the closed VC-669 legacy subscription output |
| `sessions.history` | `session.history` | VC-315 |
| `session.read` | `session.list`, `session.show`, `session.peek`, `session.answer` (the socket's Session reads, Workspace-scoped) | VC-663 (D4) |
| `model-access` | the eleven `modelAccess.*` procedures | VC-663; VC-572 refines their policy, and anything it adds takes a new name |

`settings.experiments` and `settings.setExperiment` are `hostApi` entries in no feature, so the WebSocket refuses them until VC-572 names theirs. So is `ticket.move` (VC-668), which is the board router's: no listener serves that router yet, and VC-565 gives it its board feature. Board reads join under a name of VC-565's own (for example `board.read`), never by widening `session.read`. Host events and per-connection Clients (VC-664) add `events`, `client.open-external` and `client.clipboard-write`. A host offers only what it composes: hostd offers `sessions`, `sessions.queue`, `sessions.subscribe`, `sessions.history` and `session.read`, and not `model-access`, which it does not compose yet.

The client sends `encodeHostHello(hello)` as tRPC `connectionParams`, under `volli-hello` (a JSON string). `HostHello` contains `{protocol:{min,max}, client:{kind,version}, workspaceId, lastSeen, features, credential, nonce}`. `nonce` is required v1 wire (D6): base64url, at least 128 random bits (22–128 characters); `buildHostHello` mints 256 bits from Web Crypto for every connect and reconnect, and the client keeps the hello it sent to validate the welcome against. `credential` is at most 8 KiB and `client.version` 128 characters. `client.kind` is desktop/web/mobile/cli/worker, self-description only; it never selects an actor. Missing/malformed hello is `BAD_REQUEST` / `hello-invalid`; missing/expired/revoked credentials are `UNAUTHORIZED` / `credential-invalid`. Credentials are never logged, embedded in URLs, recorded as diagnostics or put in the welcome. Use WSS outside loopback; private-network routing does not remove authentication.

VC-564 authenticates and negotiates in connection context before executing any area procedure. A base-v1 `protocol.welcome` query returns the immutable negotiated `HostWelcome`; this bootstrap query is in no feature, so it is never feature-gated. Welcome is `{protocolVersion, host:{id,version}, workspace:{id,epoch}, actor, features, proof}`. `proof` is reserved: every v1 host sends `null` until VC-575 signs the welcome over the hello's nonce (`HostWelcomeProof` is `{scheme, value}`, a named algorithm and its encoded signature, per [host identity § Keys](host-identity.md#keys-proof-behind-the-names)). The identity spec's `workspaceEpoch` is encoded as welcome `workspace.epoch` and hello `lastSeen.epoch` (when non-null); preserve these nested v1 wire fields, not a flattened or renamed `workspaceEpoch` field. The hello nonce and the welcome proof are v1 itself, not a feature a downgrade could strip: VC-663 adds them before any production client exists, and VC-575 signs and verifies them. Reconnect repeats the handshake with a fresh nonce; it is not implicit acceptance of a new host.

**The client validates before it uses the connection.** `validateWelcome(welcome, hello, { verifyProof? })` (`@volli/host-protocol`) is what a client link calls after `protocol.welcome` and before any other call or resubscribe, on every connect. It checks, in order: the welcome's grammar (`isHostWelcome`, which also refuses the reserved local device as an actor), the selected version within the range the hello asked for (`protocol-version-unsupported`), the requested Workspace and the actor's Workspace (`workspace-unknown`), granted ⊆ requested with no repeats, then the host-key proof through the `verifyProof` hook (VC-575 fills it; absent, the reserved `proof` is not judged), and only then the authority fence (`checkWorkspaceFence`: `workspace-epoch-fenced`, `workspace-split-brain`). A welcome that fails grammar, the grant or the proof is `BAD_GATEWAY` / `welcome-invalid`, a client-side reason: an upstream answered badly. `ok: false` means close the connection and use nothing from it. `isResnapshotRequired(error)` is the typed check a client link branches on for `subscription-resnapshot-required`.

### The listener (VC-663)

`startHostProtocolListener` (`@volli/session-rpc/websocket`) is the stock `applyWSSHandler` over a catalog router, plus what a network door owes the router:

- **A connection budget, before anything is allocated.** The listener accepts TCP itself and hands an HTTP server only what it admitted. Every accepted socket holds a slot until it closes, at every stage (before its upgrade, waiting for its hello, refused, admitted): at most `maxConnections` (128). Accepting is also rate-limited, a token bucket of `handshakeBurst` (64) refilling at `handshakesPerSecond` (32). Past either the socket is answered `503 Service Unavailable` and closed before any HTTP, handshake or router state exists for it, and the log says `connection-refused` with `connection-limit` or `handshake-rate`. A socket that has not upgraded within `handshakeTimeoutMs` is destroyed; a plain HTTP request is answered `426`. Limits are validated at start: each a positive integer, the frame bound within the outbound bound.
- **The handshake, in `createContext`.** It reads the hello (`BAD_REQUEST` / `hello-invalid`), hands the credential to the verifier port (`UNAUTHORIZED` / `credential-invalid`, also for a verifier that throws, answers a lapsed grant, or names an actor `isHostActor` refuses, so no verifier can mint the reserved local device, D7), looks the Workspace up (`workspace-unknown`, after the credential, so an unauthenticated peer learns nothing about which Workspaces exist), and negotiates the welcome (version, fence). A refused connection gets a context that carries only the refusal (`CatalogCallerContext.refused`): every operation it queued behind its hello answers that reason through the catalog before anything else is read, nothing runs, no subscription opens, and the listener closes it shortly after (`refusedCloseMs`, 1 s) with close code 4401 for a credential and 4400 otherwise, the reason as the close text. A connection that says no hello within `handshakeTimeoutMs` (10 s) is closed with 4408. The close codes (4400, 4401, 4408, 4413) are `HOST_PROTOCOL_CLOSE_CODES` in `@volli/host-protocol`, so a client link reads them without loading the Node-only listener (the server entry re-exports them).
- **The verifier port** (`HostCredentialVerifier`, `@volli/host-protocol`) is transport- and enrollment-neutral: it sees the credential, the hello's Workspace, nonce and client self-description, and answers a `HostCredentialGrant` (`actor`, `current()`, optional `watch(revoked)`) or `null`. Pairing (VC-575), the same-machine bootstrap (VC-577) and a hosted control plane's account-issued credentials each plug in as a verifier. hostd composes the first accepting one: devices enrolled over SSH ([Enrollment over SSH](#enrollment-over-ssh-vc-700)). `REFUSING_CREDENTIAL_VERIFIER` accepts nothing (D5). The VC-623 operator token is never accepted here.
- **Revocation.** Each connection holds an admission (`ConnectionAdmission` in the context) that ends, never to be restored, when the verifier's `watch` pushes a revocation, when the periodic re-check (`grantRecheckMs`, 30 s) finds `current()` false, or when the socket closes. The catalog judges it at every dispatch (step 1 below), **again immediately before the resolver**, after every awaited authorization step, so a call parked in `resourceWorkspace` or `sessionMayAct` when the grant ended never reaches its handler (a mutation is never accepted), and **again before a successful answer is released**, so an answer computed while the grant lapsed is refused `credential-invalid` instead. Every resolver receives a signal that aborts with the admission. Every open stream ends with `UNAUTHORIZED` / `credential-invalid` under its own request id the moment the admission ends, and its source is cancelled through that signal, so no runtime listener outlives the grant; the socket then closes with 4401. Calls with no admission (the desktop's IPC) are never re-judged, so flag off is unchanged.
- **Context.** The listener sets the caller, `transport: "websocket"` (diagnostics record it), `operations` from the granted features, the `welcome`, `replayBounds`, the connection's `admission` and `maxResponseBytes`; the composition root's `context(connection)` supplies the rest: the host's one handler map, projected through the router's policy (`admittedHandlers(map, ROUTER_POLICY)`, VC-668), and the resource ports. So a WebSocket call is judged by the catalog middleware (with the network re-checks above), then again by the router policy at the map, before any handler runs; hostd's tests record every map verdict the listener caused. `protocol.welcome` is the one door-local key the WebSocket serves (`DOOR_LOCAL_CATALOG_KEYS`): the handshake's own answer, which no handler could know. `features` is a required option: a host offers exactly what its context composes, never everything by omission.
- **Bounds.** Inbound frames are capped at 8 MiB (`maxPayload`). Outbound, no frame exceeds `HOST_PROTOCOL_MAX_FRAME_BYTES` (16 MiB, the replay byte bound, so one frame alone never outweighs a resume): the catalog refuses a query or mutation whose answer's JSON is larger (less a 4 KiB envelope allowance) with `PAYLOAD_TOO_LARGE` / `response-too-large` and the connection carries on; `session.subscribe` ends a stream whose next frame is larger with the same reason; any other frame that size (a client's own oversized request id echoed back) is never sent, and the connection closes 4413. Large content goes through a bounded or paged read (VC-315's `session.history`), never a truncated one. Each send is judged before it is enqueued: a frame that would take the socket's unsent bytes past `maxOutboundBytes` (32 MiB, two frames) is not sent and the peer is terminated as a slow peer (`slow-peer`); after it is enqueued, a backlog past the bound terminates at once rather than at the next send. A connection holds at most `maxSubscriptions` (64) open streams; one more is `TOO_MANY_REQUESTS` / `subscription-limit`, and a slot is given back however a stream ends (stopped, completed, failed, refused, revoked, closed), so refused or finished subscriptions retain nothing. Server pings (30 s) find a peer that vanished.
- **Loopback only** until VC-575 (Q5): the listener refuses any other bind address, and so does hostd's `--listen`.
- **Logs** name a connection by a random id and a refusal by its reason; never a credential, a hello or a payload.

VC-550 agreement: host id is UUIDv4, host-local, **not** `installationId`. Backup bundles omit it, so a bundle restore mints a new host id and re-enrolls devices/workers. A raw profile copy instead duplicates the singleton: detection is not implemented, and the copy must not serve until detection/re-enrollment establishes a fresh identity. Workspace id is existing `projects.id` and travels with it. Epoch 0 means never served under the flag; first validated serve is 1. Promotion raises the latest known fence (normally max+1) **only after authority validation/arbitration**; a lagging replica's local MAX(epoch)+1 proves no exclusivity. Keep the highest accepted `{epoch,hostId}` per workspace. `checkWorkspaceFence` rejects a lower epoch (`workspace-epoch-fenced`) and equal epoch/different host (`workspace-split-brain`); on split brain stop using both, retain the conflict and require an explicit fenced promotion. A higher epoch may name a new host only after authentication and authority/promotion validation. The pin survives client/worker restarts. The helper alone is not control-plane compare-and-swap, conflict persistence or durable authority storage.

T3 is a precedent for **readiness gated by an environment descriptor and absence-safe capabilities**, not tRPC or dotted features: its [client session](https://github.com/pingdotgg/t3code/blob/main/packages/client-runtime/src/rpc/session.ts) waits for the first server-config snapshot and checks environment identity; [environment contract](https://github.com/pingdotgg/t3code/blob/main/packages/contracts/src/environment.ts) carries optional capabilities and an orchestration version; [remote policy](https://github.com/pingdotgg/t3code/blob/main/docs/internals/remote.md) requires clients to respect missing capabilities. T3 uses Effect RPC and upgrade-level orchestration-version checks; Volli reuses its own tRPC router instead.

### The client host link (VC-670)

A Client reaches a host's WebSocket through **one client host link per Workspace** (`createHostLink`, `@volli/host-protocol/client-link`), never a bare tRPC socket. Renderer-safe: `@trpc/client` and the platform `WebSocket`, no Node, no Electron, no `ws`. A Client keeps its links in a `createHostLinkRegistry` so every store that reaches a Workspace shares its one socket. It is the template the M2 area tickets copy: **store → link `{state, query, mutate, subscribe(onResnapshot)}` → a configured `wsClient`**.

- **One `wsClient` and one socket per connection.** Each connect builds a fresh stock `wsClient` (`lazy` off, tRPC's own keepAlive off, its reconnect never reached) and retires it whole when the socket ends, so nothing it held can be sent on the next one. The host's `{ id: null, method: "reconnect" }` (tRPC's `broadcastReconnectNotification`) retires the connection too, before tRPC reads the frame: the in-flight calls fail `host-unreachable` and the link's own backoff makes the next attempt, with a fresh credential, hello and welcome. The socket constructor the link hands tRPC refuses a second socket for one connection, or any for a retired one. Stock tRPC would instead buffer mutations through a reconnect with no timeout, resend every pending mutation on its reconnect, back off up to 30 s, and resubscribe before any welcome is judged.
- **Handshake first, every time.** Every connect and reconnect asks the `credential` provider afresh (never cached, so a short-lived or account-issued credential refreshes; pairing is one provider, not an assumption), sends `buildHostHello`, reads `protocol.welcome` and judges it with `validateWelcome` (which ends in `checkWorkspaceFence` against the highest authority the link accepted). Only a validated welcome makes the link `ready`, and only then do calls go out and subscriptions resume. The whole attempt has `handshakeTimeoutMs` (10 s).
- **Calls never queue (Ruling 1).** `query`/`mutate` while the link is not `ready` reject at once with `SERVICE_UNAVAILABLE` / `host-unreachable` (with the refusal or fence itself when the link is `refused` or `fenced`). A call in flight when the connection dies rejects `host-unreachable` too, since its outcome is unknown; nothing is resent. A command's `commandId` is what makes an explicit retry safe.
- **Liveness.** After `heartbeatIntervalMs` (5 s) of inbound silence the link sends `PING` (tRPC's server answers `PONG`); no frame within `heartbeatTimeoutMs` (2 s) and the socket is dead, without waiting for a close handshake a vanished peer never answers. So a dead socket is found within 7 s of the host's last frame. `wake("power-resume" | "network-online")` probes a `ready` link at once (dead within 2 s) and reconnects an `unreachable` one at once, resetting its backoff; the desktop maps `powerMonitor` resume and the network returning onto it.
- **Backoff.** After the *n*th consecutive failure the next attempt waits in the upper half of `min(10 s, 500 ms × 2^(n−1))` (`hostLinkBackoffDelay`): 0.25–0.5 s, then doubling to 5–10 s, jittered so a fleet does not reconnect in lockstep. A validated welcome resets it.
- **Close codes are states.** During the handshake, 4401 is `refused` with `credential-invalid`, and 4400 is `refused` with the reason its close text names (`fenced` when that is `workspace-epoch-fenced` or `workspace-split-brain`). After `ready`, 4401 is a revoked or lapsed grant: `unreachable` with `credential-invalid`, and the next handshake asks the provider for a fresh credential and is `refused` if there is none. 4413 is `unreachable` with `response-too-large`. Anything else is `unreachable` with `host-unreachable` and the code. A refusal the host answers on `protocol.welcome` reads the same way; any other failure there is a fault, retried.
- **Subscriptions.** `subscribe(path, input, { onStarted?, onData, onResnapshot, onError, onComplete? }, { lastEventId? })` stays registered across reconnects: opened only while `ready`, resumed from its last tracked id after each validated welcome. `subscription-resnapshot-required` calls `onResnapshot` and ends it (re-read the snapshot, subscribe from its cursor). `subscription-overflow` resumes from the last id if the stream made progress since it opened, and surfaces otherwise. A stream's `credential-invalid` waits for the 4401 that follows. Any other failure ends it through `onError`; `refused`, `fenced` and `closed` end every stream. A typed client is `createTRPCClient<Router>({ links: [hostLinkTrpcLink(link)] })`; tRPC's observer has no resnapshot slot, so there `onResnapshot` arrives as `onError` with an error `isResnapshotRequired` recognizes. Its `AbortSignal` is local: an aborted query or mutation rejects `CLIENT_CLOSED_REQUEST` (before sending, or at once mid-flight), an aborted subscription stops; abort is not rollback, and a mutation the host already received may have taken effect.
- **One state, observable.** `getState()` / `subscribeState(listener)` (`useSyncExternalStore`'s shape):

  | State | Means | Leaves by |
  |---|---|---|
  | `connecting {attempt}` | an attempt is in flight | `ready`, `unreachable`, `refused`, `fenced`, `closed` |
  | `ready {welcome}` | the welcome validated; calls and streams flow | a drop, a dead heartbeat or a 4401/4413 → `unreachable`; `close()` |
  | `unreachable {attempt, error, closeCode, retryAt}` | down; retrying at `retryAt` | the timer, `wake` or `reconnect()` → `connecting`; `close()` |
  | `refused {error, closeCode}` | the host refused the handshake, or this client refused its welcome | `reconnect()` → `connecting`; `close()` |
  | `fenced {error}` | the authority fence failed (epoch moved, split brain); nothing resubscribed | `reconnect()` → `connecting`; `close()` |
  | `closed` | the owner closed the link | final |

  A listener is called synchronously and may `close()`, `reconnect()` or `subscribe()` from inside it: the link arms its timers before it notifies, and stops the transition it was making once a listener moved it on (the remaining listeners hear the newer state instead). A subscription opens once however it was registered. The state holds no Workspace data (D-C1): VC-576's connection UI and the stale, read-only view read it; what that view shows is the stores' in-memory last-known state.
- **The Session client.** `ChatSessionTransport.streamRecovery: "host-link"` replaces the chat client's resume-once-then-error: the link already resumed every drop, so the client retries nothing, reloads the snapshot on a resnapshot (at most three in a row with nothing between them), and surfaces anything else. The default, `"resume-once"`, is the IPC edge's unchanged policy: with `cloud` off nothing uses the link.

## Host-owned Session follow-ups (VC-675)

`session.command({commandId, sessionId, command:{kind:"message.submit", delivery:"queue", message}})` records durable host intent and returns acceptance without waiting for the current turn. Omitted `delivery` retains immediate submission semantics. A Client is not required for release or reattachment. Device drafts remain local.

The Sessions projection adds optional `queue` and `queueRevision`. Queue entries carry `{id, commandId, message, state:"queued"|"releasing"}` in acceptance order. `session.subscribe` publishes a `kind:"queue"` baseline on reattach and complete queue views with monotonically increasing `revision`; queue changes do not advance the event cursor. Clients ignore older revisions and replace their last-known queue view, never release from it.

The `sessions.queue` feature adds two catalog entries without widening the frozen `sessions` feature:

- `session.cancelQueued({commandId, sessionId, messageId, expectedRevision?})` withdraws pending intent.
- `session.editQueued({commandId, sessionId, messageId, message, expectedRevision?})` replaces its payload, retaining the user message's identity.
- `session.subscribeQueue({sessionId, afterSequence?, lastEventId?})` follows the bounded, resumable Session stream plus queue updates. Network bindings negotiate `sessions.queue` and supply this path to the host-link Session client. The old `session.subscribe` retains its frozen network output union; private desktop IPC continues to carry queue updates on its existing path. Network snapshot/projection reads include queue fields only when this feature was granted.

When given, `expectedRevision` must match the queue revision atomically; otherwise the command changes nothing and returns `CONFLICT` / `queue-revision-conflict`. An already-accepted command replays its original answer before this check. A Client restoring a row to its composer supplies the revision associated with the displayed payload, before any asynchronous durability wait.

Both reach the host's sealed handler map under the person/Workspace policy and return validated receipts. Live dispatch or proof of delivery refuses cancellation; an unproven `releasing` row with no sender may be explicitly withdrawn, clearing its queue Attention and unblocking the FIFO. Edits still refuse `releasing` rows. Their underlying command kinds are withheld from `session.command`, so that older feature cannot bypass negotiation. Queue-backed Steer uses the existing `message.submit{delivery:"steer"}` operation: the message id atomically claims its canonical host payload, targets the current turn, and never performs cancel-then-send. An ended target is refused; uncertain acceptance retains the payload. Pi only acknowledges targeted host-owned steering after its durable consumption marker, not after inserting into its in-memory steer array. Untargeted supervisor steering retains its immediate acknowledgement.

Storage is a separate Session follow-up command ledger in the expand-only `session_follow_up_queue` table (migration 061, after main's 060; reader floor unchanged at 58). It retains idempotency signatures, mutation replies, pending payloads, durable release claims and terminal evidence. New queue intent kinds do not enter older readers' Session event/command vocabulary; the actual delivery uses the established `message.submit` event ledger and transcript artifact store. N−1 keeps opening/writing the database and leaves this table alone. Current backups include the table. Older guarded builds stamp backups with their own schema and omit newer tables, so an N−1-made backup cannot preserve pending follow-ups; use a current-build backup to preserve them. The already-documented schema-57 release/canary backup hazard also omits this table, and the compatibility lane asserts that refusal rather than accepting an incomplete bundle.

Legacy composer-held queued/sending messages retain today's upgrade behavior: they hydrate as visible unsent recovery rows, with their original identities, text, resources and attachments. They are not silently auto-sent; the person's next Send crosses the host acceptance boundary. A queued message which was only in an already-exited old renderer's memory cannot be reconstructed from disk. New kickoff/authoring submissions cross host acceptance rather than entering a renderer-only queue.

### Release and crash recovery

An atomic ledger transaction claims the FIFO head and consumes its durable idle boundary (`idle:<latest-turn-id>`, or `idle:birth`). A second pending message cannot release on the same boundary, even if acceptance precedes a projected turn start. Before submitting, the runtime revalidates the boundary inside its command admission chain; an immediate send winning that race returns the claim to pending. The host attaches when required, submits an established event-ledger `message.submit` under an immutable derived delivery id, and retains the payload until terminal acceptance is durable. The `follow-up:` command-id namespace is reserved for host delivery/attach commands; recovery verifies the retained payload against the recorded intent before trusting its receipt. Pi's `settle:"opened"` queue release waits out the old turn's closing window and persists its acceptance marker; replay of an accepted command id cannot open a second provider turn.

On host startup, recovery starts before Clients and producers but readiness waits at most five seconds; a hung release continues in the background and close still joins it. A pending executor start holds the row `queued`, and completion wakes release. Failed pre-send attaches return the claim to `queued`; each attach attempt has its own derived id, so a restart's continuity change cannot collide with a prior attempt. Every Attention-clear and attachment-open (including Stop lift) wakes release. Safe pre-intent failures use bounded backoff (1s, 5s, 30s, 2m, 10m) and the host's structured log port; their own queue Attention cannot block retry. Configuration and unrelated Attention still pause work. Crash before claim or delivery intent leaves pending payload eligible for release. Crash after a durable executor marker but before the host receipt reconciles acceptance without dispatching again. Crash after the receipt but before queue settlement removes the entry once from that receipt. A turn explicitly attributed to the delivery command, or matching its derived turn id, is acceptance evidence; ordering alone never proves delivery. If delivery intent exists without conclusive acceptance, the host **does not redispatch**: it retains the releasing payload and raises durable Attention: “This follow-up may have been delivered. Check the transcript before resending.” The person may withdraw this unproven claim after checking the transcript; cancellation never automatically resends it. This is at-most-once automatic dispatch with evidence-based settlement, not an unconditional guarantee of eventual execution across an ambiguous provider boundary. A definitive rejection returns the payload to editable/cancellable pending state, without automatically retrying the rejected command id. `readState` and recovery reject more than one releasing entry rather than guessing. Returning pending rows after an N−1 downgrade still release: older writers leave no last-writer marker, so a reliable writer/unsent policy remains follow-up work rather than a timestamp heuristic.

## Auth and workspace authorization

VC-575 owns pairing, token format/storage/rotation/revocation. Device credentials come from pairing and bind `(deviceId, workspaceId)` and the issuing host; session credentials bind a durable Session to that workspace; worker credentials bind an enrolled worker to that workspace. A device or worker credential is short-lived and obtained by proving the key pinned at pairing or registration, so revocation drops a public key and a phone holds no long-lived bearer secret (F5, [Keys](host-identity.md#keys-proof-behind-the-names)). A host serving several workspaces requires a separate authorized connection per workspace. The host derives the actor from credential verification, never hello fields, a supplied Session id or transport location. `isHostActor` validates grammar, **not** authority; actors' `sessionId` tolerates the bounded legacy identifiers accepted by session-rpc, while new Session ids are UUIDv4.

### Enrollment over SSH (VC-700)

The first accepting verifier. A host added over SSH (VC-615 flow 1) is paired over the same SSH channel the desktop installed it through: no code is shown. Pairing by code (VC-575) stays the path for hosts installed another way and for phones; a hosted control plane's account-issued key is a third. All three write the same fact (a device's public key, trusted by this host) and are read by verifiers behind the one port (guardrail 1).

- **Enrollment.** The desktop runs `volli-hostd enroll --system|--user --public-key <P-256 SPKI, base64url> --name <label>` on the box, as the account hostd runs as (`sudo -u volli` for a system unit). It appends the key to `<dataDir>/enrolled-devices.json` (0600, public keys only, host-level, never in a backup) under a host-allocated UUIDv4 `deviceId`, and answers `{hostId, deviceId, fingerprint}`. Idempotent per key; a revoked key enrolled again is a new device. VC-575 may fold the file into the `devices` table; the verifier port is the seam.
- **Why SSH access is enough** (the trust argument):
  1. *The box is authenticated.* The desktop's ssh checks the box's SSH host key against the person's known_hosts with `StrictHostKeyChecking=yes`; an unknown key is shown by fingerprint and trusted only when the person accepts it (never `accept-new`). So the `hostId` that comes back is this box's, and the key that goes in reaches this box unaltered. The desktop pins that `hostId` as it would pin a host key from a pairing code.
  2. *The person is authenticated, and gains nothing.* Running `enroll` needs a shell on the box as a login that can act as hostd's account. That login can already read and rewrite the data directory, the database and the secret key, so enrolling a device grants no authority it did not hold.
  3. *Only a public key crosses.* The device's private key never leaves it; the credential it signs is short-lived and single-use, so a transcript of the channel admits no one.
  Until VC-575 signs the welcome (`proof` stays `null`), the client's assurance that it reached this host comes from the transport: the default route is an `ssh -L` tunnel to the host's loopback listener, which the same host key authenticates.
- **The credential** (`vdc1`, `@volli/host-protocol` `device-credential.ts`): `vdc1.<base64url(JSON {hostId, deviceId, workspaceId, iat, exp, jti})>.<base64url(ECDSA P-256 SHA-256, IEEE P1363)>`, signed over the ASCII of `vdc1.<claims>`. The device mints one per handshake (the link asks its credential provider on every connect). The verifier (`apps/hostd/src/enrolled-devices.ts`) admits it only when it names this host and the hello's Workspace, `exp - iat ≤ 300 s` and now is inside it (60 s skew), the `jti` was never seen (remembered until it would have expired; past 10,000 live ones it refuses rather than forgets), the device is enrolled and not revoked, and the signature verifies under the enrolled key. The grant's actor is `{kind: "device", deviceId, workspaceId}` and its `current()` stays true while the device stays enrolled, so revocation (the entry removed or `revokedAt` set) closes its connections at the door's next check. Example: `vdc1.eyJob3N0SWQiOiIwZjZh…In0.MEUCIQ…` admits device `1f6a…` into Workspace `2f6a…` on host `0f6a…`, once.
- **Scope.** An SSH-enrolled device is the operator's own Mac, so it may connect to every Workspace on the host, one authorized connection per Workspace (the credential binds the one it is for). It is a paired device for policy: `user`.

Carry VC-92's read / coordination / control policy into per-procedure middleware. A paired device maps to today's `user` policy actor (human intent, not an agent control tier). A Session retains its birth-frozen Role tool surface and scope. Agent control travels through a worker only on behalf of a Session it hosts, checked against that Session's frozen grants; worker identity alone confers no control tier. The paired-device human routes remain available under user policy. Today's socket is read/coordination only; control remains tool-only, not newly exposed by a token. Declare policy for every procedure, exhaustive on additions, and check grants/revocation at dispatch, not only handshake. A bad agent credential is refused, never downgraded to user (VC-163).

VC-564 implements this in the catalog middleware ([Command catalog](#command-catalog-f3)):

- **One actor mapping.** `@volli/shared`'s `catalog-actor.ts` maps both door vocabularies onto the policy actor: `HOST_ACTOR_POLICY` (device → `user`, session → `session`, worker → refused) and `DOOR_ACTOR_POLICY` (the VC-623 operator → `user`, as a paired device is). The socket's admission gate and the router read the same tables.
- **Workers are refused** at every procedure until VC-580/581 give them delegated Session grants.
- **The desktop's own window** is the reserved local device `{kind:"device", deviceId:"local"}` (`LOCAL_DEVICE_ACTOR`, `@volli/host-protocol`): device-as-user, every Workspace on its host. `isHostActor` refuses `"local"`, so no verifier can mint it from a network handshake.
- **Grants at dispatch.** A network caller must carry `current()`, in its type and at runtime; it is asked on every call, and `false`, a missing checker or an actor `isHostActor` refuses is `UNAUTHORIZED` / `credential-invalid`, before the actor, the input or the handler is read. Only the local desktop may omit it, because nothing can revoke it.
- **Production IPC is the desktop, always.** `registerSessionRpcIpcHandlers` takes no caller option: it binds `LOCAL_DESKTOP_CALLER`. The contract harness judges other actors over that bridge through a test-only router context (`session-rpc-harness-identity.test-support.ts`), never through production options.

Context carries the authorized workspace; inputs cannot override it. Every ticket, Session, terminal, artifact, blob, subscription and worker lookup verifies workspace ownership **before** returning data or mutating. Cross-workspace ids and absent ids have the same `NOT_FOUND` answer (`workspace-unknown`), including subscriptions and bulk-channel grants. Policy denial within the workspace is `FORBIDDEN` / `verb-refused`. A promoted authority rejects old-epoch writes; worker checkout writes additionally carry `(workspaceEpoch, leaseEpoch)`, ordered lexicographically, and must equal the current live, unexpired per-ticket grant for the authenticated worker. A claimed higher token is not authorization. Lease epochs belong on writes, not the hello; a valid workspace connection is not a checkout lease.

## Command catalog (F3)

Desktop has three verb vocabularies:

- per-channel `volli:` IPC channels (see `apps/desktop/src/ipc/placement.ts`);
- the Session tRPC router;
- the agent verb table (`shared/src/verb-registry.ts`, `host-core/src/agent-dispatch/table.ts`).

Left alone, they diverge. The renderer's `volli:ticket-move` once trimmed a newly Done worktree at once while socket `ticket.move` left it to the 60-second retention poll; VC-629 fixed that by having both doors call one handler (`host-core/src/ticket-move.ts`). M2's area routers must not become a fourth vocabulary.

**Amended 2026-10-06 (post-M1 review), D-A1 = (c): hybrid.** This partly amends F3 and Decided 4, not the one-handler or policy rule. Every command goes through one host-core handler map (VC-668) and the policy middleware:

- **Public tier:** entries a second Client calls (phone, CLI, agent) get the catalog ceremony below: output schemas, frozen feature membership/semantics and N−1 compatibility fixtures.
- **Desktop-only tier:** channels go through VC-608's generic bridge, with policy derived from VC-574's placement class. They remain additive-only across supported version skew; no incompatible rename, removal or semantic change. They do not need public catalog ceremony merely to move out of per-channel IPC.
- **Promotion:** before a second Client calls a desktop-only entry, make it public with its schemas, frozen features and N−1 fixtures. Both tiers must reach the same handler, checked in CI; doors never add behavior.

Source: `.scratch/arch-review-m1/architecture-review-post-M1.html`, D-A1; owner approval on VC-542 (2026-10-06). The catalog builders and their legacy exceptions below describe the public tier; this is a plan amendment, not a claim that desktop-only routing has already landed.

**One entry per public domain command.** The Verb Registry (`@volli/shared`, pure data) is the catalog's declaration half; the binding half is the one handler in host-core's handler map, `handlers[key]` ([One handler map](#one-handler-map-vc-668)), which every door's projection resolves to: a tRPC procedure for router commands, an `AGENT_VERB_TABLE` projection for socket verbs. Socket verbs that are not yet catalog entries keep their own `AGENT_VERB_TABLE` handler until their area moves; no second table appears beside these. An entry carries:

- its dot-name, `key`: one identity on every door, chosen once. A router entry's key is its procedure path (`session.snapshot`);
- its actor policy, per door. `actor` is what the agent doors (socket, tools, CLI) judge, unchanged. A router judges `catalog.actor`, defaulting to `actor` (`catalogActorOf`), and it must be a `CatalogActor`:
  - `user`: the person (a paired device, the desktop's own window, a VC-623 operator);
  - `any`: Sessions too, on any resource in their Workspace;
  - `session-own`: the person, or a Session the area's own policy lets act on every **subject** the call names. After the Workspace check, the router asks the context's `sessionMayAct(resource, sessionId)` predicate about each subject. No predicate, or no subject at all, admits no Session (fail closed). Workspace entries only.

  `session` (per-project policy) and `role` (a frozen Role bundle) are agent-door policies no router consults, so they are refused at load as a router actor. A socket verb whose `actor` is `session` declares its router policy in `catalog.actor` instead. Human and agent policy may differ for one command, and that one entry serves both doors. Tiers stay derived from access modes and the agent `actor`, never stored (VC-92);
- its `catalog` declaration (`VerbCatalogDeclaration`):
  - `scope`: `workspace` (the call names a resource, authorized before the handler runs; cross-Workspace is `NOT_FOUND`) or `host` (host-level state, no Workspace data; person-only unless the actor is `any`, D8);
  - `idempotency`: `command-id` (intent-recording: `HostCommandRequest`, durable receipt), `natural` (a repeat leaves the same state) or `read`;
  - `actor` (optional): the router's actor policy, above;
  - `refusedIntents` (optional, workspace `command-id` entries only): intent kinds no actor may send through this entry because each has its own. Its input must be a `{ command: { kind } }` envelope: `workspaceProcedure` demands one at the type (`CatalogKeyRefusingIntents`) and refuses another at construction;
- its access modes: `hostApi` is the WebSocket projection; an entry with a `catalog` and no access mode is policed but served by no network door (the lab's `labDiagnostics.*`);
- JSON input/output validators, transport-independent (BOUNDARIES rule 3): zod, in the projection that binds the entry (D2): `.input(zod)` (or `workspaceProcedure`'s schema) and `.output(zod)`. **Every new query or mutation binds an output schema;** `catalogRouter` refuses one that does not. The named legacy exceptions, listed in the Session family's `legacyUnvalidatedOutputs` (`session-catalog.ts`) so the list can only shrink, are the Session procedures that return runtime projections: `sessions.create`, `sessions.attach`, `session.cancelInteraction`, `session.reconcile`, and the lab's `labDiagnostics.list`. A subscription's yields are not validated by tRPC's `.output()`, so `session.subscribe` and `labDiagnostics.subscribe` stand outside the rule; their payloads are pinned by the static `IsJsonSafe` check only, which is not runtime validation. JSON Schema for a non-TypeScript client is derived from zod (`z.toJSONSchema`), never hand-written;
- exactly one handler: `handlers[key]` in the host's map. A procedure's resolver and a socket binding are projections of it, never handlers of their own. The lab's `labDiagnostics.*` are the one exception, answered by the router that records them (`DOOR_LOCAL_CATALOG_KEYS`).

### Committed schema and compatibility gate (VC-669)

`docs/protocol/protocol.schema.json` is the stable, sorted `z.toJSONSchema` projection of every catalog entry's input and output. `packages/session-rpc/src/protocol-schema.ts` consumes schema providers, starting with `sessionProcedureSchemas`: actual procedure validators plus explicitly named documentation-only schemas for remaining legacy outputs and subscription yields. `outputValidation` distinguishes `network-and-tests` validators from documentation-only schemas; publishing a schema does not pretend tRPC validates subscription yields. Generation uses Zod's `io: "input"` for inputs and `io: "output"` for outputs. Shape-preserving label sanitation uses `.trim()`/`.overwrite()`; JSON Schema cannot describe runtime refinements/sanitization. The existing UIMessage custom parser and interaction-answer transform have explicit structural zod views; any new unpublishable seam fails generation instead of silently becoming `{}`. `noInput` and `voidOutput` distinguish null document sentinels from domain values; runtime replies are not rewritten.

- Regenerate: `pnpm generate:protocol-schema`.
- Check freshness and additive compatibility: `pnpm check:protocol-schema -- --base origin/main`. CI supplies the PR base SHA (or the previous main SHA), never compares the artifact to itself. The first artifact is explicitly logged as a baseline when the base has no schema.
- `scripts/protocol-schema/compatibility.mjs` checks **both public and desktop tiers**. It forbids removing/renaming entries or fields, narrowing types/union alternatives/bounds, requiring an optional input field, and removing output enum members. Unknown assertion changes fail closed. The artifact also publishes `HOST_FEATURE_OPERATIONS` and `HOST_BASE_OPERATIONS` from VC-663's sole feature table. The gate freezes each existing public feature and bootstrap set, independently of order: additions need a new feature name. Before binding a WebSocket listener, readiness refuses unknown server offers, missing bootstrap/advertised operation paths, and table members without public `hostApi` entries. Hosts may offer complete subsets, not incomplete features. Dispatch derives grants solely from the negotiated welcome and refuses ungranted operations before parsing input. Readiness proves operation membership, not backend health; composition roots still offer only the facades they compose.
- Intentional incompatible changes require a real `HOST_PROTOCOL_VERSION` bump **and** exact affected JSON-pointer paths plus explanations in `docs/protocol/compatibility-allowlist.json`. A bump alone is not a waiver. Empty by default; retain historical entries only if they match the comparison's version transition.
- VC-608 plugs its typed desktop-only bridge schemas into the provider list with `tier: "desktop"`; those keys do not require public registry rows, but receive the same schema diff. Every new public area adds its router to that list; missing/extra/duplicate public keys fail generation. Frozen features and N−1 fixtures remain public-only (D-A1 hybrid).

Example rejected change: making `session.command`'s optional `sessionId` required reports `/tiers/public/session.command/input/required: optional input field made required`, even if the artifact was regenerated.

**A worked example**, the entry behind `settings.setExperiment`, with both validators:

```ts
// packages/shared/src/verb-registry.ts, in VERB_REGISTRY
{
  key: "settings.setExperiment",
  accessModes: ["hostApi"],
  actor: "user",
  handler: { site: "main", id: "settings.setExperiment" },
  listed: false,
  group: "App",
  summary: "Turn one experimental feature on or off.",
  options: [],
  catalog: { scope: "host", idempotency: "natural" },
},

// packages/session-rpc/src/index.ts, in createSessionRouter's catalogRouter({...})
settings: {
  setExperiment: hostProcedure("settings.setExperiment")   // typed to the catalog's host keys
    .input(z.object({ id: experimentIdSchema, enabled: z.boolean() })) // input validator
    .output(experimentSnapshotSchema)                       // output validator, required
    .mutation(async ({ ctx, input }) => /* the one handler */),
},
```

A workspace entry names its resource with its input schema; `session.snapshot` is:

```ts
snapshot: workspaceProcedure(
  "session.snapshot",                      // typed to the catalog's workspace keys
  z.object({ sessionId: nonEmptyString }), // the input validator
  sessionResource,                         // input -> { kind: "session", id: sessionId }: what to authorize
)
  .output(sessionSnapshotOutputSchema)
  .query(async ({ ctx, input }) => rendererSnapshot(await ctx.handlers["session.snapshot"](input, ctx.call))),
```

**At dispatch**, every call runs the same checks in this order, before its handler (`packages/session-rpc/src/catalog.ts`):

1. the caller is the local desktop or a network actor `isHostActor` accepts, and a network caller's `current()` answers `true` now; else `UNAUTHORIZED` / `credential-invalid`. A network caller is asked again immediately before the handler and before its answer is released ([The listener](#the-listener-vc-663));
2. the caller's actor, mapped through `HOST_ACTOR_POLICY`, meets the entry's router actor (`catalogActorAdmits`), and a network caller reaches only `hostApi` entries; else `FORBIDDEN` / `verb-refused`. A Session on a `session-own` entry is admitted here and judged per resource at step 6;
3. the input parses (`BAD_REQUEST`);
4. a withheld intent is refused (`FORBIDDEN` / `verb-refused`);
5. **every** resource the call names is resolved and must be in the caller's Workspace. A `project` is its own Workspace; any other kind goes through the context's `resourceWorkspace` port. Foreign, absent, an unanswered kind and a call naming nothing all answer the same `NOT_FOUND` / `workspace-unknown`, with the same message;
6. for a Session on a `session-own` entry, the context's `sessionMayAct` must answer `true` for every **subject** resource (references are not judged), with at least one subject and a predicate present; else `FORBIDDEN` / `verb-refused`. The resources are already known to be in its Workspace, so this reveals nothing.

The desktop's own window owns every Workspace, so it skips steps 5 and 6 and reads nothing new.

After the handler, a thrown error carrying the `CommandIntentConflict` brand (`@volli/shared`, where every ledger can reach it without depending on a protocol package) becomes `CONFLICT` / `command-conflict`. The router recognizes the brand, never a ledger's own classes. The Session engine's and runtime's command-id conflicts carry it; an area's intent ledger brands the error it throws when a command id is reused with a different intent, and only that one.

**Resources, open per area.** A resolver returns every resource the input names: `readonly WorkspaceResource[] | WorkspaceResource | null`, where `WorkspaceResource` is `{ kind, id, relation? }` and `kind` is an open string. An area adds its own kind (`ticket`, `terminal`, …) by naming it in its resolver and answering it in its context's `resourceWorkspace` port and `sessionMayAct` predicate; nothing in `@volli/session-rpc` changes. `relation` is `subject` (the default: what the command acts on) or `reference` (only pointed at, like the ticket a move lands after). **Every** named resource gets the Workspace check; only subjects are judged by `sessionMayAct`. Never drop a reference from the resolver to avoid the policy check, since that also drops its Workspace check: mark it `reference`.

**Session authority is the area's policy, never an owner field.** Several Sessions may work one ticket, and coordination authority is per-project policy. Implement `sessionMayAct` from the area's existing policy (for example, ticket coordination rules), never from a single owner field. Name the noun the command acts on as the subject, not its project: a `project` resource is a Workspace, so it never makes a sensible `session-own` subject. "Absent ≡ cross-Workspace" holds by construction: the only path to the handler is every resource resolving to exactly the caller's Workspace id. Anything else (null, a foreign id, a kind no port answers, no port at all) takes the one refusal.

**Subscriptions dispatch once.** Grants are checked at every dispatch, but a subscription dispatches once: the checks run when it opens, not per event. Closing streams when a credential is revoked belongs to the door, which owns connection lifetime: the WebSocket listener answers every open stream `credential-invalid` and closes the connection ([The listener](#the-listener-vc-663)). A resume is a new dispatch, so it is judged again.

**Exhaustive, at compile time and at construction.**

- `hostProcedure(key)` and `workspaceProcedure(key, input, resources)` take only catalog keys of their scope, so a procedure with no entry, or a workspace procedure with no resources, does not compile.
- Each family asserts `CatalogMismatch<ProcedurePaths<router>, CatalogKeyOf<FamilyEntry>>` is `never` (`SessionRouterCatalogBinding`, `BoardRouterCatalogBinding`): no procedure without an entry and no entry without a procedure. `HostRouterCatalogBinding` (`host-router.ts`) asserts the same over the union of every router's paths and the whole catalog, and `HostRouterPathsDisjoint` that no path is two families'. The keys that disagree are named in the error.
- `HostApiCatalogCoverage` fails a `hostApi` entry with no `catalog`; `catalogEntriesFrom` refuses one at load.
- `catalogRouter` throws at construction on a procedure the builders did not make, one at another entry's path, one whose tRPC type contradicts its idempotency (`read` is a query or subscription; anything else is a mutation), or a query/mutation with no output schema that is not a named legacy exception.
- **Provenance is private, never metadata.** Each builder call records, in a module-private `WeakMap`, the middleware that completes its entry's policy (admission for a host entry, Workspace authorization for a workspace entry), bound to that entry's key and to the exact middleware chain it built. `catalogRouter` accepts a procedure only if its chain begins with that chain at that entry's path. tRPC `meta` proves nothing (any module can `initTRPC` and set it): a bare procedure claiming an entry, a host procedure retagged as a workspace one, and a chain that runs anything before the policy are all refused at construction. A builder also refuses a key of the other scope at runtime, for a caller that cast past the types.
- Each builder family's tRPC instance never leaves its `createCatalogBuilders` call, and its provenance is its own: a family's `catalogRouter` accepts only procedures its own builders made. There is no bare procedure builder.

**Where area routers live.**

- **Builders.** `@volli/session-rpc` exports `createCatalogBuilders<Ctx extends CatalogCallerContext, Entry = Verb Registry>()`. Each area router calls it once with its own context type, and gets its own `hostProcedure`, `workspaceProcedure` and `catalogRouter`. The Session router's family is `session-catalog.ts`.
- **Routers.** An area router lives at `packages/session-rpc/src/<area>-router.ts`, for example `board-router.ts` for VC-565. Its context is `CatalogCallerContext` (caller, `resourceWorkspace`, `sessionMayAct`, diagnostics) plus the area's ports.
- **Composition.** `packages/session-rpc/src/host-router.ts` holds the binding assertion over the union of every router's paths (the board router, the second, landed with VC-668). The router that composes the families into one served router lands there with VC-565; each family has its own tRPC instance today. Both doors mount that one router: desktop IPC through VC-608's bridge, and hostd's WebSocket.
- **Layering (D2).** host-core takes no `@trpc/server`. A router procedure never holds domain logic: it calls `ctx.handlers[key]`, the host's handler map. session-rpc cannot import host-core, so each family declares the slice it projects structurally (`SessionRouterHandlers`, `BoardRouterHandlers`), keyed by catalog key; a composition root hands it the router policy's view of host-core's map (`admittedHandlers(map, ROUTER_POLICY)`), and that assignment is where the two are checked against each other. Don't copy handler bodies into session-rpc, and don't add a fourth style.

#### One handler map (VC-668)

host-core exports one map from catalog key to handler (`@volli/host-core/handlers`). Each composition root builds it once, `createHostHandlers(ports, services)`, and hands the same object to every door: desktop's Session RPC bridge, its `volli:ticket-move` channel and its agent socket (`apps/desktop/src/main/index.ts`); hostd's agent socket (`apps/hostd/src/session-runtime.ts` builds it, `hostd.ts` hands it over), and its WebSocket when VC-663 mounts one. A root passes services (the database, the recovered runtime and Sessions facade, Model Access, Automations, the busy-worktree guard), never a port per behaviour.

What a root receives is sealed: a `HostHandlerMap` has no entry anyone can call. Its one invocation path is `invokeHandler(map, policy, key, input, call)`, or the `admittedHandlers(map, policy)` view built on it. Both run the door's `HandlerPolicy` first. A policy is transport-independent: it reads the key, the input and the `HandlerCall`, and imports neither tRPC nor Electron. A refusal throws `HandlerRefusedError` (`@volli/shared`), and the handler never runs. So D-A1's "one handler map plus the policy middleware" is the only path the type offers. A synchronous verdict over a synchronous handler answers synchronously.

- **A handler is the whole command.** `(input, call) => output`, where `call` (`HandlerCall`, `@volli/shared`) says only who the door authenticated, as host history attributes them, and `origin: "desktop-window"` for the desktop's own window. What a root used to write around a call (reconciling preferences after a refresh, the availability check before a default, the Role a ticket implies, resuming an Automation's delivery after attach, a deliberate move's armed arrival, its interrupts and its feed change) is the handler's.
- **Unavailable is an answer.** The map is total on every host. A service a host lacks this launch makes its handlers throw `OperationUnavailableError` (`@volli/shared`), which a router answers `NOT_IMPLEMENTED` / `operation-unavailable` and the socket `APP_UNREACHABLE`.
- **Doors are projections, each under its own policy.** Every door judges a call at the map, before the handler:
  - **Routers.** A router procedure calls `ctx.handlers[key](input, ctx.call)`. Its context holds the catalog's ports plus `handlers` and nothing else (`RouterContextPorts<Ctx>` is `never`). A root hands it `admittedHandlers(map, ROUTER_POLICY)`. `ROUTER_POLICY` judges the catalog entry again at the map: the router actor, `hostApi` for a network caller, and every declared entry for the desktop's own window. The router's middleware still judges first, together with what only it can read (a current credential, Workspace authorization, per-subject `sessionMayAct`). A refusal at the map answers `FORBIDDEN` / `verb-refused`, as the middleware does.
  - **The socket.** A socket verb for a catalog key is `projectHandler(key, { decode, envSession })` (`agent-dispatch/projection.ts`). `decode` maps display ids, `--dry-run` and refusals in, and a `reply` maps the answer out. The projection invokes the map under that request's `socketHandlerPolicy`. That policy is the socket's own coordination policy, judged again at the map, and it admits only the key the request's verb projects. It is deliberately not the router actor, so a Session that project policy admits keeps moving tickets over the socket. A refusal at the map answers `FORBIDDEN_ACTOR`.
  - **Legacy IPC.** A legacy per-channel IPC handler serving a catalog command (`volli:ticket-move`, until VC-565 deletes it) invokes the map under `DESKTOP_WINDOW_POLICY`. That policy admits only the desktop window's trusted call (`origin: "desktop-window"`), then applies the catalog's rule for it. It is synchronous, so the channel's synchronous reply stays synchronous.
- **Checked in CI.**
  - **Coverage.** `HostHandlerCoverage` fails `pnpm typecheck` when a catalog key (less `DOOR_LOCAL_CATALOG_KEYS`) has no handler signature, or a signature has no key. Each family's `…HandlersCoverage` does the same for its slice.
  - **Socket bindings.** `AGENT_VERB_TABLE`'s type demands `projectHandler`'s brand for every `SocketHandlerKey`, so a both-door verb with a handler of its own does not compile.
  - **The seal.** A sealed map has no callable entry. `package-interface.test.ts` (host-core) refuses the two ways around it, so a door can't run the move, or seal a map of its own, outside the policy path:
    - a production entry that serves `executeTicketMove` or `sealHostHandlers`;
    - a production importer of either, other than `handlers/host-handlers.ts`.
  - **Projections.** At runtime, `handler-projection.test.ts` (session-rpc) drives every procedure against a recording map and fails one that reaches any key but its own. `agent-dispatch.test.ts` (host-core) does the same for the socket, and `ticket-move-doors.contract.test.ts` (desktop) for `volli:ticket-move`.
  - **Policy order.** The contract test records each door's verdict at the map ahead of the handler on IPC, WebSocket and the socket, and proves a refusal never reaches it.
- **Both tiers (D-A1 = (c)): a prerequisite, not yet a fact.** The map's keys are the public catalog's keys alone: `HostHandlerKey` derives from `CatalogKey` (`packages/shared/src/handler-keys.ts`), and a desktop-only key does not compile in it. VC-608 reuses the invocation shape (a sealed map, a door policy, `admittedHandlers`), but before its generic bridge can serve a desktop-only channel from this map, it must change the key contract:
  1. Add a host-owned set of desktop-only keys, with descriptors that carry the channel's placement class. Electron channel vocabulary stays out of `@volli/shared`'s domain types.
  2. Make the map's key set the union of the public catalog keys and those desktop-only keys. Keep the coverage exhaustive over both.
  3. Derive the policy for each key from its placement: catalog policy for a public key, placement-class policy for a local one.

  Only then is "both tiers reach the same handler" the same fact of the type, and the bridge's projection check joins `handler-projection.test.ts`. Promoting an entry adds its catalog row and schemas, never a second handler.

**Adding a command** (what VC-565 onward copies). The worked example is a test-only area router, `packages/session-rpc/src/example-area.test-support.ts`, proven by `example-area.test.ts` through the real builders. It declares a `ticket.create`-like and a `ticket.move`-like command. The real first both-door command is `ticket.move` (`BOARD_ENTRIES`, `board-router.ts`, its handler in `createHostHandlers`).

A command's behaviour has one implementation location, the handler. Adding one is still several edits, each checked:

- the registry entry;
- the map's signature and body;
- the family's structural slice and its coverage;
- the procedure, with its schemas and resources;
- the socket projection, if the socket serves it;
- its row in `SAMPLE_INPUTS`.

Follow it step by step:

1. **Write the handler in the host's map.** Add the key's signature to `HostHandlerSignatures` and its body to `createHostHandlers` (`packages/host-core/src/handlers/host-handlers.ts`): the whole command, with every effect it has, from the services the root already passes. The handler holds no policy; each door's policy runs before it, at the map. `HostHandlerCoverage` fails `pnpm typecheck` until the key below is declared, and the map's tests (`host-handlers.test.ts`) prove the command once, whichever door calls it:

   ```ts
   readonly "ticket.move": HostHandler<TicketMoveCommandInput, Ticket[]>;   // HostHandlerSignatures

   "ticket.move": (input, call) =>                                            // createHostHandlers
     executeTicketMove({ /* worktree, interrupts, armed arrival, notify, feed */ }, input, {
       now: now(),
       actor: call.actor,
     }),
   ```

   Then **declare the entry** in `VERB_REGISTRY`. The example's entries are in `EXAMPLE_AREA_ENTRIES` so they need no registry row. A command both doors serve is **one** entry:

   ```ts
   {
     key: "ticket.create",                   // one identity; the router path is `ticket.create`
     accessModes: ["cli", "hostApi"],        // socket/CLI and WebSocket
     actor: "session",                        // what the socket judges, unchanged
     handler: { site: "main", id: "ticket.create" },
     // ...listed, group, summary, options as for any verb
     catalog: {
       actor: "session-own",                  // what a router judges: the person, or a Session its policy lets act
       scope: "workspace",
       idempotency: "command-id",
     },
   }
   ```

   `catalogEntriesFrom` refuses a router actor it can't judge and `session-own` on a host entry. Keep the area's rows in one typed array beside the registry, spread into `VERB_REGISTRY`, so the family can be typed by exactly its own entries:

   ```ts
   // packages/shared/src/verb-registry.ts
   export const BOARD_ENTRIES = [/* ticket.create, ticket.move, ... */] as const satisfies readonly VerbEntry[];
   export const VERB_REGISTRY = [/* ... */, ...BOARD_ENTRIES, /* ... */] as const satisfies readonly VerbEntry[];

   // packages/session-rpc/src/board-router.ts
   createCatalogBuilders<BoardRouterContext, (typeof BOARD_ENTRIES)[number]>({ entries: BOARD_ENTRIES });
   ```

   A family that passes neither type nor entries is typed across the whole registry and could build another area's key. Add the entry's rows to `verb-registry.test.ts`'s tier and catalog tables.
2. **Name its resources and its slice of the map.** Choose the area's resource kinds (`TICKET_RESOURCE = "ticket"`). Its context extends `CatalogCallerContext` with exactly one field, `handlers`: the slice of the host's map the area projects, declared structurally and keyed by catalog key (`ExampleAreaHandlers`, `BoardRouterHandlers`), with a `…HandlersCoverage` assertion against the family's keys and `RouterContextPorts<Ctx>` asserted `never`. It answers `resourceWorkspace` and `sessionMayAct` for its kinds only, `null`/`false` for any other (`exampleAreaContext`). `sessionMayAct` comes from the area's existing policy: the example's ledger lets every Session coordinating on a ticket act on it. The composition root hands it the host's one map, as `admittedHandlers(map, ROUTER_POLICY)`.
3. **Build the procedure** from the area's own family, `createCatalogBuilders<ExampleAreaContext, ExampleAreaEntry>()`, inside its `catalogRouter`. Give it both zod validators, and a resolver that names **every** resource the input addresses:

   ```ts
   move: workspaceProcedure(
     "ticket.move",
     z.object({ commandId, ticketId, afterTicketId: ticketId }),      // input validator
     (input) => [
       ticketResource(input.ticketId),                    // the subject: judged by sessionMayAct
       ticketResource(input.afterTicketId, "reference"),  // a reference: Workspace-checked only
     ],
   )
     .output(receiptSchema)                                           // output validator, required
     .mutation(({ ctx, input }) => ctx.handlers["ticket.move"](input, ctx.call)), // the one handler
   ```

   A new query or mutation with no `.output()` is refused at construction.
4. **Brand the intent conflict.** A `command-id` entry's handler reaches an intent ledger. That ledger throws an error implementing `CommandIntentConflict` (`ExampleIntentConflictError`) when a command id is reused with a different intent, and answers the same receipt for the same intent.
5. **Assert the binding, and project the socket verb.** `CatalogMismatch<ProcedurePaths<router>, keys>` must be `never` (`ExampleAreaCatalogBinding`; in production, the family's and `host-router.ts`'s union assertion). `pnpm typecheck` names a key missing on either side. A socket verb for the key becomes `projectHandler(key, { decode, envSession })` in `AGENT_VERB_TABLE`, whose type demands it; its old handler body becomes `decode` and `reply` (`ticketMoveDecode`). Add the key's sample input to `handler-projection.test.ts`'s `SAMPLE_INPUTS`, which is total over the served paths.
6. **Write its cases.** The example proves, through the real builders: the person is admitted; any Session the policy lets act on the subject is admitted (two Sessions on one ticket); a Session it doesn't is `FORBIDDEN`/`verb-refused` before the handler; a Session may land after a ticket only someone else works on (a reference); a cross-Workspace reference is still `NOT_FOUND`/`workspace-unknown`, exactly as an absent one; same id with the same intent replays; and another intent is `CONFLICT`/`command-conflict`. An area writes these once in its `describeContract`, so they run on every link.
7. **Delete the area's old per-channel IPC** in the same PR (below).

When a socket verb gains a `command-id` entry, the socket door mints a `commandId` per request; that mechanism lands with VC-565, the first ticket with such an entry.

**The handler is the whole command.** Post-commit effects belong to the handler or the host-core services it calls: the Done trim, armed arrivals, wake scopes, feed changes (F1). They never belong to a door. A door that needs extra behavior has found a missing field or a missing command.

**Output compatibility.** Widening an output's type union or nullability is breaking: an N−1 client cannot consume the new value. Closed `oneOf` unions fail closed. A genuinely tolerant-on-read output union may opt in with Zod `.meta({ "x-volli-open-union": "<discriminator>" })`; the gate permits only additions with provably disjoint discriminator `const`/`enum` values and preserves every existing variant. Inputs never gain that exception. Exactly two unions are marked open: Session event payload `kind` (the reader preserves the frame envelope with `event: null` for an unknown kind) and overlay delta `op` (the reader quietly drops an unknown transient delta). Receipt `status` and attention `kind` remain closed: today's N−1 reader rejects unknown values in their events, and an unknown command-result receipt status can be misreported as success. Adding either requires a protocol bump and an explicit compatibility exception; reader tolerance is separate future work. Other unions remain closed. A marker does not make the same-version host validator accept unknown writes; the host still emits its own exhaustive vocabulary. Do not mark a union open without a tolerant reader contract.

**Validation doors.** Every door validates inputs. Output parsers run on network doors and direct router tests, **not** on trusted in-process desktop IPC (including flag-off). The catalog keeps the same bound output schema for publication/type inference, but bypasses its middleware only for `transport: "electron-ipc"` with the reserved local actor; a network actor cannot use that bypass. Subscription yields retain their explicitly documented validation status. Compile-time recursive key exactness checks compare uncast inferred output shapes to the product types so optional fields cannot silently disappear through Zod object stripping.

**Doors are projections.** The tRPC area router (WebSocket, and IPC through VC-608's generic bridge), the agent socket, agent tools and the CLI each:

- map the name and envelope;
- project only the entries whose policy admits their actors;
- add no behavior.

A public procedure, socket verb or tool without an entry fails compilation, as `AGENT_VERB_TABLE` does today. Desktop-only bridge channels follow the placement-class policy above, not a public registry row per channel. The `hostApi` access mode is the WebSocket projection, and `verbTier` tiers a `hostApi`-only entry by the socket's actor rule: `any` reads, `user` coordinates, and a Role-gated verb cannot ride it. NDJSON v1 carries no command id, so when a socket verb binds a `command-id` entry the socket door mints one per request; a socket retry stays undeduplicated, as today.

**Migration, area by area.** It deletes per-channel IPC as each area moves:

1. VC-564 lands the entry shape, the policy middleware and the tRPC projection, with the Session router as the first area. The socket projection already dispatches through `AGENT_VERB_TABLE` and is unchanged. VC-608 lands the generic IPC bridge over the same routers. The socket read verbs are not projected onto `hostApi` in VC-564 (orchestrator ruling on D4): each selects across projects and returns opaque `data`, so serving one over a Workspace-bound connection needs forced Workspace scoping and recursive JSON validation. The Session reads (`session.list/show/peek/answer`) moved to VC-663: each keeps its socket entry (`actor: "any"`) and gains `hostApi` with a router policy of the person's (`catalog.actor: "user"`), a `projectId` input the catalog authorizes, and `z.json()` output validation. Their handler-map entries (VC-668) run the socket verb's own handler through host-core's `executeInWorkspace`, with its roster forced to that one project, so another Workspace's Session answers exactly as an absent one does; the router reaches them as `ctx.handlers[key]` under the router policy like any entry. They are the map's only *socket-delegated* keys (`SOCKET_DELEGATED_HANDLER_KEYS`, `@volli/shared`, a list that can only shrink): their socket binding stays the verb's own, since a projection of the map would call itself, until an area moves a read's logic into host-core and makes its socket verb a projection. They are the `session.read` feature. The board reads (`board`, `ticket.list/show/events`) move to VC-565 under a feature name of their own ([Handshake](#handshake-and-capabilities)).
2. Each area ticket (VC-565–573) moves its handler bodies out of `data-ipc.ts` into the shared handler map. Socket/CLI/agent and phone entries are public; desktop-only channels use the generic bridge and placement-class policy without a catalog rewrite. Where doors disagree, the stronger behavior wins and is tested on every door. `ticket.move` is the first public both-door entry (VC-668): one entry (`catalog: { actor: "user", scope: "workspace", idempotency: "natural" }`, column-only on the router), one handler, and three projections. VC-565 widens its router actor to `session-own` once the board's `sessionMayAct` exists, gives it its board-feature membership (VC-669), and decides whether it becomes a `command-id` entry.
3. Renderer calls go through the generic bridge: IPC locally, WebSocket remotely, the same handler either way. D-A2 retains the Mac's Electron host pending VC-691; flag-off is an in-process link swap, not a host handoff.
4. The same PR deletes the area's channels from `contract.ts`, `ipc-descriptors.ts` and `preload/index.ts`, with their handlers. No area keeps per-channel IPC beside its generic bridge or public router.

Client-local channels (VC-574's classification) remain desktop IPC and are not catalog entries.

## Commands, subscriptions and errors

Intent-recording mutations carry `HostCommandRequest<Command> { commandId, command }` plus their resource scope. Scope fields such as `sessionId` sit beside `commandId` in the procedure input (`{sessionId, commandId, command}`), as session-rpc does today, not inside the command envelope. New clients mint UUIDv4 keys and preserve them across reconnect/retry. Repeating the same key and intent returns the durable result without new intent/effect; a different intent under that key is `CONFLICT` / `command-conflict`. The Session engine owns transactional acceptance/delivery recovery, not the transport. Do not blindly replay a mutation with a new key after timeout.

Reuse `CommandReceipt`: `accepted` = durable acceptance, not applied; `completed` = effect recorded (the brief's “applied”); `rejected` = refused with code; `unreconciled` = delivery uncertain/recovering. `HostCommandResult` names the shared receipt/cursor minimum, not a replacement ledger schema. A null receipt is not completed. Existing Session result fields remain intact. `throughSequence` is a projection cursor, scoped to that Session/stream; observe the stream through that cursor before assuming the projection includes the command. Never compare unrelated streams' sequences.

Every durable subscription yields tRPC tracked `{id,data}` on the client. Resume with `lastEventId`; Session RPC uses decimal non-negative safe-integer cursors and `max(afterSequence,lastEventId)`, replaying strictly after it. Keep cursors per resource, accept duplicate ids, apply durable facts idempotently. Transient overlays may repeat the durable cursor and receive a fresh baseline on resume; do not deduplicate them as durable events. No global ordering is implied (BOUNDARIES rule 2); one Workspace's change feed orders only that Workspace's board changes, for resume (F1).

Bound server queues (Session RPC: 4096 frames). Overflow drains the contiguous buffered prefix then terminates with `TOO_MANY_REQUESTS` / `subscription-overflow`; source failure terminates with `INTERNAL_SERVER_ERROR` / `subscription-source-failed`. Never silently drop durable events or signal clean completion on a gap. Clients resume from the last **applied**, not merely received, id. Cancellation/disconnect removes listeners; transports must also bound outbound bytes/slow peers, not merely the router queue. If history retention removes the cursor, return `PRECONDITION_FAILED` / `subscription-resnapshot-required`, never pretend to resume. Hosts may also bound replay by event count and bytes (T3 Code's precedent is 128 events / 1 MiB); past either bound return the same `subscription-resnapshot-required` failure, never silently truncate. Volli's bounds are 4,096 events and 16 MiB per resume, on the WebSocket only (VC-663); Electron IPC keeps durable Session replay unbounded with the flag off. VC-315 sized them from a measured busiest Session-day (2,796 events, 9.3 MB of frames), replacing D9's 128 events / 1 MiB: a lid closed for a working day still resumes, and past that VC-315's client reloads a bounded tail. They live in one constant, `SUBSCRIPTION_REPLAY_BOUNDS` (`@volli/host-protocol`). The listener puts it in the context (`replayBounds`); `session.subscribe` refuses before opening its source when the head is more than 4,096 events past the cursor, and admits each replayed frame (events, and UTF-8 bytes of its JSON) **before staging it**: the first frame that would take either past its bound is refused, nothing more is staged, what was staged is discarded and the runtime's replay is cancelled through the subscription's `signal` (`SessionRuntime.subscribe`), so no more than the bounds is ever held for one resume. The stream answers `subscription-resnapshot-required` having sent nothing, and its listener is gone. On the WebSocket the stream's queue is bounded in bytes too (twice the replay bound), not only in frames. Any subscription that replays, a first one from cursor 0 included, is bounded, so a Client reads the snapshot first and subscribes from its cursor. The replay lands in the stream's 4,096-emission queue before its first yield, so a full 4,096-event resume plus its overlay baselines can still end in `subscription-overflow` after draining what it holds; the Client then resumes from its last applied id, which is now near the head. Each area must define its snapshot baseline and retention contract before migration.

### Snapshot and history (VC-315)

An area's snapshot is a **checkpoint plus a bounded tail**, never its whole log, and older history is a paged read. The Session router is the template; an area copies its shape and its rules.

- **Snapshot.** `session.snapshot({sessionId})` answers `{projection, throughSequence, frames, before, latestReply}`. `projection` is the checkpoint: complete current state, folded however the host likes. `frames` is the newest window of history, oldest first, ending exactly at `throughSequence`, so the state and the frames describe one moment and a subscription resumes strictly after it. `before` is the cursor for the history above the window, absent when the window starts at the first event. `latestReply` is the current turn's latest reply as text (`{sequence, text}`), wherever it sits, absent when it has said nothing. Both are omitted rather than `null`, so a snapshot that says neither is byte-for-byte the reply an older Client parses (the N−1 recording); a Client reads absent as `null`. `session.history` pages always carry `before`, `null` at the first event.
- **The checkpoint carries what a window cannot.** A Client holds only a window, so current state that used to be a fold over every message is in the projection. Each settled transcript message's reference is recorded with a digest (`transcript.referenced.digest`: its role, whether it said something, the todo list its plan call left), and the projection folds it: `todoList` is the plan as it stands (`[]` is a list the model cleared, absent is none recorded), and `latestReply` points at the current turn's latest reply, reset by every user message. The snapshot reads that one body to answer `latestReply`; inside the window it costs nothing. Events recorded before VC-315 have no digest and move neither field, so the host recovers that baseline itself (below).
- **History.** `session.history({sessionId, before})` answers `{frames, before}`: the newest window strictly below `before`, and the cursor for the window above that. Paging until `before` is `null` reaches every event exactly once, in order. The cursor is an event sequence and is scoped to its resource, like every Session cursor (rule 2).
- **The bound is the host's.** A window ends at whichever it meets first: **512 KiB** (UTF-8 JSON of the frames as one array, transcript artifacts inlined) or **256 frames**, counted from the newest backwards (`SESSION_HISTORY_WINDOW`, `@volli/session-engine`). The engine enforces it, so no door, link or caller can ask for more. One frame larger than the byte bound is returned alone: a window that could not hold the next frame would never advance, and dropping the frame is the silent gap this section forbids.
- **A legacy baseline is recovered once, host side.** The checkpoint says `baselineComplete` when its plan and reply baseline is whole: a fold from the first event that met only digests, or a host that recovered it. On an open whose checkpoint does not say so, the host scans the history backwards in indexed ranges, newest first, and stops at the first answer for each field: the newest message whose plan call left a list, and the newest assistant message that said something unless a user message (a submit, a steer, an interaction answer, a user transcript message) comes first. A digest answers for its own fact; a fact without one is read from its body, from the window when it holds it, otherwise from the store a read pool at a time. The worst case, a legacy Session that never wrote a plan, reads every legacy body once, which is what an open cost before the window. The result is written into the checkpoint with `baselineComplete`, so every later open is the bounded one; a checkpoint that is thrown away recovers again, the same. It is best effort: a body that cannot be read is skipped and reported, and nothing in it can fail an open. Clients see only `projection.todoList` and `latestReply`, as for a Session born with digests. `baselineComplete` is an optional field on the checkpoint, not a version bump: an older build ignores it, and a checkpoint it writes back costs one recovery, never a refold of every Session.
- **Selected, then hydrated.** A window is chosen from sizes, then exactly its own frames' bodies are read: nothing outside it is read for the window (the one-time legacy recovery above reads what it must, best effort), so a corrupt body outside the window cannot fail it. A candidate's size is its event envelope plus its artifact's persisted canonical size (`TranscriptArtifactStore.byteLength`): the file store reads a gzip artifact's trailer (ISIZE) or a legacy plain file's length, never the body, and needs no migration or backfill. A size the store cannot say (a missing or unreadable file) is taken only on a page of its own. The bound is checked again on what was hydrated, so a size that lied cannot carry an oversized page. What opening a Session costs is the window, at any age. Older bodies are read when a reader scrolls back to them.
- **Validation.** `session.history` binds an output schema: the envelope is checked, and each frame's event and transcript must be plain JSON. `session.snapshot` stays on the legacy list only for its projection.
- **The Client.** A Client applies a snapshot as one write. If its frames carry on from the transcript it holds, it appends them and keeps the history it already paged in. If they start past a gap, the transcript restarts from the window. A window that starts after the first event cannot say what its prefix said, so whether a turn is open and which interactions a receipt answers are read off the checkpoint. Older pages are applied only while the transcript still holds the cursor they answer.
- **Resnapshot is quiet.** On `PRECONDITION_FAILED` / `subscription-resnapshot-required` the Client reads a fresh snapshot and resubscribes after its `throughSequence`. It shows no error band and sends no notification, because nothing failed. One guard counts these reloads, cleared only by an emission (the replay or a baseline arriving), never by the transport's `started`: tRPC's WebSocket adapter says `started` before the first `next()` that runs the replay, so a refusal routinely follows it. The budget is per edge: one reload over Electron IPC, where only retention can refuse a cursor and a second refusal means the host is broken; three behind the [client host link](#the-client-host-link-vc-670), where a bounded resume can honestly be refused again while the head races ahead. Past it the stream is reported lost, never retried in a loop.
- **Version skew.** Today a Client and the host it reads ship together (the desktop and its bundled host). A new Client against a host that predates the bound gets the whole log and no `before`, and reads it as complete; an old Client against a new host gets a window and silently lacks the history above it. Behind the WebSocket, paging is its own feature, `sessions.history` (`sessions` is frozen, VC-669): a Client granted it knows the history above a window is there to read. Before Clients and hosts release independently, a Client that does not request it must not be left to silent tail-only history — refused, or served a different snapshot feature.

```ts
// Open: the checkpoint and the newest window. Here 153 frames, 514 KiB, from a 10,000-event Session.
const { projection, throughSequence, frames, before } =
  await client.session.snapshot.query({ sessionId });       // before === 9848
subscribe({ sessionId, afterSequence: throughSequence });   // resume strictly after the window
// Scroll back: one window at a time, until the cursor runs out.
const older = await client.session.history.query({ sessionId, before }); // frames < 9848
```

Measured by `session-engine/src/snapshot-replay-cost.bench.test.ts` (in-memory stores, so the times are a floor). Before VC-315, opening a 5,000-event Session sent 18.3 MB and read 3,567 artifacts. Now it sends 514 KiB and reads 109 artifact bodies, exactly the window's own, at 500, 1,000 or 10,000 events alike, in about 2 ms; paging back reads each body above it exactly once.

One client-visible error is `HostError {code,message,reason?}`. `HOST_ERROR_CODES` exhaustively matches tRPC's keys; `HOST_ERROR_REASON_CODES` pins each reason to its code. Non-tRPC doors use `HostResult<Data>` (`{ok:true,data}` / `{ok:false,error}`), reusing the IPC registry pattern. `readHostError` normalizes `data.hostError` and older `data.code` errors. Clients branch on code, optionally known reason, not message text; messages are sanitized and no stack/cause/secret crosses the wire. Unknown reasons must fall back to the code. No new custom tRPC error codes.

Since VC-564 the Session router builds the envelope once, in `hostErrorOf` (`@volli/session-rpc`): the code, the message through `sanitizeDiagnosticText`, and the reason a `HostProcedureError` named. Its tRPC `errorFormatter` attaches it as `data.hostError` with `isDev: false`, so no stack ships whatever `NODE_ENV` says. The Electron bridge sends the same envelope as its failure payload, `reason` included (`SessionRpcIpcError`), and the renderer link puts it on `data.hostError`, so one assertion reads both links. Reasons the router emits today: `workspace-unknown`, `verb-refused`, `credential-invalid`, `command-conflict` (only a command id reused for a different intent, from the engine or the runtime; any other ledger conflict keeps its old answer), `operation-unavailable`, `subscription-overflow`, `subscription-source-failed`, `subscription-resnapshot-required`, and on the WebSocket `subscription-limit` and `response-too-large`; through the listener's handshake also `hello-invalid`, `protocol-version-unsupported`, `workspace-epoch-fenced` and `workspace-split-brain`. `welcome-invalid` and `host-unreachable` (`SERVICE_UNAVAILABLE`) are the client's own (`validateWelcome`; the [client host link](#the-client-host-link-vc-670)).

At every router seam, assert `JsonUnsafeProcedures<Router>` is `never`; it applies `IsJsonSafe` to raw procedure input/output and subscription yield. Import from `@volli/host-protocol`; Session RPC re-exports for compatibility. Use numbers for timestamps, arrays/plain records instead of Date/Map/Set, nullable values or optional keys instead of required `undefined`. The checker deliberately tolerates opaque `unknown`/`any` for existing AI SDK types: it is not runtime validation. New opaque seams must validate JSON recursively before persistence/emission; finite numbers, no cycles, no functions/bigints/symbols. Keep validators transport-independent.

## Workspace change feed (F1)

Today board state reaches windows as `data-changed` pings (`ports/events.ts:94-100`). A host with no listener drops them, and a Client that slept has no cursor to resume from. Each Workspace instead has one change feed: a tracked subscription with the Session streams' resume contract.

- **Change.** `{kind, id, projectId?, ticketId?, op: "upsert" | "delete"}` names the entity that changed; it is never a diff.
  - Each area owns a closed set of kinds. VC-565 adds project, ticket, label, comment and ticket event; later areas add theirs. Session transcripts stay on Session streams.
  - A Client applies a change by re-reading that entity through its area query; an area may inline the current row. A delete is a tombstone.
  - Applying a change needs no predecessor, so duplicates and coalescing are harmless.
- **Stamp.** Every committed write of a fed kind appends its changes in the same synchronous turn as its COMMIT, before control returns to the event loop. That holds for every door, background job and Session. No committed change lacks a cursor, and none is announced before commit. The append sits at the write (repository and transaction gate), not at a door, so a background writer cannot skip it.
- **Cursor.** The tracked id is opaque to Clients. It encodes `(workspaceEpoch, feed instance, seq)`.
  - `seq` rises by one per stamp within a feed instance: one host process's feed for one Workspace.
  - It is not a durable id (rule 1). It is never compared across Workspaces, instances or epochs.
- **Snapshot.** Every area's snapshot query returns its data and the current cursor, read in one synchronous turn so no stamp falls between them. A Client subscribes from the oldest cursor among the snapshots it holds; replaying a change it already reflects is harmless.
- **Resume or resnapshot.** `lastEventId` replays strictly after the cursor, then goes live. These cursors are `PRECONDITION_FAILED` / `subscription-resnapshot-required`, and the Client re-reads its snapshots:
  - one from another epoch or feed instance;
  - one older than retention.

  Queue bounds, overflow and source failure follow the subscription rules above.
- **Retention.** The feed lives in host memory as a bounded window, compacted to the latest change per entity; tombstones are kept for the window.
  - A host restart starts a new instance, so Clients resnapshot. Durability can come later without a wire change, because the cursor is opaque.
  - Promotion (VC-591) raises the epoch, so every Client resnapshots against the new authority.
- **Cadence.** Live delivery may batch, on the host's cadence (F4); a batch's tracked id is its last cursor. Coalesce to the latest change per entity; never drop one.
- **BOUNDARIES rule 2.** That rule governs per-Session `sequence`. The feed cursor is the single authority's delivery order for one Workspace (Ruling 1), used only to resume. Every change names state, so no reducer reads meaning from its order or adjacency. Rule 2 now says so.
- **`data-changed`** remains the flag-off desktop invalidation; flag-on Clients read the feed. The topic is deleted with the board area's old path.

## Host events (F4)

Every fact a host announces is a `HostEventMap` topic, and no host code sends to `BrowserWindow` itself. Today three things fall short:

- shell state and browser-tab state skip the bus (`main/index.ts:405-416`);
- the coalescing cadence lives in desktop's adapter (`broadcast.ts:47-55`);
- `publish(topic, payload)` names no Workspace (`ports/events.ts:95-97`).

**Addressed.** `publish` takes a scope:

- a Workspace id: delivered only to connections authorized for that Workspace;
- `host`: facts about the host itself (version, health), delivered to every authenticated connection.

One Workspace's facts never reach another Workspace's connection.

**Classed.** A mapped type, exhaustive over `HostEventMap`, gives each topic a delivery class; a topic without one fails compilation. VC-664 classifies every existing topic, adding a fourth class, `addressed`, for the per-connection topics.

| Class | Meaning | Examples |
|---|---|---|
| feed | A durable change; it travels on the Workspace change feed (F1), not as a topic | `data-changed`, `session-retitled` once their areas move |
| overlay | Live state with a latest value, coalesced per key. Never a durable cursor. A (re)connecting Client subscribes, and the subscription's first yield is the baseline, taken in the same synchronous turn the listener is installed, so no change falls between them | `shell-state`, `browser-tab-state`, `worktree-phase`, `pending-armed-runs-changed` |
| notice | Ephemeral, for connections open at the time, dropped otherwise. Never the only carrier of a durable fact | `session-started`, `pending-armed-run-settled` |

**Cadence in host-core.** Coalescing (`data-change-coalescer.ts`) and any throttle move into host-core with the bus. Adapters (desktop windows, WebSocket connections) deliver what they are handed, within their outbound byte bounds.

**Addressed streams are unchanged.** Terminal, file and worktree watches stay on `HostClientEventSink`, to the one connection that subscribed.

VC-664 (part C of VC-564's split) adds scope and class to the bus, and moves the shell and browser-tab publishers onto it. VC-622's lift did not; VC-571 keeps browser control and the screencast.

## Binary framing

VC-568/571 implement this separate channel; no binary codec/listener ships here. A host operation authorizes a short-lived, single-use stream grant bound to actor, workspace, workspace epoch and resource. Upgrade consumes it; never expose a stable bearer in a URL. Promotion/revocation/cancel closes the stream. Stream ids are random UUIDv4s granted by the host, not guessed resource locators. tRPC controls attach/input/resize/ack/cancel and reports failures; raw bytes never enter a tRPC subscription. Blobs use authenticated HTTP with SHA-256 content addresses, byte length/content type metadata and digest verification; a digest is not authorization.

One WebSocket **binary message** is one frame: 32-byte header followed by payload (message length supplies payload length). All integers are big-endian. Header: bytes 0–3 ASCII `VLB1`; byte 4 framing version `1`; byte 5 kind (`1` terminal bytes, `2` screencast image); bytes 6–7 flags, zero in v1; bytes 8–23 stream UUID (16 raw bytes); bytes 24–31 unsigned sequence. Sequence starts at 1 per stream/channel attachment, strictly increases, is capped at `Number.MAX_SAFE_INTEGER`, and never identifies durable history. Unknown magic/version/kind/flags, ungranted stream, non-monotone sequence or an oversized payload closes the stream with an explicit control-plane error; no partial delivery. Maximum payload: terminal 64 KiB; image 8 MiB. Compression is off initially; separate channels isolate bulk traffic from control.

Terminal output is ordered/lossless within a connection: bound bytes in flight and pause its producer or terminate on lag; a gap requires explicit terminal resync, not ledger replay. Screencasts may drop **whole** stale frames before assigning sequence; at most one unsent image per stream, favor latest. Image encoding/dimensions are attach metadata (JPEG initially); do not mix metadata inside image bytes. No claim of resumable live processes or durable terminal/screencast history is made. The bulk-area contracts must test resource auth, limits, cancellation and gap behavior in addition to router contracts.

**Terminal resync is a screen, not a byte tail (F6).** Today an attachment opens with the raw retained tail (host-core README, Terminals), which can start inside an escape sequence. VC-568 replaces it:

1. The host keeps a headless emulator per terminal (`@xterm/headless`, the core of the renderer's `@xterm/xterm`) and feeds it every output batch.
2. Each attachment opens with that emulator's serialization (`@xterm/addon-serialize`: screen, bounded scrollback, modes, cursor, alternate screen) as its first frames.
3. The serialization reflects the output through one byte offset, the cut. The cut is taken only after the emulator has drained its writes up to it (xterm's `write` is asynchronous; use its completion callback), and only where the escape parser is in its ground state. Live frames start at the cut, so an escape sequence still open at the cut is sent whole, never as a suffix. No byte appears in both or in neither.

Attach metadata names the serializer version. The raw tail stays for CLI peek, which reads text.

## Host operations vs client-local

Classify by who owns the effect: durable workspace state or a worker-owned resource is a **host operation**, even if implemented beside Electron today. A presentation/native integration on the viewing device is **client-local**; it never needs a remote host's filesystem path. Split mixed operations into host data/intent and a local presentation action; no generic “execute on client” RPC.

| Surface | Client-local | Host operation |
|---|---|---|
| Window | Open/focus/close, menus, clipboard, native browser view | Session lifetime/commands, board state; app quit does not stop workers |
| Theme | Client theme/appearance preference, OS resolution, CSS application | No theme-rendering RPC; any workspace-shared preference must be explicitly reclassified by VC-574, not inferred from today's app_state |
| Update | Desktop updater/install/relaunch | Host/worker version and capabilities. The desktop installs and upgrades an exact-match hostd over SSH ([Decided 1](#decided-owner-2026-10-04)); any other host self-update is a separate authorized operation |
| Pick | Native file/folder chooser on this client | Upload chosen bytes via authorized blobs; remote path selection/listing uses host resource ids |
| Reveal | Finder/open external app on this client, only for an actual local locator | Resolve resource metadata/download; remote paths never sent blindly to Finder |

Files/search, worktrees, terminals, browser control/screencasts, MCP, model/secrets policy, automations, receipts and subscriptions follow the resource-owning host/worker, not the viewing desktop. VC-574's typed inventories are `apps/desktop/src/ipc/placement.ts` (channels/events, including the cursor overlay) and `packages/shared/src/app-state-keys.ts` (exact keys, prefixes and retired keys); this rule is the classification test, not a duplicate inventory.

### The Client is a connection (F2)

Today host-core asks one process-wide `client` (`ports/client.ts`) to open links, reveal paths, use the clipboard and show menus. It asks one `attention` port (`ports/attention.ts`) to deliver alerts synchronously and to say which Sessions are focused. With N Clients, "the client" has no referent, so each of these becomes a request to one connection.

**Connection.** `HostClientConnection` extends `HostClientEventSink` (a stable id and close hooks) with:

- the authenticated actor, its Workspace and its granted features;
- `request(intent)`, which resolves with the Client's answer or rejects (refused, unsupported, closed).

A desktop window on the in-process bridge is a connection, exactly as a WebSocket is. Command context carries the calling connection. `HostCorePorts.client` and `attention.focusedSessionIds` leave the process-wide ports.

**Who is asked.** The connection whose command caused the request, or, for a question an agent raised, the connection that answered it. Never a broadcast, never "any client". With no such connection the host refuses with `PRECONDITION_FAILED` / `client-capability-unavailable`: today's `ClientCapabilityUnavailableError`, now on the wire.

**Intents.** Each is sent only to a connection granted its `client.*` feature.

- `open-external {url}`: http(s) only, checked by the host and again by the Client.
- `reveal`: see Reveal below.
- `clipboard-write {text}`. The host never reads a Client's clipboard; text a command needs arrives as its input.
- Menus are client-local. The host returns items, and the choice arrives as a command; `showMenu` leaves the port.

**Attention.** Attention items are host data (VC-578). `deliver` becomes asynchronous:

- the host records the item and sends it to that Workspace's connections granted `client.notify`;
- the outcome it reports to `volli notify` aggregates their answers within a bound VC-578 sets;
- with no connection the outcome is `unsupported`, as `HEADLESS_ATTENTION` answers now.

**Focus and presence.** Each connection reports `{focused, visibleSessionIds}` through a presence procedure. The host's focused set is the union over that Workspace's focused connections, and a connection's share leaves when it closes. The read rule (`session-read-watch.ts`) and alert suppression keep asking this one source. The same record is Ruling 10's presence.

**Reveal.** `revealFile` (`volli-fs.ts:1078-1087`) resolves a host path and hands it to `revealInFolder`, the case the table above forbids.

- A host grants `client.reveal`, and sends a resolved path, only to a same-machine connection: one whose credential VC-577's local bootstrap issued to a Client on the host's machine.
- Same-machine is never inferred from a loopback peer address, because `tailscale serve` terminates on loopback.
- Other Clients get no Reveal. VC-567 moves it.

**Auth-callback relay.** MCP sign-in listens on the Host's loopback (`OAuthCallbackServer`, `mcp/oauth.ts:162-179`, `:690-709`) while the browser opens on the Client (`runtime-services.ts:72`).

- Against a remote Host, the redirect reaches the Client's own loopback, where nothing listens. MCP sign-in fails, with no fallback.
- Pi's sign-ins (Anthropic, OpenAI Codex/ChatGPT, OpenRouter) split the same way: pi-ai listens on the host, and the renderer opens `auth-url`. They degrade to the pasted-code prompt they already race against the callback.

The relay follows VS Code's `asExternalUri`, which makes a host loopback reachable from the Client, but for one request instead of a port:

1. The host starts its listener as today. It sends the asking connection `auth-callback {flowId, redirectUri}`, carrying the exact loopback URI it registered, then `open-external` for the authorization page.
2. A Client not on the host's machine binds that loopback host and port, accepts one request on that path, and sends `{flowId, pathAndQuery}` with `auth.callback.deliver`. Same-machine connections are not sent `auth-callback`: the browser already reaches the host's listener.
3. The host replays the request to its own listener, which checks `state` and exchanges the code with the PKCE verifier only the host holds. The Client shows the result page. Tokens never reach the Client.

The grant is single-use, bound to its flow and connection, and ends with the flow. A Client that cannot bind (the port is taken, or it is a phone or web Client) falls back to pasting the redirect URL. Pi has that path already; MCP must add it. Device-code flows need no relay. VC-570 builds the relay for MCP, VC-572 for Pi.

## Contract harness

Entry point: `@volli/host-protocol/testing` → `describeContract(title, links, cases)`. Each case runs unchanged against every `ContractLink<Host,Router>`; `connect(host)` returns a typed client and teardown closes all its connections/subscriptions. `webSocketContractLink` serves a router with stock tRPC adapters on an ephemeral loopback socket, JSON on the wire, from a context the link builds. `servedWebSocketContractLink({ serve, connectionParams })` instead connects the stock client to a server the host's own code starts, with per-connection params (a fresh hello): use it to run cases through the production listener's real handshake. The package root has no Node/Electron transport imports; `/testing` is dev/test-only and has no Electron dependency either.

The desktop's `session-rpc-contract.test-support.ts` composes today's **real** `registerSessionRpcIpcHandlers` and renderer `createSessionRpcClient`, using mocked ipcMain/WebContents with structured clone, plus the WS link to the same router. `session-rpc-contract.test.ts` covers strict query equality, model facade/unavailability, receipt passthrough, BAD_REQUEST, tracked ids/resume, overflow and source failure **on both links**, and since VC-564: a Session in another Workspace answering exactly as an absent one on query, mutation and subscribe; policy denial; `session.command`'s start kinds refused; command-id replay and conflict; and the identical `HostError` reason on each link. Both links judge the case's caller. Production IPC registration takes no caller and always binds the desktop's own window, so the IPC link applies the case's caller through a test-only router context: the contract test mocks `@volli/session-rpc` with `withHarnessIdentity` (`session-rpc-harness-identity.test-support.ts`), and the link refuses to open if that mock is missing. The WebSocket link runs the production listener (`startHostProtocolListener`): every connection says a fresh hello, a test verifier turns the harness credential into the case's caller, and the listener's handshake builds the context; nothing hands the router a context directly (VC-663). Existing direct-router tests remain the unit layer; this is the portable transport contract layer. Deliberately main-only lab diagnostics are not claimed to be portable host procedures.

### N−1 public wire recordings (VC-669)

`apps/desktop/src/main/session-rpc-wire-fixtures/n-minus-one.json` and `current.json` pin application-wire requests/responses (transport-local request ids are omitted): `session.projection` and `session.snapshot` queries, `session.command` with a stable command id/retry, tracked `session.subscribe` frames with a resume cursor, and a `workspace-unknown` reason envelope. `session-rpc-wire-compatibility.test.ts` runs **old client × new host** and **new client × old host** over both the real Electron IPC bridge/client link and loopback WebSocket adapters. The old peer's parser/router is frozen separately in `session-rpc-n-minus-one.test-support.ts`; it never imports today's catalog builders, output validators or renderer codec. New-client cases validate old-host output with today's published schemas; old-client cases use the frozen consumer parser.

Initial provenance is the pre-VC-669 HP-capable main revision `4c712841ae777dcc178d10552e7b0052fa905b81`, not a claim that the released v0.2.1 hostd serves HP. The frozen peer is a reconstructed representative four-operation subset, not a historical hostd binary. Pre-HP releases cannot participate. `handshake.test.ts` covers all four old/new desktop × hostd cells, negotiated feature subsets and incompatible protocol ranges in both skew directions; DB skew stays in VC-633's separate lanes.

**Refresh at an HP-capable release cut:** in a dedicated PR, preserve the release's public request/output validators and representative router behavior as the independent old peer, stamp its exact release tag and commit into the recordings, and move that release's captured requests/responses to `n-minus-one.json`. Capture current responses from a deterministic host fixture through each real adapter (never fabricate expected data by reading the response fixture back into the host). Keep command ids and cursor resume unchanged; add a fixture before promoting another public operation/feature. Update `current.json`, execute `session-rpc-wire-compatibility.test.ts` in both directions on both links, and run `pnpm check:protocol-schema --base <release-commit>`. Never refresh old fixtures just to make a breaking PR green: a supported peer remains frozen until the declared support window moves. Desktop-only bridge entries receive the schema diff, not this public-tier fixture ceremony.

An M2 ticket adds its typed router/context and IPC adapter, then writes cases once:

```ts
// @vitest-environment node
import { describeContract, webSocketContractLink } from '@volli/host-protocol/testing';
describeContract('Tickets', [
  ticketsIpcContractLink(), // real area's IPC bridge + client link; fake only Electron
  webSocketContractLink({ router: ticketsRouter, createContext: host => host }),
], ({ connect }) => {
  it('reads the same projection on both links', async () => {
    const client = await connect(ticketHostFixture());
    expect(await client.tickets.get.query({ ticketId })).toStrictEqual(expected);
  });
});
```

`ticket-move-doors.contract.test.ts` (desktop) is the first case that runs one command through all three doors at once: the desktop's `volli:ticket-move` channel, the board router over the WebSocket link, and the agent socket, all over one host handler map. It asserts:

- the same durable state, history and effects (the armed arrival, the backward-move interrupt, no notification for a person);
- replies that are equal up to their envelope;
- the one documented feed difference: the desktop window is not echoed the board change its reply already carries;
- each door's policy verdict at the map (`desktop-ipc`, `router`, `agent-socket`), recorded ahead of the handler;
- refusals that never reach the handler: a Session on the WebSocket, an anonymous socket caller, and a policy narrowed between the socket's dispatch and the map;
- a Done move over a real git worktree, through the worktree bundle production builds: a busy worktree refuses the trim on every door, and an idle one completes it detached, with its durable `worktree_trimmed` event, snapshot invalidation and `worktree` change on every door.

Add host-protocol as a **devDependency** for `/testing`; never import it in production. Use `recordSubscription` and `expectHostError` for shared subscription/error assertions. Each area adds command replay/conflict, scope denial, snapshot/resume and its own backpressure cases. Each catalog entry's cases run on every door that projects it, the agent socket included once VC-565 adds its link, where a command first exists on both doors: that is the check the `ticket.move` divergence lacked (F3). Each fed command asserts its change on the Workspace feed, and resume and resnapshot are tested per area (F1). VC-608 (on VC-542's list) owns a generic IPC bridge replacing `SESSION_RPC_IPC_PROCEDURES` and `callProcedure`, not a second routing framework in this PR.

Workspace glob `packages/*` includes this package in `pnpm typecheck` (`vp run -r typecheck`) and CI's `Test (packages)` (`test:coverage`); desktop contract cases run in desktop test shards. Owner review of this spec, particularly binary limits/bootstrap naming, is required before migration tickets copy it. VC-564/575 own runtime enforcement and production security; VC-550 defines the identity/fence contract; copy detection and promotion arbitration remain implementation requirements for restore/promotion (VC-591) and control-plane work. This package does not solve those by typing them.

## Decided (owner, 2026-10-04)

The four questions VC-630 raised are settled.

1. **The desktop provisions hostd over SSH** (lens A, candidate D; VC-615). "Add a host over SSH" probes the box, uploads the hostd that exactly matches the desktop's version, installs a systemd user unit and pairs, as VS Code Remote-SSH and Zed do. Upgrades take the same path. Pairing by code (`volli-hostd pair`) remains the fallback for a host that is already running. Version-range negotiation in the hello is the safety net, not the daily path.
2. **Every hostd, local included, runs standalone Chromium** (lens C, candidate C5; VC-619: Chromium over a CDP pipe, plus screencast). That is the one backend code path; `WebContentsView` becomes a viewer.
   - **Amended 2026-10-06 (post-M1 review), D-A2 = (b), pending VC-691.** The Mac's host is Electron main in menu-bar mode and retains its native `WebContentsView` backend; hostd/Chromium is for boxes. Local Chromium applies only if VC-691's launchd/keychain/TCC/signing spike reverses D-A2. The parity bar below is therefore for remote hosts, not a local-host cutover gate. Source: `.scratch/arch-review-m1/architecture-review-post-M1.html`, D-A2; owner approval on VC-542.
   - **Parity bar.** Remote Chromium must meet every point below (backend-parameterized capability tests and measured remote interaction):
     - **Agent capabilities:** every agent browser tool verb behaves identically on both backends, with the same results and refusals, proved by the backend-parameterized suite (VC-619).
     - **Latency:** the 95th-percentile time from a person's input in the view to the screencast frame showing its effect is at most 100 ms. The view shows at least 30 frames per second while the page changes.
     - **The person's interaction:** pointer, scroll, keyboard and text input (IME included), clipboard, navigation, and taking and releasing the browser hold all work in the view as they do in the panel today.
   - **Known residual: same-process `data:`, `blob:` and `srcdoc` iframes (VC-619, B6(c)).** On Chromium, every document request and redirect hop is held to HTTP(S) before it is sent (`Fetch` on the page's session and on every out-of-process iframe's session, the frame kept paused until its guard is installed). A main frame sent to anything else (its own `blob:`, an external scheme) is refused before it commits. What is **not** blocked: an iframe the page makes in its own process from a `data:` URL, a `blob:` URL or `srcdoc` loads and runs its script. Desktop's `will-frame-navigate` refuses all three. **Why:** these frames make no network request, so no `Fetch` guard sees them, and CDP has no per-frame refusal before commit (`Network.setBlockedURLs` does not cover them either). None gains a privilege the page lacks: `blob:` and `srcdoc` share its origin, and `data:` is opaque. **Rejected mechanisms:** injecting a `frame-src` CSP through `Fetch` response interception rewrites every document's headers, is visible to the page (`securitypolicyviolation`) and still misses `srcdoc`; removing the frame element races the commit and changes the page's DOM. **Pinned:** `packages/host-core/src/browser/chromium-backend.test.ts`, "guards frames", asserts the three run today and flips when a mechanism lands. **Gate:** VC-571 must enforce this rule, or keep the lent-view fallback below, before persons use hostd's browser.
   - **Extensibility.** The `BrowserBackend` seam stays open to further backends and capabilities, as optional members a host advertises. The owner has larger plans for the browser.
   - **Fallback.** If Chromium cannot meet the parity bar, the fallback is option (c): the desktop's own view is lent to a same-machine host while the desktop is attached, and Chromium is used otherwise.
3. **Key-bound identity lands in M2** (F5, VC-575). That covers host-key pinning at pairing, the welcome signed over the client nonce, and short-lived device and worker credentials that prove a key. Copy detection stays open.
4. **The amendments to BOUNDARIES rules 2 and 5 are approved** as written (F1, F3).

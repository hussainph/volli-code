# Host protocol v1

**Status:** owner-review draft, VC-549 (M0); production transport is VC-564. This PR adds only types, guards, tests and documentation: no listeners, auth or runtime routing are installed. [Volli Cloud](volli-cloud.md) is the ruling; [host identity](host-identity.md) (VC-550) owns identity lifetimes and persistence. With `cloud` off, today's app is unchanged.

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
| Control transport | tRPC v11 over WebSocket, default JSON, no transformer | One router and typed client for commands, queries and events; loopback exercises the remote path | `packages/session-rpc/src/index.ts`; stock `wsLink` / `applyWSSHandler` |
| `ws` dependency | Dev-only in `@volli/host-protocol`, only `/testing` imports it | Real wire tests without choosing or shipping the production listener here | VC-564 owns production transport |
| Bulk transport | Separate binary WebSocket; content-addressed HTTP for blobs | No base64 expansion (~33%); bulk bytes cannot head-of-line block command/event frames | Existing terminal bytes and CDP screencast; framing below |
| Handshake | Integer breaking version range; highest intersection; additive feature names | Explicit compatibility refusal; old clients ignore unknown capabilities rather than infer support from app version | `handshake.ts`; T3 environment descriptor (not its transport) |
| Identity / fencing | Welcome names host, workspace, epoch, signed by the host key the client pinned at pairing; both peers fence (F5) | Reconnect is not promotion; stale hosts cannot resume authority silently; a claimed UUID is not proof | VC-550; `checkWorkspaceFence`; Syncthing device ids, Tailscale node keys |
| Actors | Credential-derived `device \| session \| worker`, one workspace per connection | Client labels cannot claim authority; invalid auth never becomes a user | VC-163 socket honesty; VC-92 actor/verb policy |
| Workspace isolation | Authorize before resolving ids; cross-workspace = `NOT_FOUND` | Guessed UUIDs must neither access nor reveal another workspace | VC-320 C01 |
| Commands | Client-minted `commandId`, durable intent and receipt; `accepted` ≠ `completed` | Retries cannot duplicate intent; acceptance is not an applied effect | Session engine command/receipt model; BOUNDARIES rule 4 |
| Subscriptions | Tracked event ids, resume, bounded queue, explicit terminal error | A silent gap cannot look like clean completion | Session RPC `lastEventId`, `AsyncQueue` (4096) |
| Errors | `HostError { code, message, reason? }`; tRPC codes | Same branchable failure on either link, no thrown strings | IPC registry's result envelope + Session RPC's code/message |
| JSON seams | `IsJsonSafe` on every raw input/output, subscription yield included | Structured-clone success must not conceal JSON data loss | BOUNDARIES rule 3; moved checker, Session RPC re-export |
| Operation placement | Authority/resource ownership, not the caller's machine | One host API, no remote tools routed back to the desktop | Cloud rulings 1–3; classification below |
| Command catalog (F3) | One host-core entry per domain command; area routers, IPC, the agent socket and tools are projections | Three door vocabularies have already diverged; VC-92 policy is checked once | Verb Registry, `AGENT_VERB_TABLE` |
| Board delivery (F1) | One change feed per Workspace: tracked cursor, resume or resnapshot | Fire-and-forget `data-changed` pings vanish with no listener and cannot resume after a lid-close | Session stream contract below |
| Host events (F4) | Every host fact is a `HostEventMap` topic with a Workspace scope and a delivery class; cadence in host-core | Two topics bypass the bus; coalescing lives in an adapter; `publish` names no Workspace | `ports/events.ts` |
| Client capabilities (F2) | Requests to the one connection that asked; per-connection focus and presence; auth-callback relay | A process-wide `client` means nothing with N Clients; remote OAuth fails | `HostClientEventSink`; VS Code `asExternalUri` |

## Handshake and capabilities

`HOST_PROTOCOL_VERSION = HOST_PROTOCOL_MIN_VERSION = 1`. A breaking semantic or wire change raises the integer; supported ranges must describe versions actually implemented. Additive procedures/optional fields use named features (`sessions`, `terminals.stream`, etc.; lowercase dotted words, ≤128 characters, ≤256 requested features). Names have fixed semantics; incompatible semantics need a new name or protocol version. Absent means unsupported; unknown names are ignored. The welcome grants the deduplicated intersection of requested features and those the host serves **to this actor**. Capability advertisement is not authorization. Features under `client.` run the other way (F2): requesting `client.open-external` declares that this Client performs the intent, and the grant means this host may send it ([The Client is a connection](#the-client-is-a-connection-f2)).

The client sends `encodeHostHello(hello)` as tRPC `connectionParams`, under `volli-hello` (a JSON string). `HostHello` contains `{protocol:{min,max}, client:{kind,version}, workspaceId, lastSeen, features, credential}`. `client.kind` is desktop/web/mobile/cli/worker, self-description only; it never selects an actor. Missing/malformed hello is `BAD_REQUEST` / `hello-invalid`; missing/expired/revoked credentials are `UNAUTHORIZED` / `credential-invalid`. Credentials are never logged, embedded in URLs, recorded as diagnostics or put in the welcome. Use WSS outside loopback; private-network routing does not remove authentication.

VC-564 authenticates and negotiates in connection context before executing any area procedure. A base-v1 `protocol.welcome` query returns the immutable negotiated `HostWelcome`; this bootstrap query is not feature-gated. VC-564 implements runtime welcome validation before area calls/subscriptions; the interface alone is not validation and this package currently guards only hellos. Welcome is `{protocolVersion, host:{id,version}, workspace:{id,epoch}, actor, features}`. The identity spec's `workspaceEpoch` is encoded as welcome `workspace.epoch` and hello `lastSeen.epoch` (when non-null); preserve these nested v1 wire fields, not a flattened or renamed `workspaceEpoch` field. The client checks selected version, requested workspace, actor workspace and granted-feature subset. It verifies the welcome's host-key proof against the key it pinned for `host.id` at pairing (F5). Only then does it apply the fence and record the authority before becoming ready. VC-575 adds the hello nonce and the welcome proof to v1 itself, not as a feature a downgrade could strip: v1 has no production listener before VC-564. Reconnect repeats the handshake; it is not implicit acceptance of a new host. A rejected handshake cannot leave an authenticated half-open subscription.

VC-550 agreement: host id is UUIDv4, host-local, **not** `installationId`. Backup bundles omit it, so a bundle restore mints a new host id and re-enrolls devices/workers. A raw profile copy instead duplicates the singleton: detection is not implemented, and the copy must not serve until detection/re-enrollment establishes a fresh identity. Workspace id is existing `projects.id` and travels with it. Epoch 0 means never served under the flag; first validated serve is 1. Promotion raises the latest known fence (normally max+1) **only after authority validation/arbitration**; a lagging replica's local MAX(epoch)+1 proves no exclusivity. Keep the highest accepted `{epoch,hostId}` per workspace. `checkWorkspaceFence` rejects a lower epoch (`workspace-epoch-fenced`) and equal epoch/different host (`workspace-split-brain`); on split brain stop using both, retain the conflict and require an explicit fenced promotion. A higher epoch may name a new host only after authentication and authority/promotion validation. The pin survives client/worker restarts. The helper alone is not control-plane compare-and-swap, conflict persistence or durable authority storage.

T3 is a precedent for **readiness gated by an environment descriptor and absence-safe capabilities**, not tRPC or dotted features: its [client session](https://github.com/pingdotgg/t3code/blob/main/packages/client-runtime/src/rpc/session.ts) waits for the first server-config snapshot and checks environment identity; [environment contract](https://github.com/pingdotgg/t3code/blob/main/packages/contracts/src/environment.ts) carries optional capabilities and an orchestration version; [remote policy](https://github.com/pingdotgg/t3code/blob/main/docs/internals/remote.md) requires clients to respect missing capabilities. T3 uses Effect RPC and upgrade-level orchestration-version checks; Volli reuses its own tRPC router instead.

## Auth and workspace authorization

VC-575 owns pairing, token format/storage/rotation/revocation. Device credentials come from pairing and bind `(deviceId, workspaceId)` and the issuing host; session credentials bind a durable Session to that workspace; worker credentials bind an enrolled worker to that workspace. A device or worker credential is short-lived and obtained by proving the key pinned at pairing or registration, so revocation drops a public key and a phone holds no long-lived bearer secret (F5, [Keys](host-identity.md#keys-proof-behind-the-names)). A host serving several workspaces requires a separate authorized connection per workspace. The host derives the actor from credential verification, never hello fields, a supplied Session id or transport location. `isHostActor` validates grammar, **not** authority; actors' `sessionId` tolerates the bounded legacy identifiers accepted by session-rpc, while new Session ids are UUIDv4.

Carry VC-92's read / coordination / control policy into per-procedure middleware. A paired device maps to today's `user` policy actor (human intent, not an agent control tier). A Session retains its birth-frozen Role tool surface and scope. Agent control travels through a worker only on behalf of a Session it hosts, checked against that Session's frozen grants; worker identity alone confers no control tier. The paired-device human routes remain available under user policy. Today's socket is read/coordination only; control remains tool-only, not newly exposed by a token. Declare policy for every procedure, exhaustive on additions, and check grants/revocation at dispatch, not only handshake. VC-564 must adapt the reserved `hostApi` verb projection and worker delegation explicitly; today's registry cannot tier hostApi-only verbs or authorize workers. A bad agent credential is refused, never downgraded to user (VC-163).

Context carries the authorized workspace; inputs cannot override it. Every ticket, Session, terminal, artifact, blob, subscription and worker lookup verifies workspace ownership **before** returning data or mutating. Cross-workspace ids and absent ids have the same `NOT_FOUND` answer (`workspace-unknown`), including subscriptions and bulk-channel grants. Policy denial within the workspace is `FORBIDDEN` / `verb-refused`. A promoted authority rejects old-epoch writes; worker checkout writes additionally carry `(workspaceEpoch, leaseEpoch)`, ordered lexicographically, and must equal the current live, unexpired per-ticket grant for the authenticated worker. A claimed higher token is not authorization. Lease epochs belong on writes, not the hello; a valid workspace connection is not a checkout lease.

## Command catalog (F3)

Desktop has three verb vocabularies:

- about 245 per-channel `volli:` IPC channels (`apps/desktop/src/ipc/contract.ts`);
- the Session tRPC router;
- the agent verb table (`shared/src/verb-registry.ts`, `host-core/src/agent-dispatch/table.ts`).

They have already diverged. The renderer's `volli:ticket-move` trims a newly Done worktree at once (`data-ipc.ts:591-606, 922-955`); socket `ticket.move` (`ticket-verbs.ts:349-490`) leaves it to the 60-second retention poll. M2's area routers must not become a fourth vocabulary.

**One entry per domain command.** The Verb Registry (`@volli/shared`, pure data) is the catalog's declaration half and host-core's `AGENT_VERB_TABLE` its binding half. Both grow to cover human commands; no second table appears beside them. An entry carries:

- its dot-name: one identity on every door, chosen once;
- JSON input/output validators, transport-independent (BOUNDARIES rule 3);
- its Workspace resource scope, resolved and authorized before the handler runs (cross-Workspace is `NOT_FOUND`);
- actor policy: which actor kinds may call it (paired device as `user`, Session, worker on a hosted Session's behalf). Tiers stay derived from access modes and actor requirement, never stored (VC-92). Human and agent policy may differ for one command;
- idempotency: `command-id` (intent-recording: `HostCommandRequest`, durable receipt), `natural` (a repeat leaves the same state) or `read`;
- exactly one handler.

**The handler is the whole command.** Post-commit effects belong to the handler or the host-core services it calls: the Done trim, armed arrivals, wake scopes, feed changes (F1). They never belong to a door. A door that needs extra behavior has found a missing field or a missing command.

**Doors are projections.** The tRPC area router (WebSocket, and IPC through VC-608's generic bridge), the agent socket, agent tools and the CLI each:

- map the name and envelope;
- project only the entries whose policy admits their actors;
- add no behavior.

A procedure, socket verb or tool without an entry fails compilation, as `AGENT_VERB_TABLE` does today. The reserved `hostApi` access mode becomes the WebSocket projection. NDJSON v1 carries no command id, so the socket door mints one per request; a socket retry stays undeduplicated, as today.

**Migration, area by area.** It deletes per-channel IPC as each area moves:

1. VC-564 lands the entry shape, the policy middleware, and the tRPC and socket projections, with Sessions as the first area. VC-608 lands the generic IPC bridge over the same routers.
2. Each area ticket (VC-565–573) moves its handler bodies out of `data-ipc.ts` and its socket verbs into entries. Where doors disagree, the stronger behavior wins and is tested on every door: VC-565 makes `ticket.move` trim on Done from every door.
3. Renderer calls go through the generic bridge: in-process IPC with the flag off, WebSocket with it on, the same procedures either way.
4. The same PR deletes the area's channels from `contract.ts`, `ipc-descriptors.ts` and `preload/index.ts`, with their handlers. No area keeps per-channel IPC beside its router.

Client-local channels (VC-574's classification) remain desktop IPC and are not catalog entries.

## Commands, subscriptions and errors

Intent-recording mutations carry `HostCommandRequest<Command> { commandId, command }` plus their resource scope. Scope fields such as `sessionId` sit beside `commandId` in the procedure input (`{sessionId, commandId, command}`), as session-rpc does today, not inside the command envelope. New clients mint UUIDv4 keys and preserve them across reconnect/retry. Repeating the same key and intent returns the durable result without new intent/effect; a different intent under that key is `CONFLICT` / `command-conflict`. The Session engine owns transactional acceptance/delivery recovery, not the transport. Do not blindly replay a mutation with a new key after timeout.

Reuse `CommandReceipt`: `accepted` = durable acceptance, not applied; `completed` = effect recorded (the brief's “applied”); `rejected` = refused with code; `unreconciled` = delivery uncertain/recovering. `HostCommandResult` names the shared receipt/cursor minimum, not a replacement ledger schema. A null receipt is not completed. Existing Session result fields remain intact. `throughSequence` is a projection cursor, scoped to that Session/stream; observe the stream through that cursor before assuming the projection includes the command. Never compare unrelated streams' sequences.

Every durable subscription yields tRPC tracked `{id,data}` on the client. Resume with `lastEventId`; Session RPC uses decimal non-negative safe-integer cursors and `max(afterSequence,lastEventId)`, replaying strictly after it. Keep cursors per resource, accept duplicate ids, apply durable facts idempotently. Transient overlays may repeat the durable cursor and receive a fresh baseline on resume; do not deduplicate them as durable events. No global ordering is implied (BOUNDARIES rule 2); one Workspace's change feed orders only that Workspace's board changes, for resume (F1).

Bound server queues (Session RPC: 4096 frames). Overflow drains the contiguous buffered prefix then terminates with `TOO_MANY_REQUESTS` / `subscription-overflow`; source failure terminates with `INTERNAL_SERVER_ERROR` / `subscription-source-failed`. Never silently drop durable events or signal clean completion on a gap. Clients resume from the last **applied**, not merely received, id. Cancellation/disconnect removes listeners; transports must also bound outbound bytes/slow peers, not merely the router queue. If history retention removes the cursor, return `PRECONDITION_FAILED` / `subscription-resnapshot-required`, never pretend to resume. Hosts may also bound replay by event count and bytes (T3 Code's precedent is 128 events / 1 MiB); past either bound return the same `subscription-resnapshot-required` failure, never silently truncate. VC-564 picks Volli's bounds; each area must define its snapshot baseline and retention contract before migration.

One client-visible error is `HostError {code,message,reason?}`. `HOST_ERROR_CODES` exhaustively matches tRPC's keys; `HOST_ERROR_REASON_CODES` pins each reason to its code. Non-tRPC doors use `HostResult<Data>` (`{ok:true,data}` / `{ok:false,error}`), reusing the IPC registry pattern. VC-564 attaches the envelope at tRPC `data.hostError`; `readHostError` normalizes it and today's IPC/WS `data.code` errors. Existing Session RPC does **not** yet emit the new reasons or map engine/runtime command conflicts to `CONFLICT`; VC-564 owns those mappings, along with sanitizing WS error messages. The harness asserts existing codes, not unimplemented enforcement. Clients branch on code, optionally known reason, not message text; messages are sanitized and no stack/cause/secret crosses the wire. Unknown reasons must fall back to the code. No new custom tRPC error codes.

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

- shell state and browser-tab state skip the bus (`main/index.ts:540-552`);
- the coalescing cadence lives in desktop's adapter (`broadcast.ts:47-55`);
- `publish(topic, payload)` names no Workspace (`ports/events.ts:95-97`).

**Addressed.** `publish` takes a scope:

- a Workspace id: delivered only to connections authorized for that Workspace;
- `host`: facts about the host itself (version, health), delivered to every authenticated connection.

One Workspace's facts never reach another Workspace's connection.

**Classed.** A mapped type, exhaustive over `HostEventMap`, gives each topic a delivery class; a topic without one fails compilation. VC-564 classifies every existing topic.

| Class | Meaning | Examples |
|---|---|---|
| feed | A durable change; it travels on the Workspace change feed (F1), not as a topic | `data-changed`, `session-retitled` once their areas move |
| overlay | Live state with a latest value, coalesced per key. Never a durable cursor. A (re)connecting Client subscribes, and the subscription's first yield is the baseline, taken in the same synchronous turn the listener is installed, so no change falls between them | `shell-state`, `browser-tab-state`, `worktree-phase`, `pending-armed-runs-changed` |
| notice | Ephemeral, for connections open at the time, dropped otherwise. Never the only carrier of a durable fact | `session-started`, `pending-armed-run-settled` |

**Cadence in host-core.** Coalescing (`data-change-coalescer.ts`) and any throttle move into host-core with the bus. Adapters (desktop windows, WebSocket connections) deliver what they are handed, within their outbound byte bounds.

**Addressed streams are unchanged.** Terminal, file and worktree watches stay on `HostClientEventSink`, to the one connection that subscribed.

VC-564 adds scope and class to the bus. VC-622's lift moves the shell and browser-tab publishers onto it.

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
| Update | Desktop updater/install/relaunch | Host/worker version and capabilities; any future host self-update is a separate authorized operation |
| Pick | Native file/folder chooser on this client | Upload chosen bytes via authorized blobs; remote path selection/listing uses host resource ids |
| Reveal | Finder/open external app on this client, only for an actual local locator | Resolve resource metadata/download; remote paths never sent blindly to Finder |

Files/search, worktrees, terminals, browser control/screencasts, MCP, model/secrets policy, automations, receipts and subscriptions follow the resource-owning host/worker, not the viewing desktop. VC-574 inventories every channel/app_state key; this rule is the classification test, not that inventory.

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

Entry point: `@volli/host-protocol/testing` → `describeContract(title, links, cases)`. Each case runs unchanged against every `ContractLink<Host,Router>`; `connect(host)` returns a typed client and teardown closes all its connections/subscriptions. `webSocketContractLink` serves the real router with stock tRPC adapters on an ephemeral loopback socket, JSON on the wire. It is not a fake serializer or production listener. The package root has no Node/Electron transport imports; `/testing` is dev/test-only and has no Electron dependency either.

The desktop's `session-rpc-contract.test-support.ts` composes today's **real** `registerSessionRpcIpcHandlers` and renderer `createSessionRpcClient`, using mocked ipcMain/WebContents with structured clone, plus the WS link to the same router. `session-rpc-contract.test.ts` covers strict query equality, model facade/unavailability, receipt passthrough, BAD_REQUEST, tracked ids/resume, overflow and source failure **on both links**. Existing direct-router tests remain the unit layer; this is the portable transport contract layer. Deliberately main-only lab diagnostics and legacy IPC-only start guards are not claimed to be portable host procedures.

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

Add host-protocol as a **devDependency** for `/testing`; never import it in production. Use `recordSubscription` and `expectHostError` for shared subscription/error assertions. Each area adds command replay/conflict, scope denial, snapshot/resume and its own backpressure cases. Each catalog entry's cases run on every door that projects it, the agent socket included once VC-564 adds its link: that is the check the `ticket.move` divergence lacked (F3). Each fed command asserts its change on the Workspace feed, and resume and resnapshot are tested per area (F1). VC-608 (on VC-542's list) owns a generic IPC bridge replacing `SESSION_RPC_IPC_PROCEDURES` and `callProcedure`, not a second routing framework in this PR.

Workspace glob `packages/*` includes this package in `pnpm typecheck` (`vp run -r typecheck`) and CI's `Test (packages)` (`test:coverage`); desktop contract cases run in desktop test shards. Owner review of this spec, particularly binary limits/bootstrap naming, is required before migration tickets copy it. VC-564/575 own runtime enforcement and production security; VC-550 defines the identity/fence contract; copy detection and promotion arbitration remain implementation requirements for restore/promotion (VC-591) and control-plane work. This package does not solve those by typing them.

## Open decisions for the owner

1. **Provisioning hostd over SSH** (lens A, candidate D; ties into VC-615's open decisions). Should the desktop ship the matching hostd and install or upgrade it over SSH, as Zed and VS Code Remote-SSH do (probe → upload → systemd user unit → pair), with later updates draining and restarting when idle, as Amp runners do?
   - **Yes:** version-range negotiation becomes the safety net rather than the daily path, and VC-615's "Add a host over SSH" is the main path. Costs: a hostd artifact per platform in each desktop release, an SSH client in the desktop, and an authorized host self-update (the Update row above).
   - **No:** operators install the tarball, the hello's version refusal is the daily path, and VC-615 designs around it.
   - Decide before VC-615 picks a direction and before VC-579's dogfood week.
2. **Where the agent browser backend lives for a local hostd** (lens C, candidate C5; Rulings 2, 3 and 8; VC-619). Once the desktop always talks to a host, the `WebContentsView` backend sits in a process that is now a Client.
   - **(a) Standalone Chromium on every hostd, local included** (VC-619). WebContentsView becomes viewer-only: the browser pane renders screencast frames and forwards input under the browser hold, as for a remote host. One backend kind per host, and agent browsing outlives app quit. Costs: a Chromium install on every Mac, and the person co-drives through screencast rather than the native view (native dialogs, passkeys and extensions behave differently).
   - **(b) The desktop lends its WebContentsView backend to a same-machine hostd** as a connection capability. Native fidelity, but agent browsing stops when the app quits, which is against the M2 demo, and agent tools run on a Client, which Ruling 3 forbids for remote hosts.
   - **(c) Both, chosen per Session at birth** from the host's capabilities (lens C, candidate C2). Two backend kinds per host.
   - Decide before the VC-577 and VC-571 briefs are expanded.
3. **Key-bound identity in M2** (F5, VC-575). The identity spec now requires host keys and key-proved, short-lived device and worker credentials before any device pairs. Confirm that, or choose bearer device tokens for M2 and keys before M5 (phones); the later choice means every device pairs again when keys arrive.
4. **BOUNDARIES rules 2 and 5** (F1, F3). This revision amends both. Rule 2 now says the Workspace feed cursor is outside it. Rule 5 now names the command catalog as the one place a new domain command is declared. Approve these with the spec.

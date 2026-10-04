# Host protocol v1

**Status:** owner-review draft, VC-549 (M0); production transport is VC-564. This PR adds only types, guards, tests and documentation: no listeners, auth or runtime routing are installed. [Volli Cloud](volli-cloud.md) is the ruling; [host identity](host-identity.md) (VC-550) owns identity lifetimes and persistence. With `cloud` off, today's app is unchanged.

## Decisions

| Decision | Choice | Reason | Precedent / code reused |
|---|---|---|---|
| Control transport | tRPC v11 over WebSocket, default JSON, no transformer | One router and typed client for commands, queries and events; loopback exercises the remote path | `packages/session-rpc/src/index.ts`; stock `wsLink` / `applyWSSHandler` |
| `ws` dependency | Dev-only in `@volli/host-protocol`, only `/testing` imports it | Real wire tests without choosing or shipping the production listener here | VC-564 owns production transport |
| Bulk transport | Separate binary WebSocket; content-addressed HTTP for blobs | No base64 expansion (~33%); bulk bytes cannot head-of-line block command/event frames | Existing terminal bytes and CDP screencast; framing below |
| Handshake | Integer breaking version range; highest intersection; additive feature names | Explicit compatibility refusal; old clients ignore unknown capabilities rather than infer support from app version | `handshake.ts`; T3 environment descriptor (not its transport) |
| Identity / fencing | Welcome names host, workspace, epoch; both peers fence | Reconnect is not promotion; stale hosts cannot resume authority silently | VC-550; `checkWorkspaceFence` |
| Actors | Credential-derived `device \| session \| worker`, one workspace per connection | Client labels cannot claim authority; invalid auth never becomes a user | VC-163 socket honesty; VC-92 actor/verb policy |
| Workspace isolation | Authorize before resolving ids; cross-workspace = `NOT_FOUND` | Guessed UUIDs must neither access nor reveal another workspace | VC-320 C01 |
| Commands | Client-minted `commandId`, durable intent and receipt; `accepted` ≠ `completed` | Retries cannot duplicate intent; acceptance is not an applied effect | Session engine command/receipt model; BOUNDARIES rule 4 |
| Subscriptions | Tracked event ids, resume, bounded queue, explicit terminal error | A silent gap cannot look like clean completion | Session RPC `lastEventId`, `AsyncQueue` (4096) |
| Errors | `HostError { code, message, reason? }`; tRPC codes | Same branchable failure on either link, no thrown strings | IPC registry's result envelope + Session RPC's code/message |
| JSON seams | `IsJsonSafe` on every raw input/output, subscription yield included | Structured-clone success must not conceal JSON data loss | BOUNDARIES rule 3; moved checker, Session RPC re-export |
| Operation placement | Authority/resource ownership, not the caller's machine | One host API, no remote tools routed back to the desktop | Cloud rulings 1–3; classification below |

## Handshake and capabilities

`HOST_PROTOCOL_VERSION = HOST_PROTOCOL_MIN_VERSION = 1`. A breaking semantic or wire change raises the integer; supported ranges must describe versions actually implemented. Additive procedures/optional fields use named features (`sessions`, `terminals.stream`, etc.; lowercase dotted words, ≤128 characters, ≤256 requested features). Names have fixed semantics; incompatible semantics need a new name or protocol version. Absent means unsupported; unknown names are ignored. The welcome grants the deduplicated intersection of requested features and those the host serves **to this actor**. Capability advertisement is not authorization.

The client sends `encodeHostHello(hello)` as tRPC `connectionParams`, under `volli-hello` (a JSON string). `HostHello` contains `{protocol:{min,max}, client:{kind,version}, workspaceId, lastSeen, features, credential}`. `client.kind` is desktop/web/mobile/cli/worker, self-description only; it never selects an actor. Missing/malformed hello is `BAD_REQUEST` / `hello-invalid`; missing/expired/revoked credentials are `UNAUTHORIZED` / `credential-invalid`. Credentials are never logged, embedded in URLs, recorded as diagnostics or put in the welcome. Use WSS outside loopback; private-network routing does not remove authentication.

VC-564 authenticates and negotiates in connection context before executing any area procedure. A base-v1 `protocol.welcome` query returns the immutable negotiated `HostWelcome`; this bootstrap query is not feature-gated. VC-564 implements runtime welcome validation before area calls/subscriptions; the interface alone is not validation and this package currently guards only hellos. Welcome is `{protocolVersion, host:{id,version}, workspace:{id,epoch}, actor, features}`. The client checks selected version, requested workspace, actor workspace and granted-feature subset, then applies the fence and records the authority before becoming ready. Reconnect repeats the handshake; it is not implicit acceptance of a new host. A rejected handshake cannot leave an authenticated half-open subscription.

VC-550 agreement: host id is UUIDv4, host-local, **not** `installationId`. Backup bundles omit it, so a bundle restore mints a new host id and re-enrolls devices/workers. A raw profile copy instead duplicates the singleton: detection is not implemented, and the copy must not serve until detection/re-enrollment establishes a fresh identity. Workspace id is existing `projects.id` and travels with it. Epoch 0 means never served under the flag; first validated serve is 1. Promotion raises the latest known fence (normally max+1) **only after authority validation/arbitration**; a lagging replica's local MAX(epoch)+1 proves no exclusivity. Keep the highest accepted `{epoch,hostId}` per workspace. `checkWorkspaceFence` rejects a lower epoch (`workspace-epoch-fenced`) and equal epoch/different host (`workspace-split-brain`); on split brain stop using both, retain the conflict and require an explicit fenced promotion. A higher epoch may name a new host only after authentication and authority/promotion validation. The pin survives client/worker restarts. The helper alone is not control-plane compare-and-swap, conflict persistence or durable authority storage.

T3 is a precedent for **readiness gated by an environment descriptor and absence-safe capabilities**, not tRPC or dotted features: its [client session](https://github.com/pingdotgg/t3code/blob/main/packages/client-runtime/src/rpc/session.ts) waits for the first server-config snapshot and checks environment identity; [environment contract](https://github.com/pingdotgg/t3code/blob/main/packages/contracts/src/environment.ts) carries optional capabilities and an orchestration version; [remote policy](https://github.com/pingdotgg/t3code/blob/main/docs/internals/remote.md) requires clients to respect missing capabilities. T3 uses Effect RPC and upgrade-level orchestration-version checks; Volli reuses its own tRPC router instead.

## Auth and workspace authorization

VC-575 owns pairing, token format/storage/rotation/revocation. Device credentials come from pairing and bind `(deviceId, workspaceId)` and the issuing host; session credentials bind a durable Session to that workspace; worker credentials bind an enrolled worker to that workspace. A host serving several workspaces requires a separate authorized connection per workspace. The host derives the actor from credential verification, never hello fields, a supplied Session id or transport location. `isHostActor` validates grammar, **not** authority; legacy Session ids remain bounded strings at the wire seam, new ids are UUIDv4.

Carry VC-92's read / coordination / control policy into per-procedure middleware. A paired device maps to today's `user` policy actor (human intent, not an agent control tier). A Session retains its birth-frozen Role tool surface and scope. Agent control travels through a worker only on behalf of a Session it hosts, checked against that Session's frozen grants; worker identity alone confers no control tier. The paired-device human routes remain available under user policy. Today's socket is read/coordination only; control remains tool-only, not newly exposed by a token. Declare policy for every procedure, exhaustive on additions, and check grants/revocation at dispatch, not only handshake. VC-564 must adapt the reserved `hostApi` verb projection and worker delegation explicitly; today's registry cannot tier hostApi-only verbs or authorize workers. A bad agent credential is refused, never downgraded to user (VC-163).

Context carries the authorized workspace; inputs cannot override it. Every ticket, Session, terminal, artifact, blob, subscription and worker lookup verifies workspace ownership **before** returning data or mutating. Cross-workspace ids and absent ids have the same `NOT_FOUND` answer (`workspace-unknown`), including subscriptions and bulk-channel grants. Policy denial within the workspace is `FORBIDDEN` / `verb-refused`. A promoted authority rejects old-epoch writes; worker checkout writes additionally carry `(workspaceEpoch, leaseEpoch)`, ordered lexicographically, and must equal the current live, unexpired per-ticket grant for the authenticated worker. A claimed higher token is not authorization. Lease epochs belong on writes, not the hello; a valid workspace connection is not a checkout lease.

## Commands, subscriptions and errors

Intent-recording mutations carry `HostCommandRequest<Command> { commandId, command }` plus their resource scope; new clients mint UUIDv4 keys and preserve them across reconnect/retry. Repeating the same key and intent returns the durable result without new intent/effect; a different intent under that key is `CONFLICT` / `command-conflict`. The Session engine owns transactional acceptance/delivery recovery, not the transport. Do not blindly replay a mutation with a new key after timeout.

Reuse `CommandReceipt`: `accepted` = durable acceptance, not applied; `completed` = effect recorded (the brief's “applied”); `rejected` = refused with code; `unreconciled` = delivery uncertain/recovering. `HostCommandResult` names the shared receipt/cursor minimum, not a replacement ledger schema. A null receipt is not completed. Existing Session result fields remain intact. `throughSequence` is a projection cursor, scoped to that Session/stream; observe the stream through that cursor before assuming the projection includes the command. Never compare unrelated streams' sequences.

Every durable subscription yields tRPC tracked `{id,data}` on the client. Resume with `lastEventId`; Session RPC uses decimal non-negative safe-integer cursors and `max(afterSequence,lastEventId)`, replaying strictly after it. Keep cursors per resource, accept duplicate ids, apply durable facts idempotently. Transient overlays may repeat the durable cursor and receive a fresh baseline on resume; do not deduplicate them as durable events. No global ordering is implied (BOUNDARIES rule 2).

Bound server queues (Session RPC: 4096 frames). Overflow drains the contiguous buffered prefix then terminates with `TOO_MANY_REQUESTS` / `subscription-overflow`; source failure terminates with `INTERNAL_SERVER_ERROR` / `subscription-source-failed`. Never silently drop durable events or signal clean completion on a gap. Clients resume from the last **applied**, not merely received, id. Cancellation/disconnect removes listeners; transports must also bound outbound bytes/slow peers, not merely the router queue. If history retention removes the cursor, return an explicit resnapshot-required failure, never pretend to resume; each area must define its snapshot baseline and retention contract before migration.

One client-visible error is `HostError {code,message,reason?}`. `HOST_ERROR_CODES` exhaustively matches tRPC's keys; `HOST_ERROR_REASON_CODES` pins each reason to its code. Non-tRPC doors use `HostResult<Data>` (`{ok:true,data}` / `{ok:false,error}`), reusing the IPC registry pattern. VC-564 attaches the envelope at tRPC `data.hostError`; `readHostError` normalizes it and today's IPC/WS `data.code` errors. Existing Session RPC does **not** yet emit the new reasons or map engine/runtime command conflicts to `CONFLICT`; VC-564 owns those mappings, along with sanitizing WS error messages. The harness asserts existing codes, not unimplemented enforcement. Clients branch on code, optionally known reason, not message text; messages are sanitized and no stack/cause/secret crosses the wire. Unknown reasons must fall back to the code. No new custom tRPC error codes.

At every router seam, assert `JsonUnsafeProcedures<Router>` is `never`; it applies `IsJsonSafe` to raw procedure input/output and subscription yield. Import from `@volli/host-protocol`; Session RPC re-exports for compatibility. Use numbers for timestamps, arrays/plain records instead of Date/Map/Set, nullable values or optional keys instead of required `undefined`. The checker deliberately tolerates opaque `unknown`/`any` for existing AI SDK types: it is not runtime validation. New opaque seams must validate JSON recursively before persistence/emission; finite numbers, no cycles, no functions/bigints/symbols. Keep validators transport-independent.

## Binary framing

VC-568/571 implement this separate channel; no binary codec/listener ships here. A host operation authorizes a short-lived, single-use stream grant bound to actor, workspace, workspace epoch and resource. Upgrade consumes it; never expose a stable bearer in a URL. Promotion/revocation/cancel closes the stream. Stream ids are random UUIDv4s granted by the host, not guessed resource locators. tRPC controls attach/input/resize/ack/cancel and reports failures; raw bytes never enter a tRPC subscription. Blobs use authenticated HTTP with SHA-256 content addresses, byte length/content type metadata and digest verification; a digest is not authorization.

One WebSocket **binary message** is one frame: 32-byte header followed by payload (message length supplies payload length). All integers are big-endian. Header: bytes 0–3 ASCII `VLB1`; byte 4 framing version `1`; byte 5 kind (`1` terminal bytes, `2` screencast image); bytes 6–7 flags, zero in v1; bytes 8–23 stream UUID (16 raw bytes); bytes 24–31 unsigned sequence. Sequence starts at 1 per stream/channel attachment, strictly increases, is capped at `Number.MAX_SAFE_INTEGER`, and never identifies durable history. Unknown magic/version/kind/flags, ungranted stream, non-monotone sequence or an oversized payload closes the stream with an explicit control-plane error; no partial delivery. Maximum payload: terminal 64 KiB; image 8 MiB. Compression is off initially; separate channels isolate bulk traffic from control.

Terminal output is ordered/lossless within a connection: bound bytes in flight and pause its producer or terminate on lag; a gap requires explicit terminal resync, not ledger replay. Screencasts may drop **whole** stale frames before assigning sequence; at most one unsent image per stream, favor latest. Image encoding/dimensions are attach metadata (JPEG initially); do not mix metadata inside image bytes. No claim of resumable live processes or durable terminal/screencast history is made. The bulk-area contracts must test resource auth, limits, cancellation and gap behavior in addition to router contracts.

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

Add host-protocol as a **devDependency** for `/testing`; never import it in production. Use `recordSubscription` and `expectHostError` for shared subscription/error assertions. Each area adds command replay/conflict, scope denial, snapshot/resume and its own backpressure cases. VC-608 (on VC-542's list) owns a generic IPC bridge replacing `SESSION_RPC_IPC_PROCEDURES` and `callProcedure`, not a second routing framework in this PR.

Workspace glob `packages/*` includes this package in `pnpm typecheck` (`vp run -r typecheck`) and CI's `Test (packages)` (`test:coverage`); desktop contract cases run in desktop test shards. Owner review of this spec, particularly binary limits/bootstrap naming, is required before migration tickets copy it. VC-564/575 own runtime enforcement and production security; VC-550 defines the identity/fence contract; copy detection and promotion arbitration remain implementation requirements for restore/promotion (VC-591) and control-plane work. This package does not solve those by typing them.

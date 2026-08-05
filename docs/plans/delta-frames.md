# Delta frames

The stream frame shape changes from full-snapshot-per-chunk to a transient delta
overlay on top of durable settle-point snapshots. This is Workstream 3's first
item in `session-ui-migration-readiness.md` (settled decision 3 there: land it
inside migration prep, prove the win on the lab before the file move).

Designed 2026-08-05 against `b70d6ac` on `session/delta-frames`.

## The problem, measured at its source

OpenCode's SSE is already delta-shaped: `message.part.delta` appends text,
`message.part.updated` upserts one part, `message.part.removed` removes one.
The adapter buffers those into a `Map` per message
(`packages/opencode-adapter/src/index.ts:529-534`, mutated at `:1241-1317`),
then every 32 ms rebuilds the entire `UIMessage` and emits it as a
`transcript.message` observation (`#emitStreamSnapshot`, `:1339-1378`). The
engine writes that whole message as a content-addressed artifact and appends a
`transcript.referenced` ledger event per tick
(`packages/session-engine/src/session-runtime.ts:1214-1230`); in production the
artifact store is one SHA-256-named file on disk per write
(`apps/desktop/src/main/session-runtime/transcript-artifacts.ts:23`). RPC
streams the full decoded artifact inline per frame
(`packages/session-rpc/src/index.ts:349-380`), and the renderer keeps the
latest full snapshot per message id
(`apps/desktop/src/renderer/lab/chat/message-projection.ts:12-21`).

So one streamed answer costs, in its own length n: O(n²) wire bytes (the
measured 81×), O(n²) artifact bytes on disk across O(chunks) files, one ledger
event per 32 ms forever, and O(chunks) artifact reads on every rehydrate
(`session-runtime.ts:935-951` reads one artifact per referencing event). The
deltas existed at the top of the pipe and were flattened into snapshots so the
renderer could diff them back out.

## Decision: transient overlay, durable settle points

Two shapes were on the table (readiness doc, correction 3): durable deltas —
new engine/artifact/RPC semantics, delta artifacts, a fold in `snapshot()`,
compaction — or a transient delta overlay with only settled snapshots durable.

**The overlay wins.** The grounds:

- Per-chunk durability today is accidental, not a product requirement. "The
  assistant said X" is a fact when it settles; "the assistant is mid-word" is
  view state. A crash mid-turn re-attaches and reconciles from the provider's
  own history (the adapter's reconcile path already re-emits full messages),
  and a half-written message with no receipt was never accepted work.
- The ledger schema, the artifact schema, `snapshot()`, and cursor semantics
  do not change at all. No migration; old sessions' per-chunk events still
  fold correctly under latest-wins. Durable deltas would have touched all
  four and kept the O(chunks) rehydrate cost.
- Adapters that cannot reconcile from provider history keep the tool they
  already have: emit durable `transcript.message` snapshots as often as they
  need. Durability granularity becomes adapter policy, not engine mandate.

## The contract

### Vocabulary (`@volli/session-engine`)

A keyed transient message shape, distinct from the durable `UIMessage` on
purpose — the key is what makes a delta addressable, and stripping keys is the
projection:

```ts
interface KeyedTranscriptPart {
  key: string; // adapter-chosen, stable for the part's lifetime
  part: UIMessagePart;
}
interface KeyedTranscriptMessage {
  id: string;
  role: UIMessage["role"];
  metadata?: unknown;
  parts: readonly KeyedTranscriptPart[];
}
```

Five delta ops:

```ts
type TranscriptDelta =
  | { op: "reset"; message: KeyedTranscriptMessage } // baseline / escape hatch
  | { op: "part.upsert"; key: string; index: number; part: UIMessagePart }
  | { op: "part.append"; key: string; text: string } // text-bearing parts only
  | { op: "part.remove"; key: string }
  | { op: "metadata"; metadata: unknown };
```

One new observation arm:

```ts
| (HarnessObservationBase & {
    kind: "transcript.delta";
    threadId: string; branchId: string; attemptId: string;
    turnId: string | null;
    messageId: string;
    delta: TranscriptDelta;
  })
```

`transcript.message` keeps its exact current shape and meaning — the durable
record — but adapters now emit it at settle points, not per tick.

### Engine (`DefaultSessionRuntime`)

- `transcript.delta` observations are never persisted: no artifact write, no
  ledger event. The runtime folds them into an in-memory per-session overlay
  (`Map<messageId, KeyedTranscriptMessage>`; the fold is a pure, unit-tested
  module) and publishes them to live subscribers in the same ordered channel
  as durable frames.
- A durable `transcript.message` frame for message X clears X's overlay entry.
  Channel ordering guarantees the settle frame arrives after its deltas.
- On subscribe: durable replay from cursor as today, then one `reset` baseline
  per in-flight overlay message, then live. A subscriber can never observe a
  delta whose base it lacks.
- `snapshot()` stays durable-only and unchanged.

### Stream shape (engine + `@volli/session-rpc`)

Subscribers receive a union:

```ts
type SessionStreamEmission =
  | { kind: "frame"; frame: SessionStreamFrame } // durable, sequenced, unchanged inside
  | { kind: "overlay"; sessionId: string; throughSequence: number;
      messageId: string; delta: TranscriptDelta };
```

`throughSequence` names the durable cursor the overlay sits on. RPC yields
both arms; `tracked()` id for an overlay emission is
`String(throughSequence)` — transient frames never advance the resume cursor,
and a reconnect from that id replays durable history and receives a fresh
baseline. `maxCursor` and the subscription schema do not change.

### Adapter (`@volli/opencode-adapter`)

- The buffer and the per-part projection memo stay. The 32 ms timer stays but
  flushes accumulated deltas (appends concatenated per key) instead of
  rebuilding the message — per-tick wire cost becomes the new bytes only.
- Part keys: `partId` when one buffered part projects to one UIMessage part,
  `partId:i` when it projects to several. Order index comes from `partOrder`.
- Per SSE event, only the touched buffered part is re-projected; old projected
  slice vs new decides the op: same single text-bearing part growing by a
  suffix → `part.append`; anything else → `part.upsert`/`part.remove`.
  Reorders, provider full snapshots that disagree with the buffer, or any
  ambiguity → `reset`. The escape hatch is the old behavior as worst case,
  and it is always correct by construction.
- Durable settle points: the provider marks a message completed, the turn
  completes, the flush paths (`#flushMessages`), and reconcile
  (`#messageObservation`) — those two already build the right shape. A failed
  settle emission must be recorded through the sink's error path (this closes
  the documented silent-final-snapshot gap where it matters); a failed delta
  emission marks the message dirty and the next flush emits `reset`.
- The scenario adapter is untouched: its full `transcript.message` beats are
  valid durable emissions and every lab scenario keeps working.

### Renderer (lab chat controller)

`LabTranscriptState` gains a per-message overlay map folded from `overlay`
emissions. The rendered message for id X is the overlay projection while an
entry exists, else the durable latest. The settle frame clears the entry —
same content when the adapter is honest, so no visual jump. Overlay emissions
never trigger `refreshProjection` (they are the flood `movesProjection` was
built to suppress, now typed instead of filtered).

## What this deliberately does not fix

The open-fence re-highlight (readiness doc C4, correction 4). Each text part
already renders through its own memoized Streamdown, so settled parts bail
today; the cost is inside the one growing text part, and delta transport does
not change what that part re-renders. The fenced-code browser probe below
measures it; if the numbers demand it, the renderer policy
(highlight-on-close / block stability for the open fence) lands as this
session's last item, scoped to the markdown components — not to the wire.

## Proof, checked in before the change

Correction 8 in the readiness doc: the audit's numbers were never committed as
replayable evidence. So the probes land first and the baseline is recorded
before any contract code changes:

1. **Wire probe** — vitest in `packages/opencode-adapter`, riding the existing
   `FakeNetwork` scripted-SSE seam: stream a deterministic long markdown
   answer (fenced code included) as `message.part.delta` events, sum
   `JSON.stringify` bytes across every emitted observation, report
   amplification = emitted bytes / final message bytes. After the change the
   same probe asserts a hard ceiling.
2. **Persistence probe** — vitest in `packages/session-engine`: the same
   observation stream through `DefaultSessionRuntime` against a counting
   artifact store; report artifact writes and ledger events per answer.
   After: settle-count writes, and an assertion.
3. **Fence probe** — browser, in `chat-performance.tsx`'s pattern: drive the
   real `ChatTurn` with a growing message, count `childList` mutations on
   Shiki spans plus long tasks during the stream, expose via
   `window.chatPerf`. This one measures the renderer policy, before and
   after, independent of transport.

## Baselines (recorded 2026-08-05, pre-change)

To be filled by the phase-1 probes.

## Phases

1. Probes + recorded baselines (no behavior change).
2. The contract: engine vocabulary + overlay fold + runtime publish/baseline;
   adapter delta emission + settle snapshots; RPC union; renderer fold.
   Expect the adapter's exact-object part-mapping assertions to churn — that
   churn is the priced-in cost (readiness doc, decision 3).
3. Re-run probes and assert ceilings; the fence policy if the probe demands
   it; docs and gates.

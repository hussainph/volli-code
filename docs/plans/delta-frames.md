# Delta frames

> **Historical design record since 2026-08-10.** The OpenCode adapter this
> document measures was removed in Session 7; see
> [`pi-native-ticket-session.md`](pi-native-ticket-session.md). The
> delta-frame concepts — a transient overlay over durable settle points — live
> on in the Session Engine.

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

So one streamed answer costs, in its own length n: O(n²) wire bytes, O(n²)
artifact bytes on disk across O(chunks) files, one ledger event per 32 ms
forever, and O(chunks) artifact reads on every rehydrate
(`session-runtime.ts:935-951` reads one artifact per referencing event). The
baselines below price the two n² terms at two points on that curve: **19.63×**
on the wire for a 16,528-char answer the 32 ms timer coalesced into 40
snapshots, and **198.15×** in artifact bytes with no coalescing at all, where
each of 397 observations settles. Both are half the snapshot count, which is
the n² restated — neither is a constant to quote back, because cutting the same
answer into twice as many snapshots doubles it. That is what makes ~2.0× the
floor worth aiming at: one transient copy of the answer plus one durable copy
of it, whatever the cadence. The deltas existed at the top of the pipe and were
flattened into snapshots so the renderer could diff them back out.

## Decision: transient overlay, durable settle points

Two shapes were on the table (readiness doc, correction 3): durable deltas —
new engine/artifact/RPC semantics, delta artifacts, a fold in `snapshot()`,
compaction — or a transient delta overlay with only settled snapshots durable.

**The overlay wins.** The grounds:

- Per-chunk durability today is accidental, not a product requirement. "The
  assistant said X" is a fact when it settles; "the assistant is mid-word" is
  view state. The cost, named honestly: OpenCode's own database never receives
  streaming deltas — a mid-turn re-hydrate serves reasoning parts as empty
  strings and at best a prefix of text
  (`opencode-adapter/src/index.ts:2397-2400`) — so a hard crash mid-turn keeps
  every settled turn and loses the in-flight one's tail. That is the trade,
  made on purpose. Every orderly exit — turn end, stream disconnect, adapter
  release — settles durably first, so only a genuine crash pays it.
- The ledger schema, the artifact schema, `snapshot()`, and cursor semantics
  do not change at all. No migration; old sessions' per-chunk events still
  fold correctly under latest-wins. Durable deltas would have touched all
  four and kept the O(chunks) rehydrate cost.
- Adapters that cannot reconcile from provider history keep the tool they
  already have: emit durable `transcript.message` snapshots as often as they
  need. Durability granularity becomes adapter policy, not engine mandate.

The contract below was adversarially validated against the code on 2026-08-05.
Nine findings — silent approval-state loss under per-part diffing, a
baseline/settle race, non-idempotent appends under sequence-keyed batching,
release() discarding the in-flight message, a reconcile-cursor corruption, an
unbounded overlay map, a wrong index base, a dead key arm, and a settle point
that does not exist — are folded in below where they belong.

## The contract

### Vocabulary (`@volli/session-engine`)

A keyed transient message shape, distinct from the durable `UIMessage` on
purpose — the key is what makes a delta addressable, and stripping keys is the
projection:

```ts
interface KeyedTranscriptPart {
  key: string; // the buffered part's provider id — projection is 1:0..1, so no sub-index exists
  part: UIMessagePart;
}
interface KeyedTranscriptMessage {
  id: string;
  role: UIMessage["role"];
  metadata?: unknown;
  parts: readonly KeyedTranscriptPart[];
}
```

Six delta ops:

```ts
type TranscriptDelta =
  | { op: "reset"; message: KeyedTranscriptMessage } // baseline / escape hatch
  | { op: "part.upsert"; key: string; index: number; part: UIMessagePart }
  | { op: "part.append"; key: string; text: string } // text-bearing parts only
  | { op: "part.remove"; key: string }
  | { op: "metadata"; metadata: unknown }
  | { op: "message.remove" }; // the provider deleted the in-flight message
```

`part.upsert.index` is the position in the **projected** keyed array after the
op applies — never a `partOrder` position. Projection elides parts
(`projectOpenCodePart` returns nothing for empty text, empty reasoning, and
unknown tool states, and empty text parts between tool calls are common), so
buffer order and projected order disagree routinely.

The observation arm deliberately does **not** extend `TranslatedObservationBase`:
the base carries `cursor`, and the runtime advances the reconcile cursor for
any observation that has one (`session-runtime.ts`, `#recordFact`). A delta that
moved it would make a later reconcile ask the provider for events after
content that was never made durable. The arm has its own base — `id`,
`occurredAt`, no `cursor` — and the runtime's handling of it returns before
the cursor-advance lines:

```ts
| { kind: "transcript.delta";
    id: string; occurredAt: number;
    threadId: string; branchId: string; attemptId: string;
    turnId: string | null;
    messageId: string;
    delta: TranscriptDelta }
```

`transcript.message` keeps its exact current shape and meaning — the durable
record — but adapters now emit it at settle points, not per tick.

Two sequencing rules make every fold self-healing: **the first transient
emission for a message id is always `reset`**, and **the first transient
emission after that message settles durably is always `reset`**. Any fold —
engine or renderer — that receives a non-reset delta for a message it has no
overlay entry for ignores it and waits; the next reset or settle heals it.

### Engine (`DefaultSessionRuntime`)

- `transcript.delta` observations are never persisted: no artifact write, no
  ledger event, and they bypass the observation-id dedupe entirely. The
  runtime folds them into an in-memory per-session overlay
  (`Map<messageId, KeyedTranscriptMessage>`; the fold is a pure, unit-tested
  module) and publishes them to live subscribers.
- Overlay delivery appends to each subscriber's `draining` chain
  **synchronously, at the same point `#enqueue` appends** — never by awaiting
  `draining` from outside, which would let a concurrent durable publish
  interleave ahead of an overlay that preceded it. Overlays thereby inherit
  the existing slowest-subscriber backpressure on the adapter's emit path;
  accepted, and worth a comment at the site.
- The runtime clears message X's overlay entry **when it processes** a durable
  `transcript.message` observation for X — not when the resulting frame is
  delivered. `SessionEngine.observe` dedupes by observation id and returns the
  original event for a repeat; that event's old sequence is behind every
  subscriber cursor, the frame is never re-delivered, and clearing keyed off
  delivery would strand the entry forever.
- On subscribe: durable replay from cursor as today, then one `reset` baseline
  per in-flight overlay message, then live. The overlay-map read and the
  baseline enqueue happen **synchronously, with no await between them** — any
  gap lets a concurrent settle clear an entry and a stale baseline resurrect
  it. The subscriber-side staleness guard (below) covers the tick-level race
  that even this cannot close.
- Overlay memory has explicit ends. The session's overlay drops on
  `attachment.closed` / `attachment.failed`, on `adapter.release`, and in
  `close()` — the same points that already drop `#bindings`. `message.remove`
  drops the single entry. The whole map is LRU-bounded the way `#histories`
  already is, so no single rule's absence is unbounded.
- `snapshot()` stays durable-only and unchanged.

### Stream shape (engine + `@volli/session-rpc`)

The durable arm stays the **bare** `SessionStreamFrame`, not a wrapped one.
Every existing consumer validates a frame by `sequence: number`
(`session-controller.ts`, `session-tracer.tsx`); wrapping the durable arm
would make them reject every frame, while leaving it bare means they keep
working untouched and simply ignore overlays until a surface opts in — the
tracer deliberately stays durable-only.

```ts
type SessionStreamEmission =
  | SessionStreamFrame // durable, sequenced — byte-identical to today
  | { kind: "overlay"; sessionId: string; throughSequence: number;
      messageId: string; delta: TranscriptDelta };
```

`throughSequence` is the latest durable sequence recorded at emission time,
and it is the consumer's staleness guard: **drop any overlay emission whose
`throughSequence` is strictly below the last durable transcript sequence
already applied for that message.** With the guard in place, application
order inside one batch stops mattering: a stale pre-settle append sorts
itself out no matter when the settle frame lands.

RPC yields both arms; `tracked()` id for an overlay emission is
`String(throughSequence)`. Duplicate tracked ids are safe on both transports
(verified on tRPC 11.18: the IPC link buffers by subscription id, not event
id; `httpSubscriptionLink` keeps last-write-wins `lastEventId`), transient
frames never advance the resume cursor, and a reconnect from an overlay id
replays durable history and receives a fresh baseline. Do not suffix the id
(`"123~4"` fails the `sseCursor` regex on resubscribe). `maxCursor` and the
subscription schema do not change.

### Adapter (`@volli/opencode-adapter`)

- The buffer and the per-part projection memo stay. The 32 ms timer stays but
  emits a delta batch instead of rebuilding the message — per-tick wire cost
  becomes the new bytes only. Part keys are the buffered part's provider id,
  plain: projection is 1:0..1, so no sub-index arm exists.
- **One tick per message at a time, and the interval does not guarantee it.**
  A tick is over when its batch reaches the sink, and the sink carries the
  slowest subscriber's backpressure by the rule above — so a batch outliving
  its own 32 ms window is a designed-for case, not an unlucky one. Two ticks
  running at once both diff against the last-emitted record the first has
  already cleared: the second sends a `reset`, the first writes its older
  record back over it, and every later diff is then computed against a state
  the consumer does not hold. On a growing text part that is an append of text
  it already has — the answer quietly saying part of itself twice, on the one
  surface with no way to notice. A message that changes while its tick is
  emitting is marked pending instead, and the tick re-arms on the way out.
- **The diff runs over the whole projected array, not the touched part.** Each
  tick projects all of `partOrder` exactly as `#emitStreamSnapshot` does today
  — the per-part memo makes unchanged parts reference-identical — and diffs
  the keyed result against the last-emitted array: reference-equal → nothing;
  the same single text-bearing part grown by a suffix → `part.append`;
  anything else per key → `part.upsert` / `part.remove`. This is complete by
  construction where a touched-part rule silently is not: `turnBusy` flips
  re-project every unfinished reasoning part in every message, a
  post-projection pass marks all-but-the-last reasoning part done when a new
  part opens, and `permission.asked` / `permission.replied` change pending
  tool parts without writing to the buffer at all — the last one is how the
  permission card, the surface's trust boundary, would have silently vanished.
  Cost per tick is O(parts) identity checks, not O(bytes). Provider full
  snapshots that disagree with the buffer, reorders, or any ambiguity →
  `reset`; the escape hatch is the old behavior as worst case.
- Delta observations bypass the adapter's `#seen` dedupe window: they carry no
  durable identity, and at ~31 emissions/sec they would evict the durable and
  interaction ids the window exists to protect. Having no durable identity,
  they carry a plain per-binding counter (`opencode:delta:<session>:<n>`) as
  their observation id, and they never move `#cursor`.
- The tick's post-projection pass — the one that marks every thought but the
  last one done while the turn is still busy — memoizes its settled reading
  against the streaming part it came from. A fresh object per tick would make
  every thought the message has already moved past look changed, which is one
  full re-upsert per tick of text nobody is writing any more: the quadratic
  cost this change exists to remove, reintroduced by the collapse pass.
- **The adapter withdraws what it will not settle.** An entry that reaches no
  durable snapshot has no other end: `message.remove` is emitted when the
  provider deletes an in-flight message, and when a settle flush finds the
  message projects to nothing at all. Without it the overlay renders a message
  that will not go away.
- Durable settle points, in the vocabulary that actually exists (there is no
  provider "message completed" signal; none is claimed): turn completion
  (`session.idle`, or idle `session.status`, → `#flushMessages`), stream
  disconnect (`#emitDisconnected`'s flush), reconcile (`#messageObservation`),
  and — new behavior — **`release()` flushes buffered messages durably before
  dropping the sink.** Today release costs at most 32 ms of staleness; under
  deltas it would have discarded the whole in-flight message, and release is
  a normal user action, not a crash.
- A failed settle flush raises attention — the sink has no error channel, and
  `attention.raised` is the mechanism `#emitDisconnected` already pairs with
  its swallowed flush. That names the documented silent-final-snapshot gap at
  the one point it becomes data loss. A failed delta emission marks the
  message dirty; the next tick emits `reset`.
- The scenario adapter is untouched: its full `transcript.message` beats are
  valid durable emissions and every lab scenario keeps working.

### Renderer (lab chat controller)

`LabTranscriptState` gains a per-message overlay map folded from `overlay`
emissions. The rendered message for id X is the overlay projection while an
entry exists, else the durable latest; a message that exists only in the
overlay renders after every durable message, in first-delta order, and takes
its durable position on settle. The settle frame clears the entry — same
content when the adapter is honest, so no visual jump. Overlay emissions
never trigger `refreshProjection` (they are the flood `movesProjection` was
built to suppress, now typed instead of filtered).

Two rules the batching must keep: overlay emissions accumulate in an
**ordered array**, never in the sequence-keyed `pendingFrames` map — every
emission in one paint shares a `throughSequence`, latest-wins would collapse
them, and `part.append` is not idempotent: a collapsed append is silently
truncated text. And the fold applies the per-message staleness guard from the
stream-shape section, which is what makes durable-then-overlay application
order inside one batch immaterial.

The overlay projection is gated by the same `speaks` rule the durable
projection uses, **with the durable message as its fallback**. A baseline
`reset` can carry nothing drawable yet — an emitter leads with one before the
first word — and rendering that would open an empty bubble in front of the
answer, or blank a settled message the moment its next turn opens. So the
rendered message is the overlay while the overlay has something to draw, else
the durable latest, else no row at all. One rule, not two.

The renderer's own overlay is **not** dropped when the attachment closes: the
engine drops its map there, but a reader that watched a sentence being written
keeps seeing it until something durable replaces it or the surface reloads.
Losing mid-word text with nothing in its place is worse than holding it, and
nothing about it was durable to begin with.

## What the transport deliberately does not fix

The open-fence re-highlight (readiness doc C4, correction 4). Each text part
already renders through its own memoized Streamdown, so settled parts bail
today; the cost is inside the one growing text part, and delta transport does
not change what that part re-renders. The fenced-code browser probe below
measures it — and its numbers say the cost is bigger than "the open fence":
every fence in the growing part is re-highlighted per chunk, closed ones
included. So the renderer policy (block stability for the fences that have
already closed) is a real item, scoped to the markdown components — not to the
wire.

It landed separately, on its own evidence, in `ai-elements/message.tsx`; the
diagnosis and the before/after are in the fence-probe section below. Nothing
about it touches the contract above, which is the point of having measured it
apart from the wire.

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

### Wire probe

`packages/opencode-adapter/src/stream-cost.bench.test.ts`. Deterministic
fixture: fixed prose plus three fenced code blocks (ts/tsx/json), 16,528
chars, split into 395 fixed 24-64-char chunks fed as `message.part.delta`
events through `FakeNetwork`, in batches of 10 with a real 40ms wait between
batches — long enough for the 32ms coalescing timer to fire and flush before
the next batch lands, instead of the whole run collapsing into one snapshot.

| metric | value |
| --- | --- |
| `message.part.delta` events fed | 395 |
| `transcript.message` snapshots emitted | 40 |
| total wire bytes (sum of `JSON.stringify(observation)` across every emitted snapshot) | 367,709 |
| final snapshot bytes | 18,729 |
| amplification (total / final) | 19.63x |

**After** (recorded 2026-08-05 against `c76f1d4`, same fixture, same probe
file — now asserting ceilings instead of logging a number nothing checked):

| metric | before | after |
| --- | --- | --- |
| `transcript.message` settles emitted | 40 | 1 |
| `transcript.delta` frames emitted | — | 39 (`{"reset":1,"part.append":38}`) |
| durable wire bytes | 367,709 | 18,729 |
| transient wire bytes | — | 29,008 |
| total wire bytes | 367,709 | 47,737 |
| final settle bytes | 18,729 | 18,729 |
| amplification (total / final) | 19.63x | 2.55x |

Ceilings the test now asserts, in `stream-cost.bench.test.ts` (opencode-adapter):
`transcriptMessages` has length exactly 1 (durable settles === 1 for the
scenario), durable bytes equal final settle bytes exactly (the 1.00x fact —
only the transient arm carries amplification, the settle carries none), and
`amplification < 3.0` — generous headroom above the measured 2.55x, sitting
above the ~2.0x floor named in "The problem, measured at its source" (one
transient copy of the answer plus one durable copy of it). A regression back
to snapshot-per-tick would blow all three.

### Persistence probe

`packages/session-engine/src/stream-cost.bench.test.ts`. Same fixture, fed as
397 cumulative `transcript.message` observations straight to
`DefaultSessionRuntime` (395 growing-text steps plus two tool-part beats on
the tail) — no adapter, no timers. This is the worst case named above ("one
ledger event per 32 ms forever"): every coalescing tick settling durably, so
it prices exactly the part of the cost the wire probe's coalescing does not
touch.

| metric | value |
| --- | --- |
| `transcript.message` observations fed | 397 |
| artifact writes | 397 |
| artifact bytes total (`canonicalJson` length, summed) | 3,498,547 |
| ledger events appended (`transcript.referenced`) | 397 |
| subscriber frame bytes total (sum of `JSON.stringify(frame)`, full decoded artifact inline) | 3,760,666 |
| final message bytes | 17,656 |
| artifact amplification (bytes total / final) | 198.15x |
| frame amplification (bytes total / final) | 213.00x |

Ledger events appended equal artifact writes 1:1 — no compaction today.
Artifact writes equal observations fed exactly: an engine invariant this
probe confirms and the delta-frame change leaves alone, since
`transcript.message` keeps its current persistence semantics; only the
adapter's emission cadence changes.

Which is why this probe still reads the same after the change, and why the
number above is now a **synthetic worst case** rather than a reading of the
shipped pipeline: it feeds per-chunk `transcript.message` observations
directly, which the real adapter no longer does. It prices the ceiling a
durable per-chunk adapter would still pay. Phase 3 owns re-pointing it at the
settle-count cadence and asserting that instead.

**After** (recorded 2026-08-05 against `c76f1d4`): the probe no longer feeds
per-chunk `transcript.message` observations as its primary case. It now feeds
the observation mix the real adapter emits — verified against the wire probe's
own measured shape — straight to `DefaultSessionRuntime`: one `transcript.delta`
reset, 38 `part.append` deltas (the wire probe's measured 39-frame shape), then
one durable `transcript.message` settle carrying the full text plus the two
tail tool parts. Still no adapter, no timers — this is the engine's own side of
the contract; the adapter-conformance half already lives in
`apps/desktop/src/renderer/lab/chat/delta-frames.integration.test.ts`.

| metric | value |
| --- | --- |
| `transcript.delta` fed | 39 (1 reset + 38 `part.append`) |
| `transcript.message` fed | 1 (the settle) |
| artifact writes | 1 |
| artifact bytes (single settle, `canonicalJson` length) | 17,656 |
| ledger events appended (`transcript.referenced`) | 1 |
| subscriber durable frame bytes | 18,313 |
| subscriber overlay bytes | 22,629 |
| subscriber bytes total (durable + overlay) | 40,942 |
| final message bytes | 17,656 |
| subscriber amplification (bytes total / final) | 2.32x |

Before/after on the two numbers durability actually turns on:

| metric | before (397 observations fed) | after (39 deltas + 1 settle) |
| --- | --- | --- |
| artifact writes | 397 | 1 |
| ledger events appended | 397 | 1 |

Ceilings the test now asserts, in `stream-cost.bench.test.ts` (session-engine):
`counting.writes()` equals exactly 1 and the subscriber's
`transcript.referenced` frames number exactly 1 — a regression to
durable-per-chunk emission would blow both straight past 1, the same way it
would blow the wire probe's settle count.

The old per-chunk feed this file used to run as its only case is kept as a
second, small one — "historical worst case / old-session replay still folds
correctly" — because a session recorded before this change has exactly that
shape sitting on disk, and `snapshot()`'s latest-wins fold has to keep
resolving it to the right content. That case asserts the folded final message
only, not its cost: the per-chunk cost is priced nowhere any more, because no
adapter pays it going forward.

### Fence probe

`apps/desktop/src/renderer/lab/scratches/chat-performance.tsx`, driven by
`window.chatPerf.streamFence()`. `pnpm lab`, open `/lab/#chat-performance`,
call it from the console (or press `fence` in the scratch's header). One
assistant turn, 4,019 characters streamed as 126 fixed 32-character chunks, one
per frame, through two closed fences (46 and 44 lines) and stopping inside a
third. Chromium 150, dev-mode React, M-series laptop:

```json
{
  "chunks": 126,
  "durationMs": 4567,
  "finalChars": 4019,
  "mutationsTotal": 33309,
  "mutationsInCode": 32638,
  "longTaskMs": 0,
  "longTaskCount": 0,
  "spanCollapses": 117
}
```

`spanCollapses` is a list in the result object; only its length is quoted here.
First collapse at 320 characters — the moment the first fence opens — then one
per chunk for the rest of the stream, deepest 704 → 185 spans.

Three runs agree to 0.2% on every count (33,253 / 33,309 / 33,294 mutations,
117 collapses in all three). Absolute milliseconds vary per machine; the counts
are the comparable figures.

What the split says, and it is not what C4 assumed:

- 98% of `childList` mutations land INSIDE a `<pre>`, and the churn is not
  confined to the fence that is growing. Per-block span counts oscillate
  `344|264|41` → `92|73|11` → `344|264|49` on every chunk: all three fences drop
  to line spans and are re-highlighted, including the two closed ones whose
  source has been byte-identical for thousands of characters. The settled blocks
  are ~86% of the span churn.
- Same behavior with `working` off, so Streamdown's animation plugin is not the
  cause — any change to the text part re-highlights every fence in it.
- 264 mutations and ~36 ms per chunk, and no long tasks at all in run 2. The
  cost sits just under the 50 ms long-task threshold while holding the stream
  at ~27 fps, which is why it never showed up as a long task in the audit.

One reading in that list was wrong, and finding out why is what named the fix.
"Mutations land inside a `<pre>`, so the `<pre>` survives" does not follow: a
subtree React builds detached and then attaches costs ONE record on the parent,
and the records inside it come afterwards. Tagging every
`[data-streamdown="code-block"]` element as it appeared showed 195 created and
192 destroyed across the 126-chunk stream — one per fence per chunk. The blocks
were not re-highlighting in place; they were being torn down and rebuilt, each
replacement mounting at its unhighlighted fallback (`useState(raw)`) and
swapping to tokens when its effect read Shiki's cache. That flip is what
`spanCollapses` had been counting all along.

Below that, the cause: Streamdown re-derives its internal component map whenever
the `components` prop changes identity, and when the map defines `inlineCode` it
re-wraps `code` in a fresh closure each time. `code` is an element TYPE, so a new
function there is a new type at the same position and React remounts every fenced
block in the message. `MessageResponse` was building that map with a literal
spread, so every token produced a new identity. Isolated, the difference is the
whole effect: a fresh `components` object WITHOUT `inlineCode` costs 2 block
mounts over a stream; the same object WITH `inlineCode` costs 22.

**After** (recorded 2026-08-05, same machine and browser, page reloaded between
the two readings so neither is measuring a hot-module state). The policy is one
memo in `apps/desktop/src/components/ai-elements/message.tsx`: the merged
`components` map keeps one identity for as long as its members do, and the
common case — no caller override — passes the module constant straight through.
`reasoning.tsx` already passed a module-level map and was already immune;
measured alongside to confirm it, not changed.

```json
{
  "chunks": 126,
  "durationMs": 4567,
  "finalChars": 4019,
  "mutationsTotal": 689,
  "mutationsInCode": 410,
  "longTaskMs": 0,
  "longTaskCount": 0,
  "spanCollapses": 0
}
```

| metric | before | after |
| --- | --- | --- |
| `childList` mutations | 33,309 | 689 |
| …of those, inside a `<pre>` | 32,638 | 410 |
| span collapses | 117 | 0 |
| code blocks mounted (created / destroyed) | 195 / 192 | 3 / 0 |

97.9% of the mutations and 98.7% of the in-`<pre>` mutations are gone, and every
span collapse with them: no block ever falls back to unhighlighted source
mid-stream any more. Three code blocks are mounted for three fences, which is
the floor. What remains is the growth this probe exists to price — the open
fence tokenizing one chunk longer each frame (410 records) and the prose around
it (279) — and it is the same work a single settled render would do.

Both readings are three runs each; the mutation counts are identical across runs
after (689 / 689 / 689) and agree to 0.7% before. Long tasks are the one figure
that is not stable, and they are a page-warm artifact rather than a difference:
the first `streamFence()` after a reload records 4–5 tasks totalling ~370–490 ms
in BOTH builds, and every later run in both records zero.

1. Probes + recorded baselines (no behavior change). **Landed.**
2. The contract: engine vocabulary + overlay fold + runtime publish/baseline;
   adapter delta emission + settle snapshots; RPC union; renderer fold.
   Expect the adapter's exact-object part-mapping assertions to churn — that
   churn is the priced-in cost (readiness doc, decision 3). **Landed**, with
   one addition the three layers earned by being written apart:
   `apps/desktop/src/renderer/lab/chat/delta-frames.integration.test.ts`
   drives the real adapter from scripted SSE through the real
   `DefaultSessionRuntime` and into the renderer's real `appendFrames`. Each
   layer's own tests state the contract in that layer's vocabulary, which is
   exactly the shape of test that cannot catch a handshake two layers spell
   differently.
3. Re-run probes and assert ceilings; re-point the persistence probe at the
   settle-count cadence; the fence policy if the probe demands it; docs and
   gates. The probe demanded it: the fence policy landed as one memo in
   `ai-elements/message.tsx`, measured before and after in this file.

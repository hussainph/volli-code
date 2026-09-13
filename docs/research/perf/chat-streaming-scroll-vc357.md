# VC-357 — streaming text while scrolling: what was measured

The ticket named five hypotheses for the chug the owner reports when a chat
pane streams and the reader scrolls at the same time. This records what each
one turned out to be, including the four that were wrong, because a disproved
hypothesis saves the next ticket the trip.

Everything here is measured against the `VC-353` harness on the `real` fixture
(1,198 Sessions / 259,855 Session Events / 392 Tickets), 20 repetitions per
arm, on an Apple M1 MacBook Pro (8 logical cores, 16 GiB, macOS 26.5.1). The
before/after artifacts and the exact commands are in
[`docs/performance-baselines/vc-357-real/`](../../performance-baselines/vc-357-real/).

## The one that was true: Shiki re-tokenises the growing fence (hypothesis 1)

Streamdown 2.6 already memoises completed markdown blocks, so the ticket's
worry that "a delta re-parses the whole message body" is only half right: the
closed blocks above the cursor are not re-parsed. The block still being written
is, and `@streamdown/code` hands its whole source to Shiki on every update.
Each update is a longer string than the last and therefore a cache miss by
definition, so an open fence costs O(n²) tokenisation over the life of the
fence — on exactly the frames where the reader is scrolling.

The harness measures this directly. It records the highlighted-token count
inside the live fence while the stream runs (`liveHighlightedTokens`) and again
after the Turn settles (`settledHighlightedTokens`):

| | live tokens | settled tokens |
|---|---:|---:|
| before | 3,482 | 3,482 |
| after | 0 | 3,482 |

That is the whole mechanism, and the whole fix: the tokens move from the
streaming frames to one settle-time pass. `message.tsx` carries the comment
explaining what it costs.

**Why the earlier 107-character fence saw nothing.** The harness's original
stream source was prose with a token fence in it. At that size Shiki's work per
update is below a frame and the probe reported zero dropped frames in both
arms, which is why `VC-353`'s first baseline could not see this bug. The stream
now traverses prose → a ~4 KB TypeScript fence → 96 growing snapshots → the
close → prose, and the reader is pinned inside the live row rather than at an
absolute offset, because Streamdown defers offscreen code work with
`content-visibility` and an absolute offset lets the fence leave the viewport
and makes the measurement vacuous.

## Disproved: layout thrash on the delta path (hypothesis 2)

Audited every layout-forcing read in `chat-plane.tsx` and the transcript
components it drives. There are five in the transcript's own code:

| site | what it reads | what triggers it | on the delta path? |
|---|---|---|---|
| `chat-plane.tsx:1718-1727` `record()` | `scrollHeight`, `scrollTop`, `clientHeight` | reveal + offset persistence | no |
| `chat-plane.tsx:1732-1735` `reveal()` | `scrollHeight`, `scrollTop` | "Show earlier" click | no |
| `chat-plane.tsx:1743-1752` layout effect | `scrollHeight`, `scrollTop`, writes `scrollTop` | `anchorKey` change after a prepend | no |
| `chat-plane.tsx:1808-1827` `read()` | `scrollHeight`, `scrollTop`, `clientHeight` | `scroll` listener, inside one rAF | no — user scroll, not deltas |
| `chat-plane.tsx:1859-1869` `apply()` | writes `scrollTop`, reads nothing | mount / remount with a saved offset | no |

The effects that DO run as the transcript changes — the ones keyed on the row
window and the sentinel arming — read no layout property at all. The comment
that says "Reading `scrollHeight` forces the layout the prepend dirtied" is on
the reveal path, which is a click, not a delta.

**Zero forced layouts run per streamed delta.** A user scroll costs one
coalesced rAF read regardless of how fast the stream is going. Hypothesis 2 is
disproved for this codebase; the deliberate read the ticket flagged is in the
right place.

## Disproved: ResizeObserver storms (hypothesis 3)

The harness counts every `ResizeObserver` callback that fires during the
measured window and divides by the wall time. Under a stream that is growing a
4 KB fence while the reader scrolls:

| arm | callbacks/second (p50) | total per sample (p50) |
|---|---:|---:|
| before, idle | 1.0 | 4 |
| before, 2-busy-core | 1.0 | 4 |
| after, idle | 1.0 | 4 |
| after, 2-busy-core | 1.0 | 4 |

Four callbacks across a four-second stream. There is no storm, before or after,
and the fix does not change the number. `use-stick-to-bottom` and the composer
observer are both quiet under streaming. Hypothesis 3 is disproved.

## Disproved: a coalesced write re-renders the whole tail (hypothesis 4)

The ticket was right that the obvious lever is already pulled — `FlushScheduler`
in `packages/session-presentation/src/client.ts` coalesces store writes to an
animation frame — and asked the harder question: does one frame's write still
re-render all 60 mounted rows?

It does not, for ordinary streamed text:

- `chat-plane.tsx:1068-1090` — `groupTurns` is memoised on `messages`, and
  `useStableList(..., sameMessages)` hands unchanged turns back their previous
  array identity, so a settled turn's `messages` prop does not move.
- `chat-plane.tsx:1048-1065` — `turnContext` is memoised on its own members and
  deliberately excludes `working`. A text delta does not change it.
- `chat-plane.tsx:1088-1092, 2128` — `live` is computed per row from
  `liveTurn`, so `isAnimating` only ever reaches the live Turn's own subtree.
  Settled rows hold `live={false}` across the whole stream.
- `ChatTurn` is `React.memo`. With stable `messages`, stable context and an
  unchanged `live`, its memo holds.

So the parent surface re-renders and re-maps the mounted tail on each batch, but
the actual turn rendering is one row. Hypothesis 4 is disproved as stated.

One caveat worth writing down: the shared `context` prop reaches every mounted
row, and it DOES change identity when interaction state moves
(`session.openedInteractions`, `resolving`). A batch that carries a gated tool
call therefore can invalidate settled rows. That is not the streaming-text path
and was not measured as a cost here, but it is the thing that would bite a
future change.

## Confirmed, and not fixed here: the structured stream has no flow control (hypothesis 5)

The ticket's instinct was right. `apps/desktop/src/main/pty/output.ts` coalesces
AND applies backpressure; the structured stream only coalesces.

What the PTY path has:

- the renderer acknowledges consumed output through `OutputPipeline.ack(chars)`
  (`output.ts:31-41`), tracked as `unackedChars` (`output.ts:49-56`);
- crossing a 100,000-character high watermark calls `sink.pause()` and pauses
  the producer (`output.ts:6-7, 77-93`);
- draining to a 5,000-character low watermark calls `sink.resume()`
  (`output.ts:128-134`);
- the pending batch is bounded at 256,000 characters or 8 ms
  (`output.ts:9-14, 113-123`).

What the structured stream has: `#receive()` buffers and schedules one flush per
animation frame, racing a 50 ms timer so an occluded window still drains
(`client.ts:287-328, 858-878`). What it does not have:

- no acknowledgement, credit, watermark or pause anywhere in the renderer-side
  contract (`client.ts:244-264, 800-823`);
- no bound on the pending batch. Durable frames are keyed by sequence so they
  replace, but `#overlays` and `#compactionProgress` are arrays that append and
  can grow without limit between flushes (`client.ts:864-867`);
- no backpressure on the main side either — `pumpSubscription()` awaits each
  iterator item and immediately `webContents.send()`s it, checking no queue
  depth and no return value (`apps/desktop/src/main/session-rpc-ipc.ts:230-248`).
  The runtime's per-subscriber `draining` chain
  (`packages/session-engine/src/session-runtime.ts:2675-2705`) is ordering, not
  flow control;
- no cross-session fairness. Each `ChatSessionClient` owns its own scheduler
  (`client.ts:375-399`), so N streaming Sessions are N independent producers
  with no shared budget.

The concrete failure mode is several Sessions streaming at once: main keeps
pumping, IPC queues and per-session overlay arrays grow, and store writes fall
behind the producer. **This was not fixed in VC-357** — it is a transport change
touching `client.ts`, `transport.ts` and `session-rpc-ipc.ts`, none of which is
this ticket's lane, and the measured chug was entirely hypothesis 1. It wants
its own ticket, with the PTY watermark protocol as the model.

## The no-virtualizer decision, re-examined

Re-read with 2025/2026 evidence in
[`react-zustand-streaming.md` §3](./react-zustand-streaming.md). The verdict:
**it still holds.** Two of its four legs have weakened — TanStack's chat mode
and Orbit's measure-once cache are real answers to variable row heights, and
the jsdom objection is a test-harness problem rather than an architecture veto
— but the scroller-ownership objection is intact, Volli's disclosure-toggled
rows are the case Orbit itself excludes, and 60 mounted rows is below the count
where a virtualizer's own observers and correction state pay for themselves.

The `WHY NOT A VIRTUALIZER` comment in `chat-plane.tsx` now carries a dated
`RE-EXAMINED` note pointing at that section and at the condition that would
reopen it: a measurement showing the 60-row window itself exceeding frame
budget. After this ticket, it does not — frames hold at 16.7 ms p50 / 17.6 ms
p95 through the stream.

## What was not needed

`content-visibility: auto` and CSS containment on settled rows were next on the
ticket's list and are cheap to try. They were not applied, because after the
Shiki change the stream-while-scroll measurement has no dropped frames and no
long tasks left to remove in either arm. Adding containment now would be a
change with no number behind it. Streamdown already applies
`content-visibility` to its own offscreen code blocks, which is why the harness
has to pin the reader inside the live row to measure anything at all.

`requestIdleCallback` was not needed either. Moving Shiki off the streaming
frames entirely is strictly better than scheduling it at idle during them, and
the settle-time pass has a frame budget of its own.

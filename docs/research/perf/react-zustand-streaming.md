# React + Zustand streaming performance: published techniques vs Volli

Research date: 2026-09-13. Scope: (a) streaming markdown at many deltas/sec while
scrolling, (b) large lists / many concurrently-updating Zustand subscriptions.
Read-only on source; every technique below was checked against this repo with
`rg` before claiming "Volli does / doesn't do it".

Baseline versions in this repo: React 19.2 (`apps/desktop/package.json:66`),
Zustand 5 (`:76`), Streamdown 2.6.0 (`:72`), `use-stick-to-bottom` 1.1.6 (`:74`),
Vercel AI SDK 7 (`:52`).

What Volli already does (so the findings below don't re-recommend it):

- **rAF-coalesced store writes.** `ChatSessionClient.#receive` buffers frames /
  overlays / progress and folds **one store write per batch** through
  `FlushScheduler` (`packages/session-presentation/src/client.ts:315-338`,
  `#receive`/`#flush` ~862-890). This is the single most important streaming
  technique and it is already in place.
- **Block-level markdown memo.** Streamdown splits into blocks and memoizes each
  (`streamdown.ai/docs/memoization`, verified in repo comments); Volli adds a
  custom `MessageResponse` comparator on `(children, isAnimating)` plus a stable
  `components` map identity
  (`components/ui/ai-elements/message.tsx:98-128`), and a stable `turnContext`
  that deliberately excludes `working` so settled turns never re-parse
  (`components/chat/chat-plane.tsx:1044-1068`).
- **No Streamdown `animated` controller.** Omitting `animated` keeps Streamdown
  on its `startTransition` block-commit branch instead of urgent per-token
  re-render of the whole block tree (`message.tsx:64-96` — read Streamdown 2.5.0
  compiled output to verify against 2.6.x before trusting it blindly).
- **Tail windowing.** 60-row tail + 40-row anchored pages with place-holding
  scroll compensation (`transcript-window.ts`, `chat-plane.tsx:1659+`).
- **Throttled scroll reads.** `passive` listener + one geometry read per rAF
  (`chat-plane.tsx` `onScroll`/`read`), instant (non-spring) stick-to-bottom
  (`conversation.tsx` header comment, measured 89px→13px standing offset).
- **Throttled sidebar hot path.** `bumpOutput` coalesces to 1 write/sec/session
  (`stores/sessions.ts: OUTPUT_THROTTLE_MS`); sidebar uses `useShallow` for
  derived maps (`components/sidebar/active-sessions.tsx:106-116,188-189`).

---

## 1. Top findings

Each item: technique, source, measured effect where published, Volli status.

### 1.1 `content-visibility: auto` + `contain-intrinsic-size` on transcript rows — NOT DONE

- **Source:** <https://github.com/huggingface/chat-ui/commit/0bca81a8571c5806da280f7e02cdce32d9f1838a>
  (HuggingFace chat-ui PR #2391); guidance rated HIGH impact at
  <https://github.com/vercel-labs/agent-skills/blob/main/skills/react-best-practices/rules/rendering-content-visibility.md>.
- **Measured effect:** chat-ui's commit message: long conversations render every
  message at once; on mobile WebKit the ~2 GB per-tab cap jetsam-kills the tab —
  the same failure mode as the "sixteen planes → two gigabytes" comment in
  `transcript-window.ts`. The agent-skills rule claims ~10× faster initial render
  for 1000 messages (990 off-screen items skip layout/paint); treat that number
  as illustrative, not a benchmark. Baseline support is Sept 2024, so it is
  universally available in this Electron (Chromium) renderer.
- **The catch (from the same commit):** `content-visibility: auto` rows start at
  their `contain-intrinsic-size` estimate, so a single `scrollToBottom` lands
  short of the true bottom as bottom rows render at full height and grow
  `scrollHeight`. chat-ui fixes it with a bounded converge loop: re-scroll across
  up to 5 frames, stopping early at bottom or on user takeover. Any adoption here
  must copy that loop, not just the CSS — it interacts directly with
  `use-stick-to-bottom`'s first-resize scroll and the offset-restore effect in
  `ChatTranscript`.
- **Volli status:** `rg` for `content-visibility|contentVisibility` returns
  nothing. Not done. This is the cheapest available win and it composes with the
  existing tail window (it reduces per-row cost *inside* the 60-row window, and
  makes "return to bottom drops pages" cheaper to reconsider).

### 1.2 Defer Shiki highlighting until the stream finishes — NOT DONE

- **Sources:**
  - Onyx `MessageTextRenderer.tsx` (read in full):
    <https://raw.githubusercontent.com/onyx-dot-app/onyx/c6a758db/web/src/app/app/message/messageComponents/renderers/MessageTextRenderer.tsx>
  - Dyad PR #2987: <https://github.com/dyad-sh/dyad/pull/2987>
  - Failure-mode evidence, Streamdown #195 (5k+ char code blocks freeze the tab
    via synchronous Shiki + main-thread DOM ops):
    <https://github.com/vercel/streamdown/issues/195>
- **Technique:** Onyx runs **two plugin pipelines**: streaming = `remarkGfm` +
  `remarkMath` + `rehypeKatex` only; the full pipeline with `rehype-highlight`
  (and its ~170 KB grammar corpus, loaded dynamically) flips in only once
  `streamFullyDisplayed` is true — defined as stream-done **and** the typewriter
  caught up, deliberately *not* "typewriter currently behind", which oscillates
  between packet bursts and would thrash the pipeline. During streaming, code
  fences render as plain pre/code with zero highlighter cost per token.
- **Measured effect:** no hard numbers published; the evidence is the inverse —
  issue #195's freeze reports, and this repo's own `message.tsx:106-107` comment
  (every closed fence re-highlighting per chunk cost 33k DOM mutations for a 4KB
  message in `docs/plans/delta-frames.md`). Orbit (below) measures ~1.5ms per
  live Streamdown segment vs ~0.05ms for a cached-HTML hit, i.e. Shiki+parse is
  ~30× the cost of the settled path.
- **Volli status:** not done. `GuardedResponse` always renders the full
  `@streamdown/code` + Shiki pipeline, including for the live turn
  (`chat-plane.tsx:2111`, `message.tsx:115-123`). The repo already computes the
  exact gate needed (`liveTurn`, `working`) — see §2.2.

### 1.3 `useDeferredValue` on the streaming string — NOT DONE (for the transcript)

- **Sources:** Dyad PR #2987 (above); React docs
  <https://react.dev/reference/react/useDeferredValue> ("background re-render is
  interruptible… prioritized below keystrokes; adapts to device speed, unlike a
  fixed throttle").
- **Technique:** feed the *deferred* content into the expensive `useMemo`
  (custom-tag parse / markdown parse) while `isStreaming`, live content once
  settled. React renders the new string urgently for cheap consumers (input,
  caret) and re-parses at background priority, abandoning stale parses when the
  next delta arrives.
- **Volli status:** the only `useDeferredValue` in the renderer is the composer
  picker's filter (`components/chat/composer-ui.tsx:1059`). The transcript path
  parses urgently per rAF batch. Note the interaction with the existing
  `FlushScheduler`: deferral and coalescing are complementary (fewer parses ×
  cheaper priority), not alternatives. Dyad's one-line review warning applies:
  gate the memo on the deferred value *and* list `isStreaming` in deps.

### 1.4 Native scroll anchoring instead of JS scroll math — PARTIALLY APPLICABLE

- **Source:** <https://heyditto.ai/blog/reverse-engineering-chatgpt-scroll-behavior/>
  (Ditto, Jan 2026). By intercepting `scrollTo`/`scrollIntoView`/`scrollTop`
  writes in ChatGPT's DOM during streaming they measured **zero JS scroll calls**:
  ChatGPT relies on `overflow-anchor: auto` (default since 2017) + a
  `position: sticky; bottom: 0` composer inside the scroller. Their rewrite
  deleted ~80% of scroll code; the jitter they chased for a year was their own
  `scrollTop = scrollHeight` loop fighting the browser's anchor adjustments.
- **Volli status:** no `overflow-anchor` rule anywhere (`rg` empty), and the
  transcript does the thing Ditto deleted — ResizeObserver-driven re-pin
  (via `use-stick-to-bottom`), a manual `scrollTop` correction after reveals
  (`chat-plane.tsx` layout effect comparing `scrollHeight` deltas), and a
  double-apply offset restore. BUT the transcript is not ChatGPT's case: the
  scroller is externally owned, history is *prepended* above the reader (native
  anchoring handles prepend-growth, which is exactly why the reveal-correction
  effect checks "did the browser already anchor this?" before writing), and the
  repo measured the spring variant and killed it with numbers. The applicable
  residue: (a) audit whether `use-stick-to-bottom`'s per-resize `scrollTop`
  writes fight native anchoring during streaming the way Ditto's did — the
  interception snippet in that post is a 10-line experiment that settles it; (b)
  never add `overflow-anchor: none` without reading
  enriquegri/chat-app@c2b0109 (found during research, **not read**): browser
  anchoring + manual `scrollTop += delta` in rAF double-applies and jumps 2× —
  the same double-correction the reveal effect already guards against.

### 1.5 Zustand: every write re-runs every subscriber's selector — MITIGATE, DON'T SWITCH

- **Sources:**
  - pmndrs/zustand discussion #2830 (read):
    <https://github.com/pmndrs/zustand/discussions/2830> — confirms the failure
    mode verbatim: with N components subscribed, **one write runs N selectors**;
    there is no `subState`/per-key subscription. Maintainer answer: `useShallow`
    or split stores. No measured numbers in-thread.
  - Official docs, `useShallow`:
    <https://zustand.docs.pmnd.rs/reference/hooks/use-shallow> — suppresses
    *re-renders*, not selector *executions*. (Also documents the v5 infinite-loop
    trap for object-literal selectors and the two fixes; worth knowing because
    §2.4 proposes more derived selectors.)
  - Official comparison page:
    <https://zustand.docs.pmnd.rs/learn/getting-started/comparison> — states
    Zustand/Redux both require manual selector discipline, while
    Jotai (atom deps) and Valtio (proxy access tracking) get it structurally.
    Asserted, not measured.
  - Measured, with caveats: tworoniak/state-management-comparison (read):
    <https://github.com/tworoniak/state-management-comparison> — same cart UI
    × Zustand/Jotai/RTK with live render counts; reports Zustand ~1.5 kB gzip,
    Jotai ~3.2 kB, RTK ~15.1 kB, and "only changed slices re-render" for all
    three when selectors are correct. Small-N demo, not a stress test.
  - Measured, weak: Marcisbee/js-store-benchmark (read):
    <https://github.com/Marcisbee/js-store-benchmark> — single-counter
    tachometer run; update path puts signals-likes fastest, Zustand mid-pack,
    Valtio anomalously slow (author disabled its batching; author disclaims
    real-world validity). Do not cite its ordering as evidence.
  - Found but **not read** (Zenodo timed out on fetch): "Measuring the Cost of
    State" (doi:10.5281/zenodo.19462715) claims a controlled React-19.1,
    7-library, 13-scenario benchmark with "zero surplus re-renders" for all
    selector libraries + `memo`. Unverified — re-fetch before citing.
- **Volli status / why it matters here:** the sidebar is the N-subscribers case
  in miniature. `ActiveSessions` subscribes to whole maps — `byOwner`
  (`active-sessions.tsx:104`), `parkState` (`:116`), `harness` (`:117`) — so
  every terminal output burst (throttled to 1/s), every harness event, every
  layout change re-runs those selectors *and* `buildActiveSessionListing` for
  every project section. `containers`/`parkState`/`harness` are bare references,
  so any write to the map re-renders even with `Object.is`. The chat side is
  better isolated (per-session slices + `sessions[sessionId]` identity checks in
  `chat-sessions.ts` `update()`), but `openTabs`/`starting` objects are still
  coarse. Concrete mitigations in §2.4; no library switch is justified by the
  measured evidence (all selector libraries converge when selectors are right;
  Jotai/Valtio move the discipline, they don't remove it).

### 1.6 Transient (React-bypassing) updates for scroll/stream metadata — NOT USED

- **Source:** Zustand README "Transient updates" (read, v5.0.15):
  <https://cdn.jsdelivr.net/npm/zustand@5.0.15/README.md> — `store.subscribe`
  in an effect + a ref/DOM write, no re-render; linked sandbox claims "drastic"
  impact for directly-mutated views. `subscribeWithSelector` (same page) adds
  per-slice subscribe with equality fn — but note discussion #2103 (found,
  **not read**): bare `subscribe` fires on *every* write regardless.
- **Volli status:** `subscribeWithSelector` unused; no transient pattern in the
  renderer. Candidates: the scroll-position bookkeeping (`before` ref,
  `rememberTranscriptView`) already lives in refs — good — but `lastOutputAt`
  ticks flow through React (`useShallow` + re-render + re-derive listing) at up
  to 1 Hz per live session; a `subscribeWithSelector`-fed clock or a transient
  timestamp read at render time would remove the periodic re-render entirely.

### 1.7 React Compiler 1.0 — NOT ADOPTED (repo targets manual memo)

- **Source:** <https://react.dev/blog/2025/10/07/react-compiler-1> (Oct 2025,
  stable; Meta Quest Store: up to +12% loads/nav, 2.5× on some interactions,
  memory neutral). Relevant guidance: compiler memoization is *as precise or
  more* than manual (it memoizes past early returns); **leave existing memo in
  place** (removing it changes compilation output); `useMemo` remains as an
  escape hatch for effect deps. Vite path is `vite-plugin-react` + Babel
  plugin; oxc support still in flight (oxc-project/oxc#10048) — matters if the
  build uses oxc.
- **Volli status:** no compiler plugin configured (`rg` for
  `react-compiler|babel-plugin-react-compiler` empty). The codebase is
  heavily manual-memo (`ChatTurn`, `MessageResponse`, `turnContext`,
  `useStableList`/`holdList`). I could not find ticket VC-216 in the repo
  (`rg VC-216` hits only TS `compilerOptions` prose) — confirm the ticket
  number before referencing it. Adoption fits this codebase unusually well
  (memo discipline is load-bearing and brittle — e.g. the `components`-identity
  teardown bug in `message.tsx:101-107`), but the "don't remove memo while
  adopting" rule means it pays off as *safety net + finer granularity*, not as
  memo deletion. Note the `useStableList` render-time `useRef` write: that is
  exactly the kind of pattern compiler lint flags (`set-state-in-render`) —
  verify it compiles clean before enabling per-file.
- **React 19 specifics that matter regardless** (React docs, both read):
  - `<Activity mode="hidden|visible">`
    (<https://react.dev/reference/react/Activity>): hide + restore with state
    and DOM preserved, effects torn down while hidden, hidden children still
    re-render at lower priority. Directly relevant: **tab switching currently
    unmounts chat planes** (`transcript-window.ts` remount section) and rebuilds
    transcript state from `rememberTranscriptView`. Activity would keep the
    plane (and its memo tree, Shiki cache warmth, scroll position) alive.
    Cost: hidden planes keep DOM + keep re-rendering on store writes — pair
    with §2.1 or it trades mount cost for steady-state cost.
  - `useDeferredValue` semantics
    (<https://react.dev/reference/react/useDeferredValue>): background render
    is interruptible and device-adaptive; **requires `memo` on the deferred
    consumer** or the optimization is defeated (docs Pitfall) — `ChatTurn`/
    `MessageResponse` already qualify.

### 1.8 Streamdown `mode="static"` for settled content — NOT USED

- **Source:** <https://github.com/vercel/streamdown/blob/main/skills/streamdown/references/features.md>:
  streaming (default) = split into blocks + remend + carets + per-block memo;
  `mode="static"` = single unit, skips streaming optimizations; "all props work
  in both modes".
- **Volli status:** no `mode=` prop on any Streamdown usage — settled turns from
  an hour ago still pay block-splitting + remend on every parent render that
  reaches them (memo usually bail-outs, but any `isAnimating`/`components`
  identity slip re-runs the streaming pipeline). Cheap experiment: render
  settled turns with `mode="static"` and measure against `docs/plans/delta-frames.md`.

### 1.9 Orbit "measure once" virtualization for AI chat — the state of the art for the virtualizer question

- **Source:** <https://orbit.build/blog/measure-once-ai-chat-virtualization>
  (ships in Orbit chat UI; Streamdown + Shiki, same stack as Volli).
- **Findings with numbers:** live Streamdown segment ~1.5ms, 3–8 segments/reply,
  ~20 segments/viewport-scroll = ~30ms inside an 8.3ms (120Hz) frame; cached
  `innerHTML` hit via `dangerouslySetInnerHTML` ~0.05ms (30×). Architecture:
  (a) row-height cache in IndexedDB keyed `sessionId:messageId` (50 sessions,
  30-day TTL) feeding TanStack `estimateSize` + ref-attach `measureElement`;
  (b) rendered-HTML cache keyed by djb2(segment text) with MutationObserver +
  80ms settle before capture; (c) per-row 500ms settle gate before persisting a
  measurement — the **pre-Shiki trap**: first RO fire records the wrapper height
  (e.g. 210px), markdown 380px, post-Shiki 470px; persisting early poisons the
  cache and overlaps rows on revisit; (d) `measureElement` split — cached value
  on ref-attach (`entry === undefined`, "a lie that works"), honest DOM read on
  RO fires, else the cache can never correct (viewport-width change, wrong
  entry); (e) scroll-compensation guard: TanStack `isScrolling` misses
  rAF-driven `scrollTop` writes, so gate `shouldAdjustScrollPositionOnItemSizeChange`
  on any scroll event within 250ms.
- **Volli status:** none of this exists here. Its relevance is almost entirely
  to §3 (it is the strongest evidence for/against virtualizing), plus one
  portable idea: the settled-row HTML cache concept maps onto Volli's settled
  turns even without a virtualizer.

---

## 2. Directly applicable

Ordered by expected value ÷ risk. All line pointers verified 2026-09-13.

### 2.1 `content-visibility: auto` on `ChatTurn` (+ `contain-intrinsic-size`)

- **Where:** the row wrapper in `ChatTranscript`'s `mounted.map`
  (`components/chat/chat-plane.tsx:1897-1905`) or one level down in `ChatTurn`
  (`:1943+`). One CSS rule, e.g.
  `.transcript-row { content-visibility: auto; contain-intrinsic-size: auto 240px; }`
  (`auto` + explicit fallback keeps scrollbar calibration while unmeasured).
- **Sketch:** add the class; add chat-ui's converged re-scroll (§1.1) to the two
  places that assume one `scrollTop` write suffices — the reveal-correction
  layout effect and the offset-restore effect in `ChatTranscript`; re-run the
  lab bench (`lab/scratches/chat-performance`, `?resize=` comparisons) plus the
  `chat-plane.window.test.tsx` / `reveal.test.tsx` suites.
- **Why now:** it attacks cost *inside* the 60-row window (Shiki-heavy settled
  turns the tail keeps mounted) without touching the no-virtualizer contract:
  rows stay mounted, `querySelector` reveal still finds them, jsdom tests still
  see a transcript. Caveat to verify: `content-visibility` + the nested
  scrollbars inside tool payloads (the `scroll-chaining.ts` wheel path) — skipped
  subtrees still hit-test correctly, but confirm the inner scrollers don't lose
  their scroll positions when skipped (they shouldn't — layout is skipped, DOM
  persists — but test it).

### 2.2 Two-pipeline markdown: plain render while live, Shiki on settle

- **Where:** `renderSegment` (`chat-plane.tsx:2103-2130`) already receives
  `live`; `GuardedResponse`/`MessageResponse` (`message.tsx:98-128`,
  `markdown-boundary.tsx`) is the seam.
- **Sketch (Onyx pattern, adapted):** when `live && role === "assistant"`,
  render Streamdown with the code plugin's highlighting disabled (plain
  pre/code — check what `@streamdown/code` exposes; fallback is a `components`
  override for `pre`/`code` that skips Shiki, mirroring the existing
  `chatMarkdownComponents.code` override at `chat-markdown.tsx:316`), then flip
  to the full pipeline when the turn settles (`live` false — already a prop).
  Gate on turn-settle, not on "highlighter idle", per Onyx's
  `streamFullyDisplayed` lesson. Keep the `components`-map identity discipline
  (`message.tsx:101-114`) — the two pipelines need two *stable* maps, not one
  map rebuilt per token.
- **Expected effect:** removes the per-chunk re-highlight of every closed fence
  (the 33k-mutations/4KB case in `docs/plans/delta-frames.md`) from the hot
  path; highlighting cost moves to once-per-turn. Visible trade: code fences in
  the *live* turn render unhighlighted until the turn completes — Onyx, Dyad and
  ChatGPT-adjacent apps all accept this; confirm with design before shipping.

### 2.3 Defer the live turn's parse with `useDeferredValue`

- **Where:** the `segment.part.text` → `GuardedResponse` edge for the live turn
  (`chat-plane.tsx:2105-2112`), or one level up where `messages` enters
  `groupTurns`/`segmentTurn`.
- **Sketch:** `const deferredText = useDeferredValue(text)` consumed only by the
  live text segment's memo chain; urgent render keeps caret + appending text
  (cheap), parse follows at background priority and self-abandons on the next
  delta. Requires the memo chain to stay intact (it is: `ChatTurn` +
  `MessageResponse` comparators). Combine with — not instead of — the rAF
  `FlushScheduler`.
- **Measure:** composer typing latency during a streaming turn (the input and
  the stream currently contend at the same priority) and dropped-frame count in
  the chat-performance scratch.

### 2.4 Narrow the sidebar's subscriptions (the N-selectors failure mode)

- **Where:** `components/sidebar/active-sessions.tsx:102-134,184-189`; stores
  `sessions.ts` (`byOwner`, `parkState`, `harness`, `lastOutputAt`),
  `chat-sessions.ts` (`openTabs`, `sessions`), `board.ts` (`ticketsByProject`),
  `workspace.ts` (2441 lines — nav/open-ticket/expanded-groups per project).
- **Sketches, cheapest first:**
  1. Replace whole-map subscriptions with per-row subscriptions: each band row
     selects its own session's slice (`state.byOwner[owner]?.tabs…`,
     `state.harness[id]`) so a write for session A doesn't re-run selectors for
     rows B–Z (discussion #2830's exact prescription; `session-band-row.tsx`
     is the seam).
  2. Memoize `buildActiveSessionListing` on its true inputs (it already takes
     clock boundaries as arguments — keep that) so selector re-runs that return
     equal inputs don't rebuild the listing.
  3. Move `lastOutputAt` ticks off React: `subscribeWithSelector` on
     `lastOutputAt[sessionId]` (or a transient `subscribe` + version counter)
     feeding only the rows whose relative-time label actually changed, instead
     of re-rendering the band at up to 1 Hz per live session.
  4. Split-or-shallow the coarse objects: `openTabs`, `starting`,
     `ticketsByProject[projectId]` are re-created per write; where identity
     can't be preserved, `useShallow` with a narrower pick (per the v5
     object-literal trap in the `useShallow` docs — prefer separate scalar
     selectors over one object pick).
- **Why:** this is the only place in the app matching the published Zustand
  failure mode (§1.5), and every fix is local to selectors — no store split, no
  migration.

### 2.5 Adopt React Compiler incrementally as a safety net

- **Where:** build config (check whether the pipeline is Babel-based —
  `vite-plugin-react` accepts the compiler as a Babel plugin — vs oxc, where
  support is still in flight per the 1.0 post); enable per-file/directory first
  per the incremental-adoption guide linked from
  <https://react.dev/blog/2025/10/07/react-compiler-1>.
- **Preconditions:** fix/verify the `useStableList` render-time ref write
  (`chat-plane.tsx` ~`useStableList`) under `eslint-plugin-react-hooks`
  `recommended` (compiler 1.0 folded the compiler lint into it); keep all
  existing `memo`/`useMemo` in place during rollout (official guidance).
  Confirm the actual VC ticket number — "VC-216" does not appear in the repo.
- **Expected effect:** per Meta, up to +12% loads/nav and 2.5× on some
  interactions, memory-neutral; for Volli the realistic win is covering the
  memo gaps no human maintains (every new `useMemo` that forgets a dep, every
  fresh object literal passed to a memoized row) rather than replacing the
  hand-tuned transcript memo layer.

### 2.6 Evaluate `<Activity>` for tab-switched chat planes

- **Where:** the tab-mount/unmount boundary that `transcript-window.ts`'s
  remount section works around (`rememberTranscriptView` / `readTranscriptView`).
- **Sketch:** wrap each session tab's plane in `<Activity mode={active ?
  "visible" : "hidden"}>` so tab switches preserve DOM, memo trees, Shiki
  warmth and scroll position instead of rebuilding them. Budget the cost first:
  hidden planes still re-render on store writes (lower priority) and keep full
  DOM — with 60-row windows × N open tabs this may exceed the current unmount
  budget; pair with §2.1 and consider capping hidden planes (e.g. Activity for
  the last K visited, unmount beyond that).

---

## 3. Re-examining the no-virtualizer decision

The comment (`chat-plane.tsx:1625-1642`) gives four reasons: (1) the scroller is
owned by `use-stick-to-bottom` and both candidate libraries want to own it;
(2) row heights are unguessable (one line … 400-line payload in a nested
scroller; disclosures ×50 on click); (3) tail+pages bound the document anyway;
(4) `querySelector` reveal and jsdom tests need real rows.

**Verdict: the decision still holds for Volli today, but two of its four legs
have weakened since it was written, and the fallback position should be
`content-visibility` (§2.1), not "revisit virtualization later".**

Against virtualizing (still strong):

- **The scroller-ownership objection is intact.** TanStack's chat mode
  (`anchorTo: 'end'` + `followOnAppend` + `scrollToEnd`/`isAtEnd`, all documented
  at <https://tanstack.com/virtual/latest/docs/chat> and
  <https://tanstack.com/blog/tanstack-virtual-chat>) re-implements the bottom
  lock, wheel detach, prepend stability and streaming pin that
  `conversation.tsx`/`ChatTranscript` already own *with local measurements*
  (89px→13px standing offset; sentinel arming; double-correction guards).
  Adopting a virtualizer means deleting that tested behavior and re-proving it
  inside someone else's scroll state machine — which is exactly the migration
  Ditto regrets in the other direction
  (<https://heyditto.ai/blog/reverse-engineering-chatgpt-scroll-behavior/>).
  Virtuoso's purpose-built `VirtuosoMessageList` (commercial license,
  <https://virtuoso.dev/message-list/>) owns even more (its `scrollModifier`
  state machine), and its issue tracker still carries dynamic-height chat
  flicker reports (e.g. react-virtuoso#1240, found during research, **not
  read** — verify before citing).
- **Volli's rows violate Orbit's generalization test.** Orbit's "measure once,
  use forever" architecture — the best published answer to AI-chat
  virtualization (<https://orbit.build/blog/measure-once-ai-chat-virtualization>) —
  only works when "this row's pixel height at this width is the same in two
  weeks". Volli rows have user-toggled disclosures (×50 height changes),
  nested scrollbars, tool payloads that expand/collapse, and interaction cards
  that resolve in place. Orbit explicitly lists editable/toggleable rows as
  *where the pattern does not apply*. The pre-Shiki trap (210→380→470px across
  three RO fires, 500ms per-row settle gate) would be worse here, where Shiki
  is only one of several async height movers.
- **The tail window already bounds the document.** A virtualizer's payoff scales
  with mounted-row count; 60 rows is below the threshold where virtualization
  beats its own measurement overhead (per-item ResizeObservers, absolute
  positioning, estimate correction).

Weakened legs:

- **"Row heights are not guessable" is now a solved sub-problem upstream.**
  TanStack `measureElement` + `measurementsCache` with `shouldAdjustScrollPositionOnItemSizeChange`
  scoping, and Orbit's ref-attach-lie / RO-truth split with per-row settle
  gating, are concrete, production answers to exactly the cited variance
  (streaming growth, async highlight, disclosure toggles). If Volli ever
  outgrows the tail window (e.g. 60 rows of Shiki-dense output still jank on
  low-end hardware *after* §2.1–2.3), the measurement layer no longer needs
  inventing — but note Orbit's bill: two IndexedDB caches, three settle timers
  (80/500/250ms), 29 integration tests, and a schema-reset story. That is the
  honest price tag.
- **jsdom invisibility is a test-harness problem, not an architecture veto.**
  Measurable-zero-height rows breaking `chat-plane.window.test.tsx` et al. can
  be answered with a non-virtualized test renderer; it shouldn't decide the
  production architecture. (It does raise the adoption cost, though.)

Recommended posture: **keep the tail window; add `content-visibility: auto`
(§2.1) as the "virtualizer without a virtualizer"** — it gets ~most of the
layout/paint skipping with none of the scroller ownership, measurement-cache,
or test-harness costs, and the HF chat-ui commit proves it composes with
stick-to-bottom scrolling given the converge loop. Revisit full virtualization
only with a measurement showing the 60-row window itself exceeding frame
budget after §2.1–2.3 land, and if so, start from TanStack's chat guide (MIT,
headless, keeps Volli's scroller markup) rather than Virtuoso's message list
(commercial license + owned scroll state machine).

---

## 4. Sources

Every URL below was fetched and read in full (or, where noted, read to the
tool's character bound) during this research. Nothing listed here is cited
second-hand from a snippet.

Streaming / markdown:

- <https://streamdown.ai/docs/memoization> — Streamdown block-level + component
  memoization; `isAnimating` streaming example.
- <https://github.com/vercel/streamdown/blob/main/skills/streamdown/references/features.md> —
  streaming vs `mode="static"`, remend table, memoization notes.
- <https://github.com/vercel/streamdown/issues/195> — large-code-block freeze
  via synchronous Shiki; suggested mitigations.
- <https://raw.githubusercontent.com/onyx-dot-app/onyx/c6a758db/web/src/app/app/message/messageComponents/renderers/MessageTextRenderer.tsx> —
  two-pipeline (deferred `rehype-highlight`) renderer; `streamFullyDisplayed`
  one-way gate; stable component identities via refs.
- <https://github.com/dyad-sh/dyad/pull/2987> — `useDeferredValue` for markdown
  parsing during streaming (+ review caveat on `isStreaming` in deps).

Scroll:

- <https://heyditto.ai/blog/reverse-engineering-chatgpt-scroll-behavior/> —
  ChatGPT zero-JS-scroll finding; `overflow-anchor` + sticky composer; monotonic
  buffer; scroll-API interception debugging recipe.
- <https://github.com/huggingface/chat-ui/commit/0bca81a8571c5806da280f7e02cdce32d9f1838a> —
  `content-visibility` on messages + 5-frame converged `scrollToBottom`.
- <https://github.com/vercel-labs/agent-skills/blob/main/skills/react-best-practices/rules/rendering-content-visibility.md> —
  `content-visibility: auto` + `contain-intrinsic-size` rule (HIGH impact).
- <https://tanstack.com/virtual/latest/docs/chat> — `anchorTo: 'end'`,
  `followOnAppend`, stable keys, streaming-pin pattern.
- <https://tanstack.com/blog/tanstack-virtual-chat> (May 2026) — reverse-scroll
  contract; prepend stability; pinned streaming growth via size deltas.
- <https://virtuoso.dev/message-list/> — commercial message-list component API
  (`computeItemKey`, `scrollModifier` state machine).

State:

- <https://cdn.jsdelivr.net/npm/zustand@5.0.15/README.md> — transient updates
  recipe; `subscribeWithSelector` signature; multi-slice + `useShallow` guidance.
- <https://zustand.docs.pmnd.rs/reference/hooks/use-shallow> — `useShallow`
  semantics; v5 object-literal infinite-loop trap and fixes.
- <https://github.com/pmndrs/zustand/discussions/2830> — N-subscribers ×
  N-selectors-per-write confirmation; maintainer answer (shallow/split).
- <https://zustand.docs.pmnd.rs/learn/getting-started/comparison> — Zustand vs
  Redux/Valtio/Jotai/Recoil render-optimization models (asserted).
- <https://github.com/tworoniak/state-management-comparison> — same-UI ×
  Zustand/Jotai/RTK with live render counts; bundle sizes (1.5/3.2/15.1 kB gzip).
- <https://github.com/Marcisbee/js-store-benchmark> — tachometer counter
  benchmark (weak; author-disclaimed; do not cite ordering).

React 19:

- <https://react.dev/blog/2025/10/07/react-compiler-1> — Compiler 1.0 stable;
  Meta numbers (+12% loads/nav, 2.5× interactions, memory-neutral);
  keep-existing-memo guidance; Vite/oxc status.
- <https://react.dev/reference/react/Activity> — hide/restore semantics,
  effect teardown, background re-render at lower priority, hydration chunking.
- <https://react.dev/reference/react/useDeferredValue> — interruptible
  background renders; device-adaptivity vs throttle; `memo` requirement.

Virtualization case study:

- <https://orbit.build/blog/measure-once-ai-chat-virtualization> — Streamdown +
  Shiki + TanStack costs (1.5ms/segment, 30× cache-hit ratio), pre-Shiki trap,
  `measureElement` ref-attach/RO split, settle-gated IndexedDB snapshot,
  250ms scroll-compensation guard, generalization test.

Found but not read (do not cite without fetching):

- doi:10.5281/zenodo.19462715 ("Measuring the Cost of State", 7-library React
  19.1 benchmark) — fetch timed out.
- enriquegri/chat-app@c2b0109 (`overflow-anchor: none` vs double-scroll) and
  petyosi/react-virtuoso#1240 (dynamic-height chat flicker) — surfaced in
  search only.

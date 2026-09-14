# Browser view performance: the sidebar-resize jank problem

> Research for Volli Code. Status: **complete**. Every URL below was opened and
> read; a fetch that failed is marked as such rather than cited. VC-363's final
> measurements and implementation verdict are in `browser-resize-vc363.md`.

## 0. The baseline mechanism in this repo (confirmed before VC-363)

- Before VC-363, `apps/desktop/src/renderer/src/components/browser/browser-pane.tsx`
  put a `ResizeObserver` on an anchor div and called
  `controller.reportBounds(anchor.getBoundingClientRect())` on **every** firing.
- Before VC-363, `browser-plane.ts` deduped only identical integer rects and
  fired `gateway.setBounds(...)` — an async IPC call to main with no throttle,
  debounce or rAF coalescing. VC-363 now keeps only the latest lazy bounds read
  per animation frame; the final measurements show why that defensive bound is
  useful but insufficient on its own (`browser-resize-vc363.md`).
- Before VC-363, `apps/desktop/src/main/browser/tab-host.ts` stored each report
  and synchronously called `entry.view.setBounds(...)` on every IPC arrival.
  It now suppresses reports equal to its canonical outer plane before laying
  out the page and optional DevTools split.
- `apps/desktop/src/renderer/src/components/app-shell.tsx` (L414–419): the
  sidebar gap is a `transition-[width]` spacer whose duration is
  `OPEN_MS = 200` / `CLOSE_MS = 160`
  (`components/sidebar/edge-reveal.ts` L82–84). A width transition re-lays-out
  every sibling every frame, so the anchor's rect changes ~every frame for
  ~160–200 ms → roughly a dozen distinct integer rects → roughly a dozen async
  IPC round trips → roughly a dozen native `setBounds` calls, each of which
  reallocates a compositor surface (see §1). The native view is positioned by
  imperative main-process calls while the sidebar moves on the
  renderer-compositor thread — the two can never stay in frame-sync.

Related: ticket VC-253 (offscreen rendering spike) and its trade with VC-251
(screenshot-freeze at detach vs ahead-of-time); `main/browser/picture-store.ts`
(the existing screenshot pipeline a placeholder strategy would reuse);
`apps/desktop/e2e/browser-throttle-bench.mjs` (precedent: models the host's
*mechanism* — one `BrowserWindow` + `WebContentsView` + `setBounds` — without a
built app; manually run, needs a display).

---

## 1. The resize problem — what Chromium does and why it is expensive

A `WebContentsView.setBounds()` is not a move of a DOM box. It allocates a new
surface identity and asks a different process to reflow and repaint the world:

1. **New surface, new frame.** The browser process assigns the view a new size;
   the renderer must produce a fresh `CompositorFrame` at exactly that size.
   That means **Blink relayout + layer re-raster at the new dimensions** — on
   the renderer's main thread and tile workers — before the frame can activate.
   Every intermediate size in a resize stream invalidates the previous pending
   frame, so during a continuous resize the compositor is perpetually chasing a
   size that has already changed again.
2. **Resize locks.** Chromium's `DelegatedFrameHost` (the browser-side owner of
   delegated renderer frames) explicitly throttles this chase: when accelerated
   compositing is on and a widget resize is pending, further UI resizes are
   delayed while waiting for a resized frame from the renderer, with a
   `kResizeLockTimeoutMs = 67` ceiling
   (`content/browser/renderer_host/delegated_frame_host_client_aura.cc`, read
   in source). There is also a "don't evict the surface during resize" path
   and a black gutter color chosen specifically "to avoid flashes of brighter
   colors during the transition" — i.e. Chromium itself expects blank/flash
   pixels during resizes and paints over them.
3. **Heavy pages miss.** Relayout cost scales with page complexity. Electron
   issue #3615 (2015, read) demos a 1000-element page whose content visibly
   trails the window edge; the follow-up #36280 (2021, read in part — the
   reader returned only the tail of the thread) still reproduces it on
   Electron 21.x. A search snippet surfaces a maintainer response closing that
   class of report as won't-fix on the grounds that Chrome's layout engine
   cannot fully synchronize window resize with layout change — **I could not
   render the full thread, so verify before quoting that statement.** The
   mechanism, however, is confirmed in Chromium source above.

Electron amplifies all three, and this repo stacks a fourth:

- **Async IPC in the resize path.** Renderer `ResizeObserver` → `ipcRenderer`
  → main `view.setBounds()`. Each hop crosses threads/processes. Issue #37330
  (read) reports `setBounds` from inside an async IPC call silently not taking
  effect without a ~25 ms delay; #39993 (found via search, not read) reports
  first `setBounds` calls not painting; #34580 (found via search, not read)
  reports views not repainting after `setBounds` at all. The primitive is
  racy under rapid successive calls even before animation is involved.
- **No frame sync between the CSS transition and the native view.** The
  sidebar moves on the renderer compositor thread (vsync-aligned); the native
  view moves on imperative main-process calls arriving ≥1 frame + 1 IPC hop
  later. A sibling project hit exactly this and wrote it down: "the view
  trailed the window edge by >=1 frame + an IPC hop" (get-bb/bb commit
  `c80656d`, read in full — see §2).
- **This repo's multiplier.** §0: ~160–200 ms of width transition → ~a dozen
  distinct integer rects → ~a dozen uncoalesced IPC round trips → ~a dozen
  native surface reallocations, each restarting the §1 chase. Integer-pixel
  `sameBounds` dedup (`browser-plane.ts`) barely helps because an eased width
  transition genuinely lands on a new integer width most frames.
- **`WebContentsView` has no `setAutoResize`.** Issue #43802 (found via
  search, not read) records that the old `BrowserView.setAutoResize` did not
  survive migration and the sanctioned replacement is a manual resize
  listener — i.e. every app hand-rolls this sync, and hand-rolls its bugs.
  Related breakage threads found via search (not read): #42501, #42003,
  #22174, #13468, #41121, #43257 (bounds ignored until visible — relevant to
  preloading/hidden tabs).

## 2. Published workarounds, ranked by UX preservation

Ranked best-UX-first. All preserve a live page; they differ in what the person
sees during the ~200 ms.

### 1. rAF-coalesce the bounds stream (best: live-follow, minimal cost)

Collapse each frame's burst of `ResizeObserver` firings to one `setBounds`.
Shipped by the sibling project get-bb/bb (commit `c80656d`, read): their first
iteration added "a burst of resize ticks collapses to a single native
setBounds per frame" with the comment that batching "lets the visible overlay
follow the panel smoothly — far better than blanking the view for the whole
drag, which flashed." They explicitly tried hiding during resize and rejected
it for flashing. Cost: still trails by ~1 frame + IPC; on heavy pages the
compositor chase (§1) remains visible as slight lag, but there is no flicker,
no freeze, no jump.

### 2. Resize-invariant layout descriptor — take renderer IPC out of the drag path

bb's second iteration (same commit): instead of streaming pixels, the renderer
sends `{left, top, rightInset, bottomInset}` once per layout-*shape* change;
the main process reprojects bounds from the cached descriptor during OS window
resizes, so "renderer IPC is not part of the window-edge drag path" and
"identical descriptors are ignored." This is the best published answer for
*window-edge* drags. It does **not** directly cover Volli's sidebar case — the
sidebar moves a renderer-side CSS box the main process cannot derive — unless
main is taught the animation (start/end + duration/easing) and interpolates
itself. That is speculative; listed as an idea in §5, not a shipped pattern.

### 3. Main-side batching of `setBounds` (defense in depth, pairs with 1)

Coalesce IPC arrivals per tab per tick in `tab-host.ts` (`layout`/`setBounds`)
so any renderer spam — present or future — still produces ≤1 native call per
frame. No published app was found naming this; it falls out of the same
reasoning as 1 and protects the main thread regardless of renderer discipline.

### 4. Screenshot placeholder during the transition (rejected)

Volli owns a screenshot placeholder for overlays, where the native plane must
leave so renderer UI can cover it. Extending that mechanism to sidebar motion
would hide/detach the native view at animation start, paint stale pixels for
200 ms, then jump on resync. It also introduces the asynchronous
capture -> hide -> animate handoff that can expose a blank frame. That is
exactly the VC-251 trade VC-253 documents (capture-ahead staleness vs
capture-at-detach flicker), paid on *every sidebar open/close*. It violates the
no-blank acceptance bar and prior art already rejected it for flashing. Keep
the overlay-only behavior, but do not use it for transitions.

### 5. Debounce to the trailing edge (cheap, visibly broken)

Send one `setBounds` ~150–200 ms after the last rect change. Zero IPC during
flight, but the page sits at the old size while the layout moves around it —
a gap or an overlap, every time. Only acceptable if the view is simultaneously
hidden, which reduces to 4 with extra staleness.

### 6. Hide during animation, show settled (rejected by prior art)

The view vanishes for 200 ms. bb tried blanking and reverted it for flashing;
Orchestra (blog post, read in full — see below) hides views behind overlays
but parks rather than detaches. For a high-frequency animation like the
sidebar this reads as constant flicker. Do not ship.

### 7. "Animate with a CSS transform, set bounds once" (not applicable)

A native `WebContentsView` ignores DOM transforms entirely — you cannot slide
or scale it with CSS. This option exists only in the OSR world (§4), where the
page is a canvas. Listed because VC-253's "alternatives" discussion invites
it; for the current architecture it is a non-starter.

### Practitioner prior art: Orchestra's five rules (blog post, read in full)

Orchestra (desktop browser-automation app embedding a `WebContentsView`, same
shape as Volli) published a three-bug saga worth mining:

1. **Never let a parked view reach zero size or detach it.** Zero-size/detached
   views lose their compositor surface; the restore `setBounds` then paints
   nothing (page alive, CDP screenshots fine, screen blank) until a real
   resize rebuilds it. Park at 1×1 in a corner instead. (Volli's VC-278
   never-shown stage already keeps a surface for headless tabs — same
   instinct; do not regress it.)
2. **Restore long-hidden views in two size steps across event-loop turns**
   (1 px off, then real bounds ~150 ms later) — a single `setBounds` after a
   long hide often produces no fresh frame.
3. **Every send path must update the "last sent" cache.** Their worst bug was
   a React cleanup that zeroed bounds without updating the dedup ref, so the
   restore send was deduplicated away forever. Direct audit item for
   `BrowserPlaneController`: `sameBounds`/`bounds` vs every path that moves
   the view without going through `reportBounds` — main-side `goOffScreen`,
   `layout` splits, `dispose`. (Current code looks safe because remounts mint
   a fresh controller with `bounds = null`, but the invariant is load-bearing
   and undocumented — see §5.)
4. **Centralize hide/show** behind one flag; never let feature components touch
   bounds directly.
5. **Verify at the layer that fails**: in-app screenshots composite the page
   correctly even when the on-screen surface is blank — assert with OS-level
   capture or `getBounds` + CDP, not app screenshots. (The existing
   `e2e/browser-headless-capture-probe.mjs` already thinks this way.)

Caveat: this is a vendor blog (they sell Orchestra), cited as empirical prior
art, not as neutral authority. The failure modes described match Electron
issues (#37330, #43257) closely enough to trust the shape.

## 3. `webview` vs `WebContentsView` vs `iframe` vs OSR

| Option | Page perf | Integration (z-index, overlays) | Verdict |
|---|---|---|---|
| `WebContentsView` (current) | Best — it *is* Chromium, fully GPU-composited | Worst — native surface always on top, resizes via async IPC (§1) | Keep; fix the sync (§5) |
| `<webview>` tag | Same engine, extra guest-view plumbing | Same always-on-top class of problems | **Ruled out by Electron itself.** Docs (`api/webview-tag.md`, `tutorial/web-embeds.md`, both surfaced via search; the warning text is quoted verbatim in issue #18187): "based on Chromium's webview, which is undergoing dramatic architectural changes… We currently recommend to not use the webview tag." I read #18187's context only via search/snippet — the docs wording above is consistent across three independent search hits. |
| `<iframe>` | Best integration — ordinary composited DOM | Free | **Ruled out (VC-253):** `X-Frame-Options`/`frame-ancestors` refuse framing on most real sites. No evidence needed beyond the headers' ubiquity. |
| OSR (§4) | Full page speed minus a capture+copy+upload tax per frame | Best — page is a canvas, z-index works, nothing freezes | Open question; the spike VC-253 defines. |

No benchmark was found showing `webview` outperforming `WebContentsView` on
resize; the two share the guest-compositor architecture and the tag adds
event-routing complexity the team is actively retreating from. There is no
performance case for `webview` here even before the deprecation warning.

## 4. OSR verdict — the honest cost

Even-handed assessment. Sources: Electron's OSR tutorial
(`docs/tutorial/offscreen-rendering.md`, read), the shared-texture PR #42953
(read), the OSR frame-pipeline README (`shell/browser/osr/README.md`, read),
the `sharedTexture` design README (`shell/common/api/shared_texture/README.md`,
read), issues #45428 / #8522 / #20333 (first read, others via search), and the
VC-253 ticket text. This repo is on **Electron 44**, so the shared-texture path
(shipped in 33, backported to 33-x-y) is available.

### What OSR buys (the VC-253 case, fairly stated)

The page becomes a bitmap/canvas in renderer DOM: z-index works, overlays
never conflict, nothing detaches or freezes, resize is a canvas resize the
compositor handles in-frame. The whole VC-251 class (freeze staleness vs
flicker, resize-while-frozen, same-task-swap limits) disappears. Idle cost is
near zero — "when nothing is happening on a webpage, no frames are
 generated." Only dirty regions are delivered to `paint`. This is real and
is the strongest argument for it.

### The three modes and their prices (from the official tutorial)

1. **Software output** (`app.disableHardwareAcceleration()`): fastest CPU
   frame generation of the non-shared-texture modes — but app-wide. Kills GPU
   compositing for everything, including terminal rendering. VC-253 already
   rules it out; concur.
2. **GPU + CPU bitmap** (`useSharedTexture: false`, the default): full page
   speed, then **GPU→CPU copy every frame + IPC + canvas draw**. The docs say
   outright it is *slower* than software mode despite supporting GPU features.
   Frame-rate ceiling notes: 240 fps max in this mode ("greater values bring
   only performance losses"). For a full-window browser tab at 60 Hz this is
   a permanent per-frame tax on the hottest surface in the app.
3. **GPU shared texture** (`useSharedTexture: true`, Electron ≥ 33): "no
   CPU-GPU memory copies overhead" — near-zero-copy (actually one
   `CopyRequest` of the frame texture, per the PR author, a Chromium
   contributor). But:
   - It is "an advanced feature requiring a native node module": a new
     `electron-rebuild` dependency beside better-sqlite3/node-pty, with
     per-platform handle code (D3D11 `HANDLE` / macOS `IOSurfaceRef` / Linux
     dmabuf fds) that Volli would own.
   - **Manual `texture.release()` per frame.** The pool holds 10 frames; hold
     textures and the pool drains, frames stop, and all you get is a GC-time
     warning. Main-process discipline on a 60 Hz path.
   - **Popup widgets are NOT composed** (select dropdowns, autofill, context
     menus): the app receives both textures and must composite them itself.
     A real browser tab without working `<select>` is a visible regression.
   - The texture is a **pool, not one stable surface**: a different texture
     per frame; open-the-handle-every-event, copy to your own texture,
     release ASAP. Caching opened textures corrupts.
   - `textureInfo` may ride IPC to the renderer, but **release is
     main-process-only** — the 60 Hz acquire/display/release loop spans two
     processes by design (see the `sharedTexture` README's SyncToken
     discussion).
   - macOS is the thin path: issue #45428 (read, open) reports no test and no
     docs for consuming `sharedTextureHandle` on macOS; the handle is an
     `IOSurfaceRef` but "no clue is given" how to use it. Volli is
     macOS-first (bench docs, occlusion notes) — this gap lands on us.

### Input: the cost VC-253 names, confirmed

"Input forwarding is ours. Mouse, wheel and keyboard go through
`sendInputEvent`." macOS scroll momentum, hover, IME, drag fidelity are the
risks. Corroboration: issue #8522 (via search) — focus/blur events don't fire
in OSR pages; #20333 (via search) — `sendInputEvent` gaps for embedded video
input. Nothing found contradicts the ticket: nobody claims OSR input is
indistinguishable from native; the claim is only that it can be made adequate.
A full-window *interactive browser* is the hardest OSR input case (cf. VJ apps
that only display). The spike's input-fidelity matrix (scroll momentum, hover,
text selection, IME) is the right gate, and it must run on macOS.

### What breaks or degrades (spike checklist)

Smooth scrolling and video pay the full capture→copy→upload pump per frame;
latency stacks (capture + IPC + canvas upload + renderer rAF) on top of the
page's own latency. Verify in the spike: `<select>`/autofill popups
(uncomposed by design), drag-and-drop, IME composition, tooltips, cursor
styles, DevTools docking, find-in-page, `window.open`/popup windows,
fullscreen video, WebGL canvases inside the page (supported in GPU modes per
docs, but measure), and HiDPI `devicePixelRatio` handling of the canvas.
Battery: a video-playing OSR tab never idles.

### Who shipped it (evidence, not vibes)

- Electron's OSR mirrors CEF's OSR (stated in Electron's own tutorial); CEF
  OSR is the long-established route for web content in games/3D scenes.
- In Electron proper: `naporin0624/electron-texture-bridge` (found via
  search, not read in full) — a napi-rs addon doing exactly the
  `useSharedTexture` → Syphon/Spout/external-program loop for VJ software;
  and `benoitlahoz/node-syphon` (#45428), whose author wants the shared-texture
  path because canvas-readback-over-IPC "works" but "is not very
  efficient." Both are *display/rebroadcast* uses, not interactive browsing.
- **No production interactive-browser-on-Electron-OSR case was found.** That
  absence is data: the mode that needs the least from OSR (display) is where
  adoption is; the mode Volli needs (full-fidelity interaction) is where
  evidence thins out.

### Verdict (not advocacy)

OSR genuinely dissolves the overlay/freeze bug class, and on Electron 44 the
fast path exists. But for a full-window interactive tab it trades a bounded,
measured 200 ms resize lag (fixable per §5 without architecture change) for
permanent ownership of input fidelity, popup composition, a native module with
per-platform texture code, a 10-deep frame pool with manual release on a 60 Hz
cross-process loop, and a macOS consumption path the Electron team hasn't
documented or tested. That is a bigger maintenance surface than a bounds-sync
fix by an order of magnitude. **Recommendation: do §5 first (days, reversible),
run the VC-253 spike against the checklist above (especially macOS input +
`<select>` + video/scroll cost in both GPU modes), and only commit to OSR if
the spike's numbers beat the measured one-endpoint native view rather than a
strawman.**

## 5. Directly applicable — what to change in this repo

Ordered by expected return. All line pointers verified by read/`rg` during
this research.

1. **rAF-coalesce `reportBounds`** — implemented by VC-363.
   `BrowserPlaneController` keeps the latest lazy geometry reader, flushes at
   most once per animation frame, forces the first real placement before show,
   and cancels pending work on disposal. Measurement corrected the forecast:
   this CSS transition's `ResizeObserver` already delivered about once per
   display frame, so the transition stayed at ~13 calls. The implementation is
   still cheap defense against colliding observer/window notifications; the
   material reduction comes from VC-359's one endpoint layout commit.
2. **Do not add a timed main-side batch now.** It was a reasonable defense
   before measurement, but rAF already caps the only renderer producer and
   direct `setBounds` cost was 0.02–0.10 ms. A second unsynchronized clock adds
   settle delay without removing the per-frame native resize stream. Keep the
   main-owned exact dedup below, and revisit batching only if a new producer
   bypasses the frame scheduler.
3. **Commit the exact endpoint in the layout owner** — VC-359's
   Browser-specific instant endpoint/no-reflow boundary now does this. That is
   safer than a renderer timer trying to infer `transitionend`, and the
   endpoint control measured exactly one native placement in every cell.
4. **Keep exact-bound deduplication in main** (implemented by VC-363 after
   the Orchestra audit). The renderer cannot know about main-owned initial and
   page/DevTools placements, so its cache could become stale and swallow a
   legitimate restore. `BrowserTabHost.setBounds` now dedupes against the
   canonical outer plane, where every placement path is visible; the renderer
   retains only a same-animation-frame pending value, never a cross-frame
   placement cache.
5. **Do not hide or detach during the transition.** The screenshot-freeze
   path remains appropriate for overlays that must cover a native plane, not
   for routine sidebar motion. Its stale-frame jump and asynchronous handoff
   fail the no-blank requirement; VC-359 should keep the live view attached and
   commit its exact native bounds at the endpoint.
6. **Do not teach main a duplicate animation clock.** Interpolating
   `setBounds` in main à la bb's layout descriptor remains possible, but it
   preserves the native resize stream and creates a second synchronization
   problem. VC-359 instead removed Browser's in-flight reflow at the source and
   made its pin/unpin boundary instant while a visible native plane exists.

Explicitly **not** recommended: screenshot-freeze for sidebar motion (§2.4),
debounced-only sync (§2.5), hide-during-animation (§2.6), CSS-transform
placement (§2.7 — impossible for native views), `webview` (§3), software-mode
OSR (§4).

## 6. Measurement plan — following `browser-throttle-bench.mjs`

Shape (per the file's own header doctrine): model the host's *mechanism*, not
the app — one `BrowserWindow` + one `WebContentsView`, no built app, no DB.
Manually run, display required, window un-minimized and un-covered (macOS
occlusion throttling flattens everything; keep the bench's occlusion warning).

- **Drive:** script a 200 ms / 160 ms width sweep matching `OPEN_MS`/`CLOSE_MS`
  easing (read the easing curve from `edge-reveal.ts`/app-shell and replay the
  same progression), calling the real path (`view.setBounds` per distinct
  integer rect) vs the candidate (rAF-coalesced). Serve the counter page over
  `http` exactly as the existing bench does (timers + rAF clocks).
- **Count:** IPC/`setBounds` calls per transition; distinct rects observed vs
  sent; trailing-edge settle error (anchor rect vs `view.getBounds()` after
  settle + one fresh guest frame).
- **Time:** guest-visible lag — guest `requestAnimationFrame` deltas during
  the sweep (jank = deltas ≫ 16.7 ms), and time-to-settled: last animation
  frame → guest `innerWidth` matches anchor + one `PipelineReporter`-clean
  frame.
- **Trace (categories that matter):** `cc` (compositor), `viz` (display
  compositor + the `PipelineReporter` BeginFrame→Commit→Activate→Draw→Swap
  chain — "the single most useful event"), `gpu` (GPU process), `blink`
  (style/layout), `toplevel` (message-loop tasks), plus
  `disabled-by-default-devtools.timeline.frame` for frame markers. Source:
  the browser-rendering.com tracing guide (read in full). Capture via
  `Tracing.start`/`Tracing.end` over CDP — the repo already drives CDP
  (`main/browser/cdp-controller.ts`, `CDP_COMMAND_TIMEOUT_MS`), so script it
  the same way and open traces in `chrome://tracing`/`ui.perfetto.dev`.
  Confirm category names against the pinned Electron 44/Chromium version
  (`base/trace_event/builtin_categories.h` lists `cc`/`gpu` etc.; renderer-
  side `PerformanceObserver(longtask)` covers main-thread stalls from JS).
- **Regression bar:** ≤1 native `setBounds` per vsync during flight; zero
  frames where guest size ≠ anchor size 100 ms after settle; no blank frame.
  The first two need timestamped anchor, `getBounds`, and guest-viewport
  observations. The last must use OS-level/window-surface capture: CDP can
  return healthy page pixels while the actual native surface is blank
  (Orchestra rule 5). The existing `browser-headless-capture-probe.mjs`
  supplies the pixel-validation pattern, not proof of on-screen composition.
- **A/B the strategies:** uncoalesced vs rAF-coalesced (§5.1) vs the
  endpoint-only/no-reflow control on three pages: trivial, heavy-layout
  (1000-node, after #3615), and video-playing. Report lag-ms + sent-bounds
  count + visible-surface frame evidence per cell. A hidden/frozen view is not
  an acceptable transition arm.

## 7. Many embedded views at once

- **Process-per-view is the standing behavior.** Issue #49960 (read): in
  Electron every `WebContents` gets its own `SiteInstance` + renderer process
  *even for same-origin pages* — unlike Chrome's `window.open` reuse. No
  public API reuses processes. Cost scales ~linearly per open tab: renderer
  process baseline + GPU surfaces/compositor contexts per view. (Chromium's
  own process-model/site-isolation doc describes the design; Electron's
  `tutorial/process-model.md` covers main vs renderer basics.)
- **What teams do:** attach only the visible tab (Volli already stages
  window/headless/detached — VC-238/VC-278); keep `backgroundThrottling: true`
  by default and lease wakefulness explicitly (VC-252 `holdAwake` + the bench
  in `browser-throttle-bench.mjs` quantifies the idle-CPU delta — rerun its
  scenario E with N tabs for the per-view number); `webContents.close()`
  promptly on tab close; cap counts / reload-on-demand for idle tabs.
  Measure with `app.getAppMetrics()` (pattern already in the bench) rather
  than guessing per-view MB.
- **OSR doesn't escape this:** each OSR view still owns a renderer process,
  plus a 10-frame shared-texture pool (or a per-frame bitmap) held in main —
  N OSR tabs multiply the release-discipline risk (§4) by N.

## Sources — every URL actually read

Repo files (read in full or at cited lines): `browser-pane.tsx`,
`browser-plane.ts`, `tab-host.ts` (L515–518, L622, L1329–1333),
`app-shell.tsx` (L414–419), `components/sidebar/edge-reveal.ts` (L79–87),
`main/browser/picture-store.ts` (header), `e2e/browser-throttle-bench.mjs`.
Ticket VC-253 via `volli ticket brief`.

- https://github.com/electron/electron/issues/3615 — heavy-layout resize lag
  report (2015; OP read, full thread not rendered).
- https://github.com/electron/electron/issues/36280 — resize-delay follow-up
  (2021; reader returned only the tail; maintainer won't-fix position seen
  only in a search snippet — verify before quoting).
- https://github.com/electron/electron/issues/37330 — `setBounds` race from
  async IPC (read).
- https://github.com/get-bb/bb/commit/c80656d78ad052446983d981489c9ec544cf70b1 —
  rAF-coalesced bounds + layout-descriptor prior art (read in full).
- https://www.orchestra-automation.com/blog/the-electron-view-that-stayed-blank-until-you-resized-the-window —
  hide/park/restore rules, dedup-cache bug (read in full; vendor blog).
- https://github.com/electron/electron/blob/main/docs/tutorial/offscreen-rendering.md —
  OSR modes, frame-rate/idle behavior notes (read).
- https://github.com/electron/electron/pull/42953 — GPU shared-texture OSR,
  merged Aug 2024, backported to 33-x-y (read).
- https://github.com/electron/electron/blob/main/shell/browser/osr/README.md —
  frame pipeline, 10-frame pool, release discipline (read).
- https://github.com/electron/electron/blob/main/shell/common/api/shared_texture/README.md —
  cross-process texture transfer, SyncToken lifetime (read).
- https://github.com/electron/electron/issues/45428 — macOS shared-texture
  docs/test gap (read, open).
- https://github.com/electron/electron/issues/49960 — per-WebContents renderer
  processes, no reuse API (read).
- https://www.browser-rendering.com/rendering-performance-metrics-and-tooling/devtools-performance-profiling/capturing-a-chrome-tracing-timeline-for-rendering/ —
  tracing categories, `PipelineReporter`, CDP capture (read in full).
- Chromium source: `content/browser/renderer_host/delegated_frame_host_client_aura.cc`
  @ 581ff14 — `kResizeLockTimeoutMs = 67`, gutter-color rationale (read).
- Searched but NOT read (named, not cited as evidence): #34580, #39993,
  #41121, #42501, #42003, #43802, #22174, #13468, #43257, #8522, #20333,
  #18187, naporin0624/electron-texture-bridge.

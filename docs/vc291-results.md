# VC-291 — terminal reflow line loss and accessibility: investigation results

**Status: negative for data loss; positive for a reproducible viewport (scroll-position) defect,
plus four accessibility/harness gaps.**

Every seeded line survived every layout transition that could be exercised. The audit's
"a `pwd` line disappeared after terminal focus was entered and left" is explained — and
reproduced 3/3 — as a **scroll-position** defect, not reflow and not data loss.

## Test setup

| Item | Value |
| --- | --- |
| Commit | `0e1ba3f5` (the audit commit; `origin/main`, no newer source changes) |
| App build | `0.2.0-canary.4`, `pnpm run build` (dist + dist-electron), Electron via `apps/desktop/node_modules/electron` |
| macOS | 26.5.1 (25F80), Apple M1 |
| Displays | Built-in Retina 2560×1600 @2x (main, window here) **plus** an external DELL E2422HS 1920×1080 attached |
| Window | content size pinned to 1280×832 for every run; display scaleFactor 2 |
| Grid at rest | `51 86` (rows cols), row height ≈ 14 CSS px |
| Font | SF Mono (see the Local Font Access note below) |
| Terminal backend | **WebGPU** for every ordinary row (canvas-context probe), **WebGL2** for the GPU-pressure row (forced) |
| Shell | `zsh -l`, idle; no TUI, no prompt redraw plugin |
| Surface | Ticket-detail terminals (the audit's path) for control/resize/focus/splits; Home terminals for the Home hide/show row |

Seed: the ticket's exact `REFLOW-*` block, run once per pane as `sh seed.sh`, `tee`'d to a
reference file that is kept (`/tmp/volli-reflow-<epoch>.txt`, copied into each evidence dir as
`reference-<case>-r<run>.txt`).

### How marker reachability was verified

restty paints into a GPU canvas, so terminal text is not in the DOM and Playwright cannot read
it. Each checkpoint therefore steps the pane's `.restty-native-scroll-host` through the **whole**
scrollback in ~85%-viewport increments, screenshots every step, and OCRs it with the macOS Vision
framework (`apps/desktop/e2e/lib/ocr.js`). A checkpoint's marker set is the union over all steps,
so "reachable by scrolling" is answered for the entire buffer rather than for three sampled
viewports. Markers checked: `REFLOW-BEGIN`, `REFLOW-SHORT-01`, `REFLOW-SHORT-15`,
`REFLOW-LONG-15`, its `-END` tail, `REFLOW-PWD-…`, `REFLOW-END`.

Every checkpoint also records the grid (`stty size`, typed in-pane), the scroll host's
`scrollTop`/`scrollHeight`/`clientHeight`, **which pane it measured** (`data-terminal-pane-id`),
devicePixelRatio, and whether the shell still executed a `REFLOW-CHECK-<case>-<run>` line.

## Deterministic reflow matrix

All rows on a newly seeded pane, three runs each. "Markers" is seed → post-action, out of 7.

| Case | Runs | Grid | Scroll top/max (seed → post) | Markers | Verdict |
| --- | --- | --- | --- | --- | --- |
| Control (10 s idle) | 3/3 | `51 86` unchanged | 1946/1946 → 2016/2016 (pinned) | 7 → 7 | **PASS** |
| Window resize (wide↔narrow ×3, restore) | 3/3 | `51 86` → `51 160` → `51 40` → `51 86` | 1946/1946 → 2506/2506 (pinned) | 7 → 7 | **PASS** |
| Terminal focus (⌥⌘⏎ ×10) | 3/3 | `51 86` → `54 169` in zen → `51 86` on every return | 1960/1960 → **1372/3430 (un-pinned)** | 7 → 7 | **PASS** for retention, **FAIL** for viewport — see below |
| Horizontal split (⇧⌘D + drags 25/50/75/50 ×3) | 3/3 | `51 86` → `25 86` → `12 86` → `37 86` (rows only) | 1946/1946 → **2352/3220 (un-pinned)** | 7 → 7 | **PASS** for retention, viewport drift as above |
| Vertical split (⌘D + same drags) | 3/3 | `51 86` → `51 42` → `51 20` → `51 63` (columns) | 1946/1946 → 5558/5558 (pinned) | 7 → 7 | **PASS** |
| Hide/show — Home tab ↔ Board ×10, then terminal ↔ terminal ×10 | 3/3 | `51 86` unchanged | 1932/1932 → 2352/2352 (pinned) | 7 → 7 | **PASS** |
| Hide/show — Ticket detail ↔ board ×10, then terminal tab ↔ terminal tab ×10 | 3/3 | `51 86` unchanged | 1946/1946 → 1946/1946 (pinned) | 7 → 7 | **PASS** |
| GPU pressure (forced WebGL2, ≥17 live terminals) | 3+3 | `51 86` unchanged | pinned / drift as on WebGPU | **7 → 0** | **FAIL — pane renders nothing; see below** |

The shell answered the `REFLOW-CHECK` probe at every checkpoint of every run, so no pane was ever
wedged. No `REFLOW-*` line was ever missing from a post-action sweep that was present in the seed
sweep — across 27 runs, **zero lost lines**.

## The reproducible defect: the viewport stops following the bottom after a row-count change

The terminal focus row reproduces the audit's observation exactly, 3/3, deterministically. Pane
identity is recorded at every checkpoint, so these readings are provably about the seeded pane:

| After cycle | Grid while focused | Grid on return | scrollTop | scrollMax | Gap below the viewport |
| --- | --- | --- | --- | --- | --- |
| seed | — | `51 86` | 1960 | 1960 | 0 (pinned) |
| 1 | `54 169` | `51 86` | 1624 | 2100 | 476 px ≈ 34 rows |
| 2 | `54 169` | `51 86` | 1596 | 2240 | 644 px |
| 3 | `54 169` | `51 86` | 1568 | 2380 | 812 px |
| 10 (post) | `54 169` | `51 86` | 1372 | 3430 | 2058 px ≈ 147 rows |

Entering terminal focus hides the chrome and re-measures the pane to `54 169`; leaving it returns
the grid to `51 86`. After the **first** round trip the viewport is no longer pinned to the bottom,
and every further cycle moves it another 28 px up while the buffer grows. New output — a `pwd`, a
prompt, the next command's result — is then rendered *below* the visible viewport, which is exactly
what "the line disappeared" looks like. Nothing is lost: the same full sweep that records the drift
finds all seven markers, including `REFLOW-PWD-…`.

Across all 27 runs the correlation is exact:

| Transition | Row count | Column count | Viewport after |
| --- | --- | --- | --- |
| Control, hide/show (Home and Ticket) | unchanged (51) | unchanged (86) | **pinned** |
| Window resize | unchanged (51) | 86 → 160 → 40 → 86 | **pinned** |
| Vertical split + divider drags | unchanged (51) | 86 → 42 → 20 → 63 | **pinned** |
| Horizontal split + divider drags | **51 → 25 → 12 → 37** | unchanged (86) | **un-pinned** (ends 868 px above bottom) |
| Terminal focus ×10 | **51 → 54 → 51** | 86 → 169 → 86 | **un-pinned** (ends 2058 px above bottom) |

Every transition that changed the pane's **row** count left the viewport un-pinned; every
transition that left the row count alone kept it pinned, including the ones that rewrapped the
whole scrollback on a column change (the vertical split swings `scrollMax` 1946 → 8750 at 20
columns → 3024 at 63 columns and still lands at the bottom).

**Classification (ticket taxonomy): Scroll position.** Not reflow (the grid on return is identical
to the grid at seed, and the seeded lines are all still in scrollback), not shell redraw (the
seeded shell is quiet and the reference file matches), not rendering (the content is present at its
recorded offset without any forced repaint), not device-loss replay (no driver-reset warning in any
WebGPU run).

## GPU pressure (WebGL2) — a second, independent defect

There is no checked-in launcher that forces the WebGL2 fallback, and `terminal/gpu-pressure.ts` has
no production caller (only its own model test and comments reference it). The harness forces the
fallback by stubbing `navigator.gpu` in a Playwright init script; the canvas-context probe then
reports `webgpu=false webgl2=true`, so this row **was exercised** rather than skipped — but only
through a harness-only lever, which is filed as a gap.

With the seeded pane open and 16 further live terminals created on top of it, Chromium logs
**`WARNING: Too many active WebGL contexts. Oldest context will be lost.`** (86 occurrences in one
run). What then happens to the seeded pane, 6/6 runs (3 focus + 3 hide/show), with its pane id
verified at every checkpoint (`backOnSeededPane: true`):

| Signal | At seed | After 17+ live WebGL2 terminals |
| --- | --- | --- |
| Markers OCR-readable in a full sweep | 7 / 7 | **0 / 7 — every sweep step OCRs to an empty string** |
| Scroll host geometry | 1946 / 1946 | intact and still growing (2114 / 2114, 3416 max after focus cycles) |
| Shell | answers `REFLOW-CHECK` | still answers `REFLOW-CHECK` at every checkpoint |
| Recovery | — | none: hide/show re-attaches and refits the pane and it stays blank |

The pane is **permanently blank while its buffer and shell are alive**. `restty-engine.ts` arms
`watchGpuDeviceLoss` only when the backend is WebGPU, so under the WebGL2 fallback an evicted
context has no rotation, no `rebuildRenderer()`, no replay, and no toast — the user is left staring
at a dead rectangle with a working shell behind it.

**Classification (ticket taxonomy): Rendering** — the content is in the buffer (the scroll host
keeps reporting and growing its height) but nothing is painted, and it does not come back after a
refit. This is *not* the WebGPU device-loss replay path, which is intentionally bounded.

This needs a machine that actually falls back to WebGL2 to bite a real user; on this M1 the
production default is WebGPU, where all rows pass.

## Accessibility, selection/copy, and find

| Check | Result |
| --- | --- |
| Terminal host semantics | `div[data-terminal-renderer]` has **no role, no accessible name, no ARIA description**; the only focusable node inside is restty's `<textarea class="pane-ime-input">` with `tabindex="-1"` and no label |
| Tab navigation | Eight consecutive `Tab` presses never leave the terminal: focus stays on the IME textarea every time — a **keyboard focus trap** |
| macOS AX tree (what VoiceOver reads) | System Events reports the window as `standard window`, accessibility description `missing value`, one child `group`; a full `entire contents` value dump is **19 bytes and contains no `REFLOW` text** — terminal output is invisible to screen readers |
| VoiceOver itself | Toggled on and off successfully from the harness (⌘F5); reading VoiceOver's cursor via AppleScript is refused unless "Allow VoiceOver to be controlled with AppleScript" is enabled, so the announced wording could not be captured automatically |
| Mouse selection + ⌘C | **Works**, before and after a focus/hide-show/split cycle. Drag-selecting `REFLOW-SHORT-01` through the first long line put 355 bytes on the clipboard containing `REFLOW-SHORT-01` and `REFLOW-LONG-01-` with a full 240-character `x` run — matching the reference file |
| Keyboard selection | **Absent.** `Shift+Arrow` then ⌘C leaves the clipboard unchanged; there is no keyboard-only path to select or copy terminal output |
| Find | ⌘F with the terminal focused opens a field labelled **"Find in scrollback"**, and it really does search terminal output: `REFLOW-SHORT-01` moved the viewport to scrollTop 70 (where that line lives) and `REFLOW-PWD-` to 2534/2534, with the query visible in the pane both times. No match-count text (`n of m`) could be found in the DOM. ⌘K quick-open searches app chrome only and never matches seeded output |

## Completion against the ticket

- Matrix: attached (this file plus `evidence/*/matrix.json`, per-step screenshots and their OCR
  sidecars, and the seed reference files).
- Negative result for line loss: 27 runs, zero lost markers, every row three times.
- Positive result: a deterministic viewport defect with a one-line repro (⌥⌘⏎ twice).
- Accessibility, copy and find results: above; gaps filed and linked.

## Reproducing

```sh
pnpm install && pnpm run build
node apps/desktop/e2e/reflow-matrix-smoke.mjs evidence/matrix-focus --cases=focus --runs=3
node apps/desktop/e2e/reflow-a11y-smoke.mjs evidence/a11y
node apps/desktop/e2e/analyze-vc291.mjs evidence      # matrix table + verdicts
```

### Harness note: Local Font Access wedges terminal init under automation

On this macOS/Electron combination `window.queryLocalFonts()` **never settles** — not with a quiet
window, not with a focused one, not after CDP user gestures. restty awaits it during init, so no
renderer is ever created: no GPU context is acquired, nothing is painted, and typed keys are
swallowed (restty's `shouldSkipKeyEvent` hands printable keys to the IME textarea, whose
`beforeinput` handler returns early while the WASM terminal is not ready). The repo's own
`apps/desktop/e2e/terminal-smoke.mjs` fails checks 1–4, 6–7 and 9–12 here for this reason.

Both harnesses work around it by serving restty the real `/System/Library/Fonts/SFNSMono.ttf`
bytes through a `FontData`-shaped stub, which is recorded in every `run-config.json`. Everything
downstream of font loading — WebGPU/WebGL2, the VT parser, scrollback, refit, the PTY — is
production code. Filed as a harness gap.

## Evidence in this repo

`docs/vc291-evidence/<run>/` carries, per run: `matrix.json` (every checkpoint — grid, scroll
offset/max, measured pane id, marker union per sweep, full renderer console log), `run-config.json`
(commit, OS, displays, window, backend, font workaround), the seeded `reference-*.txt` files, and
the OCR sidecars for the seed and post-action sweeps of the two defect rows. `docs/vc291-analysis.json`
is the folded matrix (`analyze-vc291.mjs` output). The full screenshot set (~82 MB of PNGs plus every
sidecar) stays out of git under `evidence/`, regenerable with `apps/desktop/e2e/run-vc291-matrix.sh`.

## Filed gaps

| Ticket | Gap |
| --- | --- |
| VC-343 | Terminal viewport stops following the bottom after a row-count change (⌥⌘⏎ focus, ⇧⌘D split) — the audit's `pwd` line |
| VC-344 | Terminal output invisible to VoiceOver; `Tab` cannot leave the pane |
| VC-345 | No keyboard path to select or copy terminal output |
| VC-346 | WebGL2 fallback: pane blanks permanently when contexts are evicted, no rebuild, no warning |
| VC-347 | Terminal e2e blocked on macOS 26: `queryLocalFonts` never settles, wedging restty init |
| VC-348 | No supported way to force the WebGL2 fallback (GPU-pressure row is harness-only) |

VC-107 carries the seven acceptance checks with their current-renderer results. Nothing found here
is split-navigation-only, so no gap was sent to VC-215 (recorded there as a comment).

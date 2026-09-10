# VC-291 — terminal reflow line loss and accessibility: investigation results

**Negative for data loss on WebGPU. Positive for a reproducible viewport (scroll-position) defect,
a WebGL2 rendering defect, and four accessibility/harness gaps.**

Every seeded line survived every layout transition that could be exercised on the production
WebGPU backend. The audit's "a `pwd` line disappeared after terminal focus was entered and left" is
explained — and reproduced 3/3 — as a **scroll-position** defect, not reflow and not data loss.

> **This supersedes an earlier version of this document.** That version reported a clean negative
> result from a matrix that had been run on a **malformed seed**, scored by an analyzer that
> **passed a pane which rendered nothing**. Both faults, what they invalidated, and how they are
> now prevented are listed under [What the first pass got wrong](#what-the-first-pass-got-wrong).
> Every number below comes from the corrected rerun.

## Test setup

| Item | Value |
| --- | --- |
| Commit | `596a76cf` on `volli/VC-291-investigate-terminal-reflow-line-loss-and-access` (working tree carried this branch's harness changes; recorded as `treeDirty: true` in every `run-config.json`) |
| App build | `0.2.0-canary.4`, `pnpm run build` (dist + dist-electron), Electron from `apps/desktop/node_modules/electron` |
| macOS | 26.5.1 (25F80), Apple M1 |
| Displays | 2 physical: built-in `Color LCD` 1440×900 logical @ scaleFactor 2 (main, window here) **and** an external `DELL E2422HS` 1920×1080. No virtual/Sidecar display attached |
| Window | content size pinned to **1280×811** for every run (the app clamps the requested 832 to the display's work area), display scaleFactor 2, `devicePixelRatio` 2 |
| Grid at rest | `51 86` (rows cols) |
| Font | terminal font size **14** — `DEFAULT_TERMINAL_FONT_SIZE` (`terminal/appearance-model.ts:15`), unoverridden because the isolated scratch profile carries no Ghostty config. Measured cell box in the 645×716 CSS-px pane: **14.04 × 7.50 CSS px** |
| Font source | SF Mono bytes served through the `queryLocalFonts` workaround (VC-347) |
| Shell (PTY) | **`/bin/zsh`** — measured in the pane (`ps -p $$ -o comm=` and `$0`), idle, no TUI, no prompt redraw plugin |
| Shell (seed script) | **`/bin/sh`** — the seed is run as `sh <script>`; the seed's shape is tested against `/bin/sh`, `/bin/zsh`, `/bin/bash` and `/bin/dash` |
| Terminal backend | **WebGPU** for every ordinary row, **WebGL2** for the GPU-pressure row — both confirmed per run by the canvas-context probe, not by the flag that requested them |
| Surface | Ticket-detail terminals (the audit's path) for control/resize/focus/splits/ticket hide-show; Home terminals for the Home hide-show row and the GPU-pressure row |

### The seed

The ticket's `REFLOW-*` block, corrected so it actually produces what the ticket describes:
**63 logical lines** — `REFLOW-BEGIN`, then `REFLOW-SHORT-01`…`-30` interleaved with
`REFLOW-LONG-01-<240 x>-END`…`-30-`, then `REFLOW-PWD-<cwd>` and `REFLOW-END`.

The ticket's literal text ends each long line with `printf '-END\n'`. Every shell this harness can
land on parses that leading `-E` as a **printf option**: the call fails with
`printf: -E: invalid option`, prints nothing, and emits no newline, so the next iteration's
`REFLOW-SHORT-nn` is welded onto the tail of the long line. The result is 33 lines, not 63. The
`-END` tail now rides in a `%s` argument, where no shell can read it as an option
(`apps/desktop/e2e/lib/vc291-seed.mjs`).

**The seed is validated before any case action runs.** `verifySeedReference()` checks all 63 lines
byte-for-byte — 30 standalone SHORT lines, 30 LONG lines with exactly 240 `x` and their own `-END`,
one `REFLOW-PWD-` line, and no shell error text. A run whose seed does not verify is aborted and
recorded as failed. Every committed `reference-*.txt` in this branch is 63 lines.

Each seeded pane gets its **own** reference file: the log name and the pointer file both carry a
per-run token, and the harness refuses a pointer that is not its own.

### How marker reachability was verified

restty paints into a GPU canvas, so terminal text is not in the DOM and Playwright cannot read it.
At each checkpoint the harness steps the seeded pane's `.restty-native-scroll-host` through the
**whole** scrollback in ~85 %-viewport increments, screenshots every step, and OCRs it with the
macOS Vision framework (`apps/desktop/e2e/lib/ocr.js`). A checkpoint's marker set is the union over
all steps, so "reachable by scrolling" is answered for the entire buffer.

**Exactness lives where real bytes exist.** OCR is a lossy channel, so the strength of each claim is
matched to its evidence:

- The **reference file** is compared to the intended sequence exactly, on real bytes.
- The **clipboard** is compared to the reference exactly, on real bytes (below).
- The **screen** is proved structurally: `LONG-15` is matched as `REFLOW-LONG-15-` + an unbroken run
  of ≥180 `x` + `-END`, **contiguously**, so a `REFLOW-END` elsewhere on screen cannot supply the
  tail. The observed fill length is recorded (240 in practice) rather than asserted.
  At 86 columns a 259-character line is 86+86+86+1, leaving its final `D` alone on a row; Vision
  skips one-glyph rows, so a tail one character short is accepted **and flagged**
  (`tailTruncatedByOcr`). Two characters short is a damaged line and fails.

Every checkpoint also records the grid (`stty size`, typed in-pane), the scroll host's
`scrollTop`/`scrollHeight`/`clientHeight`, **which pane it measured** (`data-terminal-pane-id`),
which pane is **active**, `devicePixelRatio`, whether the viewport is **still anchored to the
bottom** (a checked boolean, not an eyeballed note), and whether the shell still executed a
`REFLOW-CHECK-<case>-<run>` line.

At every action boundary the harness screenshots the pane **at rest first**, before any sweep,
resize or refit could repaint it — a transient failure that a later action would recover still
leaves evidence. The sweep then restores the scroll position it found, so measuring the viewport
does not destroy the drift the matrix exists to observe.

## Deterministic reflow matrix

Every row on a newly seeded pane whose identity is verified at every checkpoint. "Bounds" is the
number of action-boundary checkpoints, each carrying grid + scroll + pane identity + markers.

| Case | Runs | Bounds/run | Grid | Scroll top/max (seed → final) | Lines | Verdict |
| --- | --- | --- | --- | --- | --- | --- |
| Control (10 s idle) | 3/3 | 1 | `51 86` unchanged | 1554/1554 → 1722/1722 (anchored) | 7 → 7 | **PASS** |
| Window resize (wide↔narrow ×3, restore) | 3/3 | 7 | `51 86` → `51 160` → `51 40` → `51 86` | 1554/1554 → 2184/2184 (anchored) | 7 → 7 | **PASS** |
| Terminal focus (⌥⌘⏎ ×10) | 3/3 | 10 | `51 86` → `54 169` in zen → `51 86` on every return | 1554/1554 → **826/3164 (un-anchored)** | 7 → 7 | **PASS** for retention, **FAIL** for viewport |
| Horizontal split (⇧⌘D + drags 25/50/75/50 ×3) | 3/3 | 12 | `51 86` → `12 86` → `25 86` → `38 86` (rows only) | 1554/1554 → **2058/3010 (un-anchored)** | 7 → 7 | **PASS** for retention, viewport as above |
| Vertical split (⌘D + same drags) | 3/3 | 12 | `51 86` → `51 20` → `51 42` → `51 63` (columns only) | 1554/1554 → 4564/4564 (anchored) | 7 → 7 | **PASS** |
| Hide/show — Ticket ↔ board ×10, then terminal tab ↔ terminal tab ×10 | 3/3 | 20 | `51 86` unchanged | 1554/1554 → 3318/3318 (anchored) | 7 → 7 | **PASS** |
| Hide/show — Home Board ↔ terminal ×10, then terminal tab ↔ terminal tab ×10 | 3/3 | 20 | `51 86` unchanged | 1540/1540 → 3290/3290 (anchored) | 7 → 7 | **PASS** |
| GPU pressure (confirmed WebGL2, 17 live terminals) — focus | 1/1 | 10 | `51 86` unchanged | 1540/1540 → 756/3038 | **7 → 0** | **FAIL — pane renders nothing** |
| GPU pressure (confirmed WebGL2, 34 live terminals) — Home hide/show | 1/1 | 20 | `51 86` unchanged | 1512/1512 → 3136/3136 | **7 → 0** | **FAIL — pane renders nothing** |

**21 of 23 runs PASS; the 2 failures are the WebGL2 row and are a real product defect, not missing
evidence.** `analyze-vc291.mjs` exits non-zero on this evidence set, which is correct.

The shell answered the `REFLOW-CHECK` probe at every checkpoint of every run, so no pane was ever
wedged. On WebGPU, **no expected line that was present in the seed sweep was ever missing from a
later sweep — across 21 runs, zero lost lines.**

### Deviation from the ticket's run count

The ticket asks for three runs of every row. The **GPU-pressure row was run once per case, not
three times**, on an explicit instruction during this session to trim a ~70-minute row. Its two
runs are recorded as `runsPerCase: 1` in `run-config.json`, so the analyzer holds them to that
declared bar rather than silently to a lower one. The defect it found is unambiguous within a run
(7 → 0 markers from the *first* boundary onward, every sweep step OCRing to one character), but
**its repeatability across runs is not established here**; the earlier pass saw the same behaviour
6/6 on a malformed seed, which is suggestive and not evidence. Recorded on VC-346.

## The reproducible defect: the viewport stops following the bottom after a row-count change

The terminal focus row reproduces the audit's observation exactly, **3/3, un-anchoring on the very
first round trip in all three runs**. Pane identity is recorded at every checkpoint, so these
readings are provably about the seeded pane (run 1 shown):

| After cycle | Grid in zen | Grid on return | scrollTop | scrollMax | Gap below the viewport |
| --- | --- | --- | --- | --- | --- |
| seed | — | `51 86` | 1554 | 1554 | 0 (anchored) |
| 1 | `54 169` | `51 86` | 1148 | 1694 | 546 px ≈ 39 rows |
| 2 | `54 169` | `51 86` | 1106 | 1848 | 742 px |
| 3 | `54 169` | `51 86` | 1078 | 2002 | 924 px |
| 10 | `54 169` | `51 86` | 826 | 3080 | 2254 px ≈ 161 rows |

Entering terminal focus hides the chrome and re-measures the pane to `54 169`; leaving it returns
the grid to `51 86`. After the first round trip the viewport is no longer anchored to the bottom,
and every further cycle moves it another ~28 px up while the buffer grows. New output — a `pwd`, a
prompt, the next command's result — is then drawn *below* the visible viewport, which is exactly
what "the line disappeared" looks like. Nothing is lost: the same sweep that records the drift finds
all seven expected lines, including `REFLOW-PWD-…`.

Across the 21 WebGPU runs the correlation is exact:

| Transition | Row count | Column count | Viewport after |
| --- | --- | --- | --- |
| Control, hide/show (Home and Ticket) | unchanged (51) | unchanged (86) | **anchored** |
| Window resize | unchanged (51) | 86 → 160 → 40 → 86 | **anchored** |
| Vertical split + divider drags | unchanged (51) | 86 → 20 → 42 → 63 | **anchored** |
| Horizontal split + divider drags | **51 → 12 → 25 → 38** | unchanged (86) | **un-anchored** at 11 of 12 drags |
| Terminal focus ×10 | **51 → 54 → 51** | 86 → 169 → 86 | **un-anchored** at all 10 returns |

Every transition that changed the pane's **row** count left the viewport un-anchored; every
transition that left the row count alone kept it anchored — including the ones that rewrap the
entire scrollback on a column change. The vertical split swings `scrollMax` 1554 → 7966 at 20
columns → 2982 at 63 columns and still lands at the bottom every time.

**Classification (ticket taxonomy): Scroll position.** Not reflow (the grid on return is identical
to the grid at seed and every seeded line is still in scrollback), not shell redraw (the seeded
shell is quiet and the reference file matches), not rendering (the content is present at its
recorded offset without any forced repaint), not device-loss replay (no driver-reset message in any
WebGPU run — `consoleByLevel` carries none).

Filed as **VC-343**.

## GPU pressure (WebGL2) — a second, independent defect

There is no checked-in launcher that forces the WebGL2 fallback, and `terminal/gpu-pressure.ts` has
no production caller. The harness forces the fallback by hiding `navigator.gpu` in a Playwright init
script; the canvas-context probe then reports `webgpu=false webgl2=true navigatorGpu=false`, so this
row **was exercised** rather than skipped — but only through a harness-only lever (**VC-348**).

With the seeded pane open and 16 further live terminals created on top of it (17 live hosts;
34 by the end of the hide/show run), Chromium logs
**`WARNING: Too many active WebGL contexts. Oldest context will be lost.`** — 19 occurrences, out of
89 console messages, all at `warning` level. An error-only console filter never sees them, which is
why every level is now recorded.

What happens to the seeded pane, with its pane id verified at every checkpoint
(`backOnSeededPane: true`):

| Signal | At seed | After 17+ live WebGL2 terminals |
| --- | --- | --- |
| Expected lines found in a full sweep | 7 / 7 | **0 / 7, from the first boundary onward** |
| OCR characters per sweep step | 2884, 2853, 2784, 2764 | **1, 1, 1, 1** — the pane is blank |
| Scroll host geometry | 1540 / 1540 | intact and still growing (3038 max after focus cycles) |
| Shell | answers `REFLOW-CHECK` | still answers at every checkpoint (`51 86`) |
| Recovery | — | none: hide/show re-attaches and refits the pane and it stays blank |

The pane is blank while its buffer and shell are alive. `restty-engine.ts` arms `watchGpuDeviceLoss`
only when the backend is WebGPU, so under the WebGL2 fallback an evicted context has no rotation, no
`rebuildRenderer()`, no replay and no toast.

**Classification (ticket taxonomy): Rendering** — the content is in the buffer (the scroll host keeps
reporting and growing its height, and the shell keeps answering) but nothing is painted, and it does
not come back after a refit. This is *not* the WebGPU device-loss replay path, which is
intentionally bounded.

On this M1 the production default is WebGPU, where every row passes. This bites users whose
GPU/driver forces the WebGL2 fallback. Filed as **VC-346**; see the run-count deviation above.

## Accessibility, selection/copy, and find

Run in **both** required states: a fresh unsplit pane, and again after a terminal-focus cycle, a
hide/show cycle and a ⇧⌘D split (`B-cycle-navigation: {focus, hideShow, split}` all true). Every
macOS AX query targets **this app's pid**, never a process named "Electron".

| Check | Unsplit | After split + focus + hide/show |
| --- | --- | --- |
| Terminal host semantics | `div[data-terminal-renderer]`: no `role`, no `aria-label`, no `aria-roledescription`, no `tabindex` | same |
| Canvas | `<canvas>` **has `tabindex="0"`** — it *is* focusable — but carries no role, no name and no text | same |
| IME textarea | `<textarea class="pane-ime-input">`, `tabindex="-1"`, unlabelled; this is what holds focus after a click | same |
| Keyboard exit | `Tab` ×8, `Shift+Tab` ×8, and `Escape` then `Tab` ×3 **never** move focus out of the pane | same |
| macOS AX value dump | 421 bytes; **exposes app chrome** (sidebar, buttons, session names) and **contains no seeded terminal text** | 444 bytes, same result |
| Chromium AX snapshot | unavailable in this Playwright/Electron build (`page.accessibility.snapshot` absent) — recorded, not inferred | same |
| VoiceOver | **started** (⌘F5, pid observed) and its cursor was driven 5× with VO-Right (`moved: ok`) | started again, driven again |
| VoiceOver announcements | **not captured** — see below | **not captured** |
| Mouse selection + ⌘C | **Works, exactly.** 278 bytes → 2 logical lines: `REFLOW-SHORT-01` and `REFLOW-LONG-01-<240 x>-END`, matching reference lines 2–3 byte-for-byte | **Works, exactly, and independently proved** — same result |
| Keyboard selection | **Absent.** `Shift+ArrowRight` ×5 then ⌘C leaves the harness's unique sentinel on the clipboard | same |
| Find (⌘F) | Opens a field named **"Find in scrollback"** and really searches terminal output: `REFLOW-SHORT-01` → scrollTop 0 → 70, `REFLOW-PWD-` → 70 → 1596/1596, match visible in the pane both times | present and working; 0 → 70, then 2114/2114 |
| Quick open (⌘K) | searches app chrome only; never matches seeded output | same |

### What the copy check proves, and how

Each attempt puts a **unique sentinel** on the clipboard first (`VC291-SENTINEL-<state>-<id>`), so
"the copy worked" can never be satisfied by a stale clipboard from the previous state. The copied
text is then **unwrapped** back into logical lines — a physical row exactly `cols` wide is a wrap,
not a line ending — and compared to the seeded reference as a contiguous run. Both states report
`replacedSentinel: true`, `matchesReferenceExactly: true`, `longLineExact: true`,
`longLineHasEndTail: true`, `longLineFill: 240`. Captures: `a11y/clipboard-{unsplit,after-cycle}.txt`.

### VoiceOver: what was and was not established

VoiceOver **was** started from the harness and its cursor **was** driven (five VO-Right presses per
state, each keystroke accepted). Reading back what it announced requires VoiceOver's own AppleScript
dictionary, which is disabled unless *"Allow VoiceOver to be controlled with AppleScript"* is
enabled in VoiceOver Utility; every read attempt timed out against that closed door
(`unreadable: spawnSync osascript ETIMEDOUT`).

So **the announced wording is unavailable evidence**, and no claim here rests on it. What the
classification does rest on is independent of VoiceOver: the macOS AX tree — the tree any screen
reader reads — is richly populated with this app's chrome in both states and contains **no terminal
text at all**, and the DOM shows a canvas with no role, no name and no text content. A human pass
with VoiceOver is still worth doing for wording. Filed as **VC-344**.

## What the first pass got wrong

Recorded because the corrections are the reason to trust the numbers above.

| Fault | Effect | Now prevented by |
| --- | --- | --- |
| Seed's `printf '-END\n'` parsed as a printf option by every shell | Every run measured a **33-line** seed, not 63: no `-END` tails, `SHORT-02`…`30` welded onto long lines, `PWD` welded onto `LONG-30` | `-END` moved into a `%s` argument; `verifySeedReference()` gates every run; the seed is executed and checked under four shells in `vc291-seed.test.mjs` |
| Marker `end15` spelled `-END` | Satisfied for free by `REFLOW-END` elsewhere on screen, so a missing tail was invisible | `LONG-15` is one contiguous logical line: head + fill run + its own tail |
| Analyzer scored "markers lost = after − before" | A pane that rendered **nothing** scored 0 → 0 = "lost nothing" = **PASS** | A seed checkpoint that finds fewer than all 7 expected lines fails the run |
| Analyzer read neither `run.error` nor `meta.fatal` | An **aborted** run passed | Both fail the run; the analyzer exits non-zero |
| Baseline pointer never cleared | Runs 1 and 2 of every row shared **one** reference file | Per-run token in the log name and the pointer; the analyzer fails a shared or token-mismatched reference |
| Checkpoints only at row endpoints | No evidence at the boundaries the ticket names | Boundary counts are required per case (focus 10, resize 7, splits 12, hide/show 20) and each must carry grid, scroll, pane id and the anchor result |
| Harness always exited 0; driver printed `ALL DONE` unconditionally and never ran the analyzer | A failed row looked like a passing one | Matrix and a11y probes exit non-zero; the driver stops on failure, runs the analyzer, and its verdict is the script's verdict |
| "Reproduced 3/3 after the **first** round trip" | False: run 3 was still anchored at cycle 1 (2086/2086) | Corrected rerun genuinely un-anchors at cycle 1 in all three runs |
| "Copy … matching the reference file" | The clipboard held **malformed** seed text with `containsLongEnd: false`, and the post-cycle clipboard **never changed** (`changedFromBefore: false`) | Sentinel before every attempt; exact contiguous comparison against the reference; long-line tail required |
| "the only focusable node is the IME textarea with `tabindex="-1"`" | The **canvas has `tabindex="0"`** and is focusable | Both nodes' attributes recorded in both states |
| `shell: "unknown"`, external monitor inferred by a string-replace heuristic | Setup metadata wrong | Shell measured **in the pane**; displays parsed from `system_profiler -json` |
| GPU row reported as a uniform "7 → 0, 6/6" | One of its seeds was incomplete (5/7), and its hide/show leg ran the **ticket** surface, not the Home row the ticket names | Seed gate; the GPU row runs `--surface=home`; the analyzer requires a live-terminal floor |
| Both harnesses matched CI's `*-smoke.mjs` glob and were not deny-listed | An hour-long probe that toggles VoiceOver and owns the clipboard would have run on every PR | Both added to `run-smokes.mjs`'s deny-list with reasons |

## Completion against the ticket

- Matrix: attached (this file plus `docs/vc291-evidence/*/matrix.json`, `run-config.json`, the
  per-run reference files, OCR sidecars for the two defect rows, and `docs/vc291-analysis.json`).
- Negative result for line loss on WebGPU: 21 runs, zero lost lines, every WebGPU row three times.
- Positive results: a deterministic viewport defect with a two-keystroke repro (⌥⌘⏎ twice), and a
  WebGL2 blanking defect (one run per case — see the deviation note).
- Accessibility, copy and find: both required states; gaps filed and linked.

## Reproducing

```sh
pnpm install && pnpm run build
apps/desktop/e2e/run-vc291-matrix.sh            # every row, then the analyzer; non-zero on failure
node --test "apps/desktop/e2e/lib/*.test.mjs"   # seed shape + analyzer rules
```

Single rows:

```sh
node apps/desktop/e2e/reflow-matrix-smoke.mjs evidence/matrix-focus --cases=focus --runs=3
node apps/desktop/e2e/reflow-a11y-smoke.mjs evidence/a11y
node apps/desktop/e2e/analyze-vc291.mjs evidence
```

Neither probe runs in CI — both are deny-listed in `apps/desktop/scripts/run-smokes.mjs`.

### Harness note: Local Font Access wedges terminal init under automation

On this macOS/Electron combination `window.queryLocalFonts()` **never settles** — not with a quiet
window, not with a focused one, not after CDP user gestures. restty awaits it during init, so no
renderer is ever created: no GPU context, nothing painted, typed keys swallowed. The repo's own
`apps/desktop/e2e/terminal-smoke.mjs` is red here for this reason.

Both harnesses work around it by serving restty the real `/System/Library/Fonts/SFNSMono.ttf` bytes
through a `FontData`-shaped stub, recorded in every `run-config.json`. Everything downstream of font
loading — WebGPU/WebGL2, the VT parser, scrollback, refit, the PTY — is production code. Filed as
**VC-347**.

## Evidence in this repo

`docs/vc291-evidence/<row>/` carries, per row: `matrix.json` (every checkpoint — grid, scroll
offset/max, measured pane id, active pane, anchor result, per-sweep expected-line union, and the
full renderer console log at every level), `run-config.json` (commit, OS, hardware, displays,
window, declared backend and run counts, font workaround), and this row's `reference-*.txt` files.
`docs/vc291-evidence/a11y/` carries `a11y.json`, the two clipboard captures, the two macOS AX value
dumps and its reference file. `docs/vc291-analysis.json` is the analyzer's folded output.

The full screenshot set (~354 MB of PNGs plus every OCR sidecar) stays out of git under `evidence/`,
regenerable with `apps/desktop/e2e/run-vc291-matrix.sh`.

## Filed gaps

| Ticket | Gap |
| --- | --- |
| VC-343 | Terminal viewport stops following the bottom after a row-count change (⌥⌘⏎ focus, ⇧⌘D split) — the audit's `pwd` line |
| VC-344 | Terminal output absent from the macOS AX tree; no keyboard way out of the pane |
| VC-345 | No keyboard path to select or copy terminal output |
| VC-346 | WebGL2 fallback: pane blanks when contexts are evicted, no rebuild, no warning |
| VC-347 | Terminal e2e blocked on macOS 26: `queryLocalFonts` never settles, wedging restty init |
| VC-348 | No supported way to force the WebGL2 fallback (GPU-pressure row is harness-only) |

VC-107 carries the seven acceptance checks with their corrected current-renderer results. Nothing
found here is split-navigation-only, so no gap was sent to VC-215 — recorded there as a comment,
with the divider-drag evidence that supports the negative.

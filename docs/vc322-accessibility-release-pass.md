# VC-322 — accessibility/motion candidate checklist

**Release verdict: BLOCKED, not accessibility sign-off.** Focused fixes are ready for review;
remaining failures and unmeasured native behavior must not be counted as passes.
Merge order requested by release coordination: **VC-343 → VC-344 → VC-322**.
This patch does not change terminal shortcuts or terminal source.

## Candidate and method

- Baseline: fetched `origin/main` **3bf58945273ea876fac744f2f50483eec69ab378**, canary.11.
- Re-synced with `origin/main` **10e8ada5** (VC-412 included), then installed and rebuilt.
  Clean candidate **3497b6786f3c9fed770a5159862c84732a139405** passed the built
  `--gate-fixes` rerun; `evidence/vc322/synced/report.json` retains the same remaining
  board/list/terminal failures and 3.27:1 primary contrast. VC-343/344 are not integrated yet.
- `pnpm install` (including native rebuild) and `pnpm run build` passed.
- Real Electron main/preload and `volli-app://bundle/index.html`, not the UI lab.
  Disposable database, HOME, project repository, and profile live inside this worktree's
  ignored `evidence/` directory. Profile and built-renderer identity asserted at runtime.
- Playwright keyboard events, DOM focus/computed styles, accessibility snapshots, screenshots,
  actual native-theme changes, and persisted app zoom commands. These are **not VoiceOver speech**.
- Baseline: `evidence/vc322/baseline/`; fixed build: `evidence/vc322/candidate/`.
  Reports contain exact focus paths, styles, animation keyframes, and dialog geometry.
  The initial exploratory `report.json` had an incorrect board locator and sampled focus
  transitions too early; use `baseline/report.json`, not that initial run.

## Per-surface checklist

| Surface/check | Result | Built evidence / remaining gate |
| --- | --- | --- |
| Project navigation/chrome | Partial | Tab reaches project tile, Add Project, Home, Automations, Configure, Settings and chrome controls; settled computed focus rings recorded. Full project switching and native folder picker/VoiceOver not tested. |
| Board/list | **Fail — VC-419** | Enter opens the selected ticket; Escape from its tab returns to board/list. Both entry and return lose focus to BODY, not ticket/selected row. |
| Ticket title | **Fixed** | Baseline H1 button had no outline/shadow under `:focus-visible`; candidate has a 2px semantic ring. |
| Ticket body | Partial | Monaco exposes `Ticket description`; Tab inserts indentation. **Control+Shift+M, then Tab** successfully reaches Add a comment. Escape inside Monaco is editor-owned, not a close failure. Human discoverability/VoiceOver still required. |
| Comments | Partial | Add a comment textarea reachable using Monaco's tab-focus toggle. Submission, async completion announcements, error recovery and edit/delete confirmations not exercised. No claim of full focus-visibility compliance. |
| New-ticket dialog | **Fixed; tested pass** | Keyboard Enter opens; focus stays inside across sampled Tab path; Escape from title closes and restores the actual New ticket invoker. Baseline returned BODY. |
| Command palette | **Fixed; tested pass** | Meta+K → input → Escape restores actual pre-open control. Explicit navigation selections skip restoration. |
| Other overlays/dialogs | **Not verified** | Destructive confirms, permission overlays, nested menus and all focus-return paths require candidate sweep. Shared Radix behavior is not substituted for evidence. |
| Pending questions / permission cards | **Not verified** | No live provider turn or credentials used. Need seeded/signed candidate with pending ask/approve/deny/cancel/retry states at 320/480/720px and each zoom. |
| Files | **Incomplete — VC-311** | Existing built smoke: listing and dirty Cancel/Save guard pass; multiple row click timeouts cascade into preview/save/restore failures; refresh also times out. Requires independent triage, not assumed product failure. |
| Diffs | Partial — VC-311 | 7/8 numbered smoke checks pass: real Monaco diff, keyboard edit/save to disk, shared file/diff model and presentation toggle. Untracked-file refresh check fails. Full keyboard/VoiceOver/narrow matrix not proven. |
| Embedded browser | **Incomplete — VC-301** | Existing browser smoke 10/10 passes isolation, tab lifecycle and hold behavior, not app-shortcut routing. Separate synthetic Meta+K injection opens no palette, but quiet-window native focused WebContents is null: **inconclusive native-focus evidence**, retain human check. |
| Terminal | **Fail baseline — VC-344** | Current xterm input is named `Terminal input`. Tab, Shift+Tab, Escape and two Meta+Alt+Enter presses all retain that textarea. Host role/name null; no xterm accessibility layer. No native VoiceOver claim. Re-run after VC-344; this is not a verdict on its pending fix. |
| Pane resizing / async feedback | **Not verified** | Keyboard divider interaction, selected row retention after refresh, completion announcements and retry focus remain manual/fixture gates. |

## Default-canvas contrast

WCAG 2.x relative luminance, using computed RGB in the built renderer (no custom canvas):

| Pair | Dark | Light | Result |
| --- | ---: | ---: | --- |
| foreground/background | 14.46:1 | 15.51:1 | Pass normal text |
| muted-foreground/card | 9.02:1 | 6.63:1 | Pass normal text |
| primary-text/background | 8.71:1 | 5.08:1 | Pass normal text |
| white primary label / #d37550 | **3.27:1** | **3.27:1** | **Fail 4.5:1 at 13px — VC-418** |
| opaque ring/background | 5.59:1 | **2.57:1** | Light below 3:1; actual 45% rings need composite measurement — VC-418 |

New ticket is an enabled primary control using the failing text pair. Disabled Create & start
is not used to establish this finding. This table is a sampled semantic-token check, not an
all-controls contrast audit or a verdict on user-selected colors.

## Motion and zoom

- **Pass, dialog entrance only:** default modal/scrim have 200ms entrance animations;
  with `prefers-reduced-motion: reduce`, dialog animation computes to `none` and those
  entrance animations are absent. Preference changes can produce `scale: none → 1`
  transitions on controls (identical visual scale), not evidence of unwanted movement.
- No blanket pass for drag, split, streaming, scroll anchoring, exit interruption or delayed
  async state. These were not comprehensively exercised.
- Shipped app zoom commands persist **125% → 150% → 150%**: **200% is unavailable**.
  Recorded on VC-288. Native CSS zoom screenshots retained for 125/150; full per-pane
  functionality at those settings remains unverified.
- Exploratory BrowserWindow zoom at 125/150/200 gives in-viewport dialog DOM bounds.
  **This is not a product 200% pass.** Playwright zoom screenshots can crop differently
  from measured viewport geometry; do not use those captures as proof of visual fit.

## Focused patch and checks

- New-ticket and palette capture the focused invoker during the opening render, **before**
  autofocus children take it. Restore using Radix's close-focus lifecycle, after trap teardown.
  Do not restore a removed invoker or override explicit caller handoff/navigation.
- Palette keeps its original chrome/command contents, exposing the Radix lifecycle instead
  of cmdk's convenience Dialog. No shared-dialog global policy change.
- Ticket title gains a keyboard-only semantic focus ring.
- Focused unit run: **3 files / 7 tests passed** (dialog focus lifecycle, title, palette order).
- Focus-hook coverage: **100% statements/branches/functions/lines**, 5 tests passed.
- Renderer TypeScript, changed-file lint and whitespace checks passed after sync.
- An additional combined composer-form/palette-model/palette-search test invocation timed out
  at 45s before producing test results; it is not counted as passed. Full monorepo coverage/CI
  and signed candidate not claimed.
- Draft PR: https://github.com/hussainph/volli-code/pull/579. CI was pending when submitted;
  keep merge held for the terminal integration order and rerun the integrated candidate.

Reproduce (workspace-local artifacts):

```sh
pnpm install
pnpm run build
node apps/desktop/e2e/vc322-accessibility-smoke.mjs evidence/vc322/recheck --gate-fixes
node apps/desktop/e2e/vc322-browser-boundary.mjs
pnpm -C apps/desktop exec vp test run \
  src/renderer/src/components/ui/dialog-focus.test.tsx \
  src/renderer/src/components/ticket/ticket-title.test.tsx \
  src/renderer/src/components/command-palette-order.test.tsx \
  --maxWorkers=$VOLLI_CONCURRENCY_HINT
pnpm exec tsc --noEmit -p apps/desktop/tsconfig.web.json --composite false
```

The accessibility probe is observational by default. `--gate-fixes` fails on regression of
these two dialogs or the title ring; it deliberately does **not** turn the other known release
failures into a passing gate. The JSON checklist remains the broader verdict.

## Human / signed-candidate handoff (all unchecked)

Record candidate SHA/signature, macOS version, appearance, zoom, person, result and issue per row:

- [ ] VoiceOver: project tile names, board/list ticket names/status/selection; open and return.
- [ ] Ticket title/body/comment editing, Monaco Control+Shift+M discovery, reading order,
      persisted submission, error announcement and draft preservation.
- [ ] Pending question and permission cards: question/options announced, keyboard answer,
      approve/deny/cancel/retry; no clipped action at 320/480/720px, 125/150/200%.
- [ ] Every modal/menu/confirm: initial focus, trapped Tab/Shift+Tab, nested Escape,
      close/cancel/submit and invoker return; no focus behind native browser view.
- [ ] Browser page input → app search/navigation/close/return, correct pane, page edit keys intact.
- [ ] VC-344 integrated terminal: read output before/after split/hide/show; advertised escape
      reaches app controls, Tab reaches terminal again, PTY keys preserved.
- [ ] File tree/diff names, selected line/change, editor escape, dirty-save guard, inline fallback.
- [ ] Light/Dark focus visibility and contrast after VC-418; reduced-motion launches and live
      preference changes, resize, streaming, completion and recoverable failures.

A person must execute these checks; installing a signed candidate or toggling VoiceOver on the
shared machine was not performed by this pass.

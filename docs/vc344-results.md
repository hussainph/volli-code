# VC-344 — terminal accessibility after the xterm DOM migration

## Verdict

**Reproduced on origin/main `3bf58945273ea876fac744f2f50483eec69ab378`.**
The restty evidence was not reused. The built Electron app's xterm DOM renderer
still marks its visual rows `aria-hidden`; its separate screen-reader layer was
not enabled. The input is now labelled `Terminal input` and has `tabindex=0`, so
the original report's unlabelled, `tabindex=-1` input finding is **obsolete**.
The host still lacked a role/name, output was absent from non-ignored Chromium
AX nodes, and eight Tab / eight Shift-Tab presses never left the input.

The fix enables xterm's own screen-reader mode (parsed rows, scrollback navigation
and live output), names each region/input after its tab and pane number, and adds
a visible focus-within ring. **Control+Shift+M** toggles pane-local Tab navigation;
normal Tab/Shift-Tab remain PTY input. Navigation mode uses browser traversal,
not a hand-built list of focusable elements. The chord is documented in the
[shortcut reference](../apps/docs/src/content/docs/reference/keyboard-shortcuts.mdx),
the input's accessible description, and hover text. A toast confirms the mode.

## Built-app evidence

macOS **26.5.1 (25F80)**, Electron **44.0.0**, xterm **6.1.0-beta.304**, isolated profile,
HOME, shell startup directory, temporary directory, database and fixture repo.
The run does not read credentials or toggle VoiceOver. It explicitly enables
Electron's accessibility support in the test process.

`terminal-a11y-smoke.mjs` prints an octal-encoded marker through a real PTY, so
`VC344-OUTPUT-READABLE` occurs only in **output**, not echoed input. It checks
non-ignored Chromium AX nodes using CDP `Accessibility.getFullAXTree`, not just
DOM `textContent`. Xterm debounces accessible rows for up to one second; the
probe allows that documented interval before taking snapshots.

| Check | Baseline | Fixed built app |
| --- | --- | --- |
| Named terminal region and input | Host unnamed; generic input | `Terminal 1 — pane 1` |
| Chromium AX output before focus (input blurred to chrome) | Absent | Present |
| Chromium AX after input focus | Absent | Present |
| Chromium AX in terminal-focus mode | Absent | Present |
| Chromium AX after hide/show | Absent | Present |
| Chromium AX after split | Absent | Present |
| Native macOS AX in the five visible states | Initial System Events dump inconclusive | Present in all five |
| Hidden terminal output in AX | Absent | Absent in both Chromium and native AX |
| Split names | Both unnamed | Distinct `pane 1` / `pane 2` names |
| Default Tab/Shift-Tab | Consumed by terminal | Preserved as PTY input |
| Toggle + Tab exit / Shift-Tab reentry | No exit | Pass |
| Toggle + Shift-Tab exit / Tab reentry | No exit | Pass |
| Both split panes, both exit directions | Not available | Pass |
| Raw PTY bytes | Navigation Tab leaked through | Exactly `09 1b 5b 5a 78` |

The raw-byte test sends default Tab (`09`) and Shift-Tab (`1b 5b 5a`), enables
navigation, leaves/reenters in both directions, disables navigation, then sends
`x` (`78`). No toggle/navigation bytes may reach the waiting raw reader. This
also caught an integration subtlety: xterm's screen-reader mode otherwise lets
Shift-Tab **both** send `ESC[Z` and move focus. The fix prevents native traversal
only in PTY-input mode, preserving xterm's key encoding.

### Native AX measurement correction

The first System Events value-only dumps were empty, including chrome. As in
VC-291's correction, those are **inconclusive**, not proof of missing text. An
additional run also returned a window-resolution error with multiple Electron
processes present. The replacement helper uses `AXUIElementCreateApplication`
with this app's exact main PID and recursively reads native AX children. It
requires a trusted process and recognisable app chrome before accepting output
presence. No process-name matching, global accessibility changes, or VoiceOver
toggling is used. Native checks run with an ordinary visible window rather than
the smoke runner's accessory/non-focusable window.

## Reproduction

```sh
pnpm install
pnpm run ensure:electron
pnpm run build
node apps/desktop/e2e/terminal-a11y-smoke.mjs evidence/vc344/fixed
# Optional native AX, requires macOS Accessibility permission + Swift compiler:
node apps/desktop/e2e/terminal-a11y-smoke.mjs evidence/vc344/fixed-native --mac-ax
# On an unfixed build, collect the same failures without an assertion exit:
node apps/desktop/e2e/terminal-a11y-smoke.mjs evidence/vc344/baseline --baseline --mac-ax
```

The default probe does not require native AX permission and is picked up by the
existing `*-smoke.mjs` runner. `--mac-ax` is opt-in and fails rather than treating
an unavailable native tree as a pass. Every run retains its scratch profile and
full snapshots under the requested evidence directory for diagnosis.

Committed evidence:
- [`baseline.json`](vc344-evidence/baseline.json): unfixed built-app measurements.
- [`fixed.json`](vc344-evidence/fixed.json): fixed built-app assertions.
- [`ax-excerpts.json`](vc344-evidence/ax-excerpts.json): actual non-ignored Chromium
  and native AX marker/name nodes, without unrelated shell/user text.

Full local snapshots are under `evidence/vc344/` (gitignored). The fixed record's
commit identifies the base checkout; the implementation was an uncommitted diff
when measured, not a claim that base main already contained the fix.

## VC-322 acceptance handoff

Automated terminal semantics, native AX exposure, output preservation through
transitions, keyboard escape/reentry, and visible focus styling pass. **Spoken
VoiceOver wording and interactive row/scrollback navigation remain a human
acceptance check**, not something inferred from an AX dump. On the candidate
build, turn VoiceOver on, read the region/input name and navigation hint, read
output rows (including scrolling backwards), then repeat after hide/show and a
split. Confirm that the mode notification and focus location are understandable.
Do not mark that human checklist item passed from these automated results.

## Reconciliation with VC-343

Merged current `origin/main` (`349f3d2d`) into this branch as `70403316`.
The engine retains VC-343's pre-fit follow-bottom decision, scrollback preservation
and scroll-state instrumentation alongside screen-reader mode and the Tab toggle.
The add/add test conflict is reconciled into one xterm mock with both regression
groups, reset fit implementations between cases, and disposed engines.

The rebuilt reconciled commit passes **35/35** native macOS / Chromium AX and
keyboard assertions. See [`reconciled.json`](vc344-evidence/reconciled.json) and
[`reconciled-ax-excerpts.json`](vc344-evidence/reconciled-ax-excerpts.json).
The native tree exposes output before/after focus, in terminal-focus mode, after
hide/show and after a split; hidden output remains absent. Raw PTY bytes remain
exactly `09 1b 5b 5a 78` with no navigation/toggle bytes leaking through.

Checks on the reconciled source:

- `pnpm run build`: passed, including preload and packed-require checks.
- `pnpm exec vp check`: passed (format and lint).
- `pnpm -C apps/desktop typecheck`: passed.
- Focused engine/view/registry/appearance tests with `--maxWorkers=1`: **42 passed**.
- `node apps/desktop/e2e/terminal-a11y-smoke.mjs evidence/vc344/reconciled-native --mac-ax`: **35 passed**.
- Default quiet-window Chromium AX smoke: **29 passed** (the CI-compatible
  mode without native permission).
- Existing `terminal-smoke.mjs` with workspace-local HOME/TMPDIR: **14 passed**.
- Initial parallel workspace coverage run failed at the unchanged CLI
  `src/index.test.ts` build hook's 10-second timeout; dependent tasks were
  interrupted. This attempt was not a green gate.
- `pnpm -r --workspace-concurrency=1 run test:coverage --maxWorkers=2`:
  **passed**, including the unchanged CLI build hook. All nine coverage suites
  report 100% on their protected surfaces; desktop has **10,280 passed**, 2
  skipped. The worker count came from the background shell's
  `VOLLI_CONCURRENCY_HINT`; workspace packages ran serially.

### CI split-probe synchronization correction

PR #584's first final-head CI run passed the core and other smoke lanes but
failed `AX-split`: the original output marker was absent, while split names,
semantics and both directions of keyboard navigation passed. The probe had
assumed a fixed 1.2-second delay was sufficient and that old output would remain
inside xterm's accessible viewport after a width-changing split.

The probe now waits (bounded to 10 seconds) for real non-ignored Chromium AX
output instead of assuming a delay. After splitting it emits a fresh octal-encoded
marker through **each** live PTY, waits for each visible output, and requires each
unique marker beneath its own named AX region in the same snapshot. Native AX
also checks both markers beneath their named groups; missing/duplicate region
names fail rather than falling back to a global search. This measures readability in both resized panes;
it does **not** claim that the original marker stays in the visible viewport or
prove interactive scrollback reading. A timeout remains a failed assertion with
the final snapshot retained; no CI job was merely rerun to turn the failure green.

Reruns with the updated probe passed: quiet Chromium **29/29**, native/Chromium
**35/35**, focused engine/view/registry/appearance **42/42**, and `vp check`.
Records: [`scoped-quiet.json`](vc344-evidence/scoped-quiet.json),
[`scoped-native.json`](vc344-evidence/scoped-native.json), and
[`scoped-split-ax-excerpts.json`](vc344-evidence/scoped-split-ax-excerpts.json).
These records identify base commit `1896d3a4`; the probe correction was a working
copy change when measured, while the built product code was unchanged.

Spoken VoiceOver wording and interactive row/scrollback navigation still require
human acceptance as described above; native AX exposure does not certify them.

## Checks run before upstream reconciliation

- `pnpm run build`: passed, including standalone preload and packed-require checks.
- `pnpm -C apps/desktop typecheck`: passed.
- Focused engine/view/registry/appearance tests: **40 passed**.
- `terminal-a11y-smoke.mjs ... --mac-ax`: **35 assertions passed**, including native AX.
- Existing `terminal-smoke.mjs` with workspace-local HOME/TMPDIR: **14 checks passed**.
- Targeted `vp lint` and `git diff --check`: passed.
- `vp run -r test:coverage --maxWorkers=1`: **failed** on the unchanged
  `harness-runtime.test.ts` case “leaves an invocation outside a Volli session
  completely alone” (5-second timeout). Desktop otherwise had **10,277 passed**,
  2 skipped; other workspace packages passed. This is **not** a green coverage
  gate. A focused rerun of that complete file plus the two new test files passed
  **38/38** (the timed-out case took 1.08 seconds), without changing the test.

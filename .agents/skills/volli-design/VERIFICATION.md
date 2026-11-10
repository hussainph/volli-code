# Fidelity, stress and performance evidence

## A per-surface feature floor

Pin main's exact SHA before editing. Build this table for **every touched surface**, not
one row per source file or a diff-path count:

| Surface | Main behaviour/artwork | Candidate behaviour/artwork | Explicit approved departure or regression | Fix and evidence |
|---|---|---|---|---|

Include actions, menus, disclosure, tooltips, badges, shortcuts, drag targets, permissions,
focus order/return, drafts and mutation failures. Include provider/harness/platform/sign-in
**brand marks** explicitly: compare actual SVG paths/viewBoxes, registry colours, semantic
badges and fallbacks, not only component names. Check the shared glyph owner and every
consumer (navigator, tabs, ticket Sessions, peek, composer/pickers, Settings, usage).
An icon cleanup is not authorization to substitute vendor identity.

Visual simplification relocates capabilities one click deeper. Name old path → new path.
Unknown/unavailable/read-only paths keep their real restrictions; static mock content cannot
supply new commands, history provenance or successful states. A catalogue inventory is not
an exhaustive parity audit; mark source-only, live-proven and still-unverified rows separately.

## Side-by-side in page context

Use [verify-volli](../verify-volli/SKILL.md) for the isolated keychain-free app, real UI actions,
read-only SQL/CLI side-effect proof, doctor/console and owned-instance cleanup. Follow its
launch and safety contract rather than launching a personal dev profile. A lab remains
**Simulated wiring**, even when its layout is convincing.

Capture actual built main, candidate and the approved mock at matched viewport, DPR, zoom,
appearance, canvas and meaningful fixture state. Label every original with its exact revision
and build mode. Keep originals; make lossless side-by-sides and unscaled identity/detail crops.
Distinguish fixture-content differences from anatomy/material gaps. Do not relabel an older
capture as current-head evidence without demonstrating production equivalence.

Review the whole page and its neighbours, then crops: composition/proportions, leading axes,
control shape, row rhythm, neutral paper, tint, ink, overlays and marks. Inspect actual hover,
focus-visible, pressed, selected, disabled and long-content states. Review light/dark plus
materially different warm/cool/custom canvases, not only the default theme.

Native traffic lights, fullscreen/Spaces, physical IME and menu-bar reveal need appropriate
native/manual evidence. A quiet synthetic harness cannot certify them; a missing native
control in a renderer PNG is not proof the app lost it.

## Empty / Normal / Extreme probes

Apply the entry skill's matrix before review. Use isolated deterministic fixtures through
production stores/ledger writers for setup; prove the changed action through actual UI input,
not a renderer setter. Record exact counts, viewport, data source and fixture limitations.

| Failure class | Probe / required recovery |
|---|---|
| Attachments crowd out work or commit | 0/3/50 files; footer actions visible and hit-testable at compact size; compact count opens a bounded manager; actual submit persists all links |
| Metadata buries primary sections | Thousands of labels, Sessions and automations; bounded label pills with searchable `+N`, independently scrollable sections |
| Unbounded lists burden every page | Thousands of tickets/navigator rows/options; count mounted DOM, time mount/open/search/scroll, retain full logical model and stable row keys |
| Silent caps look complete | Search/page to the last management record; disclose omitted discovery candidates accurately; never label an undiscovered directory a readable skill |
| Long identities consume or escape the view | Unbroken names, paths/URLs, duplicate basenames, CJK/RTL/emoji; bounded rows, full accessible names, hover **and focus** reveal, bidi isolation |
| Large menus become unsearchable | Locate the final offered item by search and keyboard; retain current choice and explicit None; no arbitrary first-match selection |
| Similar initial tiles lose identity | Repeated project prefixes and missing vendor marks; full-name tooltips plus reachable searchable switcher; known marks stay real |
| Long errors dominate controls | Noun-specific failure/recovery, complete technical detail behind closed Details/Copy; action and focus remain reachable |
| False emptiness during reads | Pending→empty, pending→failure, filtered zero and failed refresh with last-good rows; never hide errors with silent Inline |

For windowing, use End/arrow/search to reach offscreen targets, keep focus/selection through
recycling, and exercise drag across boundaries where supported. Bounded DOM is not bounded
data. Test drafts, mode switches and scroll restoration at **nonzero** scroll positions.
A first-screen screenshot and a fast scroll do not establish acceptable mount cost.

## Frame-level motion proof

Capture both built and source/dev renderers when diagnosing a dev-only report, using the same
isolated runtime contract. Record consecutive frames from action start through settled tail;
CDP `Page.startScreencast` with `everyNthFrame: 1` can save every **emitted** frame. It does
not promise every physical monitor refresh. Save/ack all frames and label contact sheets by
file/time, rather than selecting representative moments.

Cover both sides and appearances: stationary-pointer open/close, click then cross the edge,
peek enter/leave, peek→pin, interrupted double toggles/reversal, rail hide/show, keyboard,
OS Reduce Motion and app Motion off. Check live-subtree and native-fence lifetime as well as
pane/paper edge geometry and the gutter.

**Pixels are a separate gate.** A second blurred decorative pane can make a one-frame ghost
without changing the resident pane's box/opacity. Cancelling a filled animation before
unmount can expose an opaque full-size base pose for a frame. Inspect each flagged frame
with both neighbours. Use a temporal RGB-excursion and sharpness-dip detector when suitable;
register translations so moving text does not become a false flash. Keep known broken
frames as positive controls and coherent translation as a negative control. Fix thresholds
before the candidate run; retain raw flags and failures. Zero detected flags in a bounded
matrix is not a universal physical-display guarantee.

## Performance measurement

Read [performance-signals.md](../../../docs/performance-signals.md) for attribution and
[performance-benchmark.md](../../../docs/performance-benchmark.md) for controlled comparison.
For a changed interaction, define the cohort, fixed action window, tail and budgets **before**
measuring. Keep before/after hardware, Electron/Chromium/GPU backend, viewport, DPR, refresh
rate, dataset, appearance and load comparable. Separate instrumentation methods and cold
from warm trials. Use three fresh launches of one clean build for cold arrival; record the
first and 20 warm opens per surface. Retain every cohort member, including failed launches.

Capture pixels and performance in separate runs: screenshots, AX snapshots, CPU profiles and
repeated geometry reads perturb the critical path. Measure pointer→observed chrome and
input-ready independently. DOM/rAF visibility is a latency proxy, not first presented pixel
or physical input latency. Stop geometry reads after the necessary observation, while
retaining the full dropped-frame window and disclosed tail.

Collect renderer/compositor/GPU trace categories, renderer `PipelineReporter STATE_DROPPED`,
covered-frame layout and long tasks. Report rAF gaps only as callback opportunities; they
are not authoritative dropped presented frames. GPU-process busy p95 can be computed from
the union of `GPUTask` wall spans per presentation interval; it is not hardware utilization,
energy or p95 frame duration. Missing interval/layer data is unavailable, not zero. Layer
extent × RGBA is not measured allocation: scrolling layers may have tiled backing.

Use the [DESIGN budgets](../../../docs/DESIGN.md#performance-is-part-of-the-design), reporting
per-action maxima as well as totals/p95. A pane-push budget is not a chooser-arrival budget.
At 120Hz the refresh budget is half the 60Hz budget; a 60Hz run cannot certify 120Hz.
Include scaled lists, long streaming content, moving backdrops, visible/hidden working rings,
rapid reversal, sustained PTY and real native Browser reattachment where affected. Compare
idle/moving backdrop and 1/10/50 indicators before attributing cost to a material or loop.
Do not trade away visual fidelity to make a graph green or substitute one green launch for
a failing fixed cohort. Report narrow success and unresolved budgets separately.

## Checks and review handoff

Run focused changed-contract tests and touched-package typechecks, plus `vp check` and:

```sh
vp run --filter @volli/desktop check:glass-design
vp run --filter @volli/desktop check:ui-copy
vp run --filter @volli/desktop check:design-tokens
node scripts/check-public-content.mjs
```

If generated colours change, regenerate both fallback blocks and run
`node apps/desktop/scripts/generate-theme-css.mjs --check`. If marks/dependencies change,
regenerate notices and run `node scripts/generate-third-party-notices.mjs --check`.
Remove fixed shrinking-allowlist pairs/ceilings; never regenerate debt to bless new violations.
Linters are static guardrails, not layout, contrast or parity proof. CI owns full suites,
coverage and the smoke matrix; keep local checks focused and respect the worker budget.

Report exact commands/results, revision-labelled side-by-sides/frame evidence, per-surface
floor and stress results, retained commands, measured budgets and unverified cases. Keep
screenshots, raw traces and review notes outside tracked source; attach appropriate evidence
to the PR rather than committing it. Stop only the instances you launched.

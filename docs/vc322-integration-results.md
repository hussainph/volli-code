# VC-322 — integrated release pass

**Verdict: BLOCKED for accessibility sign-off. PR #579 remains draft; do not merge.**
This supersedes the original baseline verdicts in
[`vc322-accessibility-release-pass.md`](vc322-accessibility-release-pass.md).

## CI failure and focused fix

PR #579's original Check + Test job failed one test, `chrome-bar.test.tsx`:
`ReferenceError: HTMLElement is not defined` in `use-dialog-focus-return.ts`.
The palette renders closed in a Node-only static-markup test; `null instanceof
HTMLElement` still resolves the absent browser constructor.

Added a Node-environment regression fixture for **both open and closed** hook
renders. Both failed before the fix. The hook now returns no invoker when closed
or when `document` is absent, without changing browser focus restoration.
The ticket-title ring also adopts VC-418's opaque semantic ring instead of the
old 45% ring. Terminal source/shortcuts and navigation-focus code stay owned by
VC-344 and VC-419.

## Integrated built evidence

First integration base: `origin/main` **31002471**, including VC-343, VC-344 and
VC-418. These runs used merged commit `095f4730` plus the focus-hook/title changes
subsequently committed as `f8b1926e`. The probe records the dirty state explicitly.
The desktop pipeline was rebuilt before the accepted measurements.

| Gate | Result | Evidence |
| --- | --- | --- |
| New-ticket Escape + focus return | Pass | Real built Electron; returns to New ticket button after trap teardown. |
| Command palette Escape + focus return | Pass | Actual pre-open control restored. |
| Ticket-title keyboard focus | Pass | Computed 2px opaque semantic ring. |
| Terminal keyboard + Chromium/native macOS AX | **35/35 pass** | PID-scoped native AX trusted and exposes parsed PTY markers in named terminal regions, before/after focus, focus mode, hide/show and both split panes. |
| Terminal default PTY behavior | Pass | Tab/Shift+Tab remain PTY input by design. Control+Shift+M enables Tab/Shift+Tab focus navigation; navigation emits no PTY bytes. |
| Default primary-control contrast | Pass | Enabled New ticket rest/hover text **4.5056:1** in Light and Dark; focused ring/offset **5.0797:1 Light**, **8.7074:1 Dark**. |
| Dialog reduced-motion entrance | Pass, limited | Modal entrance animation becomes `none`. Not an all-motion sign-off. |
| Native browser → app keyboard boundary | **Fail — VC-301** | Focused Browser WebContents URL is the local fixture; fixture logs Meta+K delivered to INPUT; app dialogs remain 0. Escape stays in page; Shift+Tab traverses the page. |
| Product zoom 200% | **Unavailable** | App zoom ladder caps at 150%. BrowserWindow zoom injection is not a product acceptance pass. |
| Spoken VoiceOver and interactive reading | **Not performed** | Native AX exposure is not speech, reading-order, rotor, or scrollback-navigation acceptance. |

Raw workspace-local evidence:

- `evidence/vc322/integration/terminal-rebuilt/record.json` and six `mac-ax-*.json` dumps.
- `evidence/vc322/integration/candidate/report.json` (focus, motion, zoom, terminal).
- `evidence/vc418/post-Z9wlZ2/report.json` (composited contrast and focus screenshots).
- `evidence/vc322/integration/browser-native/report.json` (native focus plus delivered keys).

An initial delegated terminal run in `integration/terminal/` is **invalid as
integration evidence**: it started at 20:21:39Z, while the new renderer was not
built until 20:23:52Z. It measured stale assets. It was not used to file a new
terminal regression. The post-build `terminal-rebuilt/` run is the accepted one.

## Latest-main integration and quality gates

Integrated `origin/main` **69855470** as **a4181520**, including VC-419 (#585)
and VC-413 (#581). Rebuilt the desktop pipeline successfully. The built VC-419
navigation probe passes **9/9**: board/list entry and return, back shortcut,
filtered origin, filtered-out neighbour, moved-column origin and virtualized
origin restoration. Evidence: `integration/latest-navigation/report.json`.
The general candidate probe also now reports board/list return focus passing;
all eight reported checks pass (three are injected BrowserWindow zoom geometry,
not product zoom acceptance). Its title-ring gate passes after sampling the
heading explicitly rather than relying on the old tab-order position.

On this exact build, terminal keyboard/native AX repeats **35/35 passing**, and
Light/Dark contrast repeats passing with the ratios above. Accepted latest
artifacts are `integration/latest-candidate/report.json`,
`integration/latest-terminal/record.json`, and
`evidence/vc418/post-DAxYOJ/report.json`. Probe/document changes are recorded as
dirty; the app source was clean at a4181520. None of these replaces VoiceOver
speech acceptance. The native-window Browser probe repeats VC-301's failure:
`integration/latest-browser-native/report.json` again records Meta+K reaching
the page INPUT, focused fixture WebContents and zero app dialogs.

- Focused lifecycle/Node SSR/title/ChromeBar tests: **10/10 pass**, hook-only
  coverage **100% statements, branches, functions and lines**. The first focused
  run exposed an untested null-invoker branch (92.3% branches); a regression test
  now verifies that no-HTML-invoker leaves default close focus untouched.
  Log: `integration/latest-focused-complete.log`. This scoped coverage command
  is not a substitute for the full protected coverage gate.
- `pnpm exec vp check` and `pnpm typecheck`: **pass** after integration.
- All eleven current CI design/compliance commands: **pass** (workspace licenses,
  excluded dependencies, notices, theme CSS, design tokens, Node version,
  vendored themes, dependency licenses, notice inputs, LGPL source, library
  validation). Logs: `integration/latest-*.log`.
- Website and docs builds including font/license checks: **pass** on f8b1926e.
- The original SSR exception is gone in CI. The f8b1926e run **35391689247**
  passed boot and all three smoke shards, but Check + Test **failed** seven
  five-second timeouts in `agent-dispatch.test.ts` and `db/migrations.test.ts`.
  No timeout or coverage threshold was relaxed. Latest integration CI must
  independently pass; this earlier run is not green.
- Full local recursive coverage with workspace-contained `TMPDIR`: **failed**,
  three packages failing / six passing. Agent-runtime: seven sidecar migration
  failures (**VC-420**, fixture encoding disagrees with Pi on `.volli` paths).
  CLI: eleven Unix-socket failures. Desktop: 23 failed / 10,130 passed / two
  skipped, plus two unhandled errors. Failures include overlong Unix socket
  paths, filesystem/path assertions, git directory enumeration, and one worker
  startup timeout. Full details: `integration/coverage-all.log`. These failures
  are retained, not excluded or claimed as accessibility regressions.
- The first compliance run found stale `apca-w3` / `colorparsley` directories
  in reused generated dependencies. `pnpm prune --ignore-scripts --yes` removed
  them; all compliance gates above then passed without policy exceptions.

## Human / signed candidate gates still required

Use the detailed human checklist in the baseline report. Record candidate SHA,
macOS version, appearance, zoom, operator and a pass/fail per surface:

- VoiceOver speech/rotor/reading order across project navigation, board/list,
  ticket body/comments and file/diff editors.
- Terminal output reading and scrollback traversal in both split panes;
  discovery/announcement of Control+Shift+M, hide/show and focus return.
- Pending questions/permission cards, approve/deny/cancel/retry, asynchronous
  completion/error announcements and draft preservation.
- All dialogs/nested menus/destructive confirmations and focus return; native
  browser escape to app navigation (VC-301).
- Narrow panes and the complete 125/150/200% matrix, keyboard resizing and
  selection retention; all non-essential motion under Reduce Motion.

These are not signed off by source inspection, jsdom tests, or AX dumps.
No real user profile, provider credential, clipboard or global VoiceOver setting
was used or modified by these probes.

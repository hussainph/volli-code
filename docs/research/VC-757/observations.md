# VC-757 — owner follow-up browser-lab verification

## Result

All **12 grouped UI checks pass in the browser fixture**, not in a live desktop/host process. This refresh supersedes the earlier evidence that showed persistent unsupported paragraphs.

1. **Running rows start without Move to background chrome.** [early.png](early.png) and its [snapshot](early.aria.txt) finished **153 ms** after initial DOM render, with no Move actions mounted. The first action appeared at **2002 ms**; [before.png](before.png) shows the delayed enabled action and disabled cases.
2. **Shortcut works before the two-second delay, even in a genuinely collapsed ActivityBundle.** On a separate fresh render, focused the fixture Composer and pressed **Ctrl+Shift+B** at **157 ms**; the bundle settled by **175 ms**, without opening it or mounting its nested ToolRow controls. Summary changed from **Running 1 command…** to **Ran 1 command**, with `aria-expanded="false"` before and after. [early-shortcut-before.png](early-shortcut-before.png) and [early-shortcut-after.png](early-shortcut-after.png) show this separately from the delayed-action overview. The after capture completed at **276 ms**, still with no Move controls anywhere.
3. **Unsupported reasons are on disabled controls, not paragraphs.** Frozen Session, unsupported foreground path, and **Nested Code Mode shell · reason on disabled control** each have a disabled action, wrapper `title`, and matching `aria-description`: **This command can’t move to the background. Nested commands and Sessions without background-shell support aren’t supported.** Asserted both the explanatory text node and all paragraphs absent in these rows. Native tooltip metadata is asserted; a native hover popup is not photographed.
4. **Capacity retains its recovery paragraph.** Disabled action has matching wrapper `title` and `aria-description`, and the visible paragraph **This Session already has 4 running background shells. Stop one first.** No other unavailable fixture row has inline explanatory copy. See [before.png](before.png).
5. **Receipt, marker, and disclosure checks remain intact.** Initially settled and newly settled standalone ToolRows show **Moved to background** with details collapsed. [after.png](after.png) shows the settled bundle still collapsed after shortcut. Opening it reveals the still-collapsed ToolRow marker in [after-bundle-open.png](after-bundle-open.png); opening details reveals the fixture receipt **Moved command to background shell moved-shell.** and retained output in [after-receipt.png](after-receipt.png).
6. **Fresh-page button path passes independently.** Reloaded again, waited for the delayed action to become visible, then clicked it. [after-click.png](after-click.png) shows the newly settled standalone row marker with details still collapsed.

## Methods and exact checks

- Route: `http://localhost:5337/lab/#running-bash`; existing port 5337 server left running.
- Read `.agents/skills/verify-volli/SKILL.md`, existing evidence, and relevant implementation before editing. Only files under `docs/research/VC-757` were changed by this verification task.
- [verify-lab.mjs](verify-lab.mjs) uses headless installed Google Chrome, an isolated temporary profile, mock-keychain/basic-password-store flags, viewport **1440×1400**, device scale 1. The browser was closed and temporary directory removed after the run. No Electron was launched.
- Drove UI through Playwright roles/text and keyboard input, not internal fixture setters or direct RPC calls. Navigation uses **DOMContentLoaded plus initial rendered heading/bundle waits**, not `networkidle`. A read-only DOM MutationObserver records first-render and first-action timestamps. Timers are real, not mocked. Early captures fail if their completion exceeds two seconds; the delayed-appearance assertion allows 100 ms DOM-observer tolerance (actual observation: 2002 ms). Timings measure DOM observation, not exact React effect start or a performance benchmark.
- `node --check docs/research/VC-757/verify-lab.mjs`: **exit 0**.
- `node docs/research/VC-757/verify-lab.mjs`: **exit 0**, all 12 grouped checks passed. [verification.json](verification.json) records checks and timings.
- `git diff --check -- docs/research/VC-757`: **exit 0**.
- Read and visually inspected all **eight saved PNGs**: `early`, `before`, `early-shortcut-before`, `early-shortcut-after`, `after`, `after-bundle-open`, `after-receipt`, `after-click`. In the captured light/peach auto theme, commands, markers, disabled controls, capacity paragraph and expanded receipt fit without clipping. Unsupported paragraphs are absent; early rows have no action chrome. This was not a systematic theme or responsive audit.
- Each PNG has a corresponding refreshed `.aria.txt` snapshot beside it.
- [browser-console.json](browser-console.json): **zero JavaScript page errors**, one console error: **404 for `/favicon.ico`**. Result is `UI CHECKS PASS; CONSOLE ERRORS RECORDED`, not a clean-console claim.

## Scope and limits

The scratch imports production `ActivityBundle`, `ToolRow`, and `RunningBashProvider`, but seeds the shell store and responds through fixture RPC. Its Composer is a plain textarea, not the production composer. Its shared `moved-shell` fixture state causes both standalone and bundled examples to settle after either successful move; both changing in one screenshot is **not** independent proof of two moves or RPC addressing.

No actual OS process was moved, no durable host receipt queried, and no agent continuation observed. **“Turn continues” and the receipt are fixture text.** No Electron, SSH, credentials, sign-ins, implementation/fixture edits, commits, or pushes were used. Remote-host, inactive/unattached Session reasons, failure recovery, progress-update/disclosure timer persistence, short-command completion, real composer integration, and narrow viewports are not represented/tested here. Tooltip/description assertions cover only the unsupported/frozen/nested and capacity cases present in this lab; they do not establish remote or inactive behavior. Those remain outside this browser-fixture evidence.

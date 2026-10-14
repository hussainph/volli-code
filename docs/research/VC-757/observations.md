# VC-757 — browser-lab visual verification

## Run

- Route: `http://localhost:5337/lab/#running-bash`
- Scratch: **Running bash · move to background**, `apps/desktop/src/renderer/lab/scratches/running-bash.tsx`.
- Command (repository root): `node docs/research/VC-757/verify-lab.mjs`.
- Headless installed Google Chrome through `playwright-core`, 1440×1000 viewport, device scale 1. Browser launched with mock-keychain/basic-password-store flags; isolated temporary profile cleaned up. No Electron, keychain commands, SSH, provider sign-in, or product-code edits.
- Used the already-running lab server on port 5337; did not start/stop it.

## Actions and visible results

1. Opened the route and captured [`before.png`](before.png). First row shows running spinner and enabled **Move to background**. Capacity row shows a dimmed control. Unsupported and nested rows have no such control.
2. Clicked the first row's real **Move to background** button. Captured [`after.png`](after.png): first section becomes **Moved · turn continues**, spinner becomes a settled command icon, and move control disappears. Other cases remain displayed, including disabled capacity control.
3. Clicked that settled row's **Show details** button. [`after-receipt.png`](after-receipt.png) shows **Moved to background: moved-shell** in its output.
4. Checked the capacity button is disabled and both its `aria-description` and wrapper's native `title` equal: **This Session already has 4 running background shells. Stop one first.** The reason is exposed as native-title/accessibility text, not persistent inline copy; a native hover tooltip is not captured in these screenshots.
5. Asserted unsupported and nested sections contain zero **Move to background** buttons. Screenshots also show their absence.

Screenshots were opened and visually inspected: all five cases fit without clipped commands/actions at the tested viewport. Initial and moved screenshots preserve the same layout apart from the settled state. Running rows use the existing past-tense **Ran** label with a spinner.

## Checks and console

Final command exited **0**: enabled running action, disabled capacity action/reason, absent unsupported/nested actions, settled state after click, and expanded receipt all passed. No JavaScript `pageerror` events.

One browser-console error occurred: `404 (Not Found)` for `http://localhost:5337/favicon.ico`. No other console errors. The initial run failed an overly broad zero-console-errors assertion on this same favicon; the evidence script now records console errors separately from UI assertions rather than claiming a clean console.

Raw evidence: [`verification.json`](verification.json), [`browser-console.json`](browser-console.json), [`before.aria.txt`](before.aria.txt), [`after.aria.txt`](after.aria.txt). Repeatable driver: [`verify-lab.mjs`](verify-lab.mjs).

## Scope / limits

This is real renderer-component interaction against the scratch's fixture RPC response/store seed, **not** proof of moving an actual OS process, durable host receipt, or agent-turn continuation. “Turn continues” is fixture text. No live-app/Electron verification was performed. Other themes, viewport sizes, keyboard shortcut, remote-host case, and failure recovery were not tested.

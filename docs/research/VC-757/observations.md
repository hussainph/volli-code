# VC-757 — refreshed browser-lab UI verification

## Result

All three requested UI fixes pass in the **browser fixture**, not in a live desktop/host process:

1. **Shortcut survives a genuinely collapsed ActivityBundle.** Focused the fixture's Composer textarea and pressed **Ctrl+Shift+B** without opening the bundle. Its summary changed from **Running 1 command…** to **Ran 1 command**, with `aria-expanded="false"` before and after. No nested ToolRow controls were mounted before the shortcut. See [before.png](before.png), [after.png](after.png) and corresponding `.aria.txt` files.
2. **Settled collapsed ToolRow shows “Moved to background”.** The initially settled example and the newly settled first row both show the marker while their **Show details** buttons have `aria-expanded="false"`. Opening the completed ActivityBundle reveals another still-collapsed ToolRow with the marker: [after-bundle-open.png](after-bundle-open.png). Expanding its details reveals the fixture receipt and retained output: [after-receipt.png](after-receipt.png).
3. **Unavailable reasons are visible without hover.** Capacity, old frozen Session, unsupported foreground path, and nested Code Mode rows each show a disabled **Move to background** action plus a persistent explanatory paragraph. Disabled state and matching `aria-description`/wrapper `title` were asserted. Capacity says **This Session already has 4 running background shells. Stop one first.** Other unavailable fixture rows say **This command can’t move to the background. Nested commands and Sessions without background-shell support aren’t supported.** These are visible in every overview screenshot, not merely native tooltips.

The fresh-page direct button path also passes: [after-click.png](after-click.png) shows its settled collapsed-row marker. It was tested after reload, separately from the shortcut.

## Methods and evidence

- Route: `http://localhost:5337/lab/#running-bash`; existing port 5337 server left running.
- Read `.agents/skills/verify-volli/SKILL.md` and the previous evidence script before editing. Only files in this evidence directory were changed.
- First drove the page through Browser semantic tools: `browser_navigate`, `browser_find("Composer")`, click Composer (`e5`, generation 2), `press Control+Shift+B`, fresh `browser_find("Ran 1 command")`, then click bundle (`e62`, generation 2). The before/action/after accessibility output showed the running summary become settled, with the bundle still closed until explicitly opened. Browser screenshots were visually inspected. Browser tab `7c5c5bcb-2d6c-483b-9406-504992b1eb28` was released afterwards.
- Two initial `browser_snapshot` calls timed out while the page became ready. The following screenshot/find/action calls succeeded; this did not block verification.
- Refreshed the existing permitted persisted-evidence driver, [verify-lab.mjs](verify-lab.mjs), to replay the same semantic paths through Playwright roles/text and keyboard input, with no internal state setters or direct RPC calls. It uses headless installed Google Chrome, isolated temporary profile, mock-keychain/basic-password-store flags, viewport **1440×1400**, device scale 1. The profile was cleaned up.
- Ran `node docs/research/VC-757/verify-lab.mjs`: **exit 0**, nine grouped assertions passed. Exact results: [verification.json](verification.json).
- `node --check docs/research/VC-757/verify-lab.mjs` and `git diff --check -- docs/research/VC-757`: both **exit 0**.
- Read and visually inspected all five persisted PNGs. Seven cases fit the viewport with no clipped commands, actions, reasons, or expanded receipt. Reasons wrap cleanly. The light auto-theme persisted screenshots and the dark auto-theme Browser-tool screenshots both visibly show the marker/reasons; this was not a systematic theme audit.
- Accessibility snapshots: [before.aria.txt](before.aria.txt), [after.aria.txt](after.aria.txt), [after-bundle-open.aria.txt](after-bundle-open.aria.txt), [after-receipt.aria.txt](after-receipt.aria.txt), [after-click.aria.txt](after-click.aria.txt).
- Console: zero JavaScript `pageerror` events. One recorded console error, **404 for `/favicon.ico`**, unrelated to the UI assertions. [browser-console.json](browser-console.json).

## Scope and limits

The scratch imports production `ActivityBundle`, `ToolRow`, and `RunningBashProvider`, but seeds the shell store and responds through fixture RPC. Its Composer is a plain textarea, not the production composer. Its shared `moved-shell` fixture state causes both the standalone example and bundled example to settle after either successful move; the overview changing both is **not** independent proof of two moves or RPC addressing.

No actual OS process was moved, no durable host receipt was queried, and no agent continuation was observed. **“Turn continues” and the receipt are fixture text.** No Electron, credentials, SSH, sign-ins, implementation edits, fixture edits, commits, or pushes were used. Remote-host, inactive/unattached Session reasons, failure recovery, real composer integration, and narrow viewports are not represented/tested here. Those remain outside this browser-fixture evidence.

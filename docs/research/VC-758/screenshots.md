# VC-758 — renderer screenshots

22 captures at 1100 × 780 in headless Google Chrome: ten original BEFORE images retained unchanged, ten refreshed AFTER counterparts, and two new AFTER scrolled-up error images. No Electron, real providers, keychain, SSH or Docker were used.

## Evidence

Images are in [`screenshots/`](./screenshots/), named `{before|after}-{state}-{light|dark}.png`. Accessible trees, text, assertions and browser errors are in [`screenshots-before-evidence.json`](./screenshots-before-evidence.json) and [`screenshots-after-evidence.json`](./screenshots-after-evidence.json). Text/tree dumps include offscreen transcript content; the PNGs show the actual viewport.

| State | Before | Final after |
| --- | --- | --- |
| `sending` | A held `sending` message is absent; empty state remains | Message appears with right-aligned **Pending** |
| `steering` | Held steering message absent; running dots have an accessible Working announcement but no visible word | **Working** is visibly above the message; right-aligned **Pending · After the current step** |
| `queued` | Follow-up text appears without a visible queue label (the group already has an accessible Queued message name) | Visible **Queued** beside the same follow-up |
| `working` | Active turn with no transcript shows the empty state, no Working status | Visible and accessible **Working**, empty state removed |
| `error` | Context-assembly error and Retry are attached to the composer | Same explanation and exactly one Retry are in the timeline, not the composer |
| `error-scrolled` | Not captured | While reading older history, a visible fault explanation and **Scroll to latest** sit above the composer. Clicking the hint navigates to the sole Retry in the timeline; the hint disappears. |

The seeded older user message has no delivery metadata. Both the original baseline and final AFTER show **no delivery footer** for that old unlabelled history: neither an invented Delivered receipt nor a Recorded fallback. The interim AFTER images with Recorded and left-aligned pending labels have been replaced following renderer review. These fixtures do not prove a runtime acceptance transition.

## Real components and provenance

`apps/desktop/src/renderer/lab/scratches/vc-758-silent-ends.tsx` mounts the actual `ChatPlane`, composer, status/error/queue rows, generated theme, ModelAccess provider and Zustand stores. It seeds held drafts, transcript, lifecycle, queue and session error; it never redraws these product components as screenshot markup. API reads use lab stubs. Delivery and Retry are not connected to an engine in this fixture.

Renderer edits began while the initial harness was being prepared. To avoid reverting concurrent work, BEFORE used the exact `chat-plane.tsx`, `chat-plane-model.ts`, and `composer-ui.tsx` from baseline commit **c0cfd4577363c86022df3bb6e9cb2720b8c17897**. The capture script materializes them temporarily under the owned `vc-758-before-*` scratch paths, redirecting only their internal imports. Other components/styles came from the tree at that original capture. The three temporary files were deleted when capture ended; no production source was reverted and no maintained duplicate component is committed. BEFORE was not rerun during this refresh, and its ten images and evidence JSON remain byte-for-byte unchanged.

AFTER imports the current production renderer, refreshed after the main merge and the final label-alignment, old-history-footer and scrolled-up-fault-hint fixes. The five paired states retain identical fixture data. The additional `error-scrolled` state adds 16 historical user/assistant exchanges; the script performs a real browser wheel scroll, captures the hint, then clicks it and checks navigation without invoking Retry.

Browser `colorScheme` drives the lab's existing automatic light/dark appearance; `?clean` removes only the lab's floating controls, which otherwise overlap the product composer. All twelve final AFTER PNGs were opened and visually inspected: Working is above steering, pending labels meet the bubbles' right edges, old history is unlabelled, the error has one Retry, and the scrolled-up hint is readable above the composer in both themes.

## Reproduce AFTER

Start on a free allowed port (default 5368, permitted range 5300–5399):

```sh
cd apps/desktop
pnpm exec vp dev --mode lab --port 5368 --strictPort
```

From the repository root, with that server running:

```sh
node docs/research/VC-758/screenshots-capture.mjs after
```

For another allowed port, match the server's `--port` with `VC758_LAB_PORT=53xx` on the capture command. Stop the lab server afterwards. The script uses installed `playwright-core` and `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`, with an isolated temporary browser profile. Interactive AFTER URL: `http://localhost:5368/lab/?clean&state=steering#vc-758-silent-ends`.

The `before` argument remains available to reconstruct baseline components, but is not part of this refresh: rerunning it would replace preserved evidence and would use today's other components/styles.

## Checks and limitations

- `node docs/research/VC-758/screenshots-capture.mjs after`: **12/12 passed, zero browser page errors**. The initial cold-server attempt timed out at the original 30-second navigation limit before any capture; the script now allows 120 seconds for initial compilation, and the rerun passed.
- Assertions cover pending visibility, steering copy, Working geometrically above steering, pending label/bubble right-edge equality (both at x=886), no footer on old history, visible queue label, Working on an empty transcript, error placement outside the composer, and exactly one Retry per error state. Both scrolled-up cases assert the hint is in the viewport and clicking it returns to the recovery control.
- `pnpm exec vp lint apps/desktop/src/renderer/lab/scratches/vc-758-silent-ends.tsx`: 0 warnings/errors.
- `pnpm exec vp fmt apps/desktop/src/renderer/lab/scratches/vc-758-silent-ends.tsx docs/research/VC-758/screenshots-capture.mjs`: completed (one non-ignored file).
- `node --check docs/research/VC-758/screenshots-capture.mjs`: passed.
- `git diff --exit-code -- docs/research/VC-758/screenshots/before-\* docs/research/VC-758/screenshots-before-evidence.json`: passed; original baseline evidence unchanged.
- `cd apps/desktop && pnpm exec tsc --noEmit -p tsconfig.web.json --composite false`: passed.
- `git diff --check -- apps/desktop/src/renderer/lab/scratches/vc-758-silent-ends.tsx docs/research/VC-758/screenshots*`: passed.
- This is renderer evidence, not a scripted-runtime, transport, persistence, acceptance, or recovery-click test. The navigation hint was clicked, but Retry was not. Those engine behaviors belong to the ticket's integration coverage.

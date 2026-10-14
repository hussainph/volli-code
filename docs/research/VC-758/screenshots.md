# VC-758 — renderer screenshots

20 captures: five states × before/after × light/dark, at 1100 × 780 in headless Google Chrome. No Electron, real providers, keychain, SSH or Docker were used.

## Evidence

Images are in [`screenshots/`](./screenshots/), named `{before|after}-{state}-{light|dark}.png`. Exact accessible trees, visible text, assertions and browser errors are in [`screenshots-before-evidence.json`](./screenshots-before-evidence.json) and [`screenshots-after-evidence.json`](./screenshots-after-evidence.json).

| State | Before | After |
| --- | --- | --- |
| `sending` | A held `sending` message is absent; empty state remains | Message appears with **Pending** |
| `steering` | Held steering message absent; running dots have an accessible Working announcement but no visible word | **Working** is visibly above the message; **Pending · After the current step** |
| `queued` | Follow-up text appears without a visible queue label (the group already has an accessible Queued message name) | Visible **Queued** beside the same follow-up |
| `working` | Active turn with no transcript shows the empty state, no Working status | Visible and accessible **Working**, empty state removed |
| `error` | Context-assembly error and Retry are attached to the composer | Same explanation and one Retry are in the timeline, not the composer |

The seeded older user message has no delivery metadata, so AFTER correctly shows **Recorded**, not an invented Delivered receipt. These fixtures do not prove a runtime acceptance transition.

## Real components and provenance

`apps/desktop/src/renderer/lab/scratches/vc-758-silent-ends.tsx` mounts the actual `ChatPlane`, composer, status/error/queue rows, generated theme, ModelAccess provider and Zustand stores. It seeds held drafts, transcript, lifecycle, queue and session error; it never redraws these product components as screenshot markup. API reads use lab stubs. Delivery and Retry are not connected to an engine in this fixture.

Renderer edits began while the initial harness was being prepared. To avoid reverting concurrent work, BEFORE uses the exact `chat-plane.tsx`, `chat-plane-model.ts`, and `composer-ui.tsx` from baseline commit **c0cfd4577363c86022df3bb6e9cb2720b8c17897**. The capture script materializes them temporarily under the owned `vc-758-before-*` scratch paths, redirecting only their internal imports. All other components/styles come from the current tree. The three temporary files are deleted when capture ends; no production source was reverted and no maintained duplicate component is committed. AFTER imports the live production renderer after its fixes were present.

The same fixture data is used on both sides. Browser `colorScheme` drives the lab's existing automatic light/dark appearance; `?clean` removes only the lab's floating controls, which otherwise overlap the product composer.

## Reproduce

Start on a free allowed port (the harness defaults to 5368):

```sh
cd apps/desktop
pnpm exec vp dev --mode lab --port 5368 --strictPort
```

From the repository root, with that server running:

```sh
node docs/research/VC-758/screenshots-capture.mjs before
node docs/research/VC-758/screenshots-capture.mjs after
```

The script uses the installed `playwright-core` and `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`, with an isolated temporary browser profile. It refuses to overwrite existing baseline scratch files. Interactive AFTER URL: `http://localhost:5368/lab/?clean&state=steering#vc-758-silent-ends`.

## Checks and limitations

- Both capture commands passed: ten cases each, zero browser page errors.
- Assertions check pending visibility, steering copy, Working geometrically above steering, visible queue label, Working on an empty transcript, error placement outside/inside the composer, and exactly one Retry.
- `pnpm exec vp lint apps/desktop/src/renderer/lab/scratches/vc-758-silent-ends.tsx`: 0 warnings/errors.
- `pnpm exec vp fmt apps/desktop/src/renderer/lab/scratches/vc-758-silent-ends.tsx docs/research/VC-758/screenshots-capture.mjs`: completed (one non-ignored file).
- `git diff --check -- apps/desktop/src/renderer/lab/scratches/vc-758* docs/research/VC-758/screenshots*`: passed.
- `cd apps/desktop && pnpm exec tsc --noEmit -p tsconfig.web.json --composite false`: final run passed. Earlier runs were blocked by concurrent `chat-plane-model.test.ts` typing, subsequently fixed by its owner.
- This is renderer evidence, not a scripted-runtime, transport, persistence, acceptance, or recovery-click test. Those belong to the ticket's engine/integration coverage.
- Visual follow-up communicated to the parent: delivery labels currently align at the left content edge while user bubbles align right, making them visually detached. No shared styles were changed by the screenshot owner.

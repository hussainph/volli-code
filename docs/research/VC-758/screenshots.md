# VC-758 — renderer screenshots

30 captures at 1100 × 780 in headless Google Chrome: ten original BEFORE images retained unchanged and twenty refreshed AFTER images (including six handoff-stage images). No Electron, real providers, keychain, SSH or Docker were used.

## Evidence

Images are in [`screenshots/`](./screenshots/), named `{before|after}-{state}-{light|dark}.png`. Accessible trees, text, assertions and browser errors are in [`screenshots-before-evidence.json`](./screenshots-before-evidence.json) and [`screenshots-after-evidence.json`](./screenshots-after-evidence.json). Text/tree dumps include offscreen transcript content; PNGs show the actual viewport.

| State | Before | Current after |
| --- | --- | --- |
| `sending` | A held `sending` message is absent; empty state remains | Message appears with right-aligned **Pending** |
| `accepted-streaming` | Not captured | Accepted message remains above the streaming reply and **Working**, with **no delivery footer**, no Delivered/Recorded, and no Pending |
| `steering` | Held steering message absent; running dots have an accessible Working announcement but no visible word | **Working** is visibly above the message; right-aligned **Pending · After the current step** |
| `queued` | Follow-up text appears without a visible queue label (the group already has an accessible Queued message name) | Visible **Queued** beside the same follow-up |
| `working` | Active turn with no transcript shows the empty state, no Working status | Visible and accessible **Working**, empty state removed |
| `error` | Context-assembly error and Retry are attached to the composer | Same explanation and exactly one Retry are in the timeline, not the composer |
| `error-scrolled` | Not captured | While reading older history, a visible fault explanation and **Scroll to latest** sit above the composer. Clicking the hint navigates to the sole Retry in the timeline; the hint disappears. |
| `handoff-{pending,accepted-held,durable-delivered}` | Not captured | Acceptance removes Pending and promotes the message above Working. Accepted held → durable has **identical bubble, row and Working bounds**, with no handoff jump (details below). |

Older unlabelled user messages continue to have **no delivery footer**: neither an invented Delivered receipt nor a Recorded fallback. Non-delivered assertions are retained. This follow-up replaces the previous accepted-streaming AFTER pictures that showed Delivered; BEFORE evidence is untouched. Peek facts are outside this capture and were not changed by the fixture.

## Real components and provenance

`apps/desktop/src/renderer/lab/scratches/vc-758-silent-ends.tsx` mounts the actual `ChatPlane`, composer, status/error/queue rows, generated theme, ModelAccess provider and Zustand stores. It seeds held drafts, transcript, lifecycle, queue and session error; it never redraws these product components as screenshot markup. API reads use lab stubs. Delivery and Retry are not connected to an engine in this fixture.

Renderer edits began while the initial harness was being prepared. To avoid reverting concurrent work, BEFORE used the exact `chat-plane.tsx`, `chat-plane-model.ts`, and `composer-ui.tsx` from baseline commit **c0cfd4577363c86022df3bb6e9cb2720b8c17897**. The capture script materializes them temporarily under the owned `vc-758-before-*` scratch paths, redirecting only their internal imports. Other components/styles came from the tree at that original capture. The three temporary files were deleted when capture ended; no production source was reverted and no maintained duplicate component is committed. BEFORE was not rerun during this refresh, and its ten images and evidence JSON remain byte-for-byte unchanged.

AFTER imports the current production renderer, including `RunningBashProvider`. The five paired states retain identical fixture data. The `error-scrolled` state adds 16 historical user/assistant exchanges; the script performs a real browser wheel scroll, captures the hint, then clicks it and checks navigation without invoking Retry.

`accepted-streaming` represents a normal idle-session send after opening acceptance and before the provider finishes. It uses the production `appendFrames` fold over a recorded command, an uncorrelated turn start, an accepted receipt explicitly naming that command, and a live assistant overlay whose text part is `streaming`. There is no completed receipt or turn ending. The user message is durable; the assistant reply is only an overlay. **The receipt identity is unchanged:** `opening-receipt` names command `ordinary-send`, whose transcript message is `request`; the turn-start event has **no commandId**. Acceptance is a seeded receipt fact, not an inference from event proximity. This is seeded presentation evidence, not a provider-backed send or proof of the client's opening-settle request.

## Seeded handoff geometry proof — accepted-to-durable bounds match

The `handoff` fixture keeps one actual ChatPlane mounted with an active turn and no assistant text. The lab-only **Advance handoff** button changes real store inputs in three stages:

1. A held `request`, `state: sending`, `delivery: send`, shows Pending.
2. `amendHeldMessage` sets `deliveryAccepted: true`, like the client acknowledgement arriving ahead of its stream. No footer remains; the accepted non-queue message now renders above Working.
3. The Session store receives the same recorded-command/explicit-accepted-receipt transcript as above, without the assistant overlay. ChatPlane's actual reconciliation retires the held copy. Exactly one user message remains; no footer appears.

The left-side controls explicitly say **Seeded lab presentation proof**. They do not affect the plane's layout. This simulates presentation ownership, not a transport race or real receipt arrival.

Both themes measured identically:

| Stage | Bubble x / y | Bubble width × height | User row x / y | User row width × height | Working x / y | Working width × height |
| --- | --- | --- | --- | --- | --- | --- |
| Pending | 600.140625 / 72 | 285.859375 × 39.796875 | 214 / 72 | 672 × 67.796875 | 214 / 20 | 672 × 28 |
| Accepted held | 600.140625 / 20 | 285.859375 × 39.796875 | 214 / 20 | 672 × 39.796875 | 214 / 83.796875 | 672 × 28 |
| Durable delivered | 600.140625 / 20 | 285.859375 × 39.796875 | 214 / 20 | 672 × 39.796875 | 214 / 83.796875 | 672 × 28 |

Pending → accepted removes the 28px footer allocation and promotes the bubble above Working: bubble y changes by **−52px**, and Working y changes by **+63.796875px**. This acceptance transition is not claimed to be stationary. The parent's production fix places accepted non-queue held rows above Working, while unaccepted messages and queues remain below it.

Accepted held → durable now has **zero delta in x, y, width and height**, in both themes. The runner asserts `sameBubbleBounds: true` (1px tolerance), `sameRowHeight: true`, and exact bubble dimensions. A separate evidence check confirmed exact equality of the complete bubble, row and Working rectangles, not merely the tolerance. The former 52px durable-handoff jump is resolved in this seeded presentation proof.

## Visual inspection

Opened and visually inspected both `after-accepted-streaming-{light,dark}.png` images and all six `after-handoff-{pending,accepted-held,durable-delivered}-{light,dark}.png` images. Accepted-streaming shows the prompt above the reply and Working, without a footer or leftover label space. The handoff pictures show Pending disappearing as the accepted bubble moves above Working; the subsequent durable bubble stays in exactly the same position. Text is legible in both themes; the lab-only controls sit outside the transcript column. The other twelve AFTER captures were regenerated with their original assertions and remain byte-for-byte unchanged; their earlier visual inspection is not claimed as new work.

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

For another allowed port, match the server's `--port` with `VC758_LAB_PORT=53xx` on the capture command. Stop the lab server afterwards. The script uses installed `playwright-core` and `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`, with an isolated temporary browser profile. Interactive handoff URL: `http://localhost:5368/lab/?clean&state=handoff#vc-758-silent-ends`; press **Advance handoff** twice. Reload resets the proof.

The `before` argument remains available to reconstruct baseline components, but is not part of this refresh: rerunning it would replace preserved evidence and use today's other components/styles.

## Checks and limitations

- `node docs/research/VC-758/screenshots-capture.mjs after` on **5368**: **20/20 captures completed, exit 0, all asserted checks passed, zero browser page errors**. `sameBubbleBounds` is now a passed assertion in both themes. Each theme has seven existing states plus three successive handoff stages.
- A separate `node --input-type=module` evidence check asserted 20 records, zero page errors, `sameBubbleBounds === true`, `sameRowHeight === true`, exact accepted/durable geometry equality, and `{x: 0, y: 0, width: 0, height: 0}` handoff deltas for both themes: passed.
- Accepted-streaming asserts exactly one user message, no footer, no Delivered/Recorded/Pending, one Working status, the expected streaming reply, and all three in the viewport. Its user row ends at y=59.796875, reply begins at y=83.796875, and Working begins at y=131.59375.
- Original assertions still cover Pending visibility/right alignment, steering copy/ordering, no footer on unlabelled history, Queued, empty-transcript Working, error placement, one Retry, and scrolled-up hint navigation/removal.
- `node --check docs/research/VC-758/screenshots-capture.mjs`: passed. Product tests, lint and typecheck were not rerun by this capture-only revalidation.
- `git diff --exit-code -- 'docs/research/VC-758/screenshots/before-*' docs/research/VC-758/screenshots-before-evidence.json`: passed; original evidence unchanged.
- Python SHA-256 comparison before/after capture: all ten BEFORE PNGs and the BEFORE evidence JSON unchanged (11/11 files).
- `git diff --check -- docs/research/VC-758/screenshots.md docs/research/VC-758/screenshots-after-evidence.json docs/research/VC-758/screenshots`: passed.
- Cleanup: owned lab process group **92912** terminated with SIGTERM in `finally` (exit −15); `lsof -nP -iTCP:5368 -sTCP:LISTEN` returned exit 1, no listener. Chrome closed in the runner's `finally`.
- No production edits by this screenshot task, no commit/push. This is renderer evidence, not runtime, persistence, transport, or recovery execution coverage. Retry was not clicked.

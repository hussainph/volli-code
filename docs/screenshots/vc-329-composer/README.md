# VC-329 — composer simplification

Follow-up to the initial automation improvements. The [previous composer](../../assets/vc-329/ticket-composer.webp) exposed three competing commit actions, model/effort, working-copy controls, and a batch-entry switch at once.

The new layout keeps writing on the canvas, ticket metadata below it, and one split commit button in the footer. Options holds working-copy setup and Create more. The launch selector configures the primary action without submitting; model/effort only appear for chat kickoff. Saved Automations retain their own Instructions and Runtime.

Keyboard change: `⌘/Ctrl+Enter` now follows the selected primary action (initially Create & start), rather than always creating without starting. `⇧⌘/Ctrl+Enter` remains explicit chat kickoff. Launch mode is per-open and resets on project changes; it is not part of the persistent ticket draft.

## Captures

Real renderer components in the worktree UI Lab, using `ticket-kickoff` with `automation-design-pass` Automation fixtures installed through `installFakeApi`. These are not live project records or provider-backed Runs.

- [Composer](composer.webp) / [in context](after.webp)
- [Launch selector](launch-menu.webp)
- [Saved Automation selected](automation.webp)
- [Create only](create-only.webp)
- [Working-copy and batch options](options.webp)
- [Light appearance](light.webp)
- [420px viewport](narrow.webp)

Headless Chrome interaction checks exercised selection without submission, contextual runtime visibility, nested base-branch and working-destination pickers, Create more's closed-trigger summary, expand/collapse recovery, and narrow-window overflow. The completed run reported no page errors.

254 focused automation/composer tests passed, together with typecheck, lint, design-token checks, and build. Updated packed-app smoke scripts passed syntax checks but were not executed. No provider-backed start was performed.

## Lab comparison

`automation-studio` has stronger grouping worth migrating: its board-shaped trigger selection and co-located instructions/runtime preserve a coherent reading path. `automation-trigger` provides a clearer contextual split-action hierarchy. The shipping components should retain that hierarchy rather than making every new capability another permanent control.

These are interaction references, not a specification to transplant unchanged: Studio's harness selection and parallel launches, and Trigger's move/resume semantics, do not all match the current single Agent Runtime and explicit saved-Run behavior. This composer pass does not change the shipping Automation editor or ticket-rail layout.

## Drag-loop correction

The interactive preview exposed a real `Maximum update depth exceeded` failure. A clean Chrome reproduction reached dnd-kit's sortable derived-transform reset. Keeping only same-column order stable was insufficient: the rollback stress case subsequently reached core's active-node `measureRect` loop through cross-column reparenting.

The final Board implementation keeps **all measured card order and parentage fixed for the entire gesture**, for single tickets as well as groups. The existing pure `resolveGroupDrop` resolves the intended slot from that frozen snapshot. The detached card and sortable transforms preview the gesture, while a paint-only ring names the aimed column without changing a measured rectangle; the board store is changed only on release. The earlier dnd-kit scroll-ancestry patch remains unchanged; no errors or listener warnings are suppressed.

The review hub now supplies in-memory `tickets.move` and `moveMany` handlers using the shared board operations. These return authoritative fixture snapshots rather than making every drop roll back as an unstubbed failure. They never start agents. Moved fixture tickets survive switching between the review views.

Validation of the final fix:

- 28 pure drag-resolution and fixture tests passed.
- Renderer typecheck and targeted lint passed.
- `board-sort-loop-smoke.mjs` passed 12 real-layout cross-column drags: six successful commits and six deliberately refused/rolled-back moves, plus Option-picker interactions and Escape cancellation. It asserts that neither column's measured DOM order changes during a drag and fails on React update-depth errors.
- The heavier jsdom measurement run did not complete within the tool timeout on the overloaded host. An attempted additional shim case was not retained; the new structural regression is asserted in the real-browser smoke instead. The full suite/build/coverage were not rerun for this correction.

Reproduce against the running Lab:

```sh
VOLLI_LAB_PORT=5189 pnpm smoke:board-sort-loop
```

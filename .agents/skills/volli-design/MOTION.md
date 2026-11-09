# Motion: continuity without waiting

Read the [timing table](../../../docs/DESIGN.md#motion), `lib/glass-motion.ts`, the affected
controller and `hooks/use-reduced-motion.ts`. CSS clocks/curves live in `globals.css`;
JavaScript uses `GLASS_MOTION` milliseconds, deriving seconds only at a library boundary.
Parse CSS times with `cssTimeMs`, not `parseFloat`: an optimiser may serialize milliseconds
as seconds. A physical spring response is not its finite playback duration.

## Classify before animating

Keyboard, programmatic/unknown origin and high-frequency actions settle instantly, including
hover feedback, tab selection, command palette navigation, typing and streamed text. Carry
origin through the action and portal; a global last-input-device guess can misclassify it.
Occasional pointer overlays use the shared anchored entrance and faster fade exit. Do not
stagger content or wait for an entrance before making controls usable.

Both OS Reduce Motion and app Motion off mean **instant**, including opacity, press scaling,
pseudo-elements, scope repaint and in-flight runs. Import the shared hook/function, not
`motion/react`'s system-only hook. Cancellation applies the semantic endpoint and cleans up
listeners, animation fills, resize fences and temporary promotion. Reduced transparency is
an independent opaque-material choice. Working indicators keep distinguishable static state.

## Push and peek have different ownership

- **Peek** overlays the work plane without reserving width. The fully formed fixed-size pane
  moves a short distance and fades on the shared peek clocks. It remains usable on inside
  clicks; focus holds it. Leave/grace, Escape, outside click and pin follow the existing
  controller. Hover intent is not a second pin command.
- **Push** reserves width continuously. One registered width spring drives the pane edge and
  paper edge every frame, retaining the gutter. This is an explicit layout-animation
  exception, not a FLIP approximation that shrinks then slides content. Keep text unscaled.
  xterm/Monaco/native Browser resize is fenced until settled; native pixels use a cached
  still while moving, then reattach and accept real input.
- **Peek → pin** keeps the already visible pane visible while paper reserves space. It does
  not replay a closed entrance. On reversal, sample live presentation and velocity; cancel
  the old run, retarget within travel bounds and retain the same resize fence.
- Keep the push owner through its closed endpoint. Releasing it into an ordinary 12px peek
  transition can fly a withdrawn pane back over paper. Suppress hover arming while that
  side's push owns movement, without adding a compensating timeout. Distinguish floating
  CSS exit completion from push completion so native fences cannot wait forever.

Read `sidebar/pane-motion.tsx`, `sidebar/edge-reveal.ts` and `lib/pane-resize.ts` together.
React owns semantic mode, residency, focus and accessibility; animation owns presentation.
Keep handles in refs, guard stale completions by ownership/generation, and keep explicit
activation reversible. Completion must not accept a command, persist intent or enable input.

## Choose the cheapest faithful mechanism

Use transform/opacity and, when required, clip-path. Keep the existing explicit layout
exceptions: pane push, actual tab-width cascade and pointer ticket-group disclosure. Other
folds are instant. Tabs retain the pointer-close width hold until leave/idle; keyboard and
reduced motion bypass both cascade and hold.

Use existing CSS/WAAPI and analytic spring sampling rather than a new motion dependency or
React state on every frame. Direct pointer tracking can coalesce in rAF; a predetermined
animation does not need a perpetual JS loop. CSS `linear()` provides a sampled curve, not
a velocity-preserving retargetable physics engine by itself.

Keep material, radius, rim and shadow fully formed during movement. Do not animate blur or
switch it off during a push/reveal. Keep a **single resident material**, not a duplicate
decorative glass timeline. Static backdrop filters still cost GPU work while content moves
under them; compositor eligibility is not proof of free rendering. Remove temporary
`will-change` at settle/cancel/unmount, pause hidden loops, and preserve live subtree identity.

## Proof before calling motion finished

Follow [VERIFICATION.md](VERIFICATION.md#frame-level-motion-proof) for consecutive-frame
pixel checks and [performance measurement](VERIFICATION.md#performance-measurement) for
traces and acceptance budgets. Test both sides, interrupted peeks/pins, edge crossings,
rapid reversals, keyboard and both reduced-motion settings. Include the final frame and
post-completion tail: cancellation can expose a ghost or slab for one frame even when
all bounding boxes and computed opacity pass.

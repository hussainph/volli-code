/**
 * The DECISION half of the shell's pin/unpin journey — what the content surface
 * should do next, given where it is and where it has been asked to be.
 *
 * Extracted from `app-shell.tsx` on the repo's established pattern (`listing.ts`,
 * `edge-region.ts`, `browser-plane-freeze.ts`): pure `.ts` beside the view glue,
 * so the gate can reach a rule whose every failure mode is invisible in a
 * screenshot. This one earned it the hard way — the first version could reach a
 * state where the spacer stayed pinned with nothing in it and the shell claimed
 * to be animating forever, and no test could see it because the machine lived
 * inside a `useLayoutEffect` in an un-gated `.tsx`.
 *
 * WHY THERE IS A MACHINE AT ALL. A pin genuinely changes how much room the
 * content has, so "animate a transform instead of a width" cannot mean "never
 * resize" — it means resize ONCE, at the endpoint where the edge that moves is
 * off screen. That splits one gesture into two facts that are briefly allowed to
 * disagree: which layout the surface is laid out against (`layoutPinned`) and
 * where the compositor is drawing it (`translate`). Every state below is one
 * combination of those two, and the whole job is never to strand them apart.
 *
 * The hook owns the DOM: measuring, starting the WAAPI animation, and setting
 * React state. Nothing here touches either.
 */

/**
 * Below this, a journey is not worth starting — the endpoints are the same
 * place. Half a CSS pixel is under the smallest step any display can show, and
 * animating it would cost a real compositor layer promotion to move nothing.
 */
export const MIN_TRAVEL_PX = 0.5;

/** The live journey, as the decision needs to see it. */
export interface ContentMotionJourney {
  /** Which endpoint this journey is travelling toward. */
  targetPinned: boolean;
  /**
   * The journey ARRIVED and its `fill: "forwards"` is holding the endpoint
   * while React commits the matching layout. Visually finished, technically
   * still an `Animation` — which is exactly the distinction the trap below
   * turned on.
   */
  settling: boolean;
}

export interface ContentMotionState {
  /** The endpoint being asked for now. */
  pinned: boolean;
  /** The endpoint the last decision committed to. */
  target: boolean;
  /** The layout the surface is currently laid out against. */
  layoutPinned: boolean;
  /**
   * An escape hatch is holding the shell still: a resize drag, terminal focus,
   * rail geometry, reduced motion, a visible native Browser plane, or a DOM
   * that cannot animate at all. Settle at the endpoint, do not travel.
   */
  instant: boolean;
  /** The live journey, or null. */
  journey: ContentMotionJourney | null;
  /**
   * A translate a previous pass parked the surface at so its layout could be
   * released underneath it, awaiting the animation that walks it back to zero.
   */
  closingFrom: number | null;
}

/** The two numbers only a laid-out DOM can answer. */
export interface ContentMotionMeasurement {
  /** Distance between the two presentations' visible left edges, in CSS px. */
  travel: number;
  /** Where the surface is being drawn right now, in CSS px. */
  at: number;
}

/**
 * A LAZY measurement, and the laziness is the point rather than a style choice.
 * `travel` costs a `offsetWidth` read and `at` costs a `getComputedStyle` — both
 * force synchronous layout, and this decision runs on every commit of a shell
 * that re-renders on hover peeks and window resizes. This whole ticket is about
 * forced layout in the frame path, so the plan must be able to say "nothing to
 * do" without paying for one. `planContentMotion` calls this at most once, and
 * only on a pass that is actually going to move something.
 */
export type MeasureContentMotion = () => ContentMotionMeasurement;

export type ContentMotionPlan =
  /**
   * Nothing to do — the surface is where it was asked to be, or a journey the
   * hook already started is still running.
   */
  | { readonly kind: "hold" }
  /**
   * Take the endpoint now: cancel any journey, drop any parked translate, and
   * put the layout at `layoutPinned`. Every escape hatch and every degenerate
   * geometry lands here.
   */
  | { readonly kind: "settle"; readonly layoutPinned: boolean }
  /**
   * An opening arrived and React has committed the pinned layout underneath its
   * held transform. Release the fill so the surface stops being composited —
   * the layout alone now puts it in exactly the same place.
   */
  | { readonly kind: "clear-fill" }
  /**
   * A close cannot start until the surface has the WIDE layout back, so give it
   * that layout under an equal positive translate. No frame ever sees the jump,
   * because a layout effect's re-render is flushed before paint. The animation
   * itself comes on the next pass, from `from`.
   */
  | { readonly kind: "release-layout"; readonly from: number }
  /** Travel from `from` to `to`, in CSS px, toward `targetPinned`. */
  | { readonly kind: "animate"; readonly from: number; readonly to: number };

/**
 * What the content surface should do next.
 *
 * THE TRAP THIS ENCODES, because it is the one thing here worth a comment more
 * than a name. An opening that has just landed leaves a `settling` journey in
 * place: finished, but still holding its endpoint with `fill: "forwards"` until
 * the next pass cancels it. If the user closes the sidebar in the SAME React
 * commit that finished it — ⌘B on the last frame of an open, which is an
 * ordinary thing to do — that settling journey is still on the books. Reading it
 * as "a live journey" makes the close skip `release-layout`, so the surface
 * animates back to zero with the spacer still reserving a panel width that no
 * longer has a panel in it, and the closing finish has no layout left to
 * release. The result was terminal: a permanent phantom gutter, `moving` stuck
 * true, every Browser plane frozen behind a stand-in, and no input that could
 * re-run the machine to heal it.
 *
 * So a settling journey is NOT a live one. It is the previous journey's shadow,
 * and a new decision may walk straight over it.
 */
export function planContentMotion(
  state: ContentMotionState,
  measure: MeasureContentMotion,
): ContentMotionPlan {
  const { pinned, target, layoutPinned, instant, journey, closingFrom } = state;
  if (instant) return { kind: "settle", layoutPinned: pinned };

  const settling = journey !== null && journey.settling;
  const travelling = journey !== null && !journey.settling;

  if (target === pinned && closingFrom === null) {
    // The layout has caught up with a landed opening: let the transform go.
    if (settling && layoutPinned === pinned) return { kind: "clear-fill" };
    return { kind: "hold" };
  }

  const { travel, at } = measure();
  // A panel with no width to give (measured before first layout, or a shell
  // whose two arrangements coincide) has no journey to make.
  if (travel <= 0) return { kind: "settle", layoutPinned: pinned };

  if (!pinned && layoutPinned && !travelling) {
    return { kind: "release-layout", from: travel };
  }

  // A live journey is reversing: pick it up from where the compositor actually
  // has it, not from the endpoint it was aiming at. A settling one is holding
  // its endpoint, which `at` reports just as truthfully.
  const from = journey === null ? (closingFrom ?? 0) : at;
  const to = pinned ? travel : 0;
  if (Math.abs(to - from) < MIN_TRAVEL_PX) return { kind: "settle", layoutPinned: pinned };
  return { kind: "animate", from, to };
}

/**
 * Whether the shell is mid-journey, for the callers that have to paint above a
 * native child view while the content surface is not where its layout says.
 *
 * Not the same question as "is an `Animation` running": the surface is equally
 * out of step during the one commit where the layout has been released but the
 * animation has not started, and during the settle at the far end. The honest
 * test is the pair — a journey exists, OR the two facts disagree.
 */
export function isContentMoving(input: {
  animating: boolean;
  layoutPinned: boolean;
  pinned: boolean;
}): boolean {
  return input.animating || input.layoutPinned !== input.pinned;
}

/**
 * The effort control's arithmetic, without a control.
 *
 * Everything here is a decision the slider has to get right and a renderer
 * cannot help it get right: what a wire-format level is called, which stop a
 * model change lands on, and — the part worth extracting most — where a pointer
 * sitting at some x actually *is* on a notched track with soft ends.
 *
 * THE POINTER MAPPING IS NOT `x / pitch`. A discrete slider that maps the
 * pointer straight onto the visible track has two failures, and both are felt
 * rather than seen:
 *
 *  1. **The extremes need pixel-perfect aim.** The first and last stops sit ON
 *     the track's ends, so half of each one's catchment area is outside the
 *     element. Overshoot by a pixel and the value stops responding, which reads
 *     as the control jamming. {@link EffortTrack.deadZone} is the repair: a band
 *     of travel past each visible end that still means that end's stop, so the
 *     two values people reach for most are the two that cost nothing to hit.
 *     The pointer range is therefore WIDER than the drawn track.
 *  2. **The end of the range is invisible.** A value that has stopped changing
 *     and a control that has stopped listening look identical. So past the dead
 *     zone the track STRETCHES — {@link rubberBand}, Apple's own resistance
 *     curve — and the further it is pulled the less it gives. Nothing about the
 *     value changes; the whole point is that the limit becomes something you
 *     feel with the hand that is already moving, before you look.
 *
 * Both are the reason this is a hand-built control and not `<input
 * type="range">`: a range input hard-stops at its bounds and has no vocabulary
 * for either idea.
 */
import { REASONING_LEVELS, type ReasoningLevel } from "@volli/shared";

/**
 * The enum is a wire format; this is the copy.
 *
 * `xhigh` is what Pi calls it and what the composer rendered until now. A
 * control that names its own values in identifiers is a control nobody
 * proof-read.
 */
const LEVEL_LABEL: Record<ReasoningLevel, string> = {
  off: "Off",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Max",
};

/**
 * A level as a person reads it.
 *
 * Takes a `string` rather than a {@link ReasoningLevel} because a Session
 * records its model policy at birth and nothing re-reads that decision: a
 * durable row written by a build that knew a level this one does not still has
 * to render as something. It renders as itself — a level we cannot name is
 * still the level this Session is pinned to, and blanking it would hide that.
 */
export function effortLabel(level: string): string {
  const known = REASONING_LEVELS.find((candidate) => candidate === level);
  return known === undefined ? level : LEVEL_LABEL[known];
}

/** Which stop a level sits on, or the first one when the set does not hold it. */
export function effortIndex(levels: readonly string[], level: string): number {
  return Math.max(0, levels.indexOf(level));
}

/**
 * The level a model change lands on.
 *
 * The stop set is per-model and changes *under* the control — picking a model
 * that cannot run the current level has to rewrite it, because a control
 * holding a value the harness would refuse is the one thing this surface has
 * never done. `off` is the floor for a model that offers nothing at all, which
 * is the same fallback the model row has always used.
 */
export function reclampEffort(levels: readonly string[], current: string): string {
  return levels.includes(current) ? current : (levels[0] ?? "off");
}

/* ---------------------------------------------------------------- geometry */

/**
 * Pointer travel past each visible end that still means that end's stop.
 *
 * 16px, the spacing ladder's rung: wide enough that a deliberate overshoot
 * never costs the value, narrow enough that the stretch beyond it still starts
 * while the hand is clearly past the end rather than a gesture later.
 */
export const EFFORT_DEAD_ZONE = 16;

/**
 * How far the track can be pulled past a dead zone, in px, as the pull goes to
 * infinity. Not a distance anyone reaches — {@link rubberBand} approaches it
 * asymptotically, so a realistic 40px overdrag spends about three quarters of
 * it. Small on purpose: this is a 28px pill inside a popover, and the stretch
 * has to read as the material giving rather than as the control coming apart.
 */
export const EFFORT_STRETCH_LIMIT = 10;

/** The drawn track, and the two soft edges the pointer mapping adds to it. */
export interface EffortTrack {
  /** The pill's measured width: the first stop at 0, the last at `width`. */
  width: number;
  /** How many stops this model offers. */
  stops: number;
  /** {@link EFFORT_DEAD_ZONE}, or another number a caller wants to justify. */
  deadZone: number;
  /** {@link EFFORT_STRETCH_LIMIT}. **Zero turns the elasticity off** — which is
   * exactly what `prefers-reduced-motion` asks for, and the whole of what it
   * needs, since the dead zones are aim and not motion. */
  stretchLimit: number;
}

/** Where the pointer is: the stop it commits, and how far past the end it pulls. */
export interface EffortReading {
  index: number;
  /** Signed px. Negative pulls left of the first stop, positive right of the last. */
  stretch: number;
  /** `1 + |stretch| / width` — the horizontal scale that draws that pull. */
  scaleX: number;
}

/**
 * Apple's rubber-band resistance (*Designing Fluid Interfaces*, WWDC 2018).
 *
 * Diminishing returns with a hard ceiling: the result approaches `limit` as
 * `overshoot` grows without ever reaching it, so there is no second edge to hit
 * behind the first one. `constant` is Apple's own 0.55 — at an overshoot equal
 * to `limit` the track has given about a third of it, which is the ratio that
 * reads as resistance rather than as lag.
 */
export function rubberBand(overshoot: number, limit: number, constant = 0.55): number {
  if (limit <= 0) return 0;
  const magnitude = Math.abs(overshoot);
  const give = (magnitude * limit * constant) / (limit + constant * magnitude);
  return overshoot < 0 ? -give : give;
}

/**
 * The stop a pointer at `offsetX` (px from the track's left edge) commits to,
 * and the elastic pull it is applying past the ends.
 *
 * Reading it as three zones per side, from the middle out: **the track**, where
 * the nearest stop wins; **the dead zone**, where the end stop wins and nothing
 * moves; and **the stretch**, where the end stop still wins and the track
 * itself gives. A degenerate track — one stop, or a rail that has not been laid
 * out yet — is a control with nothing to choose, so it reads as stop zero and
 * refuses to stretch rather than dividing by its own width.
 */
export function readEffortPointer(offsetX: number, track: EffortTrack): EffortReading {
  const last = track.stops - 1;
  if (last <= 0 || track.width <= 0) return { index: 0, stretch: 0, scaleX: 1 };

  const stretchAt = (overshoot: number): EffortReading => {
    const stretch = rubberBand(overshoot, track.stretchLimit);
    return {
      index: overshoot < 0 ? 0 : last,
      stretch,
      scaleX: 1 + Math.abs(stretch) / track.width,
    };
  };

  if (offsetX < -track.deadZone) return stretchAt(offsetX + track.deadZone);
  if (offsetX > track.width + track.deadZone) {
    return stretchAt(offsetX - track.width - track.deadZone);
  }
  const pitch = track.width / last;
  return {
    index: Math.min(last, Math.max(0, Math.round(offsetX / pitch))),
    stretch: 0,
    scaleX: 1,
  };
}

/**
 * The vibrancy ramp's two ends, as the share of the ACCENT in the track.
 *
 * The wash is `color-mix(in oklab, var(--primary) N%, var(--border-strong))`:
 * the pill's own unfilled colour with the accent stirred into it. So the floor
 * is the track barely tinted, the ceiling is half accent, and 0% would be the
 * groove exactly — the ramp starts where the control already is instead of at
 * some colour that had to be picked. Nothing in it is authored; it is two live
 * tokens and one number.
 *
 * WHY A MIX RATHER THAN THE ALPHA IT REPLACES. Both put the accent over the
 * track, but only one of them can be made vibrant, and the reason is where the
 * contrast budget goes. A translucent wash spends the budget on LIGHTNESS —
 * every extra percent of alpha drags the ground toward the accent's own
 * lightness, which is mid, which is the direction the ink cannot afford in
 * either appearance — and it takes chroma along for the ride at exactly the
 * same rate, so the most saturated wash the labels can stand is a mid-tone
 * brown. Measured on the shipped ramp, over its true ground: the value label
 * read 4.61 → 4.74:1 in dark, already inside a quarter-point of AA, on a wash
 * whose top stop was `#8b5641`. There was no headroom left to be vibrant with.
 *
 * A mix separates the two. `color-mix` lands the lightness — toward the track,
 * which is the safe direction in BOTH appearances because the track is a colour
 * the ink already stands on — and then {@link EFFORT_CHROMA_GAIN} puts the
 * chroma back on top of that lightness, where it costs nothing. Same measurement
 * on the same labels: 7.14 → 5.05:1 in dark and 9.13 → 7.58:1 in light, a
 * HIGHER floor than the old ceiling, on a top stop of `#a53e0b` — a burnt
 * orange rather than a brown.
 *
 * WHY THE CEILING IS 50% AND NOT MORE. Dark binds, as it always does here, and
 * it binds late enough to be worth measuring: the top stop reads 5.34:1 at 45%,
 * 5.05:1 at 50%, 4.71:1 at 55% and 4.41:1 at 60%, so AA's 4.5 line sits between
 * 55 and 60 and 50 keeps half a point in hand for a canvas that derives a
 * lighter groove than this one. Light is nowhere near it (7.58:1 at 50%).
 */
export const EFFORT_MIX_FLOOR = 0.2;
export const EFFORT_MIX_CEILING = 0.5;

/**
 * How much of the chroma the mix took away is put back at the top of the ramp.
 *
 * Mixing the accent into the track cuts its chroma in proportion, so at the
 * ceiling the wash carries about half the accent's saturation and all of the
 * lightness it needs. `oklch(from <mix> l calc(c * 2) h)` reads the mixed colour
 * back, holds the lightness the mix just solved and doubles the chroma only.
 * That is the whole trick, and it is why this ramp can be saturated at all.
 *
 * Doubling slightly OVERSHOOTS the accent, because the track is not neutral and
 * the mix picks up its chroma too: measured on the shipped canvas, the top stop
 * lands at C 0.147 in dark and C 0.173 in light against the accent's own 0.129.
 * That overshoot is wanted — it is the difference between the top of the ramp
 * reading as the accent and reading as heat — and it is bounded, which the next
 * paragraph is about.
 *
 * IT CANNOT BLOW THE GAMUT, WHICH THE OBVIOUS VERSION OF THIS CAN. Multiplying
 * `var(--primary)`'s chroma directly is the same idea and it is unshippable:
 * `--primary` is whatever the accent math derived, at vibrancy 1 it IS the
 * authored seed, and several shipped seeds sit near the sRGB edge already —
 * measured, `oklch(from #e8652a l calc(c * 1.5) h)` clips and `#f2d060` and
 * `#e05561` clip too, which collapses the top rungs into one colour on exactly
 * the canvases that start most saturated. Doubling AFTER the mix starts from
 * roughly half the chroma and at a lightness pulled toward the track, which is
 * away from the gamut's own ceiling on both counts: checked by driving each of
 * the nine coloured swatches through the whole seven-rung ramp, every seed
 * produces seven separable colours with none of them stuck at an edge.
 */
export const EFFORT_CHROMA_GAIN = 2;

/**
 * Where a stop sits on the ramp: 0 at the first, 1 at the last.
 *
 * A one-stop set reads as the TOP rather than as 0/0, and that is not the same
 * clamp {@link effortStopPercent} makes: a lone stop has nowhere to sit on a
 * track, so it is drawn at the left end — but it has nothing to be less vibrant
 * *than*, and a lone control painted at the dimmest end would read as disabled.
 */
function effortTravel(index: number, stops: number): number {
  const last = stops - 1;
  if (last <= 0) return 1;
  return Math.min(last, Math.max(0, index)) / last;
}

/**
 * How much accent is in the wash at a given stop, as a `color-mix` share.
 *
 * Effort's meaning is magnitude, and until now the only thing carrying that was
 * position: at four stops the difference between `low` and `medium` was 33% of
 * a track. Colour is the second channel and the one read without measuring —
 * the wash at `max` is a different *substance* from the wash at `minimal`, not
 * merely a longer one.
 *
 * Interpolated rather than stepped, because a ramp that lands on three values
 * across seven stops leaves four pairs of adjacent stops looking identical, and
 * "adjacent stops look the same" is the complaint the redesign started from.
 */
export function effortWashMix(index: number, stops: number): number {
  const travel = effortTravel(index, stops);
  return EFFORT_MIX_FLOOR + (EFFORT_MIX_CEILING - EFFORT_MIX_FLOOR) * travel;
}

/**
 * The chroma multiplier applied to the mix at a given stop — 1 at the floor,
 * {@link EFFORT_CHROMA_GAIN} at the ceiling.
 *
 * It ramps rather than sitting at the ceiling throughout, and that is the
 * difference between a ramp and a tint. Held at 2 the bottom stop comes back
 * fully saturated too — measured in light, where the track carries chroma of its
 * own, the floor lands on `#f49773`, a vivid orange that is only slightly paler
 * than the top — and the control then says "hot" at every setting. Ramped, the
 * floor is the track's own colour barely warmed and the two channels move
 * together: at the bottom of the range there is little accent in the wash and
 * what there is stays quiet; at the top there is a lot of it and it is at full
 * strength.
 */
export function effortChroma(index: number, stops: number): number {
  const travel = effortTravel(index, stops);
  return 1 + (EFFORT_CHROMA_GAIN - 1) * travel;
}

/**
 * How hard the control radiates at a given stop, as an opacity for the ember
 * halo the pill throws onto the popover behind it.
 *
 * SQUARED, where the two ramps above are straight lines, and for a reason the
 * ramps do not have. The mix and the gain are read by COMPARISON — a stop is
 * only ever hotter than the one beside it, so every pair has to differ and a
 * straight line is the only curve that guarantees it. A halo is read on its
 * own, in one glance, against no neighbour: it has to be absent at the bottom
 * of the range rather than merely dimmer, or a control set to `low` sits there
 * glowing at a third of `max` and the top of the range stops meaning anything.
 * Squaring spends half the travel getting to a quarter of the strength and the
 * top of the range on the rest of it.
 */
export function effortGlow(index: number, stops: number): number {
  const travel = effortTravel(index, stops);
  return travel * travel;
}

/** Where a stop sits along the track, as a percentage of its width. */
export function effortStopPercent(index: number, stops: number): number {
  const last = stops - 1;
  return last <= 0 ? 0 : (Math.min(last, Math.max(0, index)) / last) * 100;
}

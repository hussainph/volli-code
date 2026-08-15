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

/** Where a stop sits along the track, as a percentage of its width. */
export function effortStopPercent(index: number, stops: number): number {
  const last = stops - 1;
  return last <= 0 ? 0 : (Math.min(last, Math.max(0, index)) / last) * 100;
}

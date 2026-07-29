/**
 * Every edit the stop editor can make, as pure transitions on a {@link Canvas}.
 *
 * Editor-only: nothing on the paint path calls any of it. It lives in the shared
 * package rather than beside the editor UI because the RULES are the model's —
 * how a family stays a family when a color changes, which stop "−" is allowed to
 * take, where a new pool lands — and a rule that lived in a component would be
 * re-implemented the first time a second surface (a preset importer, a CLI) had
 * to make the same edit.
 *
 * Positions are never derived. Those are the part a person placed by hand, and
 * the one thing here that must survive every other operation untouched.
 */

import { clamp, hexToOklch, oklchToHex } from "../color";
import { ARC_TUNING, MAX_STOPS } from "./tuning";
import type { Canvas, CanvasStop } from "./types";

function harmonyOffsets(count: number): readonly number[] {
  return ARC_TUNING.harmony[clamp(count, 1, MAX_STOPS) - 1];
}

/**
 * Re-derives every non-primary hex from the primary's, at the harmony offsets
 * for the current stop count.
 *
 * Lightness and chroma are copied from the primary rather than preserved per
 * stop, which is what makes a multi-stop canvas read as one family instead of
 * three unrelated colors that happen to share a window.
 *
 * Every edit that can change the primary's color OR the stop count runs through
 * here, so the family is a property of the canvas rather than of the order the
 * controls were pressed.
 */
function deriveHarmony(stops: CanvasStop[], primaryIndex: number): CanvasStop[] {
  const { L, C, h } = hexToOklch(stops[primaryIndex].hex);
  const offsets = harmonyOffsets(stops.length);
  return stops.map((stop, index) => {
    if (index === primaryIndex) return stop;
    const rotated = (((h + offsets[index] - offsets[primaryIndex]) % 360) + 360) % 360;
    return { ...stop, hex: oklchToHex(L, C, rotated) };
  });
}

/** Sets the primary's color; every other stop follows it around the wheel. */
export function withPrimaryHex(canvas: Canvas, hex: string): Canvas {
  const stops = canvas.stops.map((stop, index) =>
    index === canvas.primaryIndex ? { ...stop, hex } : stop,
  );
  return { ...canvas, stops: deriveHarmony(stops, canvas.primaryIndex) };
}

/**
 * Promotes a stop to primary — the editor's click gesture. Moves the index and
 * NOTHING else.
 *
 * Re-deriving here would be worse than redundant, and the reason is a property
 * of the harmony table: every row is closed under rotation. {0, 180} and
 * {0, 120, 240} have the same multiset of pairwise hue differences seen from any
 * member, so the set of colors a family produces does not depend on which of
 * them is called the primary. Re-deriving therefore asks for the colors that are
 * already on screen — but asks for them through `oklchToHex`, which gamut-maps,
 * so a stop whose chroma had been given up to reach sRGB came back quantised a
 * little flatter every time. Promote A→B→A drifted. Doing nothing is both the
 * correct answer and a lossless one.
 */
export function withPrimaryIndex(canvas: Canvas, index: number): Canvas {
  if (index === canvas.primaryIndex || index < 0 || index >= canvas.stops.length) return canvas;
  return { ...canvas, primaryIndex: index };
}

/** Moves one stop's anchor, clamped away from the very edges of the window. */
export function moveStop(canvas: Canvas, index: number, x: number, y: number): Canvas {
  const { min, max } = ARC_TUNING.dragBounds;
  return {
    ...canvas,
    stops: canvas.stops.map((stop, at) =>
      at === index ? { ...stop, x: clamp(x, min, max), y: clamp(y, min, max) } : stop,
    ),
  };
}

/** The diagonal from `from` that lands furthest from every stop already placed. */
function freestDiagonal(stops: readonly CanvasStop[], from: CanvasStop): { x: number; y: number } {
  const { step, min, max } = ARC_TUNING.newStop;
  const candidates = [
    { x: from.x + step, y: from.y + step },
    { x: from.x - step, y: from.y - step },
    { x: from.x + step, y: from.y - step },
    { x: from.x - step, y: from.y + step },
  ].map(({ x, y }) => ({ x: clamp(x, min, max), y: clamp(y, min, max) }));

  let best = candidates[0];
  let bestClearance = -1;
  for (const candidate of candidates) {
    const clearance = Math.min(
      ...stops.map((stop) => Math.hypot(stop.x - candidate.x, stop.y - candidate.y)),
    );
    if (clearance > bestClearance) {
      bestClearance = clearance;
      best = candidate;
    }
  }
  return best;
}

/**
 * Adds a harmony stop.
 *
 * The offsets change with the COUNT, so this re-derives the whole family rather
 * than only coloring the newcomer: going from a complement to a triad moves the
 * existing second stop from 180° to 120°, and leaving it behind would produce a
 * set that no longer has a rule.
 */
export function addStop(canvas: Canvas): Canvas {
  if (canvas.stops.length >= MAX_STOPS) return canvas;
  const primary = canvas.stops[canvas.primaryIndex];
  const stops = [...canvas.stops, { ...freestDiagonal(canvas.stops, primary), hex: primary.hex }];
  return { ...canvas, stops: deriveHarmony(stops, canvas.primaryIndex) };
}

/**
 * Drops the highest-index stop that is not the primary.
 *
 * Never the primary itself: "−" means "one fewer color", and taking the one the
 * whole family is derived from would recolor the entire window instead. So when
 * the primary happens to BE the last stop, the one below it goes and the middle
 * of the list is what closes up — a deliberate asymmetry, and the only rule that
 * keeps "−" from changing the color you are looking at.
 */
export function removeStop(canvas: Canvas): Canvas {
  if (canvas.stops.length <= 1) return canvas;
  const last = canvas.stops.length - 1;
  const dropped = last === canvas.primaryIndex ? last - 1 : last;
  const stops = canvas.stops.filter((_, index) => index !== dropped);
  const primaryIndex =
    canvas.primaryIndex > dropped ? canvas.primaryIndex - 1 : canvas.primaryIndex;
  return { ...canvas, stops: deriveHarmony(stops, primaryIndex), primaryIndex };
}

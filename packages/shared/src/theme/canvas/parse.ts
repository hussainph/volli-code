/**
 * The storage boundary: anything at all in, a canvas this package can actually
 * paint or null.
 *
 * Everything downstream of here assumes a well-formed {@link Canvas} — a stop
 * list with at least one entry, an in-range primary index, finite unit numbers —
 * and none of it re-checks. This is the one function that earns those
 * assumptions, so it is also the only place a stored payload is allowed to be
 * doubted.
 */

import { clamp, isHexColor } from "../color";
import { MAX_STOPS } from "./tuning";
import type { Canvas, CanvasStop } from "./types";

/** The canvas the app ships with: one ember pool, high on the right. */
export const DEFAULT_CANVAS: Canvas = {
  stops: [{ hex: "#e8652a", x: 0.68, y: 0.3 }],
  primaryIndex: 0,
  vibrancy: 0.6,
  grain: 0.15,
};

function isUnit(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * `#RGB`, `rrggbb`, stray whitespace → the one form everything downstream can
 * actually use: trimmed, `#`-prefixed, lowercase, six digits. Null when the input
 * is not a color at all.
 *
 * Normalizing rather than merely accepting, because {@link isHexColor} is
 * generous — it takes all of those — while the things that consume a stop's hex
 * are not. ` #E8652A ` reaches CSS as an invalid `background` (the space breaks
 * the value), an editor's `===` match against its lowercase presets fails, and a
 * readout prints it back in whatever shape it arrived. Widening the guard and
 * narrowing the output is what makes the accepted set and the paintable set the
 * same set.
 */
function normalizeHex(value: string): string | null {
  const trimmed = value.trim();
  if (!isHexColor(trimmed)) return null;
  const digits = trimmed.replace("#", "").toLowerCase();
  return `#${digits.length === 3 ? digits.replace(/./g, (digit) => digit + digit) : digits}`;
}

function parseStop(value: unknown): CanvasStop | null {
  if (typeof value !== "object" || value === null) return null;
  const { hex, x, y } = value as Record<string, unknown>;
  if (typeof hex !== "string") return null;
  const normalized = normalizeHex(hex);
  if (normalized === null) return null;
  if (!isUnit(x) || !isUnit(y)) return null;
  return { hex: normalized, x: clamp(x, 0, 1), y: clamp(y, 0, 1) };
}

/**
 * Ranges are CLAMPED and shapes are REJECTED, which is the distinction that
 * matters. A vibrancy of 4 is a stale value from an earlier tuning pass and still
 * says what the user meant; a missing `stops` array says nothing, and guessing at
 * it would silently resurrect a canvas nobody authored.
 *
 * Extra keys are IGNORED, which is the third case and the one the freeze created.
 * Every canvas stored while `lift`, `cardTint`, `surfaceSpread`, `textWeight` and
 * `shadow` were still dials carries all five, and those settings are no longer
 * the user's to state — so reading them back would resurrect a tuning pass that
 * has already been decided, and rejecting the entry would throw away the gradient
 * that was actually authored. Reading only the fields this shape still has does
 * both right things at once, and it is why the destructure below names them one
 * by one instead of spreading.
 *
 * `mode` is one of those ignored keys now. Appearance is scoped separately from
 * the canvas (see `types.ts`), so a stored canvas that names one is describing a
 * decision this type no longer carries.
 */
export function parseCanvas(value: unknown): Canvas | null {
  if (typeof value !== "object" || value === null) return null;
  const { stops, primaryIndex, vibrancy, grain } = value as Record<string, unknown>;

  if (!Array.isArray(stops) || stops.length < 1 || stops.length > MAX_STOPS) return null;
  const parsed: CanvasStop[] = [];
  for (const raw of stops) {
    const stop = parseStop(raw);
    if (stop === null) return null;
    parsed.push(stop);
  }

  if (!isUnit(primaryIndex) || !Number.isInteger(primaryIndex)) return null;
  if (primaryIndex < 0 || primaryIndex >= parsed.length) return null;
  if (!isUnit(vibrancy) || !isUnit(grain)) return null;

  return {
    stops: parsed,
    primaryIndex,
    vibrancy: clamp(vibrancy, 0, 1),
    grain: clamp(grain, 0, 1),
  };
}

/**
 * Chart colour DERIVED from the live canvas, never authored (VC-55).
 *
 * Color tokens in this app are generated from a canvas (CLAUDE.md), so a chart
 * that names its own colours is a chart that stops being themed the moment the
 * workspace is. These two functions are how a drawing takes its palette from
 * the tokens already on the document: hand them what `getComputedStyle` says
 * `--background` and `--primary` are, and they answer in the primary's own hue.
 *
 * Both are pure and hex-in/hex-out, so the DOM reading stays in the renderer
 * and the colour maths is testable here.
 */
import { hexToOklch, lerp, oklchToHex } from "./color";

/**
 * The near-zero chroma the coldest ramp step carries.
 *
 * Not zero: an exactly grey first step reads as a different material from the
 * three tinted ones above it, and the whole point of interpolating is that the
 * ramp is one substance getting stronger.
 */
const RAMP_FLOOR_CHROMA = 0.004;

/**
 * A ramp travelling from the BACKGROUND to the primary, in the primary's hue.
 *
 * Lightness has to travel, not just chroma. Draining chroma out of a mid-tone
 * primary lands on a mid grey, which on light paper is DARKER than the paper —
 * so empty days would draw heavier than busy ones, and the chart would read
 * inside out. Starting from the background is also what makes ONE ramp correct
 * in both appearances with no per-mode branch: light ramps down from paper,
 * dark ramps up from ink.
 *
 * `stops` are positions in [0, 1] along that journey; the caller owns how many
 * steps its scale has.
 */
export function rampFromBackground(
  backgroundHex: string,
  primaryHex: string,
  stops: readonly number[],
): string[] {
  const base = hexToOklch(backgroundHex);
  const tip = hexToOklch(primaryHex);
  return stops.map((t) =>
    oklchToHex(lerp(base.L, tip.L, t), lerp(RAMP_FLOOR_CHROMA, tip.C, t), tip.h),
  );
}

/**
 * `count` hues fanned symmetrically around the primary, holding its L and C.
 *
 * For a series whose members are peers — board columns, not intensities — where
 * a lightness ramp would rank them. Holding L and C keeps every member the same
 * weight, so only the hue says which is which, and the whole fan moves when the
 * canvas does.
 *
 * A one-member series is the primary itself: half of a spread has no meaning,
 * and `count - 1` would divide by zero.
 */
export function hueFan(primaryHex: string, count: number, spreadDegrees: number): string[] {
  const { L, C, h } = hexToOklch(primaryHex);
  if (count <= 1) return count < 1 ? [] : [oklchToHex(L, C, h)];
  return Array.from({ length: count }, (_, index) => {
    const offset = (index / (count - 1) - 0.5) * spreadDegrees;
    return oklchToHex(L, C, (h + offset + 360) % 360);
  });
}

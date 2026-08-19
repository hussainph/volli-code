/**
 * The vibrancy fader's WAVE — the track itself, not a line drawn across one.
 *
 * VC-57 authored this wave for the effort pill and VC-82 moved it here. The
 * first move ported the pill's GEOMETRY and nothing else: a 2px hairline at
 * `/40`, laid over a native range input that still painted its own 4px track
 * underneath. The peaks landed exactly on that track's edges, so the wave could
 * never rise above the bar it was drawn on — arithmetically correct, and it
 * read as a scribble over an ordinary slider, because that is what the DOM
 * said it was.
 *
 * SO THE WAVE IS THE TRACK NOW. `globals.css` suppresses the native paint for
 * this one input (nothing else changes: the thumb still travels the same box,
 * click-to-jump and the keyboard and the focus ring all stay), and the editor
 * draws the groove itself — the whole wave in the unfilled ink, the filled
 * share over it clipped at the seam, and a capsule thumb centred on that same
 * seam. Numbers re-derived for a 176px fader rather than inherited from a 28px
 * pill: ~5.5 cycles instead of ~15, a 5px peak instead of 2px inside a 4px
 * stripe.
 *
 * The arithmetic is pure so the coverage gate can hold it at 100%.
 */

/** One full wave, in px — ~5.5 cycles across the fader. */
export const SLIDER_SQUIGGLE_WAVELENGTH = 32;

/** The wave's peak, in px from its centreline, at full vibrancy. */
export const SLIDER_SQUIGGLE_AMPLITUDE = 5;

/**
 * The fader's width — `w-44` on the input, the one place its geometry is
 * authored — which lets the path be baked once per render instead of measured.
 */
export const SLIDER_SQUIGGLE_WIDTH = 176;

/**
 * The capsule thumb's width, which is also its travel inset at either end.
 *
 * It matches the native thumb this draws over (14px in `globals.css`), so the
 * capsule sits exactly where the pointer grabbed and neither end of the travel
 * hangs the thumb out of the trough.
 */
export const SLIDER_THUMB_WIDTH = 14;

/**
 * The amplitude floor, as a share of the peak.
 *
 * The wave never lies fully flat. A flat track at 0 vibrancy would change what
 * the control IS at the bottom of its range — the shape of the thing under your
 * hand should not become a different shape as you drag it — and a wave that
 * vanishes for the lower third of the range reports nothing there anyway. The
 * value is carried by the fill and the thumb; the amplitude is the redundant
 * channel that makes "vibrancy" legible as agitation, so it RAMPS from a
 * resting ripple to a full wave rather than switching on partway up.
 */
export const SLIDER_SQUIGGLE_FLOOR = 0.28;

/**
 * The wave's geometry: a wave along `y = 0`, one SVG path string.
 *
 * Alternating quadratic half-waves — an explicit `Q` for the first and `T`
 * (smooth-quadratic, which reflects the previous control point) for the rest —
 * so the whole wave after the opening segment is one coordinate per half-wave
 * and cannot kink. The control point sits at `2 × amplitude` because a
 * quadratic's midpoint takes half its control's offset: that is what makes
 * `amplitude` the PEAK rather than a number near it.
 *
 * The wave runs to the first half-wave boundary AT or past `width` rather than
 * stopping short: the trough clips the overshoot, so overshooting costs nothing
 * and undershooting would leave the far end of the groove bare. Degenerate
 * inputs (a zero width, a zero wavelength) return the empty path rather than
 * dividing by themselves.
 */
export function sliderSquigglePath(width: number, wavelength: number, amplitude: number): string {
  if (width <= 0 || wavelength <= 0) return "";
  const half = wavelength / 2;
  const crest = amplitude * 2;
  const segments = Math.max(1, Math.ceil(width / half));
  const parts = [`M 0 0 Q ${half / 2} ${crest} ${half} 0`];
  for (let at = 2; at <= segments; at += 1) parts.push(`T ${at * half} 0`);
  return parts.join(" ");
}

/**
 * How much of the wave is standing at a given vibrancy: the floor at 0, full
 * at 1. Drawn as a `scaleY` on the path rather than a regenerated `d`, because
 * a transform interpolates between two amplitudes and a path string snaps.
 */
export function sliderSquiggleScale(value: number): number {
  const unit = Math.min(1, Math.max(0, value));
  return SLIDER_SQUIGGLE_FLOOR + (1 - SLIDER_SQUIGGLE_FLOOR) * unit;
}

/**
 * Where the filled share ends, in px from the fader's left edge.
 *
 * The thumb's centre and the fill's seam are the SAME x — one object, not two
 * that nearly agree — so both read it from here. The travel is inset by half a
 * thumb at each end, which is what the native control does under the paint;
 * clipping at a flat percentage instead would drift from the thumb by up to
 * half its width at the extremes, and the seam would visibly miss the capsule.
 */
export function sliderSeam(value: number, width: number, thumb: number): number {
  const unit = Math.min(1, Math.max(0, value));
  return thumb / 2 + unit * Math.max(0, width - thumb);
}

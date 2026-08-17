/**
 * The canvas editor's SQUIGGLE — the Arc-lineage wave, in the home it was
 * always headed for.
 *
 * VC-57 authored the wave as "the Arc-lineage wave the vibrancy pass (VC-26)
 * was always headed for", then mounted it on the effort slider for one ticket;
 * VC-82 took it back out of the shipped control at the owner's call. This is
 * the same geometry, on the surface the lineage named: the VIBRANCY slider,
 * where amplitude-as-value needs no notched track to justify itself — the
 * control is continuous, so the wave stands taller with every point of
 * vibrancy, flat at 0 (clipped away with the empty fill) to full wave at 100.
 * The design's specimen, exactly as it shipped in the effort pill, is kept
 * alive in `lab/scratches/effort-squiggle.tsx`; the arithmetic below is the
 * same module re-homed, and it is pure so the gate can hold it at 100%.
 */

/** One full wave of the squiggle, in px (VC-57, the Arc-lineage wave). */
export const SLIDER_SQUIGGLE_WAVELENGTH = 12;

/** The wave's peak, in px from its centreline, at full vibrancy. */
export const SLIDER_SQUIGGLE_AMPLITUDE = 2;

/**
 * The vibrancy slider's own width — `w-44` on `UnitSlider`'s input, the one
 * place the control's geometry is authored — which lets the path be baked once
 * per render instead of measured.
 */
export const SLIDER_SQUIGGLE_WIDTH = 176;

/**
 * The squiggle's geometry: a wave along `y = 0`, one SVG path string.
 *
 * Alternating quadratic half-waves — an explicit `Q` for the first and `T`
 * (smooth-quadratic, which reflects the previous control point) for the rest —
 * so the whole wave after the opening segment is one coordinate per half-wave
 * and cannot kink. The control point sits at `2 × amplitude` because a
 * quadratic's midpoint takes half its control's offset: that is what makes
 * `amplitude` the PEAK rather than a number near it.
 *
 * The wave runs to the first half-wave boundary AT or past `width` rather than
 * stopping short: the drawer clips it at the fill's seam, so overshooting
 * costs nothing and undershooting would leave the last share bare. Degenerate
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

/** The wave's amplitude at a given vibrancy: 0 flat, 1 full. */
export function sliderSquiggleScale(value: number): number {
  return Math.min(1, Math.max(0, value));
}

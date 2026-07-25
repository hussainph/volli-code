/**
 * Grain: the film-noise texture a theme carries as `ThemeDefinition.grain`
 * (docs/plans/theming-engine.md § Grain).
 *
 * This module owns the one number the overlay needs — how opaque the noise
 * tile paints — and nothing else. The element itself lives in
 * `grain-overlay.tsx`; the tile is a committed, build-time-rasterized PNG
 * (`scripts/generate-grain.mjs`).
 */

/**
 * The usable overlay-opacity window. Below the floor the texture is invisible
 * on a near-black ladder; above the ceiling it reads as dirt rather than
 * grain, and starts to matter for the surfaces' measured contrast.
 *
 * *Measured, so it is a known tradeoff rather than an oversight:* the tile is
 * mid-grey noise composited normally, so it lifts the surface underneath it by
 * `opacity × (127.5 − surface)` — 2.4 of 255 on `--background` at 0.022, and
 * 3.9 at the 0.035 ceiling. Read back through `apca-w3` that costs **0.15 Lc**
 * for every foreground on the card (`--muted-foreground` 60.01 → 59.86,
 * `--foreground` 90.17 → 90.02).
 *
 * **That measurement is real and it is not the one that mattered.** Dogfooding
 * the layer made the app harder to read at an intensity 0.15 Lc cannot explain,
 * because the mean lift is the wrong statistic: what costs legibility is the
 * **variance**. Noise puts per-pixel luminance jitter in every counter and
 * sidebearing of every glyph, and an antialiased edge resolved against a field
 * that changes pixel to pixel reads as softer than the same edge on a flat
 * surface. "Never above text" (§ Grain) turned out not to be far enough below
 * it. So every shipped theme now carries `grain: 0` (see `DEFAULT_THEME`) and
 * this window only describes what the slider reaches when someone asks for it.
 *
 * The lesson generalizes to PR 5's canvas: texture belongs behind the framed
 * card (#31), not under the body copy inside it.
 */
export const GRAIN_MIN_OPACITY = 0.015;
export const GRAIN_MAX_OPACITY = 0.035;

/**
 * The tile's edge, in CSS pixels — pinned rather than left to the image's
 * intrinsic size so the texture reads the same on 1x and 2x displays. Mirrors
 * `GRAIN_TILE_PX` in `scripts/generate-grain.mjs`, which is the authority on
 * the raster itself.
 */
export const GRAIN_TILE_PX = 128;

/**
 * Maps a theme's authored `grain` (0–1) onto that window — the multiplier
 * across it, so a grain of 0.35 lands at 0.022.
 *
 * Zero is not the bottom of the window, it is OFF: it returns 0 so the caller
 * renders no layer at all. A grain of 0 means "I don't want this", and the
 * cheapest honest answer to that is an element that does not exist.
 */
export function grainOpacity(grain: number): number {
  if (grain <= 0) return 0;
  const multiplier = Math.min(grain, 1);
  return GRAIN_MIN_OPACITY + (GRAIN_MAX_OPACITY - GRAIN_MIN_OPACITY) * multiplier;
}

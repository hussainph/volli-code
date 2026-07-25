import grainTileUrl from "@renderer/assets/grain-128.png";
import { GRAIN_TILE_PX, grainOpacity } from "@renderer/theme/grain";

/**
 * The app surface's film-noise layer (docs/plans/theming-engine.md § Grain).
 *
 * One element, mounted once on the backdrop the framed content card floats on
 * (see `components/app-shell.tsx`). Everything about it is defensive:
 *
 *  - `z-index: -1` — it paints after the backdrop's own background and before
 *    every in-flow sibling, so it is *structurally* incapable of landing above
 *    text. Noise interacting with subpixel/greyscale AA makes body copy
 *    shimmer, and the opaque sidebar and content card sit above it, which is
 *    also why the terminal canvas and Monaco are never textured.
 *  - `contain: strict` + `will-change: transform` — the tile becomes its own
 *    compositor layer, so nothing that scrolls above it re-rasterizes it.
 *    (`contain: size` is safe here: an inset-0 absolutely positioned box takes
 *    its size from its insets, never from its contents.)
 *  - `pointer-events: none` + `aria-hidden` — a full-surface element that
 *    swallowed a click or announced itself would be a bug in every direction.
 *
 * The styles are inline rather than a CSS file on purpose: the tile's URL is
 * content-hashed by the bundler, the opacity is derived per theme, and the
 * three defensive rules above read as one contract in one place instead of
 * being separable from the element that depends on them.
 */
export function GrainOverlay({ grain }: { grain: number }) {
  const opacity = grainOpacity(grain);
  // Grain 0 is OFF: no element at all, rather than a transparent one that
  // still costs a promoted layer.
  if (opacity === 0) return null;
  return (
    <div
      aria-hidden="true"
      data-volli-grain=""
      style={{
        position: "absolute",
        inset: 0,
        zIndex: -1,
        pointerEvents: "none",
        contain: "strict",
        willChange: "transform",
        backgroundImage: `url(${grainTileUrl})`,
        backgroundRepeat: "repeat",
        backgroundSize: `${GRAIN_TILE_PX}px ${GRAIN_TILE_PX}px`,
        opacity,
      }}
    />
  );
}

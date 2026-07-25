import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { GrainOverlay } from "./grain-overlay";
import { GRAIN_TILE_PX } from "./grain";

/** The rendered overlay's inline `opacity`, or null when nothing rendered. */
function renderedOpacity(grain: number): number | null {
  const html = renderToStaticMarkup(<GrainOverlay grain={grain} />);
  const match = /opacity:([0-9.]+)/.exec(html);
  return match === null ? null : Number(match[1]);
}

describe("GrainOverlay", () => {
  it("paints at an opacity that tracks the theme's grain", () => {
    const subtle = renderedOpacity(0.2);
    const heavy = renderedOpacity(0.9);

    expect(subtle).not.toBeNull();
    expect(heavy).not.toBeNull();
    expect(heavy!).toBeGreaterThan(subtle!);
  });

  it("renders NOTHING at grain 0 — not a transparent layer", () => {
    // A zero-opacity div is still a promoted compositor layer and still a hit
    // -testing participant; "off" has to mean absent.
    expect(renderToStaticMarkup(<GrainOverlay grain={0} />)).toBe("");
  });

  it("can never stack above text — it paints behind everything in its layer", () => {
    // The rule from § Grain: noise over subpixel/greyscale AA makes body copy
    // shimmer. A negative z-index makes that structurally impossible rather
    // than a matter of where the element happens to be mounted: inside its
    // stacking context it paints after the backdrop's own background and
    // BEFORE every in-flow sibling, text included.
    expect(renderToStaticMarkup(<GrainOverlay grain={0.35} />)).toContain("z-index:-1");
  });

  it("is inert to the pointer and to assistive tech, and is its own compositor layer", () => {
    const html = renderToStaticMarkup(<GrainOverlay grain={0.35} />);

    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain("pointer-events:none");
    // contain:strict + will-change:transform promote the tile to a layer of
    // its own, so scrolling the surfaces above it never re-rasterizes it.
    expect(html).toContain("contain:strict");
    expect(html).toContain("will-change:transform");
  });

  it("paints a tiled raster of the bundled noise asset, never a live filter", () => {
    const html = renderToStaticMarkup(<GrainOverlay grain={0.35} />);

    // A rasterized tile the bundler owns — an SVG feTurbulence filter over a
    // window-sized element re-runs on the compositor forever.
    expect(html).toMatch(/background-image:url\([^)]*grain[^)]*\)/);
    expect(html).toContain("background-repeat:repeat");
    // Pinned in CSS pixels so the texture reads identically on 1x and 2x.
    expect(html).toContain(`background-size:${GRAIN_TILE_PX}px ${GRAIN_TILE_PX}px`);
  });
});

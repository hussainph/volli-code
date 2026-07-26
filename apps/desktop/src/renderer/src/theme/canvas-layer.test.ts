import { describe, expect, it } from "vite-plus/test";
import { DEFAULT_THEME, deriveCanvasStops, type ThemeDefinition } from "@volli/shared";

import { CANVAS_SOLID_FILL, canvasBackground, nextCanvasLayers } from "./canvas-layer";

const STOPS = deriveCanvasStops({ seed: DEFAULT_THEME.seed, kind: "gradient" });

const GRADIENT: ThemeDefinition = {
  ...DEFAULT_THEME,
  canvas: { kind: "gradient", stops: STOPS },
};

describe("canvasBackground", () => {
  it("paints solid as the exact fill the backdrop painted before the layer existed", () => {
    // The safety property: until someone picks a gradient, this PR changes no
    // pixel. Everything else about it rests on that being literally true.
    expect(canvasBackground(DEFAULT_THEME)).toBe(CANVAS_SOLID_FILL);
    expect(CANVAS_SOLID_FILL).toBe("var(--rail)");
  });

  it("paints a gradient from the theme's own stops", () => {
    const background = canvasBackground(GRADIENT);

    expect(background).toContain("linear-gradient(180deg");
    for (const stop of STOPS) expect(background).toContain(stop);
  });
});

describe("nextCanvasLayers", () => {
  const solid: CanvasLayersFixture = { current: CANVAS_SOLID_FILL, outgoing: null };

  it("crossfades on a scope change, keeping the old canvas to fade out over", () => {
    const next = nextCanvasLayers(solid, canvasBackground(GRADIENT), true);

    expect(next.current).toBe(canvasBackground(GRADIENT));
    expect(next.outgoing).toBe(CANVAS_SOLID_FILL);
  });

  it("cuts straight to the new canvas everywhere else", () => {
    // Picking a Background, or arrowing through the list: instant IS the
    // correct feedback, and an ease here would be latency chasing the cursor.
    const next = nextCanvasLayers(solid, canvasBackground(GRADIENT), false);

    expect(next.current).toBe(canvasBackground(GRADIENT));
    expect(next.outgoing).toBeNull();
  });

  it("does not restart a running fade when the canvas has not moved", () => {
    // Re-rendering mid-fade must not re-arm it, or a burst of unrelated store
    // updates during a project switch would hold the old canvas on screen.
    const fading = { current: canvasBackground(GRADIENT), outgoing: CANVAS_SOLID_FILL };

    expect(nextCanvasLayers(fading, canvasBackground(GRADIENT), true)).toBe(fading);
  });
});

/** Local alias so the fixture reads without importing the type for one line. */
type CanvasLayersFixture = { current: string; outgoing: string | null };

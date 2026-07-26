import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import { DEFAULT_THEME, deriveCanvasStops } from "@volli/shared";

import { canvasBackground, CANVAS_SOLID_FILL } from "./canvas-layer";
import { ThemeCanvas } from "./theme-canvas";

const GRADIENT = canvasBackground({
  ...DEFAULT_THEME,
  canvas: {
    kind: "gradient",
    stops: deriveCanvasStops({ seed: DEFAULT_THEME.seed, kind: "mesh" }),
  },
});

describe("ThemeCanvas", () => {
  it("paints the flat rail fill for a solid canvas — today's backdrop, exactly", () => {
    expect(renderToStaticMarkup(<ThemeCanvas background={CANVAS_SOLID_FILL} />)).toContain(
      "background:var(--rail)",
    );
  });

  it("can never stack above anything the app draws", () => {
    // Same structural guarantee grain leans on: inside its stacking context a
    // z-index:-1 child paints after the host's own background and BEFORE every
    // in-flow sibling. The sidebar's nav text is drawn directly on this layer,
    // so "below everything" has to be a property of the element rather than of
    // where it happens to be mounted.
    expect(renderToStaticMarkup(<ThemeCanvas background={GRADIENT} />)).toContain("z-index:-1");
  });

  it("is inert to the pointer, to assistive tech, and to layout", () => {
    const html = renderToStaticMarkup(<ThemeCanvas background={GRADIENT} />);

    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain("pointer-events:none");
    // contain:strict keeps a window-sized gradient out of every layout and
    // paint invalidation above it. Safe here because an inset-0 absolutely
    // positioned box takes its size from its insets, never from its contents.
    expect(html).toContain("contain:strict");
  });

  it("holds no content of its own — it is a surface, not a container", () => {
    // Anything with text in it would be text drawn at z-index:-1, which is a
    // bug in every direction: unreachable, unselectable, and under the app.
    const html = renderToStaticMarkup(<ThemeCanvas background={GRADIENT} />);

    expect(html.replaceAll(/<[^>]*>/g, "")).toBe("");
  });

  it("paints one layer at rest — the second exists only while a scope fades", () => {
    // A permanently stacked pair would be a second window-sized composited
    // layer for nothing.
    const html = renderToStaticMarkup(<ThemeCanvas background={GRADIENT} />);

    expect(html.match(/<div/g)).toHaveLength(2);
    expect(html).toContain("linear-gradient(180deg");
  });
});

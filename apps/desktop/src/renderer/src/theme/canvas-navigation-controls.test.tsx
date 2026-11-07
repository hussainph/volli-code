// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import { compile } from "tailwindcss";
import {
  DEFAULT_CANVAS,
  compositeHex,
  effectiveStopHexes,
  hexToOklch,
  regularGlassBackdrop,
  wcagContrast,
} from "@volli/shared";
import { Button } from "@renderer/components/ui/button";
import { GlassSurface, PaperSurface } from "@renderer/components/ui/surface";
import { Sidebar, SidebarProvider } from "@renderer/components/ui/sidebar";
import { RAIL_FOOTER } from "@renderer/components/ticket/rail-panel-parts";
import { deriveCanvasPaint, type CanvasTokenName } from "./canvas-paint";

const css = readFileSync(resolve(import.meta.dirname, "../globals.css"), "utf8").replace(
  /\/\*[\s\S]*?\*\//g,
  "",
);
const navigationRule =
  /(:is\(\[data-volli-sidebar\]\.glass,\s*\[data-volli-rail\]\.glass\)[^{]*\[data-variant="outline"\][^{]*)\{([^}]+)\}/.exec(
    css,
  )!;
const navigationSelector = navigationRule[1].trim();
const sharedSelector = '[data-control="button"].control-material:active:not(:disabled)';
const rule = (selector: string) => {
  const start = css.indexOf(`${selector} {`);
  expect(start).toBeGreaterThanOrEqual(0);
  return css.slice(start, css.indexOf("}", start));
};
const imageToken = (body: string) => {
  const match = /background-image:\s*linear-gradient\(\s*var\((--[\w-]+)\),\s*var\(\1\)\s*\)/.exec(
    body,
  );
  expect(match).not.toBeNull();
  return match![1] as CanvasTokenName;
};
const stateSelector = (selector: string) =>
  selector.replaceAll(":active", '[data-test-active="true"]');

// Check the source rule's layer, not just its declarations: a desired utility
// cannot beat an unlayered material rule. Ignore quoted braces in CSS values.
function braceDepthBefore(index: number): number {
  let depth = 0;
  let quote = "";
  for (let i = 0; i < index; i++) {
    const char = css[i];
    if (quote) {
      if (char === "\\") i++;
      else if (char === quote) quote = "";
    } else if (char === '"' || char === "'") quote = char;
    else if (char === "{") depth++;
    else if (char === "}") depth--;
  }
  return depth;
}

function inScope(scope: string, button: ReactNode): ReactNode {
  if (scope === "sidebar") return <GlassSurface data-volli-sidebar>{button}</GlassSurface>;
  if (scope === "rail") return <GlassSurface data-volli-rail>{button}</GlassSurface>;
  if (scope === "footer")
    return (
      <GlassSurface data-volli-rail>
        <section className={RAIL_FOOTER}>{button}</section>
      </GlassSurface>
    );
  if (scope === "inspector-pane") return <GlassSurface data-inspector-panel>{button}</GlassSurface>;
  if (scope === "paper") return <PaperSurface>{button}</PaperSurface>;
  if (scope === "nested-paper")
    return (
      <GlassSurface data-volli-rail>
        <PaperSurface>{button}</PaperSurface>
      </GlassSurface>
    );
  if (scope === "portal") return <GlassSurface data-slot="popover-content">{button}</GlassSurface>;
  if (scope === "nested-popover")
    return (
      <GlassSurface data-volli-rail>
        <GlassSurface data-slot="popover-content">{button}</GlassSurface>
      </GlassSurface>
    );
  return (
    <SidebarProvider>
      <Sidebar collapsible="none" className="bg-transparent">
        {button}
      </Sidebar>
    </SidebarProvider>
  );
}

function emittedOver(fill: string, backdrop: string): string {
  if (fill.startsWith("#")) return fill;
  const rgba = /^rgb\((\d+) (\d+) (\d+) \/ ([\d.]+)\)$/.exec(fill)!;
  expect(rgba).not.toBeNull();
  const hex = `#${rgba
    .slice(1, 4)
    .map((value) => Number(value).toString(16).padStart(2, "0"))
    .join("")}`;
  return compositeHex(hex, Number(rgba[4]), backdrop);
}

describe("navigation outline pressed material", () => {
  it.each([
    ["sidebar", "outline", false, true],
    ["rail", "outline", false, true],
    ["footer", "outline", false, true],
    ["inspector-pane", "outline", false, false],
    ["paper", "outline", false, false],
    ["nested-paper", "outline", false, false],
    ["portal", "outline", false, false],
    ["nested-popover", "outline", false, false],
    ["bare-sidebar", "outline", false, false],
    ["sidebar", "inspector", false, false],
    ["rail", "secondary", false, false],
    ["rail", "toolbar", false, false],
    ["rail", "outline", true, false],
  ] as const)(
    "%s / %s / disabled=%s scopes the effective pressed image",
    (scope, variant, disabled, optical) => {
      const host = document.createElement("div");
      host.innerHTML = renderToStaticMarkup(
        inScope(
          scope,
          <Button variant={variant} disabled={disabled}>
            Action
          </Button>,
        ),
      );
      const button = host.querySelector("button")!;
      for (const hover of [false, true]) {
        button.toggleAttribute("data-test-hover", hover);
        button.setAttribute("data-test-active", "false");
        expect(button.matches(stateSelector(navigationSelector))).toBe(false);
        button.setAttribute("data-test-active", "true");
        expect(button.matches(stateSelector(navigationSelector))).toBe(optical);
        if (optical) {
          expect(button.matches(stateSelector(sharedSelector))).toBe(true);
          expect(imageToken(navigationRule[2])).toBe("--glass-outline-pressed");
        } else if (button.matches(stateSelector(sharedSelector))) {
          expect(imageToken(rule(sharedSelector))).toBe("--fill-secondary");
        }
      }
    },
  );

  it("keeps the shared face and ring while the unlayered scoped image wins hover+press", async () => {
    const restingSelector =
      '[data-control="button"]:is([data-variant="outline"], [data-variant="secondary"])';
    expect(braceDepthBefore(css.indexOf(restingSelector))).toBe(0);
    expect(braceDepthBefore(navigationRule.index)).toBe(0);
    expect(rule(restingSelector)).toContain("background-color: var(--control-face)");
    expect(navigationRule.index).toBeGreaterThan(css.indexOf(sharedSelector));
    // The scoped rule owns only an image, never a border, shadow, geometry or ink.
    expect(navigationRule[2].replace(/\s/g, "")).toBe(
      "background-image:linear-gradient(var(--glass-outline-pressed),var(--glass-outline-pressed));",
    );
    expect(rule('[data-control="button"].control-material')).toContain(
      "var(--tw-ring-shadow, 0 0 transparent)",
    );
    const html = renderToStaticMarkup(<Button variant="outline">Action</Button>);
    for (const utility of [
      "hover:bg-accent",
      "focus-visible:ring-ring",
      "focus-visible:ring-offset-background",
    ])
      expect(html).toContain(utility);
    const theme = /--color-accent:[^;]+;/.exec(css)![0];
    const hoverCss = (
      await compile(`@theme inline { ${theme} } @layer utilities { @tailwind utilities; }`)
    ).build(["hover:bg-accent"]);
    expect(hoverCss).toContain("@layer utilities");
    expect(hoverCss).toContain("background-color: var(--accent)");
  });

  it.each(["text", "focus"] as const)(
    "retains %s floors on the emitted resting/hover/pressed/hover+pressed states",
    (role) => {
      const poles = new Set<boolean>();
      const pressedToken = imageToken(navigationRule[2]);
      for (const mode of ["light", "dark"] as const) {
        for (const seed of [
          "#00ff00",
          "#ef8a4b",
          "#2a7de8",
          "#f8f0d8",
          "#e6f6ff",
          "#f5eaff",
          "#ffffff",
          "#000000",
          "#18b6a4",
          "#ffff00",
          "#00ac4f",
          "#00a97a",
          "#00a692",
          "#00a4a4",
          "#00a1b5",
          "#009ec7",
        ]) {
          for (const vibrancy of [0, 0.6, 1]) {
            for (const primaryIndex of [0, 1, 2]) {
              const canvas = {
                ...DEFAULT_CANVAS,
                vibrancy,
                primaryIndex,
                stops: [
                  { hex: seed, x: 0, y: 1 },
                  { hex: "#ffffff", x: 1, y: 0 },
                  { hex: "#000000", x: 0.5, y: 0.5 },
                ],
              };
              const { tokens: t, canvasTokens: c } = deriveCanvasPaint(canvas, mode);
              const lightInk = hexToOklch(c["--glass-ink"]).L > 0.5;
              poles.add(lightInk);
              expect(c[pressedToken]).toBe(
                lightInk ? "rgb(0 0 0 / 0.078)" : "rgb(255 255 255 / 0.078)",
              );
              for (const peak of effectiveStopHexes(canvas, mode)) {
                const glass = emittedOver(c["--glass-pane-veil"], regularGlassBackdrop(peak, mode));
                expect(RAIL_FOOTER).toContain("bg-popover/30");
                for (const backing of [glass, compositeHex(t["--popover"], 0.3, glass)]) {
                  const control = emittedOver(c["--control-face"], backing);
                  for (const hover of [false, true]) {
                    for (const pressed of [false, true]) {
                      // Unlayered background-color wins over hover:bg-accent, and
                      // the scoped active image wins over the shared paper press.
                      const face = pressed ? emittedOver(c[pressedToken], control) : control;
                      const context = `${mode}/${seed}/v${vibrancy}/primary${primaryIndex}/backing${backing}/hover${hover}/pressed${pressed}/${face}`;
                      if (role === "text")
                        expect(
                          wcagContrast(c["--glass-ink"], face),
                          `${context}/ink${c["--glass-ink"]}`,
                        ).toBeGreaterThanOrEqual(4.5);
                      // The real two-pixel ring offset is background, so its ring
                      // touches that offset and the pane/footer, not the control fill.
                      if (role === "focus")
                        for (const adjacent of [t["--background"], backing]) {
                          expect(
                            wcagContrast(t["--ring"], adjacent),
                            `${context}/focus${t["--ring"]}/adjacent${adjacent}`,
                          ).toBeGreaterThanOrEqual(3);
                        }
                    }
                  }
                }
              }
            }
          }
        }
      }
      expect(poles).toEqual(new Set([false, true]));
    },
  );
});

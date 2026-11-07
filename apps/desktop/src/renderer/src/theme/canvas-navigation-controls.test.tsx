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
const writingRestRule =
  /(\[data-slot="popover-content"\]\s*\[data-control="button"\]:is\(\s*\[data-variant="outline"\],\s*\[data-variant="secondary"\]\s*\):not\(\s*\[data-material="paper"\] \*\s*\))\s*\{([^}]+)\}/.exec(
    css,
  )!;
const writingPressedRule =
  /(\[data-slot="popover-content"\]\s*\[data-control="button"\]:is\(\s*\[data-variant="outline"\],\s*\[data-variant="secondary"\]\s*\)\.control-material:active[^{]*)\{([^}]+)\}/.exec(
    css,
  )!;
const writingRestSelector = writingRestRule[1].trim();
const writingPressedSelector = writingPressedRule[1].trim();
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
      // Neither pressed selector names :hover, so hover cannot change which
      // pressed image applies; only the active state is substituted here.
      for (const selector of [navigationSelector, sharedSelector, writingPressedSelector])
        expect(selector).not.toContain(":hover");
      // Writing popovers own outline/secondary presses inside a popover only.
      const writing =
        (scope === "portal" || scope === "nested-popover") &&
        (variant === "outline" || variant === "secondary") &&
        !disabled;
      button.setAttribute("data-test-active", "false");
      expect(button.matches(stateSelector(navigationSelector))).toBe(false);
      expect(button.matches(stateSelector(writingPressedSelector))).toBe(false);
      button.setAttribute("data-test-active", "true");
      expect(button.matches(stateSelector(navigationSelector))).toBe(optical);
      expect(button.matches(stateSelector(writingPressedSelector))).toBe(writing);
      if (optical) {
        expect(button.matches(stateSelector(sharedSelector))).toBe(true);
        expect(imageToken(navigationRule[2])).toBe("--glass-outline-pressed");
      } else if (writing) {
        // Later and more specific than the shared press: its image wins.
        expect(button.matches(stateSelector(sharedSelector))).toBe(true);
        expect(imageToken(writingPressedRule[2])).toBe("--writing-control-pressed");
      } else if (button.matches(stateSelector(sharedSelector))) {
        expect(imageToken(rule(sharedSelector))).toBe("--fill-secondary");
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

  const seeds = [
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
  ];
  const canvases = () =>
    seeds.flatMap((seed) =>
      [0, 0.6, 1].flatMap((vibrancy) =>
        [0, 1, 2].map((primaryIndex) => ({
          seed,
          vibrancy,
          primaryIndex,
          canvas: {
            ...DEFAULT_CANVAS,
            vibrancy,
            primaryIndex,
            stops: [
              { hex: seed, x: 0, y: 1 },
              { hex: "#ffffff", x: 1, y: 0 },
              { hex: "#000000", x: 0.5, y: 0.5 },
            ],
          },
        })),
      ),
    );

  // Hover leaves the face alone: the unlayered `--control-face` background
  // beats the layered hover:bg-accent utility (the cascade test above), and no
  // pressed selector names :hover. So resting and pressed are the two faces.
  it("retains text floors on the emitted resting and pressed faces", () => {
    const poles = new Set<boolean>();
    const pressedToken = imageToken(navigationRule[2]);
    for (const mode of ["light", "dark"] as const) {
      for (const { seed, vibrancy, primaryIndex, canvas } of canvases()) {
        const { tokens: t, canvasTokens: c } = deriveCanvasPaint(canvas, mode);
        const lightInk = hexToOklch(c["--glass-ink"]).L > 0.5;
        poles.add(lightInk);
        expect(c[pressedToken]).toBe(lightInk ? "rgb(0 0 0 / 0.078)" : "rgb(255 255 255 / 0.078)");
        for (const peak of effectiveStopHexes(canvas, mode)) {
          const glass = emittedOver(c["--glass-pane-veil"], regularGlassBackdrop(peak, mode));
          expect(RAIL_FOOTER).toContain("bg-popover/30");
          for (const backing of [glass, compositeHex(t["--popover"], 0.3, glass)]) {
            const control = emittedOver(c["--control-face"], backing);
            for (const [state, face] of [
              ["rest", control],
              ["pressed", emittedOver(c[pressedToken], control)],
            ] as const) {
              expect(
                wcagContrast(c["--glass-ink"], face),
                `${mode}/${seed}/v${vibrancy}/primary${primaryIndex}/backing${backing}/${state}/${face}/ink${c["--glass-ink"]}`,
              ).toBeGreaterThanOrEqual(4.5);
            }
          }
        }
      }
    }
    expect(poles).toEqual(new Set([false, true]));
  });

  // One painted ring for every place it draws. Its two-pixel offset is
  // --background; around that sit paper, the under-page, the accent and editor
  // selections, writing glass over any content, navigation glass and the rail
  // footer wash. Backings are rebuilt from emitted tokens, not the solver's list.
  it("paints one focus ring that clears reading, writing and navigation backings", () => {
    const corners = [
      "#000000",
      "#ffffff",
      "#ff0000",
      "#00ff00",
      "#0000ff",
      "#ffff00",
      "#00ffff",
      "#ff00ff",
    ];
    for (const mode of ["light", "dark"] as const) {
      for (const { seed, vibrancy, primaryIndex, canvas } of canvases()) {
        const { tokens: t, canvasTokens: c } = deriveCanvasPaint(canvas, mode);
        const navigation = effectiveStopHexes(canvas, mode).flatMap((peak) => {
          const glass = emittedOver(c["--glass-pane-veil"], regularGlassBackdrop(peak, mode));
          return [
            ["navigation", glass],
            ["rail-footer", compositeHex(t["--popover"], 0.3, glass)],
          ] as const;
        });
        for (const [role, backing] of [
          ["offset", t["--background"]],
          ["under-page", t["--muted"]],
          ["accent-selection", compositeHex(seed, 0.18, t["--background"])],
          ["editor-selection", compositeHex(c["--wash-ink"], 0.22, t["--background"])],
          ...corners.map(
            (corner) =>
              [
                `writing-glass${corner}`,
                emittedOver(c["--glass-veil"], regularGlassBackdrop(corner, mode)),
              ] as const,
          ),
          ...navigation,
        ] as const) {
          expect(
            wcagContrast(t["--ring"], backing),
            `${mode}/${seed}/v${vibrancy}/primary${primaryIndex}/${role}/${backing}/ring${t["--ring"]}`,
          ).toBeGreaterThanOrEqual(3);
        }
      }
    }
  });
});

// Outline and secondary Buttons inside a writing popover take the writing
// control face and press from their unlayered scoped rules, stacked press OVER
// face OVER the popover's writing glass over any content.
const source = (path: string) => readFileSync(resolve(import.meta.dirname, path), "utf8");
const popoverBlock = (text: string, label: string) => {
  const at = text.indexOf(label);
  expect(at).toBeGreaterThanOrEqual(0);
  const open = text.lastIndexOf("<PopoverContent", at);
  const close = text.indexOf("</PopoverContent>", at);
  expect(open).toBeGreaterThanOrEqual(0);
  expect(text.slice(open, at)).not.toContain("</PopoverContent>");
  return text.slice(open, close);
};

describe("writing-popover outline and secondary controls", () => {
  it("binds the real popover callers to the outline variant", () => {
    const retry = popoverBlock(
      source("../components/sidebar/update-button.tsx"),
      "Retry update check",
    );
    expect(retry).toContain('variant="outline"');
    // Retry sits in an error Notice: its backing is that notice's tint.
    expect(retry).toContain('tone="error"');
    expect(source("../components/ui/notice.tsx")).toContain(
      'error: "border-destructive/30 bg-destructive/10 text-destructive"',
    );
    const signOut = popoverBlock(
      source("../components/rail/cloud-rail.tsx"),
      "Sign out to open them",
    );
    expect(signOut).toContain('variant="outline"');
  });

  it.each(["portal", "nested-popover"] as const)(
    "%s outline/secondary take the writing face and press, not shared or navigation's",
    (scope) => {
      for (const variant of ["outline", "secondary"] as const) {
        const host = document.createElement("div");
        host.innerHTML = renderToStaticMarkup(
          inScope(scope, <Button variant={variant}>Action</Button>),
        );
        const button = host.querySelector("button")!;
        expect(
          button.matches(
            '[data-control="button"]:is([data-variant="outline"], [data-variant="secondary"])',
          ),
        ).toBe(true);
        expect(button.matches(writingRestSelector)).toBe(true);
        button.setAttribute("data-test-active", "true");
        expect(button.matches(stateSelector(sharedSelector))).toBe(true);
        expect(button.matches(stateSelector(writingPressedSelector))).toBe(true);
        expect(button.matches(stateSelector(navigationSelector))).toBe(false);
        // A paper descendant keeps the shared face and press.
        const paper = document.createElement("div");
        paper.innerHTML = renderToStaticMarkup(
          inScope(
            scope,
            <PaperSurface>
              <Button variant={variant}>Action</Button>
            </PaperSurface>,
          ),
        );
        const onPaper = paper.querySelector("button")!;
        onPaper.setAttribute("data-test-active", "true");
        expect(onPaper.matches(writingRestSelector)).toBe(false);
        expect(onPaper.matches(stateSelector(writingPressedSelector))).toBe(false);
      }
      // Unlayered, after the shared face and press, with the writing pair.
      const resting = css.indexOf(
        '[data-control="button"]:is([data-variant="outline"], [data-variant="secondary"]) {',
      );
      for (const found of [writingRestRule, writingPressedRule]) {
        expect(braceDepthBefore(found.index)).toBe(0);
        expect(found.index).toBeGreaterThan(resting);
        expect(found.index).toBeGreaterThan(css.indexOf(sharedSelector));
      }
      expect(writingRestRule[2].replace(/\s/g, "")).toBe(
        "background-color:var(--writing-control-face);",
      );
      expect(imageToken(writingPressedRule[2])).toBe("--writing-control-pressed");
    },
  );

  it("keeps body ink at AA on resting and pressed faces over every writing-glass backing", () => {
    // The tokens the winning scoped rules actually paint.
    const faceToken = /background-color:\s*var\((--[\w-]+)\)/.exec(
      writingRestRule[2],
    )![1] as CanvasTokenName;
    const pressToken = imageToken(writingPressedRule[2]);
    const corners = [
      "#000000",
      "#ffffff",
      "#ff0000",
      "#00ff00",
      "#0000ff",
      "#ffff00",
      "#00ffff",
      "#ff00ff",
    ];
    for (const mode of ["light", "dark"] as const) {
      for (const seed of [
        "#e8652a",
        "#18b6a4",
        "#4653a2",
        "#a020f0",
        "#00ff00",
        "#80817f",
        "#ffffff",
        "#000000",
      ]) {
        for (const vibrancy of [0, 0.6, 1]) {
          const canvas = { ...DEFAULT_CANVAS, vibrancy, stops: [{ hex: seed, x: 0.5, y: 0.5 }] };
          const { tokens: t, canvasTokens: c } = deriveCanvasPaint(canvas, mode);
          for (const corner of corners) {
            const popover = emittedOver(c["--glass-veil"], regularGlassBackdrop(corner, mode));
            for (const [caller, backing] of [
              ["sign-out", popover],
              ["retry-in-error-notice", compositeHex(t["--destructive"], 0.1, popover)],
            ] as const) {
              const rest = emittedOver(c[faceToken], backing);
              const pressed = emittedOver(c[pressToken], rest);
              for (const [state, face] of [
                ["rest", rest],
                ["pressed", pressed],
              ] as const) {
                expect(
                  wcagContrast(t["--foreground"], face),
                  `${mode}/${seed}/v${vibrancy}/corner${corner}/${caller}/${state}/face${face}/ink${t["--foreground"]}`,
                ).toBeGreaterThanOrEqual(4.5);
              }
            }
          }
        }
      }
    }
  });
});

import { describe, expect, it } from "vite-plus/test";
import {
  DEFAULT_CANVAS,
  effectiveStopHexes,
  regularGlassBackdrop,
  compositeHex,
  hexToOklch,
  oklchToHex,
  wcagContrast,
} from "@volli/shared";
import { deriveCanvasPaint } from "./canvas-paint";

/** Composite the emitted CSS, not a separately maintained approximation of its recipe. */
function over(css: string, background: string): string {
  if (css.startsWith("#")) return css;
  const mix = /^color-mix\(in oklab, (#[a-f0-9]{6}) ([\d.]+)%, transparent\)$/.exec(css);
  if (mix) return compositeHex(mix[1], Number(mix[2]) / 100, background);
  const rgba = /^rgb\((\d+) (\d+) (\d+) \/ ([\d.]+)\)$/.exec(css);
  if (!rgba) throw new Error(`Unexpected fill: ${css}`);
  const hex = `#${rgba
    .slice(1, 4)
    .map((byte) => Number(byte).toString(16).padStart(2, "0"))
    .join("")}`;
  return compositeHex(hex, Number(rgba[4]), background);
}

const seeds = [
  "#e8652a",
  "#18b6a4",
  "#4653a2",
  "#a020f0",
  "#00ff00",
  "#80817f",
  "#ff00ff",
  "#000000",
  "#ffffff",
  "#0000ff",
  "#ffff00",
  "#ff0000",
  ...Array.from({ length: 24 }, (_, i) => oklchToHex(0.65, 0.25, i * 15)),
];

describe("tinted material contrast", () => {
  describe.each(["light", "dark"] as const)("%s", (mode) => {
    it.each(seeds)("%s: reading ink survives actual material composites", (seed) => {
      for (const vibrancy of [0, 0.3, 0.6, 1]) {
        const canvas = { ...DEFAULT_CANVAS, stops: [{ hex: seed, x: 0.5, y: 0.5 }], vibrancy };
        const { tokens: t, canvasTokens: c } = deriveCanvasPaint(canvas, mode);
        const opaque = [t["--background"], t["--muted"], t["--popover"], c["--card-face"]];
        const surfaces = [
          ...opaque,
          compositeHex(seed, 0.18, t["--card"]),
          ...opaque.flatMap((base) => [
            over(c["--fill-row-hover"], base),
            over(c["--fill-row-selected"], base),
            over(c["--fill-secondary"], base), // user bubble and pressed fills
            over(c["--fill-quaternary"], base), // quiet tool/track fills
            over(c["--control-face"], base),
            over(c["--tab-selected-face"], base),
            over(c["--control-face"], over(c["--fill-secondary"], base)),
            over(c["--tab-selected-face"], over(c["--fill-secondary"], base)),
            over(c["--glass-writing-veil"], regularGlassBackdrop(base, mode)),
          ]),
          // Probe all RGB corners under floating menus, not just opaque paper.
          ...[
            "#000000",
            "#ffffff",
            "#ff0000",
            "#00ff00",
            "#0000ff",
            "#ffff00",
            "#00ffff",
            "#ff00ff",
          ].map((base) => over(c["--glass-veil"], regularGlassBackdrop(base, mode))),
        ];
        for (const surface of surfaces) {
          const context = `${seed}/${vibrancy}/${mode}/${surface}`;
          for (const ink of [
            t["--foreground"],
            t["--muted-foreground"],
            c["--label-ink"],
            c["--diff-added"],
            c["--diff-removed"],
          ]) {
            expect(wcagContrast(ink, surface), `${context}/${ink}`).toBeGreaterThanOrEqual(4.5);
          }
          expect(wcagContrast(c["--tertiary-foreground"], surface), context).toBeGreaterThanOrEqual(
            3,
          );
          expect(wcagContrast(t["--ring"], surface), context).toBeGreaterThanOrEqual(3);
        }
        for (const peak of effectiveStopHexes(canvas, mode)) {
          const glass = over(c["--glass-pane-veil"], regularGlassBackdrop(peak, mode));
          for (const surface of [
            glass,
            over(c["--fill-row-hover"], glass),
            over(c["--fill-row-selected"], glass),
          ]) {
            for (const ink of [c["--glass-ink"], c["--glass-secondary"]]) {
              expect(
                wcagContrast(ink, surface),
                `${seed}/${mode}/navigation/${surface}/${ink}`,
              ).toBeGreaterThanOrEqual(4.5);
            }
          }
        }
        expect(c["--glass-writing-veil"]).toBe(c["--glass-veil"]);
        expect(t["--foreground"]).toBe(mode === "light" ? "#272727" : "#ededed");
        // Hue-locked semantic colours remain independent of the canvas colour.
        for (const [name, hue] of [
          ["--positive", 162.48],
          ["--attention", 70.08],
          ["--info", 237.32],
          ["--destructive", 23.026],
        ] as const) {
          expect(Math.abs(hexToOklch(t[name]).h - hue)).toBeLessThan(3);
          expect(wcagContrast(t[name], t[`${name}-foreground`])).toBeGreaterThanOrEqual(4.5);
        }
      }
    });
  });
});

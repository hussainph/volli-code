import { describe, expect, it } from "vite-plus/test";
import { wcagContrast } from "culori";
import { compositeHex, hexToOklch, isHexColor, oklchToHex } from "../color";
import { THEME_TOKEN_NAMES } from "../tokens";
import {
  deriveCanvasTokens,
  deriveLabelInk,
  tintCanvasNeutral,
  writingGlass,
  windowBackground,
} from "./index";
import { baseFillHex } from "./gradient";
import { DEFAULT_CANVAS } from "./parse";

// Ember, Dusk, Tide, purple, saturated green, near-grey and channel extremes,
// plus the complete hue wheel. Use an independent contrast oracle on emitted bytes.
const hues = [
  "#e8652a",
  "#4653a2",
  "#18b6a4",
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

describe("neutral paper and canvas-tinted materials", () => {
  it("bounds a writing-glass tint that would push body ink below AA under its 7.8% fill", () => {
    const canvas = { ...DEFAULT_CANVAS, vibrancy: 1, stops: [{ hex: "#18b6a4", x: 0.5, y: 0.5 }] };
    const tokens = deriveCanvasTokens(canvas, "dark");
    const popover = hexToOklch(tokens["--popover"]);
    const full = hexToOklch(tintCanvasNeutral("#282828", canvas, "dark"));
    // Yields chroma only: lightness and hue stay, and it is still tinted.
    expect(popover.C).toBeLessThan(full.C);
    expect(popover.C).toBeGreaterThan(0.01);
    expect(popover.L).toBeCloseTo(full.L, 2);
    const fill = tintCanvasNeutral(tokens["--foreground"], canvas, "dark");
    for (const pool of writingGlass(tokens["--popover"], "dark").pools)
      expect(
        wcagContrast(tokens["--foreground"], compositeHex(fill, 0.078, pool)),
        pool,
      ).toBeGreaterThanOrEqual(4.5);
    // Ember already clears the pair; its tint is untouched.
    expect(deriveCanvasTokens(DEFAULT_CANVAS, "dark")["--popover"]).toBe(
      tintCanvasNeutral("#282828", DEFAULT_CANVAS, "dark"),
    );
  });

  for (const mode of ["light", "dark"] as const) {
    it.each(hues)(`${mode}/%s: secondary and labels clear AA on reading pools`, (hex) => {
      for (const vibrancy of [0, 0.6, 1]) {
        const canvas = { ...DEFAULT_CANVAS, stops: [{ hex, x: 0.3, y: 0.6 }], vibrancy };
        const tokens = deriveCanvasTokens(canvas, mode);
        // Actual emitted writing-glass pools, not the former 90%-veil approximation.
        const surfaces = [
          ...["--background", "--card", "--popover", "--muted", "--accent", "--sidebar"].map(
            (name) => tokens[name as keyof typeof tokens],
          ),
          compositeHex(hex, 0.18, tokens["--card"]),
          ...writingGlass(tokens["--popover"], mode).pools,
        ];
        for (const surface of surfaces) {
          const context = `${hex}/${vibrancy}/${mode}/${surface}`;
          expect(wcagContrast(tokens["--foreground"], surface), context).toBeGreaterThanOrEqual(
            4.5,
          );
          expect(
            wcagContrast(tokens["--muted-foreground"], surface),
            context,
          ).toBeGreaterThanOrEqual(4.5);

          expect(wcagContrast(deriveLabelInk(tokens, mode), surface)).toBeGreaterThanOrEqual(4.5);
        }
        expect(
          wcagContrast(tokens["--primary-text"], compositeHex(hex, 0.18, tokens["--card"])),
        ).toBeGreaterThanOrEqual(4.5);
        expect(tokens["--foreground"]).toBe(mode === "light" ? "#272727" : "#ededed");
        expect(tokens["--sidebar-foreground"]).toBe(tokens["--foreground"]);
        expect(tokens["--background"]).toBe(mode === "light" ? "#ffffff" : "#1e1e1e");
        expect(tokens["--card"]).toBe(tokens["--background"]);
        for (const name of THEME_TOKEN_NAMES) expect(isHexColor(tokens[name])).toBe(true);
        expect(
          wcagContrast(tokens["--primary"], tokens["--primary-foreground"]),
        ).toBeGreaterThanOrEqual(4.5);
        expect(wcagContrast(tokens["--ring"], tokens["--card"])).toBeGreaterThanOrEqual(3);
        expect(deriveCanvasTokens(canvas, mode)).toEqual(tokens);
      }
    });
    it(`${mode}: personality follows hue and vibrancy without inventing colour in greys`, () => {
      const canvas = { ...DEFAULT_CANVAS, stops: [{ hex: "#18b6a4", x: 0.5, y: 0.5 }] };
      const vivid = deriveCanvasTokens({ ...canvas, vibrancy: 1 }, mode);
      const quiet = deriveCanvasTokens({ ...canvas, vibrancy: 0 }, mode);
      const grey = deriveCanvasTokens(
        { ...canvas, stops: [{ hex: "#808080", x: 0.5, y: 0.5 }] },
        mode,
      );
      for (const name of ["--muted", "--border", "--muted-foreground"] as const) {
        expect(hexToOklch(vivid[name]).C).toBeGreaterThan(0.018);
        expect(hexToOklch(vivid[name]).C).toBeGreaterThan(hexToOklch(quiet[name]).C);
        // One-byte rounding at the contrast boundary can leave sub-perceptual chroma.
        expect(hexToOklch(grey[name]).C).toBeLessThan(0.002);
        if (name !== "--muted-foreground") {
          expect(Math.abs(hexToOklch(vivid[name]).L - hexToOklch(quiet[name]).L)).toBeLessThan(
            0.005,
          );
        }
      }
    });
    it(`${mode}: accent follows the first stop, not the mesh primary index`, () => {
      expect(
        deriveCanvasTokens(
          {
            ...DEFAULT_CANVAS,
            stops: [DEFAULT_CANVAS.stops[0], { hex: "#18b6a4", x: 0.5, y: 0.5 }],
            primaryIndex: 1,
          },
          mode,
        ),
      ).toEqual(deriveCanvasTokens(DEFAULT_CANVAS, mode));
      expect(windowBackground(null, mode)).toBe(baseFillHex(DEFAULT_CANVAS, mode));
      expect(windowBackground(DEFAULT_CANVAS, mode)).toBe(baseFillHex(DEFAULT_CANVAS, mode));
    });
  }
});

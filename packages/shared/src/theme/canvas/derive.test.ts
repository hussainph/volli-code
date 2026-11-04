import { describe, expect, it } from "vite-plus/test";
import { compositeHex, isHexColor, wcagContrast } from "../color";
import { THEME_TOKEN_NAMES } from "../tokens";
import { deriveCanvasTokens, deriveLabelInk, windowBackground } from "./index";
import { baseFillHex } from "./gradient";
import { DEFAULT_CANVAS } from "./parse";

const hues = ["#e8652a", "#4653a2", "#18b6a4", "#f2d060", "#000000", "#ffffff"];

describe("neutral paper and glass", () => {
  for (const mode of ["light", "dark"] as const) {
    it(`${mode}: secondary ≥4.5:1 and tertiary ≥3:1 on paper and all glass pools`, () => {
      for (const hex of hues) {
        for (const vibrancy of [0, 0.6, 1]) {
          const canvas = { ...DEFAULT_CANVAS, stops: [{ hex, x: 0.3, y: 0.6 }], vibrancy };
          const tokens = deriveCanvasTokens(canvas, mode);
          // Worst possible pools under the 90% neutral veil, including arbitrary
          // content beneath a floating menu. Intermediate mesh pools are bounded.
          const surfaces = [
            tokens["--card"],
            tokens["--muted"],
            ...(mode === "light" ? ["#e1e1e1", "#fbfbfb"] : ["#242424", "#3e3e3e"]),
          ];
          for (const surface of surfaces) {
            expect(wcagContrast(tokens["--muted-foreground"], surface)).toBeGreaterThanOrEqual(4.5);
            expect(
              wcagContrast(mode === "light" ? "#666666" : "#aaaaaa", surface),
            ).toBeGreaterThanOrEqual(3);
            expect(wcagContrast(deriveLabelInk(tokens, mode), surface)).toBeGreaterThanOrEqual(4.5);
          }
          expect(
            wcagContrast(tokens["--primary-text"], compositeHex(hex, 0.18, tokens["--card"])),
          ).toBeGreaterThanOrEqual(4.5);
          expect(tokens["--card"]).toBe(mode === "light" ? "#ffffff" : "#1e1e1e");
          for (const name of THEME_TOKEN_NAMES) expect(isHexColor(tokens[name])).toBe(true);
          expect(
            wcagContrast(tokens["--primary"], tokens["--primary-foreground"]),
          ).toBeGreaterThanOrEqual(4.5);
          expect(wcagContrast(tokens["--ring"], tokens["--card"])).toBeGreaterThanOrEqual(3);
          expect(deriveCanvasTokens(canvas, mode)).toEqual(tokens);
        }
      }
    });
    it(`${mode}: accent follows the first stop, not the mesh primary index`, () => {
      expect(
        deriveCanvasTokens(
          {
            ...DEFAULT_CANVAS,
            stops: [...DEFAULT_CANVAS.stops, { hex: "#18b6a4", x: 0.5, y: 0.5 }],
            primaryIndex: 1,
          },
          mode,
        )["--primary"],
      ).toBe(deriveCanvasTokens(DEFAULT_CANVAS, mode)["--primary"]);
      expect(windowBackground(null, mode)).toBe(baseFillHex(DEFAULT_CANVAS, mode));
      expect(windowBackground(DEFAULT_CANVAS, mode)).toBe(baseFillHex(DEFAULT_CANVAS, mode));
    });
  }
});

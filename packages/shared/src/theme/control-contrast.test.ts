import { describe, expect, it } from "vite-plus/test";
import { wcagContrast } from "culori";
import { apcaLc, oklchToHex } from "./color";
import { DEFAULT_THEME } from "./definition";
import { generateThemeTokens } from "./generate";
import { deriveCanvasTokens } from "./canvas/derive";
import { DEFAULT_CANVAS } from "./canvas/parse";

// Independent sRGB oracle: APCA alone accepted #fff on #d37550 (3.27:1).
describe("semantic control contrast (WCAG AA)", () => {
  it.each(["light", "dark"] as const)("protects default controls in %s", (mode) => {
    const tokens = deriveCanvasTokens(DEFAULT_CANVAS, mode);
    expect(
      wcagContrast(tokens["--primary"], tokens["--primary-foreground"]),
    ).toBeGreaterThanOrEqual(4.5);
    for (const surface of ["--background", "--card", "--popover"] as const) {
      expect(wcagContrast(tokens["--primary"], tokens[surface]), surface).toBeGreaterThanOrEqual(3);
    }
    for (const surface of [
      "--background",
      "--card",
      "--popover",
      "--muted",
      "--accent",
      "--rail",
      "--sidebar",
    ] as const) {
      expect(wcagContrast(tokens["--ring"], tokens[surface]), surface).toBeGreaterThanOrEqual(3);
    }
  });

  it("keeps arbitrary canvas hues and vibrancy valid in both modes", () => {
    for (const seed of [
      "#000000",
      "#ffffff",
      ...Array.from({ length: 24 }, (_, h) => oklchToHex(0.65, 0.25, h * 15)),
    ]) {
      const generated = generateThemeTokens({ ...DEFAULT_THEME, seed });
      expect(
        wcagContrast(generated["--primary"], generated["--primary-foreground"]),
        seed,
      ).toBeGreaterThanOrEqual(4.5);
      for (const vibrancy of [0, 0.6, 1]) {
        for (const mode of ["light", "dark"] as const) {
          const tokens = deriveCanvasTokens(
            {
              ...DEFAULT_CANVAS,
              stops: [{ hex: seed, x: 0.5, y: 0.5 }],
              primaryIndex: 0,
              vibrancy,
            },
            mode,
          );
          expect(
            wcagContrast(tokens["--primary"], tokens["--primary-foreground"]),
            `${seed}/${vibrancy}/${mode}`,
          ).toBeGreaterThanOrEqual(4.5);
          expect(
            apcaLc(tokens["--primary-foreground"], tokens["--primary"]),
          ).toBeGreaterThanOrEqual(60);
          for (const surface of [
            "--background",
            "--card",
            "--popover",
            "--muted",
            "--accent",
            "--rail",
            "--sidebar",
          ] as const) {
            expect(
              wcagContrast(tokens["--ring"], tokens[surface]),
              `${seed}/${mode}/${surface}`,
            ).toBeGreaterThanOrEqual(3);
          }
        }
      }
    }
  });
});

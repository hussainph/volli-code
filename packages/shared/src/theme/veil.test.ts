import { describe, expect, it } from "vite-plus/test";

import { oklchToHex } from "./color";
import { DEFAULT_THEME } from "./definition";
import { generateThemeTokens } from "./generate";
import { THEME_VEIL_TOKEN_NAMES, VEIL_ALPHA, generateVeilTokens } from "./veil";

/** `rgb(R G B / a)` → its three 8-bit channels. */
function veilChannels(veil: string): number[] {
  const match = /^rgb\((\d+) (\d+) (\d+) \/ ([\d.]+)\)$/.exec(veil);
  expect(match).not.toBeNull();
  expect(Number(match![4])).toBe(VEIL_ALPHA);
  return [1, 2, 3].map((group) => Number(match![group]));
}

/** `#rrggbb` → its three 8-bit channels. */
function hexChannels(hex: string): number[] {
  return [1, 3, 5].map((index) => parseInt(hex.slice(index, index + 2), 16));
}

/**
 * What a compositor does with `rgb(R G B / a)` over an opaque fill — the source
 * -over formula, in 8-bit sRGB. This is the browser's half of the contract, so
 * it is stated here rather than imported from the module under test.
 */
function compositeOver(veil: string, base: string): number[] {
  const source = veilChannels(veil);
  return hexChannels(base).map((channel, index) =>
    Math.round(source[index]! * VEIL_ALPHA + channel * (1 - VEIL_ALPHA)),
  );
}

describe("generateVeilTokens", () => {
  it("reproduces today's opaque surfaces byte-exactly, at every hue", () => {
    // The veil is what lets a surface give up its fill without giving up its
    // rung: in `solid` mode the composite below IS the old opaque token, so
    // the app is pixel-identical, and over a gradient the surface keeps its
    // RELATIVE lift instead of a fixed absolute one.
    for (let hue = 0; hue < 360; hue += 5) {
      for (const chroma of [0.01, 0.06, 0.12, 0.2, 0.35]) {
        const tokens = generateThemeTokens({
          ...DEFAULT_THEME,
          seed: oklchToHex(0.661, chroma, hue),
        });
        const veils = generateVeilTokens(tokens);

        expect(compositeOver(veils["--sidebar-veil"], tokens["--rail"])).toEqual(
          hexChannels(tokens["--sidebar"]),
        );
        // Stacked on the sidebar's own veil — two deep, and never more. Apple's
        // rule: a light translucent surface never sits on another one.
        expect(compositeOver(veils["--sidebar-accent-veil"], tokens["--sidebar"])).toEqual(
          hexChannels(tokens["--sidebar-accent"]),
        );
      }
    }
  });

  it("solves to a color sRGB can actually hold, at every hue", () => {
    // α 0.10 is the LOWEST alpha that does this: the solve divides by α, so a
    // thinner veil drives the solved color out of gamut at the hues where the
    // rung it reproduces is furthest from the surface underneath.
    for (let hue = 0; hue < 360; hue += 5) {
      const tokens = generateThemeTokens({ ...DEFAULT_THEME, seed: oklchToHex(0.661, 0.2, hue) });
      const veils = generateVeilTokens(tokens);

      for (const name of THEME_VEIL_TOKEN_NAMES) {
        for (const channel of veilChannels(veils[name])) {
          expect(channel).toBeGreaterThanOrEqual(0);
          expect(channel).toBeLessThanOrEqual(255);
        }
      }
    }
  });

  it("solves ember to the values globals.css authors", () => {
    // globals.css carries the generator's output verbatim so the first paint
    // needs no JS. If these drift, the app flashes at boot.
    expect(generateVeilTokens(generateThemeTokens(DEFAULT_THEME))).toEqual({
      "--sidebar-veil": "rgb(135 101 99 / 0.1)",
      "--sidebar-accent-veil": "rgb(157 140 128 / 0.1)",
      "--sidebar-border-veil": "rgb(167 150 128 / 0.1)",
    });
  });
});

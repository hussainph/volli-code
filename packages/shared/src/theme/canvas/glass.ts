/** Shared optical model: the CSS writer and reading-ink solver use the same pools. */
import { compositeHex, hexChannels, hexToOklch, lerp, oklchToHex, wcagContrast } from "../color";
import type { ResolvedAppearance } from "./types";

/**
 * Keep hue/chroma and move only as far toward the appearance's ink pole as
 * necessary. Tests establish that our material pools admit the requested floor;
 * the bounded search returns the pole if an incompatible pool set cannot.
 * Contrast is measured after gamut mapping and byte rounding, as CSS paints it.
 */
export function readingInk(
  hex: string,
  pools: readonly string[],
  mode: ResolvedAppearance,
  floor: number,
): string {
  const passes = (ink: string) => pools.every((surface) => wcagContrast(ink, surface) >= floor);
  if (passes(hex)) return hex;
  const { L, C, h } = hexToOklch(hex);
  const pole = mode === "light" ? 0 : 1;
  let low = 0,
    high = 1;
  for (let i = 0; i < 20; i++) {
    const mid = (low + high) / 2;
    if (passes(oklchToHex(lerp(L, pole, mid), C, h))) high = mid;
    else low = mid;
  }
  return oklchToHex(lerp(L, pole, high), C, h);
}

const REGULAR_TONE = {
  light: [
    ["contrast", 0.44174],
    ["brightness", 1.44847],
    ["saturate", 1.91139],
  ],
  dark: [
    ["brightness", 1.56971],
    ["contrast", 0.6149],
    ["brightness", 0.7124],
    ["saturate", 2.79074],
  ],
} as const;

const clampGlassChannel = (value: number) => Math.max(0, Math.min(1, value));

/** The CSS filter chain in sRGB, before the mock's neutral veil is composited.
 * Ink must be solved against measured glass, not against unfiltered canvas. */
export function regularGlassBackdrop(hex: string, mode: ResolvedAppearance): string {
  let rgb = [1, 3, 5].map((offset) => parseInt(hex.slice(offset, offset + 2), 16) / 255);
  for (const [kind, value] of REGULAR_TONE[mode]) {
    if (kind === "saturate") {
      const [r, g, b] = rgb,
        s = value;
      rgb = [
        (0.213 + 0.787 * s) * r + (0.715 - 0.715 * s) * g + (0.072 - 0.072 * s) * b,
        (0.213 - 0.213 * s) * r + (0.715 + 0.285 * s) * g + (0.072 - 0.072 * s) * b,
        (0.213 - 0.213 * s) * r + (0.715 - 0.715 * s) * g + (0.072 + 0.928 * s) * b,
      ].map(clampGlassChannel);
    } else
      rgb = rgb.map((channel) =>
        clampGlassChannel(kind === "contrast" ? (channel - 0.5) * value + 0.5 : channel * value),
      );
  }
  return `#${rgb
    .map((channel) =>
      Math.round(channel * 255)
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;
}

/** CSS filter spelling emitted by the renderer. */
export function regularGlassTone(mode: ResolvedAppearance): string {
  return REGULAR_TONE[mode].map(([kind, value]) => `${kind}(${value})`).join(" ");
}

/**
 * Coverage of the translucent `--fill-secondary` wash: an inspector control's
 * resting face, and the press image on control materials. The navigation
 * outline press uses the same coverage. The renderer emits it; writing glass
 * bounds its tint under the inspector's resting face. Paper's opaque
 * `--surface-secondary` rung is its own value.
 */
export const SECONDARY_FILL_ALPHA = 0.078;

/** The veil and filtered RGB corner probes share one opacity, never two recipes. */
export function writingGlass(
  fill: string,
  mode: ResolvedAppearance,
): { veil: string; pools: string[] } {
  const alpha = 0.56;
  return {
    veil: `rgb(${hexChannels(fill).join(" ")} / ${alpha})`,
    pools: [
      "#000000",
      "#ffffff",
      "#ff0000",
      "#00ff00",
      "#0000ff",
      "#ffff00",
      "#00ffff",
      "#ff00ff",
    ].map((hex) => compositeHex(fill, alpha, regularGlassBackdrop(hex, mode))),
  };
}

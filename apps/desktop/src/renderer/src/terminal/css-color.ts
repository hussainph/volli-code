/**
 * Minimal hex-color parsing for reading design tokens (globals.css custom
 * properties) into restty's 0-255 RGB theme records. Pure — no DOM.
 */

export interface RgbColor {
  r: number;
  g: number;
  b: number;
}

const HEX_COLOR = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/;

/** Parse `#rgb` or `#rrggbb` (whitespace-tolerant, case-insensitive); null otherwise. */
export function parseHexColor(value: string): RgbColor | null {
  const hex = value.trim().toLowerCase();
  if (!HEX_COLOR.test(hex)) return null;
  const digits = hex.slice(1);
  const expanded =
    digits.length === 3
      ? digits
          .split("")
          .map((d) => d + d)
          .join("")
      : digits;
  return {
    r: parseInt(expanded.slice(0, 2), 16),
    g: parseInt(expanded.slice(2, 4), 16),
    b: parseInt(expanded.slice(4, 6), 16),
  };
}

import type { Canvas } from "@volli/shared";

export function toHsl(hex: string): number[] {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const max = Math.max(r, g, b),
    min = Math.min(r, g, b),
    d = max - min,
    l = (max + min) / 2;
  const h =
    d === 0
      ? 0
      : max === r
        ? ((g - b) / d + (g < b ? 6 : 0)) * 60
        : max === g
          ? ((b - r) / d + 2) * 60
          : ((r - g) / d + 4) * 60;
  return [
    Math.round(h),
    Math.round((d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1))) * 100),
    Math.round(l * 100),
  ];
}
export function toHex(h: number, s: number, l: number): string {
  s /= 100;
  l /= 100;
  const a = s * Math.min(l, 1 - l);
  return (
    "#" +
    [0, 8, 4]
      .map((n) => {
        const k = (n + h / 30) % 12;
        return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))))
          .toString(16)
          .padStart(2, "0");
      })
      .join("")
  );
}
const fan = (n: number) => (n % 2 === 1 ? 1 : -1) * Math.ceil(n / 2) * 30;
export function harmonyHue(
  hue: number,
  style: "analogous" | "complementary",
  index: number,
  primaryIndex: number,
): number {
  const rank = index < primaryIndex ? index + 1 : index;
  const offset = style === "analogous" ? fan(rank) : rank === 1 ? 180 : 180 - fan(rank - 1);
  return (((hue + offset) % 360) + 360) % 360;
}
export function harmonize(
  canvas: Canvas,
  primary: string,
  style: "analogous" | "complementary",
): Canvas {
  const [h, s, l] = toHsl(primary);
  return {
    ...canvas,
    stops: canvas.stops.map((stop, i) => ({
      ...stop,
      hex:
        i === canvas.primaryIndex
          ? primary
          : toHex(harmonyHue(h, style, i, canvas.primaryIndex), s, l),
    })),
  };
}

/** HSV is the geometry of the Custom colour pad, not a stored theme shape. */
export function toHsv(hex: string): readonly [number, number, number] {
  const channels = [1, 3, 5].map((at) => Number.parseInt(hex.slice(at, at + 2), 16) / 255);
  const [r, g, b] = channels;
  const high = Math.max(r, g, b),
    low = Math.min(r, g, b),
    range = high - low;
  const hue =
    range === 0
      ? 0
      : high === r
        ? ((g - b) / range + 6) % 6
        : high === g
          ? (b - r) / range + 2
          : (r - g) / range + 4;
  return [hue * 60, high === 0 ? 0 : (range / high) * 100, high * 100];
}
export function hsvHex(hue: number, saturation: number, brightness: number): string {
  const h = (((hue % 360) + 360) % 360) / 60,
    s = saturation / 100,
    v = brightness / 100;
  const channel = (n: number) => {
    const k = (n + h) % 6;
    return Math.round(255 * (v - v * s * Math.max(0, Math.min(k, 4 - k, 1))))
      .toString(16)
      .padStart(2, "0");
  };
  return `#${channel(5)}${channel(3)}${channel(1)}`;
}

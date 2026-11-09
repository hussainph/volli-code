import { describe, expect, it } from "vite-plus/test";
import { DEFAULT_CANVAS } from "@volli/shared";
import { harmonize, harmonyHue, toHex, toHsl, hsvHex, toHsv } from "./colour-model";

describe("Settings colour instrument", () => {
  it("round trips the custom pad's HSV colours, including black and grey", () => {
    for (const hex of ["#000000", "#ffffff", "#808080", "#ff0000", "#00ff00", "#0000ff", "#2ba39c"])
      expect(hsvHex(...toHsv(hex))).toBe(hex);
    expect(hsvHex(360, 100, 100)).toBe("#ff0000");
  });
  it("keeps each companion's hue distinct in either harmony and at every primary position", () => {
    for (const style of ["analogous", "complementary"] as const)
      for (let primary = 0; primary < 5; primary++) {
        const hues = Array.from({ length: 5 }, (_, i) =>
          i === primary ? 350 : harmonyHue(350, style, i, primary),
        );
        expect(new Set(hues).size).toBe(5);
        expect(hues.every((hue) => hue >= 0 && hue < 360)).toBe(true);
      }
  });
  it("retains stop positions, primary choice and authored primary colour", () => {
    const canvas = {
      ...DEFAULT_CANVAS,
      stops: [
        { hex: "#ff0000", x: 0.2, y: 0.3 },
        { hex: "#00ff00", x: 0.4, y: 0.6 },
        { hex: "#0000ff", x: 0.8, y: 0.5 },
      ],
      primaryIndex: 1,
    };
    const changed = harmonize(canvas, "#e8652a", "analogous");
    expect(changed.primaryIndex).toBe(1);
    expect(changed.stops[1].hex).toBe("#e8652a");
    expect(changed.stops.map(({ x, y }) => [x, y])).toEqual(canvas.stops.map(({ x, y }) => [x, y]));
    expect(new Set(changed.stops.map(({ hex }) => hex)).size).toBe(3);
  });
  it("handles achromatic colours and round-trips primary HSL channels", () => {
    expect(toHsl("#ffffff")).toEqual([0, 0, 100]);
    expect(toHsl("#000000")).toEqual([0, 0, 0]);
    expect(toHex(0, 100, 50)).toBe("#ff0000");
    expect(toHex(240, 100, 50)).toBe("#0000ff");
  });
});

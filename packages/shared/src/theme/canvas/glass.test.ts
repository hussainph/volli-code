import { describe, expect, it } from "vite-plus/test";
import { compositeHex, hexChannels, wcagContrast } from "../color";
import { readingInk, regularGlassBackdrop, regularGlassTone, writingGlass } from "./glass";

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

describe("shared glass optical model", () => {
  it.each(["light", "dark"] as const)(
    "%s: repairs ink against every pool without changing a passing colour",
    (mode) => {
      const pools = writingGlass(mode === "light" ? "#fff0e7" : "#33251f", mode).pools;
      const seed = mode === "light" ? "#99918c" : "#706b66";
      const ink = readingInk(seed, pools, mode, 4.5);
      expect(ink).not.toBe(seed);
      expect(pools.every((surface) => wcagContrast(ink, surface) >= 4.5)).toBe(true);
      expect(readingInk(ink, pools, mode, 4.5)).toBe(ink);
      // No unbounded loop if a future caller supplies incompatible dark/light pools.
      expect(readingInk(seed, ["#000000", "#ffffff"], mode, 7)).toBe(
        mode === "light" ? "#000000" : "#ffffff",
      );
    },
  );
  it.each(["light", "dark"] as const)(
    "%s: the emitted veil and ink probes share the optical recipe",
    (mode) => {
      const fill = mode === "light" ? "#fff0e7" : "#33251f";
      const { veil, pools } = writingGlass(fill, mode);
      expect(veil).toBe(`rgb(${hexChannels(fill).join(" ")} / 0.56)`);
      expect(pools).toEqual(
        corners.map((hex) => compositeHex(fill, 0.56, regularGlassBackdrop(hex, mode))),
      );
      expect(regularGlassTone(mode)).toBe(
        mode === "light"
          ? "contrast(0.44174) brightness(1.44847) saturate(1.91139)"
          : "brightness(1.56971) contrast(0.6149) brightness(0.7124) saturate(2.79074)",
      );
    },
  );

  it("retains the existing navigation filter, including channel clipping", () => {
    expect(corners.map((hex) => regularGlassBackdrop(hex, "light"))).toEqual([
      "#676767",
      "#ffffff",
      "#ff4a4a",
      "#04ff04",
      "#5d5dff",
      "#ffff00",
      "#00ffff",
      "#ff40ff",
    ]);
    expect(corners.map((hex) => regularGlassBackdrop(hex, "dark"))).toEqual([
      "#232323",
      "#939393",
      "#ff0000",
      "#00cc00",
      "#1515ff",
      "#a1a100",
      "#00bdbd",
      "#ff00ff",
    ]);
  });
});

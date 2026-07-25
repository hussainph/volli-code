import { readFileSync } from "node:fs";
import { describe, expect, it } from "vite-plus/test";

import { GRAIN_TILE_PATH, generateGrainTilePng } from "../../../../scripts/generate-grain.mjs";

import { GRAIN_TILE_PX } from "./grain";

describe("the committed grain tile", () => {
  it("is exactly what the generator produces — the binary is never hand-made", () => {
    // A committed binary nobody can regenerate is a one-off. Re-running the
    // script here is what keeps it an artifact of the script instead.
    expect(readFileSync(GRAIN_TILE_PATH).equals(generateGrainTilePng())).toBe(true);
  });

  it("stays inside § Grain's 2–6 KB budget at the declared tile size", () => {
    const png = generateGrainTilePng();

    expect(png.byteLength).toBeGreaterThan(2 * 1024);
    expect(png.byteLength).toBeLessThan(6 * 1024);
    // Bytes 16–24 of a PNG are IHDR's width and height. The overlay pins
    // background-size to GRAIN_TILE_PX, so a raster of another size would
    // silently rescale the noise instead of failing.
    expect(png.readUInt32BE(16)).toBe(GRAIN_TILE_PX);
    expect(png.readUInt32BE(20)).toBe(GRAIN_TILE_PX);
  });
});

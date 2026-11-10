import { describe, expect, it } from "vite-plus/test";
import { paintWorld, shaderPalette, WORLDS, type WorldName } from "./worlds";

describe("build-time world shader fixtures", () => {
  it("keeps every world paintable without treating gradient CSS as a data protocol", () => {
    for (const name of Object.keys(WORLDS) as WorldName[]) {
      const palette = shaderPalette(name);
      expect(palette.base).toMatch(/^#[0-9a-f]{6}$/i);
      expect(palette.canvas).toHaveLength(WORLDS[name].stops.length);
      expect(palette.canvas.every((pool) => /^#[0-9a-f]{6}$/i.test(pool.hex))).toBe(true);
      expect(palette.light).toEqual(paintWorld(name).pools);
      expect(palette.bloom).toMatch(/^#[0-9a-f]{6}$/i);
      expect(palette.grain).toBe(WORLDS[name].grain);
    }
  });
  it("pins Ember's shared dark base and first authored peak across the new color-mix CSS", () => {
    expect(paintWorld("ember").background).toContain("color-mix(in oklab");
    const palette = shaderPalette("ember");
    expect(palette.base).toBe("#45291e");
    expect(palette.canvas.at(-1)?.hex).toBe("#a44c25");
    expect(palette.light[0]).toMatchObject({ hex: "#e8652a", x: 0.12, y: 0.08, primary: true });
  });
});

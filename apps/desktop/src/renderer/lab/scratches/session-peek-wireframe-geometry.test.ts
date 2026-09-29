import { describe, expect, it } from "vite-plus/test";
import { positionPeek } from "./session-peek-wireframe-geometry";

describe("peek viewport geometry", () => {
  it("does not constrain a bottom-row card to its unmeasured height", () => {
    const bounds = { width: 768, height: 600 };
    const row = { left: 8, right: 760, top: 520 };
    const initial = positionPeek(row, "rail", 0, bounds, 280);
    const measured = positionPeek(row, "rail", 410, bounds, 280);
    expect(initial.top).toBe(48);
    expect(initial.maxHeight).toBe(496);
    expect(measured.maxHeight).toBe(initial.maxHeight);
    expect(measured.top + 410).toBeLessThanOrEqual(544);
  });

  for (const surface of ["nav", "rail"] as const) {
    it(`bounds wide and tall content from the ${surface} side`, () => {
      const bounds = { width: 320, height: 480 };
      const row = { left: 8, right: 312, top: 1000 };
      const position = positionPeek(row, surface, 2000, bounds, 420);
      expect(position.left).toBe(8);
      expect(position.top).toBe(48);
      expect(position.top + position.maxHeight).toBe(424);
    });
  }

  it("opens inward on a desktop when there is room", () => {
    const bounds = { width: 1280, height: 800 };
    expect(positionPeek({ left: 0, right: 280, top: 90 }, "nav", 360, bounds, 360).left).toBe(288);
    expect(positionPeek({ left: 1000, right: 1280, top: 90 }, "rail", 360, bounds, 360).left).toBe(
      632,
    );
  });
});

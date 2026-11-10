import { describe, expect, it } from "vite-plus/test";
import { capsulePath, liquidIslandGeometry, type LiquidGeometry } from "./liquid-island-geometry";

const resting: LiquidGeometry = {
  islandWidth: 176,
  cluster: 1,
  width: 140,
  presence: 1,
  stretch: 0,
  pinch: 0,
  detached: false,
  fade: 1,
  dropping: false,
  squash: 0,
  gulp: 0,
  reduce: false,
};

describe("the sessile bead's drawn union", () => {
  it("alone is exactly one stadium with no foot, flare or fillet", () => {
    const g = liquidIslandGeometry({ ...resting, cluster: 0 });
    expect(g.shell).toBe("");
    expect(g.bead).toBe(capsulePath(140, 30));
    expect(g.joined).toBe(false);
    expect(g.top).toBe(2);
    expect(g.clusterOpacity).toBe(0);
  });

  it("grows the island before forming fillets, and reverses along the same path", () => {
    const early = liquidIslandGeometry({ ...resting, cluster: 0.2 });
    expect(early.joined).toBe(false);
    expect(early.shell).not.toBe("");
    expect(early.bead).not.toBe("");
    expect(early.clusterOpacity).toBe(0);
    const formed = liquidIslandGeometry({ ...resting, cluster: 0.8 });
    expect(formed.joined).toBe(true);
    expect(formed.bead).toBe("");
    expect(formed.shell.match(/M/gu)).toHaveLength(1);
    expect(formed.shell.match(/C/gu)).toHaveLength(2);
    expect(liquidIslandGeometry({ ...resting, cluster: 0.2 })).toEqual(early);
  });

  it("allows a wide mushroom bead to overhang a narrow island", () => {
    const g = liquidIslandGeometry({ ...resting, width: 250, islandWidth: 48 });
    expect(g.width).toBe(250);
    expect(g.joined).toBe(true);
    expect(g.shell).toContain("125");
    expect(g.shell).not.toMatch(/NaN|Infinity/u);
  });

  it("draws the syrup thread before detaching and popping", () => {
    const drawn = liquidIslandGeometry({ ...resting, pinch: 0.81, stretch: 89.1 });
    expect(drawn.joined).toBe(true);
    expect(drawn.top).toBeLessThan(liquidIslandGeometry(resting).top);
    const snapped = liquidIslandGeometry({
      ...resting,
      pinch: 1,
      stretch: 110,
      detached: true,
      fade: 0.5,
    });
    expect(snapped.joined).toBe(false);
    expect(snapped.bead).not.toBe("");
    expect(snapped.width).toBeGreaterThan(resting.width);
    expect(snapped.shell.startsWith(capsulePath(176, 32))).toBe(true);
    expect(snapped.shell.match(/M/gu)).toHaveLength(2); // retracting thread tip
    expect(liquidIslandGeometry({ ...resting, detached: true, fade: 0.1 }).shell).toBe(
      capsulePath(176, 32),
    );
  });

  it("ends an empty abort with a 4px drop; reduced motion never squashes or scales", () => {
    const g = liquidIslandGeometry({ ...resting, cluster: 0, dropping: true, fade: 0 });
    expect(g.top).toBe(6);
    const reduced = liquidIslandGeometry({
      ...resting,
      cluster: 0,
      presence: 0.4,
      squash: 0.14,
      reduce: true,
    });
    expect(reduced.width).toBe(140);
    expect(reduced.height).toBe(30);
  });

  it("has no bead once drained and no invalid coordinates across the full transition", () => {
    expect(liquidIslandGeometry({ ...resting, presence: 0 }).bead).toBe("");
    expect(capsulePath(0, 0)).toBe("");
    for (const width of [54, 140, 250]) {
      for (const islandWidth of [32, 48, 176, 300]) {
        for (let i = 0; i <= 20; i += 1) {
          const g = liquidIslandGeometry({
            ...resting,
            width,
            islandWidth,
            cluster: i / 20,
            presence: i / 20,
          });
          expect(g.shell + g.bead).not.toMatch(/NaN|Infinity/u);
          expect(g.width).toBeGreaterThanOrEqual(0);
        }
      }
    }
  });
});

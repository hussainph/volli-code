import { describe, expect, it } from "vite-plus/test";
import {
  capsulePath,
  liquidIslandGeometry,
  liquidIslandRise,
  type LiquidGeometry,
} from "./liquid-island-geometry";

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

/** How far the bead is actually drawn above the island box, wobble included. */
const drawnRise = (s: LiquidGeometry) => Math.max(0, -liquidIslandGeometry(s).top);

describe("the bead's rise above the island box (VC-1210)", () => {
  // The jump-to-latest button keeps a 12px band over the island box; the rise
  // is what it adds while the bead is drawn above that box.
  const BAND = 12;

  it("is the bead's full height and gap on the rim, and nothing for a lone pill", () => {
    expect(liquidIslandRise(resting, false, false)).toBeCloseTo(30, 5);
    expect(liquidIslandRise({ ...resting, cluster: 0 }, false, false)).toBe(0);
    expect(liquidIslandRise(resting, false, true)).toBe(0);
  });

  it("ignores the wobble, which never closes the band", () => {
    for (const squash of [-0.14, -0.07, 0.07, 0.14]) {
      for (const stretch of [0, 6]) {
        for (const gulp of [0, 0.3]) {
          const wobbling = { ...resting, squash, stretch, gulp };
          expect(liquidIslandRise(wobbling, false, false)).toBe(
            liquidIslandRise(resting, false, false),
          );
          const intrusion = drawnRise(wobbling) - liquidIslandRise(wobbling, false, false);
          expect(intrusion).toBeLessThan(BAND - 4);
        }
      }
    }
  });

  it("follows a pinching exit's thread up, so the departing bead stays clear", () => {
    for (let i = 0; i <= 10; i += 1) {
      const pinching = { ...resting, stretch: (i / 10) ** 2 * 110, pinch: (i / 10) ** 2 };
      expect(drawnRise(pinching) - liquidIslandRise(pinching, true, false)).toBeLessThan(BAND);
    }
    const thread = { ...resting, stretch: 110, pinch: 1 };
    expect(liquidIslandRise(thread, true, false)).toBeGreaterThan(
      liquidIslandRise(thread, false, false),
    );
  });

  it("follows a draining bead down without a final step, and never under the band", () => {
    let previous = Infinity;
    for (let i = 20; i >= 0; i -= 1) {
      const draining = { ...resting, presence: i / 20 };
      const rise = liquidIslandRise(draining, false, false);
      expect(rise).toBeLessThanOrEqual(previous);
      expect(drawnRise(draining) - rise).toBeLessThan(BAND);
      previous = rise;
    }
    expect(previous).toBe(0);
  });
});

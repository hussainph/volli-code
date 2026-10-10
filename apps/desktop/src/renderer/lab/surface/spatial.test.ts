import { describe, expect, it } from "vite-plus/test";
import { crossing, lightResponse, type Body } from "./spatial";

const target: Body = { x: 100, y: 100, width: 100, height: 100, elevation: 10 };
const key = { x: 0, y: 0, elevation: 100, power: 1 };

describe("placement-aware Surface lighting", () => {
  it("casts shadows away from light and lights the facing edges", () => {
    const response = lightResponse(target, key, []);
    expect(response.shadow.x).toBeGreaterThan(0);
    expect(response.shadow.y).toBeGreaterThan(0);
    expect(response.edges[0]).toBeGreaterThan(0);
    expect(response.edges[3]).toBeGreaterThan(0);
    expect(response.edges[1]).toBe(0);
    expect(response.edges[2]).toBe(0);
    const opposite = lightResponse(target, { ...key, x: 300, y: 300 }, []);
    expect(opposite.shadow.x).toBeLessThan(0);
    expect(opposite.shadow.y).toBeLessThan(0);
  });
  it("responds to component position, distance and elevation, not just a global angle", () => {
    const near = lightResponse(target, key, []);
    const far = lightResponse({ ...target, x: 800 }, key, []);
    expect(far.strength).toBeLessThan(near.strength);
    const higher = lightResponse({ ...target, elevation: 25 }, key, []);
    expect(higher.shadow.x).toBeGreaterThan(near.shadow.x);
    expect(lightResponse({ ...target, elevation: 0 }, key, []).shadow.x).toBe(0);
  });
  it("only a taller neighbour across the light ray attenuates illumination", () => {
    const blocker: Body = { x: 120, y: 120, width: 10, height: 10, elevation: 40 };
    const clear = lightResponse(target, key, []).strength;
    expect(lightResponse(target, key, [blocker]).strength).toBeLessThan(clear);
    expect(lightResponse(target, key, [{ ...blocker, elevation: 2 }]).strength).toBe(clear);
    expect(lightResponse(target, key, [{ ...blocker, x: 500 }]).strength).toBe(clear);
    expect(lightResponse(target, key, [target]).strength).toBe(clear);
  });
  it("handles parallel rays, misses and zero-distance sources without NaN", () => {
    expect(crossing({ x: 0, y: 0 }, { x: 0, y: 300 }, target)).toBeNull();
    expect(crossing({ x: 150, y: 0 }, { x: 150, y: 300 }, target)).toBeCloseTo(1 / 3);
    const response = lightResponse(target, { ...key, x: 150, y: 150 }, []);
    expect(response.strength).toBe(1);
    expect(response.edges).toEqual([0, 0, 0, 0]);
    expect(Number.isFinite(response.shadow.x)).toBe(true);
  });
});

import { describe, expect, it } from "vite-plus/test";

import {
  SESSION_CURSOR_GLIDE_MAX_MS,
  SESSION_CURSOR_GLIDE_MIN_PX,
  SESSION_CURSOR_LABEL_PIN_MS,
  pointDistance,
  sessionCursorGlideMs,
} from "./session-cursor-motion";

describe("sessionCursorGlideMs", () => {
  it("is zero for nothing to travel, under reduced motion, and for a distance that is not a number", () => {
    expect(sessionCursorGlideMs(0, false)).toBe(0);
    expect(sessionCursorGlideMs(SESSION_CURSOR_GLIDE_MIN_PX - 1, false)).toBe(0);
    expect(sessionCursorGlideMs(400, true)).toBe(0);
    expect(sessionCursorGlideMs(Number.NaN, false)).toBe(0);
    expect(sessionCursorGlideMs(Number.POSITIVE_INFINITY, false)).toBe(0);
  });

  it("scales with distance from a short floor and caps at the ceiling", () => {
    const short = sessionCursorGlideMs(20, false);
    const medium = sessionCursorGlideMs(300, false);
    const far = sessionCursorGlideMs(2_000, false);
    expect(short).toBeGreaterThan(0);
    expect(medium).toBeGreaterThan(short);
    expect(far).toBe(SESSION_CURSOR_GLIDE_MAX_MS);
    expect(medium).toBeLessThanOrEqual(SESSION_CURSOR_GLIDE_MAX_MS);
  });

  it("keeps the ceiling at the ticket's bound and the pin long enough to read", () => {
    expect(SESSION_CURSOR_GLIDE_MAX_MS).toBe(250);
    expect(SESSION_CURSOR_LABEL_PIN_MS).toBeGreaterThan(1_000);
  });
});

describe("pointDistance", () => {
  it("is the straight line between two points", () => {
    expect(pointDistance({ x: 0, y: 0 }, { x: 3, y: 4 })).toBe(5);
    expect(pointDistance({ x: 3, y: 4 }, { x: 3, y: 4 })).toBe(0);
  });
});

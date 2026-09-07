import { describe, expect, it } from "vite-plus/test";

import { MODEL_MARK_TINTS } from "./model-mark-color";

describe("MODEL_MARK_TINTS", () => {
  it("is one palette of literal hex, since a vendor's identity is not a theme token", () => {
    for (const [key, tint] of Object.entries(MODEL_MARK_TINTS)) {
      expect(tint, key).toMatch(/^#[0-9A-F]{6}$/);
    }
  });

  it("gives the account and its family one colour, so either name finds the same row", () => {
    expect(MODEL_MARK_TINTS.gemini).toBe(MODEL_MARK_TINTS.google);
  });

  it("stays low-chroma, so no mark reads as Volli's own ember accent", () => {
    // The rule `harness-identity.tsx` records, asserted rather than trusted:
    // the widest channel gap is what saturation looks like in hex, and a
    // vendor's own saturated brand colour clears this by a wide margin.
    for (const [key, tint] of Object.entries(MODEL_MARK_TINTS)) {
      const channels = [1, 3, 5].map((at) => Number.parseInt(tint.slice(at, at + 2), 16));
      expect(Math.max(...channels) - Math.min(...channels), key).toBeLessThanOrEqual(0x60);
    }
  });
});

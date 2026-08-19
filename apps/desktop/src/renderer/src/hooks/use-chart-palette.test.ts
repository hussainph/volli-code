import { describe, expect, it } from "vite-plus/test";

import { usableToken } from "./use-chart-palette";

/**
 * The renderer test project runs under vitest's default `node` environment, so
 * there is no document to read tokens off and no `MutationObserver` to fire —
 * the same constraint `theme/apply.test.ts` works around with a stand-in. What
 * is worth pinning here is the decision the hook makes about a reading it does
 * not like, because the failure mode is not a wrong colour: `hexToRgb` throws,
 * and an unguarded token would take the whole empty chat down with it.
 */
describe("usableToken", () => {
  const FALLBACK = "#1a1210";

  it("takes a hex token exactly as the generator writes it", () => {
    expect(usableToken("#d37550", FALLBACK)).toBe("#d37550");
  });

  it("takes the shorthand and the whitespace getPropertyValue leaves behind", () => {
    expect(usableToken("#abc", FALLBACK)).toBe("#abc");
    expect(usableToken("  #d37550  ", FALLBACK)).toBe("#d37550");
  });

  it("falls back rather than throwing on a colour space the math cannot parse", () => {
    // Every one of these is a legal CSS colour and none of them is a hex —
    // `hexToRgb` throws on all four, which in a render is a blank surface.
    expect(usableToken("oklch(0.7 0.15 40)", FALLBACK)).toBe(FALLBACK);
    expect(usableToken("color-mix(in oklch, red, blue)", FALLBACK)).toBe(FALLBACK);
    expect(usableToken("rgb(211 117 80)", FALLBACK)).toBe(FALLBACK);
    expect(usableToken("rebeccapurple", FALLBACK)).toBe(FALLBACK);
  });

  it("falls back on a token that is not there at all", () => {
    // `getPropertyValue` answers "" for an unset custom property; the nullish
    // arms are for a caller that has no reading rather than an empty one.
    expect(usableToken("", FALLBACK)).toBe(FALLBACK);
    expect(usableToken(null, FALLBACK)).toBe(FALLBACK);
    expect(usableToken(undefined, FALLBACK)).toBe(FALLBACK);
  });
});

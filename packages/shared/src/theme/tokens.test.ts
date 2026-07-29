import { describe, expect, it } from "vite-plus/test";

import { HUE_LOCKED_TOKENS, isThemeTokenName, THEME_TOKEN_NAMES } from "./tokens";

describe("the token registry", () => {
  it("names every token exactly once", () => {
    expect(new Set(THEME_TOKEN_NAMES).size).toBe(THEME_TOKEN_NAMES.length);
  });

  // A token the generator emits but the registry doesn't name keeps whatever
  // `globals.css` last had, forever and silently — the failure CLAUDE.md's
  // "add any new color token to THEME_TOKEN_NAMES" rule exists to prevent.
  it("recognizes a registered token and nothing else", () => {
    for (const name of THEME_TOKEN_NAMES) expect(isThemeTokenName(name)).toBe(true);
    expect(isThemeTokenName("--not-a-token")).toBe(false);
    expect(isThemeTokenName("--background ")).toBe(false);
    expect(isThemeTokenName("")).toBe(false);
  });

  it("locks only tokens the registry names", () => {
    for (const name of HUE_LOCKED_TOKENS) expect(isThemeTokenName(name)).toBe(true);
  });
});

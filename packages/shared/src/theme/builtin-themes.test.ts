import { describe, expect, it } from "vite-plus/test";

import { BUILTIN_THEME_SLUGS, isBuiltinThemeSlug, rejectReservedThemeSlug } from "./builtin-themes";

describe("isBuiltinThemeSlug", () => {
  it("recognizes every shipped slug", () => {
    for (const slug of BUILTIN_THEME_SLUGS) {
      expect(isBuiltinThemeSlug(slug)).toBe(true);
    }
  });

  it("rejects custom slugs", () => {
    expect(isBuiltinThemeSlug("sunset")).toBe(false);
    expect(isBuiltinThemeSlug("ember-copy")).toBe(false);
  });
});

describe("rejectReservedThemeSlug", () => {
  it("throws for a built-in slug", () => {
    expect(() => rejectReservedThemeSlug("ember")).toThrow(/reserved for a built-in theme/i);
  });

  it("allows a custom slug", () => {
    expect(() => rejectReservedThemeSlug("sunset")).not.toThrow();
  });
});

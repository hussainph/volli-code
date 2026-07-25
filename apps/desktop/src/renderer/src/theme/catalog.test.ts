import { describe, expect, it } from "vite-plus/test";
import { BUILTIN_THEME_SLUGS, DEFAULT_THEME, type ThemeDefinition } from "@volli/shared";

import { BUILTIN_THEMES, mergeThemeCatalog } from "./catalog";

function custom(slug: string): ThemeDefinition {
  return { ...DEFAULT_THEME, name: slug, slug };
}

describe("BUILTIN_THEMES", () => {
  it("lists the same slugs as the shared reserved set", () => {
    expect(BUILTIN_THEMES.map((theme) => theme.slug).toSorted()).toEqual(
      [...BUILTIN_THEME_SLUGS].toSorted(),
    );
  });
});

describe("mergeThemeCatalog", () => {
  it("appends custom themes after built-ins", () => {
    const merged = mergeThemeCatalog(BUILTIN_THEMES, [custom("sunset")]);

    expect(merged.map((theme) => theme.slug)).toEqual([
      ...BUILTIN_THEMES.map((theme) => theme.slug),
      "sunset",
    ]);
  });

  it("omits a custom theme whose slug collides with a built-in", () => {
    const forged = { ...DEFAULT_THEME, name: "Forged", slug: "ember", seed: "#000000" };
    const merged = mergeThemeCatalog(BUILTIN_THEMES, [forged, custom("sunset")]);

    expect(merged.filter((theme) => theme.slug === "ember")).toHaveLength(1);
    expect(merged.map((theme) => theme.slug)).toContain("sunset");
    expect(merged.find((theme) => theme.slug === "ember")?.seed).toBe(DEFAULT_THEME.seed);
  });
});

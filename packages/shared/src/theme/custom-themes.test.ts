import { describe, expect, it } from "vite-plus/test";

import { DEFAULT_THEME } from "./definition";
import {
  customThemePath,
  isValidThemeSlug,
  serializeThemeFile,
  themeSlugFromFileName,
  volliThemesDir,
} from "./custom-themes";
import { parseThemeJson } from "./persistence";

describe("volliThemesDir", () => {
  it("is one directory under the userData root", () => {
    expect(volliThemesDir("/Users/u/Library/Application Support/Volli Code")).toBe(
      "/Users/u/Library/Application Support/Volli Code/volli/themes",
    );
  });

  it("builds the same path with or without a trailing slash", () => {
    expect(volliThemesDir("/data/")).toBe(volliThemesDir("/data"));
  });
});

describe("isValidThemeSlug", () => {
  it("accepts what slugify itself produces", () => {
    for (const slug of ["ember", "tokyo-night", "one-dark-2", "x"]) {
      expect(isValidThemeSlug(slug)).toBe(true);
    }
  });

  // The whole security boundary: none of these is a slugify fixed point, so
  // none of them can name a file at all.
  it("rejects anything that could escape the themes directory", () => {
    for (const slug of [
      "",
      "..",
      "../evil",
      "../../.config/ghostty/config",
      "/etc/passwd",
      "..\\evil",
      "a/b",
      "~/x",
      ".hidden",
      "trailing-",
      "Ember",
      "with space",
      "x".repeat(49),
    ]) {
      expect(isValidThemeSlug(slug)).toBe(false);
    }
  });
});

describe("customThemePath", () => {
  it("names one JSON file per theme, by slug", () => {
    expect(customThemePath("/data", "tokyo-night")).toBe("/data/volli/themes/tokyo-night.json");
  });

  // Throwing rather than returning a path is what makes a rejected slug one no
  // filesystem call was ever built from; the main-process caller turns this
  // into a typed error.
  it("throws rather than building a path from an invalid slug", () => {
    expect(() => customThemePath("/data", "../evil")).toThrow(/invalid theme slug/i);
  });
});

describe("themeSlugFromFileName", () => {
  it("reads the slug off a theme file's name", () => {
    expect(themeSlugFromFileName("tokyo-night.json")).toBe("tokyo-night");
  });

  it("is null for anything that isn't a theme file", () => {
    for (const name of ["notes.txt", ".DS_Store", "..json", "Ember.json", ".json"]) {
      expect(themeSlugFromFileName(name)).toBeNull();
    }
  });
});

describe("serializeThemeFile", () => {
  it("round-trips an authored theme", () => {
    expect(parseThemeJson(serializeThemeFile(DEFAULT_THEME))).toEqual(DEFAULT_THEME);
  });

  it("is pretty-printed and newline-terminated, because this file is meant to be opened", () => {
    const text = serializeThemeFile(DEFAULT_THEME);

    expect(text).toContain('\n  "slug": "ember"');
    expect(text.endsWith("}\n")).toBe(true);
  });

  // The same rule `serializeGlobalTheme` enforces, at the second storage
  // surface: a resolved token set cannot reach a theme file either.
  it("writes only the authored shape, whatever the caller passes", () => {
    const smuggled = { ...DEFAULT_THEME, tokens: { "--background": "#000" } };

    expect(JSON.parse(serializeThemeFile(smuggled))).toEqual(DEFAULT_THEME);
  });
});

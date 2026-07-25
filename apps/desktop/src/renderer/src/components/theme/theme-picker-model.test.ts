import { describe, expect, it } from "vite-plus/test";
import { DEFAULT_THEME, type ThemeDefinition } from "@volli/shared";

import {
  MAX_RECENT_THEMES,
  buildThemePickerGroups,
  deriveThemeTags,
  noteRecentTheme,
  themeHueFamily,
  themeForRowKey,
  toggleFavoriteTheme,
} from "./theme-picker-model";

const theme = (name: string, slug: string, seed: string): ThemeDefinition => ({
  ...DEFAULT_THEME,
  name,
  slug,
  seed,
});

const EMBER = theme("Ember", "ember", "#e8652a");
const MIDNIGHT = theme("Midnight", "midnight", "#4c6ef5");
const MOSS = theme("Moss", "moss", "#3f9142");
const GRAPHITE = theme("Graphite", "graphite", "#8a8a8a");
const THEMES = [EMBER, MIDNIGHT, MOSS, GRAPHITE];

const build = (over: Partial<Parameters<typeof buildThemePickerGroups>[0]> = {}) =>
  buildThemePickerGroups({ themes: THEMES, favorites: [], recents: [], query: "", ...over });

describe("themeHueFamily", () => {
  it("reads the family off the theme's own seed — no hand-maintained tag table", () => {
    expect(themeHueFamily(EMBER)).toBe("warm");
    expect(themeHueFamily(MIDNIGHT)).toBe("cool");
    expect(themeHueFamily(MOSS)).toBe("cool");
    expect(themeHueFamily(theme("Rose", "rose", "#f43f5e"))).toBe("warm");
  });

  it("calls a seed with no usable chroma neutral", () => {
    expect(themeHueFamily(GRAPHITE)).toBe("neutral");
  });

  it("follows an unlocked accent, which is the hue the eye actually names", () => {
    // Cool grey chrome with a warm accent (#75's one unlockable case).
    expect(themeHueFamily({ ...GRAPHITE, accent: "#e8652a" })).toBe("warm");
  });
});

describe("deriveThemeTags", () => {
  it("chips the appearance and the hue family", () => {
    expect(deriveThemeTags(EMBER)).toEqual([
      { kind: "appearance", label: "Dark" },
      { kind: "hue", label: "Warm" },
    ]);
  });

  it("tracks the theme's own appearance field", () => {
    const light = { ...MIDNIGHT, appearance: "light" as const };
    expect(deriveThemeTags(light)[0]).toEqual({ kind: "appearance", label: "Light" });
  });
});

describe("buildThemePickerGroups", () => {
  it("lists everything under All when nothing is favorited or recent", () => {
    const groups = build();

    expect(groups.map((group) => group.key)).toEqual(["all"]);
    expect(groups[0]?.rows.map((row) => row.theme.slug)).toEqual([
      "ember",
      "midnight",
      "moss",
      "graphite",
    ]);
  });

  it("pins Favorites and Recent above All (#73)", () => {
    const groups = build({ favorites: ["moss"], recents: ["midnight"] });

    expect(groups.map((group) => group.key)).toEqual(["favorites", "recent", "all"]);
    expect(groups[0]?.rows.map((row) => row.theme.slug)).toEqual(["moss"]);
    expect(groups[1]?.rows.map((row) => row.theme.slug)).toEqual(["midnight"]);
  });

  it("keeps a pinned theme in All too — the full list stays complete", () => {
    const groups = build({ favorites: ["moss"] });
    const all = groups.find((group) => group.key === "all");

    expect(all?.rows.map((row) => row.theme.slug)).toContain("moss");
  });

  it("does not repeat a favorite under Recent", () => {
    const groups = build({ favorites: ["moss"], recents: ["moss", "midnight"] });

    expect(
      groups.find((group) => group.key === "recent")?.rows.map((row) => row.theme.slug),
    ).toEqual(["midnight"]);
  });

  it("orders Recent most-recent-first and caps it", () => {
    const recents = ["graphite", "moss", "midnight", "ember"];
    const groups = buildThemePickerGroups({
      themes: THEMES,
      favorites: [],
      recents,
      query: "",
      recentLimit: 2,
    });

    expect(
      groups.find((group) => group.key === "recent")?.rows.map((row) => row.theme.slug),
    ).toEqual(["graphite", "moss"]);
  });

  it("ignores a recent or favorite slug whose theme is gone", () => {
    const groups = build({ favorites: ["deleted"], recents: ["also-deleted"] });

    expect(groups.map((group) => group.key)).toEqual(["all"]);
  });

  it("marks favorites on every row that shows them", () => {
    const groups = build({ favorites: ["moss"] });
    const all = groups.find((group) => group.key === "all");

    expect(all?.rows.find((row) => row.theme.slug === "moss")?.favorite).toBe(true);
    expect(all?.rows.find((row) => row.theme.slug === "ember")?.favorite).toBe(false);
  });

  it("gives every row a key unique across groups", () => {
    const groups = build({ favorites: ["moss"], recents: ["midnight"] });
    const keys = groups.flatMap((group) => group.rows.map((row) => row.key));

    expect(new Set(keys).size).toBe(keys.length);
  });

  it("filters by name, case-insensitively", () => {
    const groups = build({ query: "MID" });

    expect(groups.flatMap((group) => group.rows.map((row) => row.theme.slug))).toEqual([
      "midnight",
    ]);
  });

  it("filters by derived tag, so the chips are searchable", () => {
    const groups = build({ query: "neutral" });

    expect(groups.flatMap((group) => group.rows.map((row) => row.theme.slug))).toEqual([
      "graphite",
    ]);
  });

  it("requires every search term to match", () => {
    expect(build({ query: "dark warm" }).flatMap((g) => g.rows.map((r) => r.theme.slug))).toEqual([
      "ember",
    ]);
    expect(build({ query: "ember midnight" })).toEqual([]);
  });

  it("drops groups a filter empties, rather than showing an empty heading", () => {
    const groups = build({ favorites: ["moss"], query: "midnight" });

    expect(groups.map((group) => group.key)).toEqual(["all"]);
  });
});

describe("themeForRowKey", () => {
  it("resolves the row a selection names, so preview can follow the highlight", () => {
    const groups = build({ favorites: ["moss"] });

    expect(themeForRowKey(groups, "favorites:moss")).toEqual(MOSS);
    expect(themeForRowKey(groups, "all:ember")).toEqual(EMBER);
    expect(themeForRowKey(groups, "all:nope")).toBeUndefined();
  });
});

describe("toggleFavoriteTheme", () => {
  it("adds and removes", () => {
    expect(toggleFavoriteTheme([], "moss")).toEqual(["moss"]);
    expect(toggleFavoriteTheme(["moss", "ember"], "moss")).toEqual(["ember"]);
  });

  it("never duplicates", () => {
    expect(toggleFavoriteTheme(["moss"], "ember")).toEqual(["moss", "ember"]);
  });
});

describe("noteRecentTheme", () => {
  it("moves a re-applied theme back to the front instead of duplicating it", () => {
    expect(noteRecentTheme(["moss", "ember"], "ember")).toEqual(["ember", "moss"]);
  });

  it("caps the list", () => {
    const many = Array.from({ length: MAX_RECENT_THEMES + 4 }, (_unused, index) => `t${index}`);
    const noted = noteRecentTheme(many, "fresh");

    expect(noted).toHaveLength(MAX_RECENT_THEMES);
    expect(noted[0]).toBe("fresh");
  });
});

import { describe, expect, it } from "vite-plus/test";
import { DEFAULT_THEME, slugify, type ThemeDefinition } from "@volli/shared";

import {
  beginThemeDuplicate,
  beginThemeEdit,
  duplicateTheme,
  GRAIN_RANGE,
  withAccent,
  withAccentUnlocked,
  withGrain,
  withName,
  withSeed,
  swatchColor,
  type ThemeDraft,
} from "./theme-editor-model";

/** A theme the user owns — one that came back from the custom-theme catalog. */
const MINE: ThemeDefinition = {
  ...DEFAULT_THEME,
  name: "Ember Copy",
  slug: "ember-copy",
  seed: "#d94f1f",
};

describe("beginThemeEdit", () => {
  it("duplicates a built-in rather than editing it, leaving the built-in untouched", () => {
    const before = structuredClone(DEFAULT_THEME);

    const draft = beginThemeEdit({ source: DEFAULT_THEME, owned: [], catalog: [DEFAULT_THEME] });

    expect(draft.duplicated).toBe(true);
    expect(draft.theme.slug).not.toBe(DEFAULT_THEME.slug);
    expect(draft.theme.seed).toBe(DEFAULT_THEME.seed);
    expect(DEFAULT_THEME).toEqual(before);
  });

  it("edits a theme the user owns in place, keeping its slug", () => {
    const draft = beginThemeEdit({ source: MINE, owned: [MINE], catalog: [DEFAULT_THEME, MINE] });

    expect(draft.duplicated).toBe(false);
    expect(draft.theme.slug).toBe(MINE.slug);
    expect(draft.theme.name).toBe(MINE.name);
  });

  it("never hands back the source object itself, so an edit cannot reach the catalog entry", () => {
    const draft = beginThemeEdit({ source: MINE, owned: [MINE], catalog: [MINE] });

    expect(draft.theme).not.toBe(MINE);
    expect(draft.theme.overrides).not.toBe(MINE.overrides);
  });

  it("duplicates a built-in even when a custom file shares its slug", () => {
    const forged = { ...DEFAULT_THEME, name: "Forged Ember", seed: "#000000" };
    const draft = beginThemeEdit({
      source: DEFAULT_THEME,
      owned: [forged],
      catalog: [DEFAULT_THEME, forged],
    });

    expect(draft.duplicated).toBe(true);
    expect(draft.theme.slug).not.toBe(DEFAULT_THEME.slug);
    expect(draft.theme.seed).toBe(DEFAULT_THEME.seed);
  });
});

describe("beginThemeDuplicate", () => {
  it("always produces a new slug, even for a theme the user owns", () => {
    const draft = beginThemeDuplicate({ source: MINE, catalog: [DEFAULT_THEME, MINE] });

    expect(draft.duplicated).toBe(true);
    expect(draft.theme.slug).not.toBe(MINE.slug);
    expect(draft.theme.seed).toBe(MINE.seed);
  });
});

/** An open edit on a theme the user already owns. */
function draftOf(theme: ThemeDefinition): ThemeDraft {
  return beginThemeEdit({ source: theme, owned: [theme], catalog: [theme] });
}

describe("editing a draft", () => {
  it("takes a seed only once it is a color the generator can parse", () => {
    const draft = draftOf(MINE);

    expect(withSeed(draft, "#0af")?.theme.seed).toBe("#0af");
    expect(withSeed(draft, "#00aaff")?.theme.seed).toBe("#00aaff");
    // Mid-typing: `#00aa` is where a hex field spends most of its life, and
    // the generator THROWS on one — a preview must never be asked to paint it.
    expect(withSeed(draft, "#00aa")).toBeNull();
    expect(withSeed(draft, "")).toBeNull();
    expect(withSeed(draft, "rebeccapurple")).toBeNull();
  });

  it("unlocks the accent at the seed's own color, so nothing jumps on the way in", () => {
    const unlocked = withAccentUnlocked(draftOf(MINE), true);

    expect(unlocked.theme.accent).toBe(MINE.seed);
    expect(withAccentUnlocked(unlocked, false).theme.accent).toBeNull();
  });

  it("remembers an unlocked accent across a re-lock, so the toggle is not destructive", () => {
    const chosen = withAccent(withAccentUnlocked(draftOf(MINE), true), "#8b5cf6");
    const relocked = withAccentUnlocked(chosen!, false);

    expect(relocked.theme.accent).toBeNull();
    expect(withAccentUnlocked(relocked, true).theme.accent).toBe("#8b5cf6");
  });

  it("holds the accent still while its hex field is mid-typing", () => {
    expect(withAccent(withAccentUnlocked(draftOf(MINE), true), "#8b5c")).toBeNull();
  });

  it("keeps the remembered accent when the disclosure is closed twice", () => {
    const chosen = withAccent(withAccentUnlocked(draftOf(MINE), true), "#8b5cf6")!;
    const locked = withAccentUnlocked(withAccentUnlocked(chosen, false), false);

    expect(locked.lastAccent).toBe("#8b5cf6");
  });

  it("clamps grain to the slider's own range", () => {
    const draft = draftOf(MINE);

    expect(withGrain(draft, 0.5).theme.grain).toBe(0.5);
    expect(withGrain(draft, 2).theme.grain).toBe(GRAIN_RANGE.max);
    expect(withGrain(draft, -1).theme.grain).toBe(GRAIN_RANGE.min);
  });

  it("renames without moving the slug, because the slug is the theme's identity", () => {
    const renamed = withName(draftOf(MINE), "Sunset");

    expect(renamed.theme.name).toBe("Sunset");
    expect(renamed.theme.slug).toBe(MINE.slug);
  });
});

describe("swatchColor", () => {
  it("expands a short hex, because a native color input silently blacks one out", () => {
    expect(swatchColor("#0af")).toBe("#00aaff");
    expect(swatchColor("#00AAFF")).toBe("#00aaff");
  });

  it("falls back to black for anything unparseable rather than throwing at render", () => {
    expect(swatchColor("#00aa")).toBe("#000000");
  });
});

describe("duplicateTheme", () => {
  it("keeps duplicating past a name already taken", () => {
    const first = duplicateTheme(DEFAULT_THEME, [DEFAULT_THEME]);
    const second = duplicateTheme(DEFAULT_THEME, [DEFAULT_THEME, first]);
    const third = duplicateTheme(DEFAULT_THEME, [DEFAULT_THEME, first, second]);

    expect(first.slug).toBe("ember-copy");
    expect(second.slug).toBe("ember-copy-2");
    expect(second.name).toBe("Ember Copy 2");
    expect(third.slug).toBe("ember-copy-3");
  });

  it("finds a unique slug when long names collapse under slugify's length cap", () => {
    const longName = "A".repeat(60);
    const source = { ...DEFAULT_THEME, name: longName, slug: "a".repeat(48) };
    const first = duplicateTheme(source, [source]);
    const second = duplicateTheme(source, [source, first]);

    expect(first.slug).not.toBe(source.slug);
    expect(second.slug).not.toBe(first.slug);
    expect(second.slug).not.toBe(source.slug);
  });

  it("falls back to a timestamp slug when every numbered candidate is taken", () => {
    const source = { ...DEFAULT_THEME, name: "X", slug: "x" };
    const base = "X Copy";
    const stem = slugify(base).replace(/-+$/, "").slice(0, 40);
    const catalog: ThemeDefinition[] = [{ ...DEFAULT_THEME, name: base, slug: slugify(base) }];
    for (let n = 2; n < 100; n += 1) {
      catalog.push({ ...DEFAULT_THEME, name: `${base} ${n}`, slug: slugify(`${base} ${n}`) });
    }
    for (let n = 2; n < 1000; n += 1) {
      catalog.push({ ...DEFAULT_THEME, name: `stem ${n}`, slug: `${stem}-${n}` });
    }

    const copy = duplicateTheme(source, catalog);

    expect(copy.slug).toMatch(new RegExp(`^${slugify(base).slice(0, 36)}-\\d+$`));
    expect(copy.name).toBe(base);
  });
});

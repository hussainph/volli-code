import { describe, expect, it } from "vite-plus/test";

import {
  chooseSuggestedIdentity,
  GLYPH_CATALOG,
  glyphChoice,
  isGlyphName,
  proceduralStamp,
  suggestGlyphs,
  type GlyphName,
  type IdentityChoice,
  type StampGrid,
} from "./model";

/** The catalog's exact universe, spelled out so the curated bound is a test. */
const CURATED_CODES = [
  "code",
  "tree",
  "leaf",
  "mountains",
  "flame",
  "sparkle",
  "planet",
  "moon",
  "rocket",
  "paper-plane",
  "scroll",
  "book-open",
  "archive",
  "package",
  "git-branch",
  "circuitry",
  "atom",
  "music-notes",
  "waves",
  "coffee",
  "bird",
  "flower",
  "compass",
  "diamond",
] as const;

/** Every suggestion must be three distinct, genuinely cataloged glyph names. */
function expectSuggestionShape(suggestions: readonly GlyphName[]): void {
  expect(suggestions).toHaveLength(3);
  expect(new Set(suggestions).size).toBe(3);
  for (const glyph of suggestions) expect(isGlyphName(glyph)).toBe(true);
}

/** The stamp contract: 5×5 booleans, mirrored, never blank. */
function expectStampShape(grid: StampGrid): void {
  expect(grid).toHaveLength(5);
  for (const row of grid) {
    expect(row).toHaveLength(5);
    for (const cell of row) expect(typeof cell).toBe("boolean");
  }
  for (let y = 0; y < grid.length; y += 1) {
    const cells = grid[y]!;
    for (let x = 0; x < cells.length; x += 1) expect(cells[x]).toBe(cells[4 - x]);
  }
  expect(grid.some((row) => row.some((filled) => filled))).toBe(true);
}

describe("GLYPH_CATALOG", () => {
  it("bounds glyph choices to exactly the 24 curated Phosphor names", () => {
    const names = GLYPH_CATALOG.map((entry) => entry.name);
    expect(names).toHaveLength(24);
    expect(new Set(names).size).toBe(24);
    expect(names.toSorted()).toEqual(CURATED_CODES.toSorted());
  });

  it("gives every entry a label and at least one usable keyword", () => {
    for (const entry of GLYPH_CATALOG) {
      expect(entry.label.trim()).not.toBe("");
      expect(entry.keywords.length).toBeGreaterThan(0);
      for (const keyword of entry.keywords) {
        expect(keyword.trim()).not.toBe("");
        expect(keyword).toBe(keyword.toLowerCase());
      }
    }
  });

  it("recognizes exactly its own codes, not near misses", () => {
    for (const code of CURATED_CODES) expect(isGlyphName(code)).toBe(true);
    for (const near of ["Code", "codes", "sparkles", "paperplane", "paper plane", " rocket", ""]) {
      expect(isGlyphName(near)).toBe(false);
    }
  });
});

describe("suggestGlyphs", () => {
  it("leads with the semantic match for named projects", () => {
    expect(suggestGlyphs("Canopy")).toEqual(["tree", "code", "leaf"]);
    expect(suggestGlyphs("Paper Trail")).toEqual(["scroll", "paper-plane", "code"]);
    expect(suggestGlyphs("Cinder")).toEqual(["flame", "code", "tree"]);
    expect(suggestGlyphs("Volli Code")).toEqual(["code", "tree", "leaf"]);
  });

  it("ranks a stronger semantic match above a weaker one", () => {
    // "scroll" matches both of the name's tokens; "paper-plane" only one.
    expect(suggestGlyphs("Paper Trail")[0]).toBe("scroll");
    expect(suggestGlyphs("Paper Trail")[1]).toBe("paper-plane");
  });

  it("de-prioritizes a used glyph without excluding it when it is the match", () => {
    // Equal relevance: the unused "atom" overtakes the taken "moon", which
    // stays suggested rather than vanishing.
    expect(suggestGlyphs("Moon Lab")).toEqual(["moon", "atom", "code"]);
    expect(suggestGlyphs("Moon Lab", ["moon"])).toEqual(["atom", "moon", "code"]);
    // Stronger relevance wins even when taken: "scroll" is still Paper
    // Trail's best match, taken or not — semantic matches are never pushed
    // out of the suggestions entirely.
    expect(suggestGlyphs("Paper Trail", ["scroll"])).toEqual(["scroll", "paper-plane", "code"]);
  });

  it("stays unique and deterministic under collision", () => {
    const names = ["Canopy", "Paper Trail", "Cinder", "Volli Code", "Moon Lab", "", "zzz"];
    const everyGlyph = GLYPH_CATALOG.map((entry) => entry.name);
    for (const used of [[], ["code", "tree", "leaf"], everyGlyph] as const) {
      for (const name of names) {
        const suggestions = suggestGlyphs(name, used);
        expectSuggestionShape(suggestions);
        expect(suggestGlyphs(name, used)).toEqual(suggestions);
      }
    }
    // Even with all 24 glyphs taken, three unique suggestions come back.
    expect(suggestGlyphs("Canopy", everyGlyph)).toEqual(["tree", "code", "leaf"]);
  });

  it("falls back deterministically for unknown and empty names", () => {
    expect(suggestGlyphs("")).toEqual(["code", "tree", "leaf"]);
    expect(suggestGlyphs("zzz qqq")).toEqual(suggestGlyphs(""));
    expect(suggestGlyphs("!!!")).toEqual(suggestGlyphs(""));
    // Used glyphs lose the fallback slots to fresh ones.
    expect(suggestGlyphs("", ["code", "tree", "leaf"])).toEqual(["mountains", "flame", "sparkle"]);
  });
});

describe("chooseSuggestedIdentity", () => {
  it("returns the first glyph suggestion as the choice", () => {
    expect(chooseSuggestedIdentity("Canopy")).toEqual({ kind: "glyph", name: "tree" });
  });

  it("still lands on a glyph for unknown names, matching the suggestion", () => {
    const suggestions = suggestGlyphs("???");
    expect(chooseSuggestedIdentity("???")).toEqual({ kind: "glyph", name: suggestions[0] });
  });
});

describe("glyphChoice", () => {
  it("accepts every catalog name as a glyph choice", () => {
    for (const code of CURATED_CODES) {
      expect(glyphChoice(code)).toEqual({ kind: "glyph", name: code });
    }
  });

  it("falls back to initials for anything outside the catalog", () => {
    for (const invalid of [
      "",
      "Code",
      "codes",
      "sparkles",
      "paper plane",
      " moon ",
      "rocketship",
    ]) {
      expect(glyphChoice(invalid)).toEqual({ kind: "initials" });
    }
  });

  it("hands back a fresh value each call, with no shared cell to alias", () => {
    const first = glyphChoice("code");
    expect(glyphChoice("code")).toEqual(first);
    expect(glyphChoice("code")).not.toBe(first);
    if (first.kind === "glyph") first.name = "tree";
    expect(glyphChoice("code")).toEqual({ kind: "glyph", name: "code" });
  });
});

describe("proceduralStamp", () => {
  const sweep = ["", "ws-1", "ws-7", "canopy", "paper-trail", "zzz", "0"] as const;
  const variants = [0, 1, 2, 3] as const;

  it("reproduces the same grid for the same seed and variant", () => {
    for (const seed of sweep) {
      for (const variant of variants) {
        const grid = proceduralStamp(seed, variant);
        proceduralStamp("unrelated", 9);
        expect(proceduralStamp(seed, variant)).toEqual(grid);
      }
    }
  });

  it("stays a compact 5×5 mirrored grid with at least one filled cell", () => {
    for (const seed of sweep) {
      for (const variant of variants) expectStampShape(proceduralStamp(seed, variant));
    }
  });

  it("varies across seeds and variants", () => {
    const seeds = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k", "l"];
    const grids = seeds.map((seed) => JSON.stringify(proceduralStamp(seed, 0)));
    expect(new Set(grids).size).toBe(seeds.length);
    const versions = [0, 1, 2, 3, 4].map((variant) =>
      JSON.stringify(proceduralStamp("vc-489", variant)),
    );
    expect(new Set(versions).size).toBe(versions.length);
    expect(proceduralStamp("canopy", 0)).not.toEqual(proceduralStamp("canopy", 1));
    expect(proceduralStamp("ws-7", 1)).not.toEqual(proceduralStamp("ws-8", 1));
  });

  it("follows the seed, never the name", () => {
    // The choice stores the stable seed (a workspace id); renaming the
    // workspace re-derives the identical grid, and a different id draws
    // differently. Nothing here reads a project name.
    const choice: IdentityChoice = { kind: "stamp", seed: "ws-7", variant: 1 };
    const before = proceduralStamp(choice.seed, choice.variant);
    expectStampShape(before);
    expect(proceduralStamp(choice.seed, choice.variant)).toEqual(before);
    expect(proceduralStamp("ws-8", 1)).not.toEqual(before);
  });
});

describe("no hidden state across renames", () => {
  it("keeps an existing choice when the workspace is renamed", () => {
    const original = chooseSuggestedIdentity("Canopy");
    // Other workspaces ask for suggestions; the renamed workspace asks fresh.
    suggestGlyphs("Paper Trail");
    suggestGlyphs("Canopy Air");
    expect(chooseSuggestedIdentity("Canopy")).toEqual(original);
    // And the rename itself only changes what a NEW choice would be; the
    // already-made choice is untouched.
    expect(original).toEqual({ kind: "glyph", name: "tree" });
    expect(chooseSuggestedIdentity("Ember Works")).toEqual({ kind: "glyph", name: "flame" });
    expect(chooseSuggestedIdentity("Canopy")).toEqual({ kind: "glyph", name: "tree" });
  });

  it("answers the same inputs identically after unrelated calls", () => {
    const first = suggestGlyphs("Cinder");
    suggestGlyphs("Volli Code");
    suggestGlyphs("", ["code"]);
    expect(suggestGlyphs("Cinder")).toEqual(first);
    expect(suggestGlyphs("Cinder")).not.toBe(first);
  });
});

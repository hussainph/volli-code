import { describe, expect, it } from "vite-plus/test";

import {
  chooseSuggestedIdentity,
  GLYPH_CATALOG,
  glyphChoice,
  isGlyphName,
  proceduralStamp,
  parseWorkspaceIdentity,
  type WorkspaceIdentity,
  suggestGlyphs,
  type GlyphName,
  type IdentityChoice,
  type StampGrid,
} from "./workspace-identity";

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
    expect(suggestGlyphs("Moonshot")[0]).toBe("rocket");
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

function identity(choice: unknown) {
  return { choice, surface: "etched", monogramStyle: "editorial" };
}

describe("parseWorkspaceIdentity", () => {
  it("accepts every material, style, and exact catalog glyph", () => {
    for (const surface of ["etched", "porcelain", "orbit", "letterpress"] as const) {
      for (const monogramStyle of ["editorial", "architect", "woven"] as const) {
        for (const name of CURATED_CODES) {
          const value: WorkspaceIdentity = {
            surface,
            monogramStyle,
            choice: { kind: "glyph", name },
          };
          expect(parseWorkspaceIdentity(value)).toEqual(value);
        }
      }
    }
    expect(parseWorkspaceIdentity(identity({ kind: "initials" }))).toEqual(
      identity({ kind: "initials" }),
    );
  });

  it("copies only safe fields and never aliases the caller's choice", () => {
    const choice = {
      kind: "stamp",
      seed: "  stable-before-project-exists  ",
      variant: 1,
      ignored: "secret",
    };
    const raw = { ...identity(choice), ignored: "secret" };
    const safe = parseWorkspaceIdentity(raw);
    expect(safe).toEqual(identity({ kind: "stamp", seed: choice.seed, variant: 1 }));
    expect(safe).not.toBe(raw);
    expect(safe?.choice).not.toBe(choice);
    choice.seed = "renamed";
    expect(safe?.choice).toMatchObject({ seed: "  stable-before-project-exists  " });
    expect(parseWorkspaceIdentity(identity({ kind: "initials", name: "ignored" }))?.choice).toEqual(
      { kind: "initials" },
    );
  });

  it("rejects malformed objects, materials, styles, and choice discriminants", () => {
    for (const raw of [
      null,
      undefined,
      false,
      1,
      "identity",
      [],
      {},
      { ...identity({ kind: "initials" }), surface: "wood" },
      { ...identity({ kind: "initials" }), monogramStyle: "script" },
      identity(null),
      identity([]),
      identity("initials"),
      identity({}),
      identity({ kind: "remote" }),
    ])
      expect(parseWorkspaceIdentity(raw)).toBeNull();
    for (const name of [undefined, 1, "Code", "code ", "unknown", "__proto__"]) {
      expect(parseWorkspaceIdentity(identity({ kind: "glyph", name }))).toBeNull();
    }
  });

  it("bounds seeds and requires safe nonnegative bounded integer variants", () => {
    for (const seed of ["x", "x".repeat(128)]) {
      for (const variant of [0, 1_000_000]) {
        const value = identity({ kind: "stamp", seed, variant });
        expect(parseWorkspaceIdentity(value)).toEqual(value);
      }
    }
    for (const seed of [undefined, 1, "", "  ", "x".repeat(129)]) {
      expect(parseWorkspaceIdentity(identity({ kind: "stamp", seed, variant: 0 }))).toBeNull();
    }
    for (const variant of [
      undefined,
      "1",
      -1,
      0.1,
      1_000_001,
      NaN,
      Infinity,
      Number.MAX_SAFE_INTEGER + 1,
    ]) {
      expect(
        parseWorkspaceIdentity(identity({ kind: "stamp", seed: "stable", variant })),
      ).toBeNull();
    }
  });

  it("allows only local PNG/JPEG/WebP base64 and caps decoded bytes at 2 MiB", () => {
    for (const type of ["png", "jpeg", "webp"]) {
      for (const payload of ["AAAA", "AAA=", "AA=="]) {
        const value = identity({ kind: "custom", dataUrl: `data:image/${type};base64,${payload}` });
        expect(parseWorkspaceIdentity(value)).toEqual(value);
      }
    }
    // 2 MiB is 2 mod 3: same encoded length, different padding distinguishes
    // exactly the limit from one byte over it.
    const body = "A".repeat(Math.ceil((2 * 1024 * 1024) / 3) * 4 - 1);
    const atLimit = identity({ kind: "custom", dataUrl: `data:image/png;base64,${body}=` });
    expect(parseWorkspaceIdentity(atLimit)).toEqual(atLimit);
    for (const dataUrl of [
      undefined,
      1,
      "https://example.com/icon.png",
      "file:///icon.png",
      "data:image/svg+xml;base64,PHN2Zz4=",
      "data:image/gif;base64,AAAA",
      "data:image/png,AAAA",
      "data:image/png;charset=utf-8;base64,AAAA",
      "data:image/png;base64,",
      "data:image/png;base64,AAA",
      "data:image/png;base64,====",
      "data:image/png;base64,A=AA",
      "data:image/png;base64,AAA\n",
      "data:image/png;base64,A A=",
      `data:image/png;base64,${body}A`,
      `data:image/png;base64,${body}AAAAA`,
    ])
      expect(parseWorkspaceIdentity(identity({ kind: "custom", dataUrl }))).toBeNull();
  });
});

it("gives an otherwise empty procedural stamp a center cell", () => {
  expect(proceduralStamp("empty-3304", 0)).toEqual([
    [false, false, false, false, false],
    [false, false, false, false, false],
    [false, false, true, false, false],
    [false, false, false, false, false],
    [false, false, false, false, false],
  ]);
  expect(proceduralStamp("stable")).toEqual(proceduralStamp("stable", 0));
});

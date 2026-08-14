import { describe, expect, it } from "vite-plus/test";
import { APCAcontrast, sRGBtoY } from "apca-w3";

import { apcaLc, hexToOklch, hexToRgb, oklchToHex } from "./color";
import { DEFAULT_THEME, type ThemeDefinition } from "./definition";
import {
  generateThemeTokens,
  pickAccentLabel,
  solveLightnessForContrast,
  solveLightnessOrCeiling,
  solveStatusTokens,
  THEME_CONTRAST_FLOORS,
} from "./generate";
import {
  HUE_LOCKED_TOKENS,
  THEME_TOKEN_NAMES,
  type ThemeTokenName,
  type ThemeTokens,
} from "./tokens";

describe("generateThemeTokens", () => {
  it("emits exactly the themeable token set", () => {
    const tokens = generateThemeTokens(DEFAULT_THEME);
    expect(Object.keys(tokens).toSorted()).toEqual(THEME_TOKEN_NAMES.toSorted());
  });

  it("emits --primary-text, the accent solved for body copy", () => {
    // --primary is pinned at PRIMARY_LIGHTNESS for its job as a *fill*, which
    // leaves it at Lc 41 as text on --background — fine for icons, below the
    // floor for body copy. --primary-text is the second accent lightness that
    // fixes every such site at once.
    expect(generateThemeTokens(DEFAULT_THEME)["--primary-text"]).toMatch(/^#[0-9a-f]{6}$/);
  });
});

describe("the ember golden", () => {
  // Written out as literals rather than a snapshot file so that any change to
  // the color math shows up as a reviewable colour diff in the PR, not as an
  // obscured `-1 +1` in an artifact nobody opens.
  const EMBER: ThemeTokens = {
    "--rail": "#0f0b09",
    "--background": "#15100e",
    "--card": "#1b1412",
    "--popover": "#1f1816",
    "--secondary": "#211a17",
    "--muted": "#211a17",
    "--accent": "#28201d",
    "--sidebar": "#1b1412",
    "--foreground": "#ebe3df",
    "--card-foreground": "#ebe3df",
    "--popover-foreground": "#ebe3df",
    "--secondary-foreground": "#ebe3df",
    "--muted-foreground": "#b9b0ad",
    "--accent-foreground": "#ebe3df",
    "--sidebar-foreground": "#d3cbc7",
    "--sidebar-accent": "#28201d",
    "--sidebar-accent-foreground": "#ebe3df",
    "--border": "#2d2421",
    "--border-hover": "#3b312d",
    "--border-strong": "#423834",
    "--input": "#2d2421",
    "--sidebar-border": "#29211d",
    "--primary": "#e8652a",
    "--primary-foreground": "#ffffff",
    "--primary-text": "#ff966c",
    "--ring": "#e8652a",
    "--sidebar-primary": "#e8652a",
    "--sidebar-primary-foreground": "#ffffff",
    "--sidebar-ring": "#e8652a",
    "--destructive": "#e5484d",
    "--destructive-foreground": "#ffffff",
    "--positive": "#27d496",
    "--positive-foreground": "#001c10",
    "--attention": "#fea92e",
    "--attention-foreground": "#221200",
    "--info": "#62c5ff",
    "--info-foreground": "#001827",
  };

  it("reproduces the shipped ember theme", () => {
    expect(generateThemeTokens(DEFAULT_THEME)).toEqual(EMBER);
  });

  it("makes the brand accent an exact fixed point of the accent math", () => {
    // The seed goes in, the *same* hex comes back out of `oklch(0.661 C h)`.
    // If this ever breaks, the accent lightness constant has drifted.
    expect(generateThemeTokens(DEFAULT_THEME)["--primary"]).toBe("#e8652a");
  });

  it("keeps today's destructive red exactly", () => {
    expect(generateThemeTokens(DEFAULT_THEME)["--destructive"]).toBe("#e5484d");
  });

  it("pins the ember ladder's background, card and accent rungs", () => {
    const tokens = generateThemeTokens(DEFAULT_THEME);
    expect(tokens["--background"]).toBe("#15100e");
    expect(tokens["--card"]).toBe("#1b1412");
    expect(tokens["--accent"]).toBe("#28201d");
  });
});

/** 360 hues × 5 seed chromas, spanning grey through beyond-sRGB saturation. */
const SEED_SWEEP: string[] = [];
for (let h = 0; h < 360; h += 1) {
  for (const C of [0.01, 0.05, 0.1, 0.15, 0.25]) {
    SEED_SWEEP.push(oklchToHex(0.6, C, h));
  }
}

const themeFor = (seed: string): ThemeDefinition => ({
  ...DEFAULT_THEME,
  seed,
});

const sweep = SEED_SWEEP.map((seed) => ({
  seed,
  tokens: generateThemeTokens(themeFor(seed)),
}));

describe("the generator's guarantees, over 360 hues × 5 chromas", () => {
  it("emits exactly the token set, for every seed", () => {
    const expected = THEME_TOKEN_NAMES.toSorted();
    for (const { tokens } of sweep) {
      expect(Object.keys(tokens).toSorted()).toEqual(expected);
    }
  });

  it("emits only in-sRGB #rrggbb, for every seed", () => {
    for (const { seed, tokens } of sweep) {
      for (const [name, hex] of Object.entries(tokens)) {
        expect(hex, `${name} for seed ${seed}`).toMatch(/^#[0-9a-f]{6}$/);
      }
    }
  });

  it("holds every contrast floor, for every seed", () => {
    for (const { seed, tokens } of sweep) {
      const at = (name: keyof typeof tokens) => tokens[name];
      expect(
        apcaLc(at("--foreground"), at("--background")),
        `--foreground for seed ${seed}`,
      ).toBeGreaterThanOrEqual(90);
      expect(
        apcaLc(at("--muted-foreground"), at("--background")),
        `--muted-foreground for seed ${seed}`,
      ).toBeGreaterThanOrEqual(60);
      expect(
        apcaLc(at("--sidebar-foreground"), at("--sidebar")),
        `--sidebar-foreground for seed ${seed}`,
      ).toBeGreaterThanOrEqual(75);
      expect(
        apcaLc(at("--primary-foreground"), at("--primary")),
        `--primary-foreground for seed ${seed}`,
      ).toBeGreaterThanOrEqual(60);
    }
  });

  it("keeps every border a visible edge in OKLCH ΔL, for every seed", () => {
    // Asserted in ΔL and never in APCA: APCA low-clips below Lc ~10, so it
    // returns a flat 0 for every border/background pair and cannot tell a
    // visible edge from an invisible one.
    const borders = [
      "--border",
      "--input",
      "--border-hover",
      "--border-strong",
      "--sidebar-border",
    ] as const;
    for (const { seed, tokens } of sweep) {
      const backgroundL = hexToOklch(tokens["--background"]).L;
      for (const border of borders) {
        expect(
          hexToOklch(tokens[border]).L - backgroundL,
          `${border} for seed ${seed}`,
        ).toBeGreaterThanOrEqual(0.07);
      }
    }
  });

  it("keeps every border a visible edge on --card too, for every seed", () => {
    // The pair the edge-separation argument actually rests on: borders are
    // drawn on cards far more often than on the page, and --card sits a rung
    // above --background, so this is the tighter of the two tests — passing the
    // one above says nothing about this one.
    //
    // The floor is 0.062 against a measured sweep minimum of 0.0656, at seed
    // #997964 (--border/--input, the lowest border rung); the headroom is
    // 8-bit quantisation of two rungs, same as the --background test's.
    //
    // --sidebar-border is deliberately absent. Its rung (L 0.255) is only 0.055
    // above --card's by construction, so it *cannot* meet this floor — measured
    // minimum 0.0517 at seed #71886b. Moving the ladder to fix that would
    // repaint every shipped theme, so it stays as authored and stays asserted
    // against --background, where it clears comfortably.
    const borders = ["--border", "--input", "--border-hover", "--border-strong"] as const;
    for (const { seed, tokens } of sweep) {
      const cardL = hexToOklch(tokens["--card"]).L;
      for (const border of borders) {
        expect(
          hexToOklch(tokens[border]).L - cardL,
          `${border} on --card for seed ${seed}`,
        ).toBeGreaterThanOrEqual(0.062);
      }
    }
  });

  it("never lets hue perturb the lightness ladder", () => {
    // The whole design rests on this: the ladder is identical for a red seed,
    // a blue seed and a grey seed, so no seed can flatten the UI.
    const rungs: [keyof ThemeTokens, number][] = [
      ["--rail", 0.155],
      ["--background", 0.178],
      ["--card", 0.2],
      ["--popover", 0.218],
      ["--secondary", 0.226],
      ["--accent", 0.252],
      ["--sidebar-border", 0.255],
      ["--border", 0.269],
      ["--border-hover", 0.321],
      ["--border-strong", 0.349],
    ];
    for (const { seed, tokens } of sweep) {
      for (const [name, L] of rungs) {
        // The only permitted deviation is 8-bit quantisation of the emitted
        // hex — well under half a step of the ladder's tightest rung.
        expect(Math.abs(hexToOklch(tokens[name]).L - L), `${name} for seed ${seed}`).toBeLessThan(
          0.004,
        );
      }
    }
  });

  it("pins --destructive regardless of the seed", () => {
    for (const { tokens } of sweep) {
      expect(tokens["--destructive"]).toBe("#e5484d");
      expect(tokens["--destructive-foreground"]).toBe("#ffffff");
    }
  });

  it("holds the accent at its fixed lightness, repairing imperceptibly", () => {
    // The verify/repair pass (step 9) may nudge the accent's lightness where
    // no label clears Lc 60 — saturated mid-greens are the real case. Measured
    // over the sweep it fires for 6 seeds in 1800 and never moves further than
    // ΔL 0.0035, about one 8-bit step. If this bound grows, the repair has
    // started doing something the eye can see and wants re-examining.
    for (const { seed, tokens } of sweep) {
      expect(
        Math.abs(hexToOklch(tokens["--primary"]).L - 0.661),
        `--primary for seed ${seed}`,
      ).toBeLessThan(0.004);
    }
  });
});

/** 8-bit channel triple, the form apca-w3 takes. */
function toBytes(hex: string): [number, number, number] {
  const { r, g, b } = hexToRgb(hex);
  return [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)];
}

/**
 * Lc computed by `apca-w3` itself — the independent oracle. The design doc is
 * explicit that APCA must never be verified against the math under test, and
 * `--primary-text` exists *only* because of an APCA number, so the oracle
 * matters more for it than anywhere else in this file.
 */
function referenceLc(text: string, background: string): number {
  return Math.abs(Number(APCAcontrast(sRGBtoY(toBytes(text)), sRGBtoY(toBytes(background)))));
}

describe("--primary-text, the accent at body-copy contrast", () => {
  it("clears Lc 60 on --background, for every seed", () => {
    // The contract. Measured minimum over the sweep is 60.0001 at seed
    // #bf558e — the solver lands *on* the floor by construction, so there is
    // no headroom here to lose and any regression shows up immediately.
    for (const { seed, tokens } of sweep) {
      expect(
        referenceLc(tokens["--primary-text"], tokens["--background"]),
        `--primary-text for seed ${seed}`,
      ).toBeGreaterThanOrEqual(60);
    }
  });

  it("stays legible on the lighter surfaces it is also drawn on", () => {
    // The token is solved against --background, but body copy carrying it also
    // lands on cards, popovers and control fills, which sit one to three rungs
    // lighter. Those cannot reach 60 from a solve aimed at --background; what
    // matters is that they stay within a hair of it rather than falling away.
    // Measured minima: --card 59.57, --popover 59.10, --secondary 58.87 (the
    // last two at seed #009a42). The 58.5 floor is that worst case with room
    // for 8-bit quantisation, not a target.
    for (const { seed, tokens } of sweep) {
      for (const surface of ["--card", "--popover", "--secondary"] as const) {
        expect(
          referenceLc(tokens["--primary-text"], tokens[surface]),
          `--primary-text on ${surface} for seed ${seed}`,
        ).toBeGreaterThan(58.5);
      }
    }
  });

  it("is the accent brightened — same hue and chroma, never a different color", () => {
    // The point of a second token rather than a brighter --primary: the fill
    // keeps its pinned lightness (and ember keeps being a fixed point), while
    // text gets the lightness it needs. Anything that moved hue would make an
    // accent link stop matching the accent button beside it.
    for (const { seed, tokens } of sweep) {
      const text = hexToOklch(tokens["--primary-text"]);
      const fill = hexToOklch(tokens["--primary"]);
      expect(text.L, `--primary-text for seed ${seed}`).toBeGreaterThan(fill.L);
      // Chroma is the axis gamut mapping is allowed to spend, and a lighter
      // rung has less of it available — so hue is what must survive intact.
      // (An achromatic accent has no hue to compare; C 0 is asserted instead.)
      //
      // Compared as a circular distance so hues either side of 0° are not read
      // as 359° apart. Measured maximum is 2.19° at seed #9c766e, which is
      // 8-bit quantisation of a barely-tinted color resolving hue coarsely —
      // the same slop the unlocked-accent test allows for --background.
      if (fill.C < 1e-6) {
        expect(text.C, `--primary-text for seed ${seed}`).toBeLessThan(1e-6);
      } else {
        expect(
          Math.abs(((text.h - fill.h + 540) % 360) - 180),
          `--primary-text for seed ${seed}`,
        ).toBeLessThan(3);
      }
    }
  });

  it("never washes out to white", () => {
    // A solve that could only reach the floor by heading for #ffffff would be
    // a legible token that no longer reads as the accent at all. Measured L
    // range over the sweep is 0.741–0.786, so the whole family sits well
    // inside a recognisable tint of the seed.
    for (const { seed, tokens } of sweep) {
      const { L } = hexToOklch(tokens["--primary-text"]);
      expect(L, `--primary-text for seed ${seed}`).toBeLessThan(0.85);
    }
  });

  it("stays legible on the grey-seed path", () => {
    // Cs < 0.02 zeroes the accent's chroma, so --primary-text has no color to
    // lean on and is carried entirely by lightness. It must still clear the
    // floor — a monochrome theme's links are links.
    const tokens = generateThemeTokens(themeFor("#808080"));
    expect(tokens["--primary-text"]).toBe("#b2b2b2");
    expect(referenceLc(tokens["--primary-text"], tokens["--background"])).toBeGreaterThanOrEqual(
      60,
    );
  });

  it("fixes the Lc 41 finding that motivated it", () => {
    // Ember's --primary is Lc 41 as body copy. Both halves are pinned so the
    // gap cannot silently close from the wrong end — --primary must stay the
    // fill it is.
    const tokens = generateThemeTokens(DEFAULT_THEME);
    expect(referenceLc(tokens["--primary"], tokens["--background"])).toBeCloseTo(41, 0);
    expect(referenceLc(tokens["--primary-text"], tokens["--background"])).toBeGreaterThanOrEqual(
      60,
    );
  });

  it("follows an unlocked accent rather than the seed", () => {
    // #75's pairing: cool chrome, warm accent. The text token belongs to the
    // accent family, so it has to track the accent, not the neutrals.
    const tokens = generateThemeTokens({ ...DEFAULT_THEME, seed: "#3b82f6", accent: "#e8652a" });
    expect(hexToOklch(tokens["--primary-text"]).h).toBeCloseTo(hexToOklch("#e8652a").h, 0);
  });

  it("is deterministic", () => {
    const base = generateThemeTokens(DEFAULT_THEME)["--primary-text"];
    expect(generateThemeTokens(DEFAULT_THEME)["--primary-text"]).toBe(base);
  });

  it("can be overridden like any other token", () => {
    const tokens = generateThemeTokens({
      ...DEFAULT_THEME,
      overrides: { "--primary-text": "#ffd7c4" },
    });
    expect(tokens["--primary-text"]).toBe("#ffd7c4");
    expect(tokens["--primary"]).toBe("#e8652a");
  });
});

describe("the ladder's monotonicity", () => {
  // NOTE: the spec is self-inconsistent here. Its ladder table sets --popover
  // at L 0.218 and --secondary at L 0.226 — a step of 0.008 — while its Tests
  // paragraph asks for ΔL ≥ 0.015 "between adjacent surfaces". Both cannot
  // hold. The ladder wins: it is given explicitly, with worked hexes for two
  // hues, and it reproduces the values shipping in globals.css today (#1a1a1a
  // and #1c1c1c are likewise 2/255 apart).
  //
  // The 0.015 floor is kept where it is load-bearing — between surfaces that
  // actually stack, and between every state/edge token and the background it
  // is drawn on. --popover and --secondary never touch: a popover is a
  // floating surface, --secondary is a control fill on --background or --card.
  const ORDER = [
    "--rail",
    "--background",
    "--card",
    "--popover",
    "--secondary",
    "--accent",
    "--sidebar-border",
    "--border",
    "--border-hover",
    "--border-strong",
  ] as const;

  const STACKING_SURFACES = ["--rail", "--background", "--card", "--popover"] as const;

  it("never inverts two rungs, at any hue", () => {
    // Non-decreasing rather than strictly increasing: the spec's ladder puts
    // --accent (L 0.252) and --sidebar-border (L 0.255) 0.003 apart, which is
    // under one 8-bit step, so at some hues they quantise to the same hex.
    // Harmless — they are a surface and an edge that never meet — but it does
    // mean strict monotonicity is not achievable from these constants.
    // Inversion, which would be a real bug, is what this rules out.
    for (const { seed, tokens } of sweep) {
      const lightnesses = ORDER.map((name) => hexToOklch(tokens[name]).L);
      for (let i = 1; i < lightnesses.length; i += 1) {
        expect(
          lightnesses[i]!,
          `${ORDER[i]} vs ${ORDER[i - 1]} for seed ${seed}`,
        ).toBeGreaterThanOrEqual(lightnesses[i - 1]!);
      }
    }
  });

  it("separates adjacent stacking surfaces by ΔL ≥ 0.015", () => {
    for (const { seed, tokens } of sweep) {
      for (let i = 1; i < STACKING_SURFACES.length; i += 1) {
        const above = hexToOklch(tokens[STACKING_SURFACES[i]!]).L;
        const below = hexToOklch(tokens[STACKING_SURFACES[i - 1]!]).L;
        expect(above - below, `${STACKING_SURFACES[i]} for seed ${seed}`).toBeGreaterThanOrEqual(
          0.015,
        );
      }
    }
  });

  it("separates every state and edge token from --background by ΔL ≥ 0.015", () => {
    const layered = [
      "--secondary",
      "--muted",
      "--accent",
      "--sidebar-accent",
      "--border",
      "--input",
      "--border-hover",
      "--border-strong",
      "--sidebar-border",
    ] as const;
    for (const { seed, tokens } of sweep) {
      const background = hexToOklch(tokens["--background"]).L;
      for (const name of layered) {
        expect(
          hexToOklch(tokens[name]).L - background,
          `${name} for seed ${seed}`,
        ).toBeGreaterThanOrEqual(0.015);
      }
    }
  });
});

describe("the clamps", () => {
  it("pins a fully-saturated seed's accent chroma at 0.20", () => {
    // #ff0000 is far outside the accent window; the accent must land on the
    // ceiling, not follow the seed out.
    const tokens = generateThemeTokens(themeFor("#ff0000"));
    const { C, h } = hexToOklch(tokens["--primary"]);
    // Red at L 0.661 cannot hold C 0.20 in sRGB, so what is asserted is that
    // the request was clamped to 0.20 before gamut mapping — i.e. the result
    // is the sRGB cusp at this lightness, never more.
    expect(C).toBeLessThanOrEqual(0.2);
    expect(C).toBeGreaterThan(0.13);
    // Hue survives the clamp — 8-bit quantisation of the emitted hex is the
    // only thing that moves it, and only by hundredths of a degree.
    expect(h).toBeCloseTo(hexToOklch("#ff0000").h, 0);
  });

  it("floors a barely-tinted seed's accent chroma at 0.06", () => {
    // Cs 0.025 — tinted enough to clear the grey guard (the guard's own path
    // is asserted below), still far under the accent window's floor.
    const tokens = generateThemeTokens(themeFor("#8e7c75"));
    expect(hexToOklch(tokens["--primary"]).C).toBeCloseTo(0.06, 3);
  });

  it("takes the grey path for a grey seed, leaving the whole theme untinted", () => {
    // Cs < 0.02 ⇒ Cn = 0: the muddy-black guard. It covers the accent too, and
    // has to. A colorless seed's hue is float residue — #808080 reports
    // h 89.88° with C 2e-8 — so flooring the accent at C 0.06 would have paid
    // out a muddy olive `--primary` at a hue that jumps somewhere unrelated
    // when the seed changes by one bit. Grey in, grey out: every generated
    // token comes back a true grey (r == g == b), `--primary` included.
    const tokens = generateThemeTokens(themeFor("#808080"));
    for (const [name, hex] of Object.entries(tokens)) {
      // The hue-locked semantics ignore the seed by design (step 8) — they are
      // the one family a grey seed does not grey out. Asked of the registry
      // rather than matched by name, so a semantic added to the escape list
      // does not need this test edited to keep telling the truth.
      if (HUE_LOCKED_TOKENS.includes(name as ThemeTokenName)) continue;
      expect(hex.slice(1, 3), name).toBe(hex.slice(3, 5));
      expect(hex.slice(3, 5), name).toBe(hex.slice(5, 7));
    }
  });

  it("keeps the achromatic accent legible and at its fixed lightness", () => {
    // A neutral --primary is still a button: its label must clear the same
    // Lc 60 floor, and it must sit on the ladder's accent rung like any other.
    const tokens = generateThemeTokens(themeFor("#808080"));
    expect(tokens["--primary"]).toBe("#929292");
    expect(tokens["--primary-foreground"]).toBe("#ffffff");
    expect(apcaLc(tokens["--primary-foreground"], tokens["--primary"])).toBeGreaterThanOrEqual(60);
    expect(hexToOklch(tokens["--primary"]).L).toBeCloseTo(0.661, 2);
  });

  it("still solves a readable foreground from a near-black seed", () => {
    // The seed's lightness is discarded, so near-black must be no different
    // from any other hue-and-chroma input.
    for (const seed of ["#010101", "#000000", "#020100"]) {
      const tokens = generateThemeTokens(themeFor(seed));
      expect(apcaLc(tokens["--foreground"], tokens["--background"]), seed).toBeGreaterThanOrEqual(
        90,
      );
      expect(hexToOklch(tokens["--background"]).L).toBeCloseTo(0.178, 2);
    }
  });

  it("discards the seed's lightness entirely", () => {
    // Same hue and chroma, four very different lightnesses — one theme.
    const { h, C } = hexToOklch("#e8652a");
    const seeds = [0.25, 0.45, 0.661, 0.85].map((L) => oklchToHex(L, C, h));
    const generated = seeds.map((seed) => generateThemeTokens(themeFor(seed)));
    // The darkest seed cannot hold ember's chroma in sRGB, so compare the
    // pair that can: lightness alone must change nothing.
    expect(generated[2]).toEqual(generateThemeTokens(DEFAULT_THEME));
    expect(hexToOklch(generated[3]!["--background"]).L).toBeCloseTo(0.178, 2);
  });
});

describe("determinism and idempotence", () => {
  it("returns the same tokens for the same definition, every time", () => {
    for (const seed of ["#e8652a", "#3b82f6", "#808080", "#00ff00"]) {
      const first = generateThemeTokens(themeFor(seed));
      expect(generateThemeTokens(themeFor(seed))).toEqual(first);
      expect(generateThemeTokens({ ...themeFor(seed) })).toEqual(first);
    }
  });

  it("converges when its own --primary is fed back as the seed", () => {
    // The resolved theme is recomputed at every render and never persisted,
    // so a generator that wandered under its own output would make the UI
    // wander. Feeding --primary back must reach a fixed point and stay there.
    //
    // Most seeds are a fixed point on the first pass. The exception is a seed
    // whose accent gets gamut-mapped hard (pure green): each pass re-reads a
    // chroma one 8-bit step nearer the sRGB cusp, so it creeps a few LSBs and
    // then stops. It converges — it does not oscillate or run away.
    for (const seed of ["#e8652a", "#3b82f6", "#00ff00", "#808080", "#ff0000"]) {
      let current = generateThemeTokens(themeFor(seed))["--primary"];
      let settled = "";
      for (let i = 0; i < 10; i += 1) {
        const next = generateThemeTokens(themeFor(current))["--primary"];
        if (next === current) {
          settled = next;
          break;
        }
        current = next;
      }
      expect(settled, `seed ${seed} never settled`).toBe(current);
    }
  });

  it("makes ember a fixed point on the very first pass", () => {
    const once = generateThemeTokens(DEFAULT_THEME);
    expect(generateThemeTokens(themeFor(once["--primary"]))).toEqual(once);
  });
});

describe("overrides", () => {
  it("wins over the generated value", () => {
    const tokens = generateThemeTokens({
      ...DEFAULT_THEME,
      overrides: { "--border-strong": "#4a3227" },
    });
    expect(tokens["--border-strong"]).toBe("#4a3227");
    // Nothing else moves.
    expect(tokens["--border"]).toBe("#2d2421");
  });

  it("wins even when it breaks a contrast floor", () => {
    // Applied last, after generation and after every guard: the clamps exist
    // to stop the math producing something unreadable, not to overrule a
    // person who asked for a specific hex.
    const tokens = generateThemeTokens({
      ...DEFAULT_THEME,
      overrides: { "--foreground": "#1a1a1a" },
    });
    expect(tokens["--foreground"]).toBe("#1a1a1a");
    expect(apcaLc(tokens["--foreground"], tokens["--background"])).toBeLessThan(90);
  });

  it("does not follow an aliased token", () => {
    // --card-foreground is generated as a copy of --foreground, but
    // overriding one must not silently move the other.
    const tokens = generateThemeTokens({
      ...DEFAULT_THEME,
      overrides: { "--foreground": "#1a1a1a" },
    });
    expect(tokens["--card-foreground"]).toBe("#ebe3df");
  });
});

describe("the unlocked accent (#75)", () => {
  it("keeps the seed's hue in the neutrals and the accent's in --primary", () => {
    // The one thing a single seed cannot express: cool grey chrome, warm
    // accent.
    const tokens = generateThemeTokens({
      ...DEFAULT_THEME,
      seed: "#3b82f6",
      accent: "#e8652a",
    });
    expect(hexToOklch(tokens["--primary"]).h).toBeCloseTo(hexToOklch("#e8652a").h, 1);
    // Near-black at C 0.011 resolves hue coarsely once quantised to 8 bits —
    // a degree of slop here is a rounding artifact, not a hue shift.
    expect(Math.abs(hexToOklch(tokens["--background"]).h - hexToOklch("#3b82f6").h)).toBeLessThan(
      3,
    );
  });

  it("still colors the accent when the seed itself is grey", () => {
    // The grey guard zeroes the accent's chroma for a colorless seed, but only
    // because that seed has no hue to honor. An authored accent does, and it
    // outranks the guard: saturated accent on genuinely achromatic chrome is
    // the exact pairing #75 exists to make expressible.
    const tokens = generateThemeTokens({
      ...themeFor("#808080"),
      accent: "#e8652a",
    });
    expect(tokens["--primary"]).toBe("#e8652a");
    expect(tokens["--background"]).toBe(generateThemeTokens(themeFor("#808080"))["--background"]);
  });

  it("leaves the neutral ladder identical to the locked theme", () => {
    const locked = generateThemeTokens(themeFor("#3b82f6"));
    const unlocked = generateThemeTokens({
      ...themeFor("#3b82f6"),
      accent: "#e8652a",
    });
    expect(unlocked["--background"]).toBe(locked["--background"]);
    expect(unlocked["--card"]).toBe(locked["--card"]);
    expect(unlocked["--border"]).toBe(locked["--border"]);
    expect(unlocked["--primary"]).not.toBe(locked["--primary"]);
  });
});

describe("solveLightnessForContrast", () => {
  // Lc is a magnitude, so contrast is V-shaped in the text's lightness: it is
  // ~0 where the text matches the background and rises along both arms. Which
  // arm holds the answer depends on the background, and every background the
  // generator feeds this today is a fixed constant below L 0.5 — so the light
  // arm and the failure mode are only reachable from here. They are what a
  // light-mode ladder (#70) would land on first.

  it("goes lighter than a dark background", () => {
    const solved = solveLightnessForContrast(90, 0.011, 40, "#15100e");
    expect(solved).toBeGreaterThan(hexToOklch("#15100e").L);
    expect(apcaLc(oklchToHex(solved, 0.011, 40), "#15100e")).toBeGreaterThanOrEqual(90);
  });

  it("goes darker than a light background", () => {
    // The case the old search got silently wrong: it probed L 0.5 first, found
    // it lighter-than-required by its own reversed test, and walked *up* to
    // #ffffff — Lc ~0 on a near-white page, returned as though it had solved.
    const solved = solveLightnessForContrast(60, 0.011, 40, "#faf7f5");
    expect(solved).toBeLessThan(hexToOklch("#faf7f5").L);
    expect(apcaLc(oklchToHex(solved, 0.011, 40), "#faf7f5")).toBeGreaterThanOrEqual(60);
  });

  it("finds the smallest step that clears the target, not the extreme", () => {
    // The answer is the lightness *nearest* the background that still passes:
    // asking for less contrast must never hand back a more extreme color.
    const strict = solveLightnessForContrast(90, 0.011, 40, "#15100e");
    const loose = solveLightnessForContrast(60, 0.011, 40, "#15100e");
    expect(loose).toBeLessThan(strict);
    expect(loose).toBeGreaterThan(hexToOklch("#15100e").L);
  });

  it("throws rather than returning an unsolved bound", () => {
    // Lc 110 is past what even black-on-white reaches. Failing loudly is the
    // point: the old search returned its bound either way, so an impossible
    // target and a solved one were indistinguishable at the call site.
    expect(() => solveLightnessForContrast(110, 0.011, 40, "#faf7f5")).toThrow(/Lc 110/);
    expect(() => solveLightnessForContrast(110, 0.011, 40, "#15100e")).toThrow(/#15100e/);
  });
});

describe("solveLightnessOrCeiling", () => {
  // The same solver with the throw traded for a clamp — for callers whose INK is
  // not fixed. The generator's backgrounds are constants, so a floor it cannot
  // meet is a bug; the canvas layer solves at whatever chroma and hue a user's
  // gradient implies, where an unreachable ask is a Tuesday.

  it("is the solver itself whenever the target is reachable", () => {
    for (const background of ["#15100e", "#faf7f5"]) {
      expect(solveLightnessOrCeiling(60, 0.011, 40, background)).toBe(
        solveLightnessForContrast(60, 0.011, 40, background),
      );
    }
  });

  it("returns the best the surface allows instead of throwing", () => {
    // Lc 110 is past black-on-white, so nothing at this hue reaches it. The
    // honest answer is everything the arm has rather than an exception that
    // blanks a window on a swatch click — asserted as the CONTRAST delivered,
    // since the nearest lightness that still measures the ceiling is a step or
    // two in from the bound once the hex is quantised.
    for (const [background, bound] of [
      ["#faf7f5", 0],
      ["#15100e", 1],
    ] as const) {
      const ceiling = apcaLc(oklchToHex(bound, 0.011, 40), background);
      const solved = solveLightnessOrCeiling(110, 0.011, 40, background);
      expect({ background, lc: apcaLc(oklchToHex(solved, 0.011, 40), background) }).toEqual({
        background,
        lc: expect.closeTo(ceiling, 4),
      });
    }
  });

  it("clamps a chromatic ink that simply cannot reach the ask", () => {
    // The real case, and the reason this exists at all: a saturated hue on
    // tinted paper, where the ceiling is measured at that chroma rather than at
    // black. Copy stops darkening when the color space runs out instead of
    // falling off it.
    const ceiling = apcaLc(oklchToHex(0, 0.16, 60), "#f2ede4");
    expect(ceiling).toBeLessThan(100);
    const solved = solveLightnessOrCeiling(100, 0.16, 60, "#f2ede4");
    expect(apcaLc(oklchToHex(solved, 0.16, 60), "#f2ede4")).toBeCloseTo(ceiling, 4);
  });
});

describe("THEME_CONTRAST_FLOORS", () => {
  it("states the floors this generator actually solves to", () => {
    // The table is a restatement for sweeps, not a second source of truth: every
    // number in it is the constant the solve uses. Asserted against the emitted
    // set so a floor edited in one place and not the other fails here.
    const tokens = generateThemeTokens(DEFAULT_THEME);
    for (const { text, surface, floor, what } of THEME_CONTRAST_FLOORS) {
      const lc = Math.abs(apcaLc(tokens[text], tokens[surface]));
      expect({ what, meets: lc >= floor }).toEqual({ what, meets: true });
    }
  });

  it("names each floor's own surface rather than one page for all of them", () => {
    // The mistake it exists to prevent: a floor asserted against `--background`
    // for a token painted on `--card` or on a button.
    expect(THEME_CONTRAST_FLOORS.map(({ surface }) => surface)).toContain("--primary");
    expect(THEME_CONTRAST_FLOORS.map(({ surface }) => surface)).toContain("--sidebar");
  });
});

describe("pickAccentLabel", () => {
  it("prefers white on the accent at its shipped lightness", () => {
    // Ember's own button: white wins, comfortably above the Lc 60 floor.
    expect(pickAccentLabel("#e8652a", hexToOklch("#e8652a").h).hex).toBe("#ffffff");
  });

  it("prefers the dark label once the button is above the crossover", () => {
    // A bright yellow sits well above L 0.72, where white collapses and the
    // near-black tint is the only legible label. This is the branch a
    // light-mode ladder (#70) will depend on.
    const yellow = oklchToHex(0.9, 0.18, 100);
    const label = pickAccentLabel(yellow, 100);
    expect(label.hex).not.toBe("#ffffff");
    expect(label.lc).toBeGreaterThan(apcaLc("#ffffff", yellow));
  });

  it("never prefers the dark label at the accent's fixed lightness", () => {
    // The invariant solveAccentPair's downward-only repair search relies on:
    // if this ever fails, the search's lower bound of L 0 is no longer sound.
    for (let hue = 0; hue < 360; hue += 1) {
      for (const chroma of [0.06, 0.1, 0.14, 0.18, 0.2]) {
        const primary = oklchToHex(0.661, chroma, hue);
        expect(pickAccentLabel(primary, hue).hex).toBe("#ffffff");
      }
    }
  });
});

describe("the accent repair path", () => {
  // A saturated mid-green is the one place no label clears Lc 60 at the
  // ladder's fixed accent lightness, so step 9's "adjust lightness only"
  // repair fires. Verified by sweep: ~6 seeds in 1800 reach it.
  const GREEN = "#24af32";

  it("moves the accent until its label is legible", () => {
    const tokens = generateThemeTokens({ ...DEFAULT_THEME, seed: GREEN });
    expect(apcaLc(tokens["--primary-foreground"], tokens["--primary"])).toBeGreaterThanOrEqual(60);
  });

  it("repairs by lightness only — never the hue or chroma the user chose", () => {
    const tokens = generateThemeTokens({ ...DEFAULT_THEME, seed: GREEN });
    const repaired = hexToOklch(tokens["--primary"]);
    const ideal = hexToOklch(oklchToHex(0.661, hexToOklch(GREEN).C, hexToOklch(GREEN).h));
    expect(repaired.h).toBeCloseTo(ideal.h, 0);
    expect(repaired.C).toBeCloseTo(ideal.C, 2);
    // Darker than the ideal, and only barely — about one 8-bit step.
    expect(repaired.L).toBeLessThan(0.661);
    expect(0.661 - repaired.L).toBeLessThan(0.01);
  });
});

describe("the status family", () => {
  // The three hues, restated here rather than imported: a test that reads the
  // constant it is checking cannot notice the constant moving, and "green means
  // working" is exactly the kind of fact that must break loudly when edited.
  const HUES = { "--positive": 162.48, "--attention": 70.08, "--info": 237.32 };
  const FILLS = ["--positive", "--attention", "--info"] as const;

  /**
   * Cards a ladder can actually produce: both ends of the shipped canvas, and
   * both extremes of the space. A mid-grey belongs in the ceiling test below
   * and nowhere else — Lc 65 is physically out of reach there, so what comes
   * back is the clamp rather than a solved colour.
   */
  const SURFACES = ["#1b1412", "#f4d4c8", "#0a0a0a", "#ffffff"];

  it("emits the six names and nothing else, as paintable hexes", () => {
    for (const surface of SURFACES) {
      const status = solveStatusTokens(surface);
      expect(Object.keys(status).toSorted()).toEqual(
        FILLS.flatMap((fill) => [fill, `${fill}-foreground`]).toSorted(),
      );
      for (const [name, hex] of Object.entries(status)) {
        expect(hex, `${name} on ${surface}`).toMatch(/^#[0-9a-f]{6}$/);
      }
    }
  });

  it("keeps each hue locked, whatever surface it is solved against", () => {
    // The solve moves lightness and gamut mapping takes chroma; neither may
    // touch hue, because hue is the only part of a status colour that MEANS
    // anything. A degree of slack for the 8-bit round trip.
    for (const surface of SURFACES) {
      const status = solveStatusTokens(surface);
      for (const fill of FILLS) {
        expect(hexToOklch(status[fill]).h, `${fill} on ${surface}`).toBeCloseTo(HUES[fill], 0);
      }
    }
  });

  it("lands all three at one contrast, so no status colour shouts over its peers", () => {
    // The point of solving them rather than authoring them. Today's raw palette
    // put emerald-500 at Lc 52, sky-500 at 48 and amber-500 at 60 on the same
    // dark card — a 12-point spread that reads as amber being more urgent than
    // it is. Solved, the spread is a rounding error.
    for (const surface of ["#1b1412", "#211815", "#f4d4c8", "#fdded2"]) {
      const status = solveStatusTokens(surface);
      const scores = FILLS.map((fill) => apcaLc(status[fill], surface));
      expect(Math.max(...scores) - Math.min(...scores), `spread on ${surface}`).toBeLessThan(1);
      for (const [index, score] of scores.entries()) {
        expect(score, `${FILLS[index]} on ${surface}`).toBeGreaterThanOrEqual(60);
      }
    }
  });

  it("flips its labels with the fill, both directions", () => {
    // `pickAccentLabel`'s two branches, reached by the two appearances of the
    // shipped canvas alone. Dark solves the fills bright, where a near-black
    // tint of the status hue wins; light solves them deep, where white does.
    // A single authored `--positive-foreground` could only be right in one.
    const onDark = solveStatusTokens("#211815");
    const onLight = solveStatusTokens("#f4d4c8");
    for (const fill of FILLS) {
      const label = `${fill}-foreground` as const;
      expect(hexToOklch(onDark[label]).L, `${label} on a dark card`).toBeLessThan(0.35);
      expect(onLight[label], `${label} on a light card`).toBe("#ffffff");
      expect(apcaLc(onDark[label], onDark[fill]), label).toBeGreaterThanOrEqual(60);
      expect(apcaLc(onLight[label], onLight[fill]), label).toBeGreaterThanOrEqual(60);
    }
  });

  it("clamps to the ceiling instead of throwing where Lc 65 is out of reach", () => {
    // A mid-grey surface no status hue can clear the floor on. The generator's
    // ladder never produces one, but a canvas is the user's to author and the
    // status solve runs against whatever card it implies — so this path is the
    // difference between a washed-out dot and a blank window.
    const status = solveStatusTokens("#7a7a7a");
    for (const fill of FILLS) {
      expect(status[fill]).toMatch(/^#[0-9a-f]{6}$/);
      expect(apcaLc(status[fill], "#7a7a7a"), fill).toBeGreaterThan(0);
    }
  });

  it("follows the surface it is given rather than a surface it assumes", () => {
    // The reason this is a second entry point rather than a slice of
    // `generateThemeTokens`'s output: two different cards must yield two
    // different families, or the canvas layer's re-solve is decoration.
    expect(solveStatusTokens("#1b1412")["--positive"]).not.toBe(
      solveStatusTokens("#f4d4c8")["--positive"],
    );
  });

  it("keeps its hue off the seed and its contrast on the floor, for every seed", () => {
    // Hue-locked means hue-locked: a green seed must not make "waiting" green,
    // and 360 hues is what says so.
    //
    // Deliberately NOT byte-equality across the sweep, which is the assertion
    // this test wants to make and cannot. The seed moves `--card`'s own chroma,
    // the status family is solved against that card, and an 8-bit step in the
    // surface moves the answer by an 8-bit step (`#27d496` → `#27d396` at seed
    // #e70075). Pinning the hex would therefore be pinning the wrong invariant:
    // what must not follow the seed is the HUE, and what must not drift with it
    // is the contrast. The colour tracking its own surface is the feature.
    for (const { seed, tokens } of sweep) {
      for (const fill of FILLS) {
        expect(hexToOklch(tokens[fill]).h, `${fill} for seed ${seed}`).toBeCloseTo(HUES[fill], 0);
        expect(
          apcaLc(tokens[fill], tokens["--card"]),
          `${fill} on --card for seed ${seed}`,
        ).toBeGreaterThanOrEqual(60);
      }
    }
  });
});

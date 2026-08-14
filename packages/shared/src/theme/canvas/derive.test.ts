/**
 * The floors, swept rather than spot-checked.
 *
 * A derived token set has one job — stay readable for every canvas anyone can
 * author — and a handful of examples cannot show that. So this is a value sweep
 * over the whole input space an editor can reach: hue × vibrancy × appearance,
 * with the achromatic extremes included because they are where the generator's
 * grey-seed guard changes behavior and where a chroma-scaled ladder is most
 * likely to divide by something it should not.
 *
 * `THEME_CONTRAST_FLOORS` is iterated as DATA, so this file states no floor of
 * its own — it asks the same table the generator's own contract is written in.
 */
import { describe, expect, it } from "vite-plus/test";

import { apcaLc, hexToOklch, isHexColor, oklchToHex } from "../color";
import { solveStatusTokens, THEME_CONTRAST_FLOORS } from "../generate";
import { THEME_TOKEN_NAMES, type ThemeTokenName } from "../tokens";
import { deriveCanvasTokens, deriveLabelInk, windowBackground } from "./derive";
import { copyFloors } from "./floors";
import { accentChroma, baseFillHex } from "./gradient";
import { DEFAULT_CANVAS } from "./parse";
import type { Canvas, ResolvedAppearance } from "./types";

/** Eight hues around the wheel plus both achromatic extremes. */
const HUES = [
  "#e8652a", // ember — the shipped accent
  "#c53d43", // red
  "#f2d060", // yellow
  "#4a7d5b", // green
  "#2e6f8e", // teal
  "#4653a2", // blue
  "#a06bb8", // violet
  "#f2a7c3", // magenta
  "#000000", // no hue at all
  "#ffffff", // no hue, other end
];

const VIBRANCIES = [0, 0.6, 1];
const MODES: readonly ResolvedAppearance[] = ["light", "dark"];

function canvasOf(hex: string, vibrancy: number): Canvas {
  return { ...DEFAULT_CANVAS, stops: [{ hex, x: 0.68, y: 0.3 }], vibrancy };
}

/** Every (hue, vibrancy, appearance) the sweep covers, as one flat list of cases. */
function everyCase(): { hex: string; vibrancy: number; resolved: ResolvedAppearance }[] {
  return HUES.flatMap((hex) =>
    VIBRANCIES.flatMap((vibrancy) => MODES.map((resolved) => ({ hex, vibrancy, resolved }))),
  );
}

/**
 * The best contrast ANY ink can reach on `surface` — measured from the two
 * extremes of the space rather than from a hue, so it is an upper bound on every
 * candidate: nothing at any chroma beats black or white on a given surface. The
 * same expression `solveLightnessOrCeiling` guards with.
 */
function ceilingOn(surface: string): number {
  return Math.max(Math.abs(apcaLc("#000000", surface)), Math.abs(apcaLc("#ffffff", surface)));
}

/** |ΔL| between the page and the rail on the shipped canvas — the tab strip's pair. */
function railGap(resolved: ResolvedAppearance): number {
  const tokens = deriveCanvasTokens(DEFAULT_CANVAS, resolved);
  return Math.abs(hexToOklch(tokens["--background"]).L - hexToOklch(tokens["--rail"]).L);
}

/** The two copy numbers exactly as an editor's readout rounds them. */
function shownFloors(resolved: ResolvedAppearance): { secondary: number; labelTowardBody: number } {
  const floors = copyFloors(resolved);
  return {
    secondary: Number(floors.secondary.toFixed(0)),
    labelTowardBody: Math.round((1 - floors.labelTowardSecondary) * 100),
  };
}

describe("deriveCanvasTokens", () => {
  it("clears every declared floor, or the ceiling its surface physically allows", () => {
    // The escape clause is not a softened assertion, it is the honest contract,
    // and the settled spread is what made it load-bearing. A floor can be asked
    // for on a surface where NO ink of any hue reaches it: light's `--sidebar` is
    // pushed to L 0.840, where even pure black scores 74.8 against a declared 75.
    // `solveLightnessOrCeiling` answers that by clamping rather than throwing, so
    // the assertion has to be the one that can actually be kept — every token
    // either meets its floor or is AT the best its surface allows, which still
    // catches anything short for a reason other than physics.
    //
    // The next test pins how narrow that exception is, and it has to stay narrow
    // or this one stops meaning anything.
    const failures: string[] = [];
    for (const { hex, vibrancy, resolved } of everyCase()) {
      const tokens = deriveCanvasTokens(canvasOf(hex, vibrancy), resolved);
      for (const { text, surface, floor, what } of THEME_CONTRAST_FLOORS) {
        const lc = Math.abs(apcaLc(tokens[text], tokens[surface]));
        if (lc < floor && lc < ceilingOn(tokens[surface]) - 0.5) {
          failures.push(
            `${what} (${text} on ${surface}) scored ${lc.toFixed(1)} < ${floor} — ${hex} @ v${vibrancy} ${resolved}`,
          );
        }
      }
    }
    expect(failures).toEqual([]);
  });

  it("names the ONE floor the settled spread puts physically out of reach", () => {
    // The exception above, pinned by name and by size so it cannot quietly grow
    // into a standing hole in the contract.
    //
    // It is `--sidebar-foreground` and nothing else, in light and not dark, and
    // it misses by under half an Lc. The cause is `ARC_SETTLED.surfaceSpread`:
    // solving light's rail gap to 0.042 drives every rung below the page down
    // with it, and `--sidebar` lands at L 0.840 where the space itself runs out a
    // fraction short of 75. It is also the least costly place for that to happen
    // — the canvas layer overrides this token with the canvas ink on every
    // surface that sits out on the gradient, which is where the sidebar is.
    //
    // If a retune drives some OTHER rung past its ceiling, this fails and names
    // it. That is the intended failure mode.
    const capped = new Set<string>();
    let shortfall = 0;
    for (const { hex, vibrancy, resolved } of everyCase()) {
      const tokens = deriveCanvasTokens(canvasOf(hex, vibrancy), resolved);
      for (const { text, surface, floor } of THEME_CONTRAST_FLOORS) {
        const ceiling = ceilingOn(tokens[surface]);
        if (ceiling >= floor) continue;
        capped.add(`${text} on ${surface} in ${resolved}`);
        shortfall = Math.max(shortfall, floor - ceiling);
      }
    }
    expect([...capped]).toEqual(["--sidebar-foreground on --sidebar in light"]);
    expect(shortfall).toBeLessThan(0.5);
  });

  it("keeps the rail a real gap under the page on every canvas, in both modes", () => {
    // The rung the complaint was actually about: the tab strip under a tab.
    // Pinned to a floor here and to its exact settled value below — this one is
    // the property that has to survive every seed, that one is the number the
    // seeds were tuned around.
    for (const { hex, vibrancy, resolved } of everyCase()) {
      const tokens = deriveCanvasTokens(canvasOf(hex, vibrancy), resolved);
      const gap = Math.abs(hexToOklch(tokens["--background"]).L - hexToOklch(tokens["--rail"]).L);
      const at = `${hex} @ v${vibrancy} ${resolved} — ${gap.toFixed(4)}`;
      expect({ at, separated: gap > 0.015 }).toEqual({ at, separated: true });
    }
  });

  it("emits every token name as a paintable hex", () => {
    for (const { hex, vibrancy, resolved } of everyCase()) {
      const tokens = deriveCanvasTokens(canvasOf(hex, vibrancy), resolved);
      const broken = THEME_TOKEN_NAMES.filter(
        (name) => typeof tokens[name] !== "string" || !isHexColor(tokens[name]),
      );
      // A missing name is the trap CLAUDE.md names: it silently keeps whatever
      // the previous set left on the element, so the card would half-flip.
      expect({ case: `${hex} @ v${vibrancy} ${resolved}`, broken }).toEqual({
        case: `${hex} @ v${vibrancy} ${resolved}`,
        broken: [],
      });
    }
  });

  it("actually inverts polarity in light mode, and keeps it in dark", () => {
    for (const { hex, vibrancy, resolved } of everyCase()) {
      const tokens = deriveCanvasTokens(canvasOf(hex, vibrancy), resolved);
      const background = hexToOklch(tokens["--background"]).L;
      const foreground = hexToOklch(tokens["--foreground"]).L;
      const label = `${hex} @ v${vibrancy} ${resolved}`;
      if (resolved === "light") {
        expect({ label, lighter: background > foreground }).toEqual({ label, lighter: true });
      } else {
        expect({ label, lighter: background < foreground }).toEqual({ label, lighter: true });
      }
    }
  });

  it("keeps a real copy hierarchy — secondary is visibly lighter than body", () => {
    // Distinct, not merely non-inverted. Solving this token against the canvas as
    // well as the card used to flatten the two onto one hex; the on-canvas rows
    // are handled by the scoped flip in the canvas layer instead, which leaves
    // this free to say what it means on the card.
    for (const { hex, vibrancy } of everyCase().filter((one) => one.resolved === "light")) {
      const tokens = deriveCanvasTokens(canvasOf(hex, vibrancy), "light");
      const card = tokens["--card"];
      const gap =
        Math.abs(apcaLc(tokens["--foreground"], card)) -
        Math.abs(apcaLc(tokens["--muted-foreground"], card));
      expect({ case: `${hex} @ v${vibrancy}`, gap: gap > 6 }).toEqual({
        case: `${hex} @ v${vibrancy}`,
        gap: true,
      });
    }
  });

  it("keeps every veil solvable at the light end", () => {
    // `generateVeilTokens` solves C = (T − B(1−α))/α and does NOT clamp, so a
    // rung pair outside the window silently emits an out-of-range rgb().
    const pairs: [ThemeTokenName, ThemeTokenName][] = [
      ["--sidebar", "--rail"],
      ["--sidebar-accent", "--sidebar"],
      ["--sidebar-border", "--sidebar"],
    ];
    for (const { hex, vibrancy } of everyCase().filter((one) => one.resolved === "light")) {
      const tokens = deriveCanvasTokens(canvasOf(hex, vibrancy), "light");
      for (const [target, base] of pairs) {
        for (let channel = 0; channel < 3; channel += 1) {
          const at = (name: ThemeTokenName) =>
            parseInt(tokens[name].slice(1 + channel * 2, 3 + channel * 2), 16);
          const solved = (at(target) - at(base) * 0.9) / 0.1;
          expect({
            case: `${target} over ${base} — ${hex} @ v${vibrancy}`,
            inRange: solved >= 0 && solved <= 255,
          }).toEqual({ case: `${target} over ${base} — ${hex} @ v${vibrancy}`, inRange: true });
        }
      }
    }
  });

  it("lets vibrancy decide how much the paper says about the canvas", () => {
    // Vibrancy 0 is near-neutral paper; 1 is visibly of the canvas's family.
    const quiet = hexToOklch(deriveCanvasTokens(canvasOf("#2e6f8e", 0), "light")["--background"]).C;
    const loud = hexToOklch(deriveCanvasTokens(canvasOf("#2e6f8e", 1), "light")["--background"]).C;
    expect(quiet).toBeLessThan(0.008);
    expect(loud).toBeGreaterThan(quiet * 2);
  });

  it("is deterministic — the same canvas always derives the same set", () => {
    const canvas = canvasOf("#4653a2", 0.6);
    for (const resolved of MODES) {
      expect(deriveCanvasTokens(canvas, resolved)).toEqual(deriveCanvasTokens(canvas, resolved));
    }
  });

  it("clears the copy floors on the surface each one is actually painted on", () => {
    // The bug this locks out, measured before the fix: secondary copy cleared its
    // floor on `--background` (60.3) and missed it on `--card` (57.0) — and
    // `--card` is the rung every panel, rail and popover in the app paints it on.
    // A floor asserted against the lightest surface in the ladder is a floor that
    // fails everywhere else in the ladder.
    const failures: string[] = [];
    for (const { hex, vibrancy, resolved } of everyCase()) {
      const tokens = deriveCanvasTokens(canvasOf(hex, vibrancy), resolved);
      const floors = copyFloors(resolved);
      const label = deriveLabelInk(tokens, resolved);
      const cases: [string, string, string, number][] = [
        ["body", tokens["--foreground"], tokens["--background"], floors.body],
        ["secondary", tokens["--muted-foreground"], tokens["--card"], floors.secondary],
      ];
      for (const [what, text, surface, floor] of cases) {
        const lc = Math.abs(apcaLc(text, surface));
        // The ask is clamped to what the hue can actually deliver, so the
        // assertion is against the SAME ceiling rather than against the raw
        // floor. Demanding the raw number would assert that OKLCH can produce
        // contrast it cannot.
        const { C, h } = hexToOklch(text);
        const bound = hexToOklch(surface).L < 0.5 ? 1 : 0;
        const owed = Math.min(floor, Math.abs(apcaLc(oklchToHex(bound, C, h), surface)));
        if (lc < owed - 0.5) {
          failures.push(
            `${what} scored ${lc.toFixed(1)} < ${owed.toFixed(1)} — ${hex} @ v${vibrancy} ${resolved}`,
          );
        }
      }
      // The label tier has no floor of its own — it is a position between the two
      // above — so what it owes is that it stay between them. Stated as a
      // DISTANCE from body, since light's inks darken away from paper and dark's
      // lighten away from it.
      const labelL = hexToOklch(label).L;
      const bodyL = hexToOklch(tokens["--foreground"]).L;
      const secondaryL = hexToOklch(tokens["--muted-foreground"]).L;
      if (!(Math.abs(labelL - bodyL) < Math.abs(secondaryL - bodyL) && labelL !== bodyL)) {
        failures.push(
          `label L ${labelL.toFixed(3)} outside body ${bodyL.toFixed(3)}…secondary ${secondaryL.toFixed(3)} — ${hex} @ v${vibrancy} ${resolved}`,
        );
      }
    }
    expect(failures).toEqual([]);
  });

  it("keeps a real span between body and secondary, on every canvas and in both modes", () => {
    // The span is what the settled weight has to leave intact; where the label
    // sits inside it is what the weight decides. Both ends of `secondary`'s range
    // are deliberately close to body, so this asserts the tiers stay
    // distinguishable rather than asserting a comfortable gap.
    for (const { hex, vibrancy, resolved } of everyCase()) {
      const tokens = deriveCanvasTokens(canvasOf(hex, vibrancy), resolved);
      const card = tokens["--card"];
      const body = Math.abs(apcaLc(tokens["--foreground"], card));
      const secondary = Math.abs(apcaLc(tokens["--muted-foreground"], card));
      const at = `${hex} @ v${vibrancy} ${resolved} — ${body.toFixed(1)}/${secondary.toFixed(1)}`;
      expect({ at, spanned: body - secondary > 2 }).toEqual({ at, spanned: true });
    }
  });

  it("mixes the paper toward the canvas without letting vibrancy off the hook", () => {
    // `cardTint` and `vibrancy` were never two names for one thing. The tint
    // decides how much of the canvas reaches the paper; vibrancy decides how much
    // canvas there is to reach it. It settled at the top of its range, so the
    // property that matters is the one that stops that from being loud on its
    // own: at vibrancy 0 the wash is near-neutral, and a quarter of nearly
    // nothing is still nearly nothing.
    const chromaAt = (vibrancy: number) =>
      hexToOklch(deriveCanvasTokens(canvasOf("#e8652a", vibrancy), "light")["--card"]).C;

    expect(chromaAt(0)).toBeLessThan(0.01);
    expect(chromaAt(0.6)).toBeGreaterThan(chromaAt(0) * 3);
    expect(chromaAt(1)).toBeGreaterThan(chromaAt(0.6));
  });

  it("holds the light ladder's order down to `--border-hover`", () => {
    // The tint moves every rung by the same fraction toward the same target, so
    // gaps scale by (1 − tint) and the order among them is preserved by
    // construction. The SPREAD is what can break it, and the assertion stops one
    // rung short of the end because at the settled spread it does — see the next
    // test. Everything above that point is what the veil solve depends on, and it
    // does not clamp: a pair that swapped rungs would emit an out-of-range rgb()
    // rather than an error.
    const rungs: ThemeTokenName[] = [
      "--background",
      "--popover",
      "--card",
      "--rail",
      "--secondary",
      "--sidebar",
      "--sidebar-border",
      "--accent",
      "--border",
      "--border-hover",
    ];
    for (const { hex, vibrancy } of everyCase().filter((one) => one.resolved === "light")) {
      const tokens = deriveCanvasTokens(canvasOf(hex, vibrancy), "light");
      const Ls = rungs.map((rung) => hexToOklch(tokens[rung]).L);
      for (let i = 1; i < Ls.length; i += 1) {
        const at = `${hex} @ v${vibrancy} — ${rungs[i - 1]} → ${rungs[i]}`;
        expect({ at, descending: Ls[i] <= Ls[i - 1] }).toEqual({ at, descending: true });
      }
    }
  });

  it("bounds the last rung's inversion, which the settled spread introduces", () => {
    // A characterization, not an endorsement. `spreadCurve` applies its FADED
    // multiplier to a rung's whole distance from paper rather than integrating it
    // along the way, which makes the map non-monotone once the gain passes 2.0 —
    // and light's settled gain is 2.509. So `--border-strong`, which sits at the
    // fade's far end and by design does not move at all, ends up a little LIGHTER
    // than `--border-hover`, which is still being pushed.
    //
    // Measured at ΔL 0.0063 on ember and never more across the sweep: two
    // hairline borders a hundredth of a lightness unit out of order, under a
    // ladder whose visible surfaces all sit above them and whose veil pairs do not
    // involve either. Left rather than fixed because the fix is a change to the
    // curve, and the curve is what the settled spread was chosen against.
    //
    // Bounded here so it cannot grow: if a later edit widens it into something
    // visible, or pushes the inversion up into a rung that carries a surface, this
    // fails.
    for (const { hex, vibrancy } of everyCase().filter((one) => one.resolved === "light")) {
      const tokens = deriveCanvasTokens(canvasOf(hex, vibrancy), "light");
      const hover = hexToOklch(tokens["--border-hover"]).L;
      const strong = hexToOklch(tokens["--border-strong"]).L;
      const at = `${hex} @ v${vibrancy} — hover ${hover.toFixed(4)} strong ${strong.toFixed(4)}`;
      expect({ at, hairline: strong - hover < 0.01 }).toEqual({ at, hairline: true });
    }
  });

  it("re-solves the status family per appearance, where it carries --destructive across", () => {
    // The whole claim behind deleting 36 `dark:` twins: one token name is
    // correct on paper AND in the dark because the two appearances derive two
    // different colours for it, not because a call site wrote both by hand.
    //
    // `--destructive` is the control. It is hue-locked the same way and it is
    // deliberately identical across the flip, because it is frozen outright
    // rather than solved — which is also why it is the one status-adjacent
    // colour a light surface makes no brighter.
    const STATUS = ["--positive", "--attention", "--info"] as const;
    for (const { hex, vibrancy } of everyCase().filter((one) => one.resolved === "dark")) {
      const dark = deriveCanvasTokens(canvasOf(hex, vibrancy), "dark");
      const light = deriveCanvasTokens(canvasOf(hex, vibrancy), "light");
      const at = `${hex} @ v${vibrancy}`;
      for (const token of STATUS) {
        expect({ at, token, flips: dark[token] !== light[token] }).toEqual({
          at,
          token,
          flips: true,
        });
        // And the light one is the DARKER ink, not merely a different hex —
        // the polarity flip the twins were hand-writing.
        expect({ at, token, darkerOnPaper: true }).toEqual({
          at,
          token,
          darkerOnPaper: hexToOklch(light[token]).L < hexToOklch(dark[token]).L,
        });
      }
      expect(light["--destructive"]).toBe(dark["--destructive"]);
    }
  });

  it("solves the status family against the canvas's OWN card, not the shipped ladder's", () => {
    // Stated as an identity rather than as a difference, and that is the point.
    // `darkTokens` spreads `generateThemeTokens`'s output — which already
    // carries a status family, solved on the SHIPPED ladder's card — and then
    // moves the ladder toward the canvas. A carried value would still be a
    // green, still clear its floor, and still be wrong for the card the window
    // is now painting; in dark it would be wrong by a single 8-bit step, which
    // is exactly the size of mistake no spot-check ever catches.
    //
    // So the assertion is that the emitted colour IS the solve of the emitted
    // card. Delete either `solveStatusTokens` call in `derive.ts` and this
    // fails on the first canvas whose card differs from the default's.
    for (const { hex, vibrancy, resolved } of everyCase()) {
      const tokens = deriveCanvasTokens(canvasOf(hex, vibrancy), resolved);
      const at = `${hex} @ v${vibrancy} ${resolved}`;
      const expected = solveStatusTokens(tokens["--card"]);
      expect({ at, positive: tokens["--positive"] }).toEqual({
        at,
        positive: expected["--positive"],
      });
      expect({ at, attention: tokens["--attention"] }).toEqual({
        at,
        attention: expected["--attention"],
      });
      expect({ at, info: tokens["--info"] }).toEqual({ at, info: expected["--info"] });
    }
  });
});

/**
 * The accent, which is the one family in the set that is NOT seeded at the
 * chroma the gradient paints.
 *
 * Two things have to hold together, and only together: the accent has to be able
 * to reach the color the app is branded in, and reaching it must not warm a
 * single grey on the way. So the table below pins where the accent lands, and
 * the block after it pins that everything else is byte-identical to what the
 * one-seed derivation produced.
 */
describe("the accent", () => {
  /** Every accent token, and nothing else — the exact set the second seed reaches. */
  const ACCENT_TOKENS: ThemeTokenName[] = [
    "--primary",
    "--primary-foreground",
    "--primary-text",
    "--ring",
    "--sidebar-primary",
    "--sidebar-primary-foreground",
    "--sidebar-ring",
  ];

  it("walks from a near-neutral chrome to the brand color exactly, as vibrancy travels", () => {
    // The four rows the curve was settled on. Vibrancy 1 is the row that
    // matters most: ember `#e8652a` is an exact fixed point of `generate.ts`'s
    // accent math (its authored L 0.6614 IS `PRIMARY_LIGHTNESS`), so a canvas
    // authored on the brand color at full vibrancy has to come back out as the
    // brand color. Under the gradient's own cap it could not — the dark ceiling
    // held it to 51% of ember's chroma at EVERY setting of the slider, which
    // made the app's accent unreachable in its own default theme.
    //
    // Vibrancy 0 is the other end of the same statement, and it is what says
    // the accent goes through `generateAccentTokens` rather than a second read
    // of `generateThemeTokens`: 0.0248 is below that function's authored-seed
    // chroma floor, so a seed pushed through it would come back `#b38776` — a
    // visible ember on a wash with no color in it at all.
    const authored = hexToOklch("#e8652a").C;
    const rows = [
      { vibrancy: 0, chroma: 0.0248, primary: "#a08e87" },
      { vibrancy: 0.3, chroma: 0.0864, primary: "#c08168" },
      { vibrancy: 0.6, chroma: 0.1285, primary: "#d37550" },
      { vibrancy: 1, chroma: 0.1769, primary: "#e8652a" },
    ];
    for (const row of rows) {
      const canvas = { ...DEFAULT_CANVAS, vibrancy: row.vibrancy };
      expect({
        vibrancy: row.vibrancy,
        chroma: Number(accentChroma(authored, row.vibrancy).toFixed(4)),
        primary: deriveCanvasTokens(canvas, "dark")["--primary"],
      }).toEqual({ vibrancy: row.vibrancy, chroma: row.chroma, primary: row.primary });
    }
    // 0.6 is what the app ships at, so it is also the default's accent.
    expect(deriveCanvasTokens(DEFAULT_CANVAS, "dark")["--primary"]).toBe("#d37550");
  });

  it("is one color in both appearances, unlike every surface around it", () => {
    // The accent's curve carries no mode, so a light↔dark flip repaints the
    // whole window and leaves the one color the app is recognized by where it
    // was. It used to differ between the two (dark capped at 0.09, light at
    // 0.16) purely as a side effect of being seeded off the backdrop.
    for (const { hex, vibrancy } of everyCase().filter((one) => one.resolved === "dark")) {
      const canvas = canvasOf(hex, vibrancy);
      const dark = deriveCanvasTokens(canvas, "dark");
      const light = deriveCanvasTokens(canvas, "light");
      const at = `${hex} @ v${vibrancy}`;
      expect({ at, primary: light["--primary"], label: light["--primary-foreground"] }).toEqual({
        at,
        primary: dark["--primary"],
        label: dark["--primary-foreground"],
      });
      // …with the one exception that proves the rule: accent-as-TEXT is solved
      // against the card it is read on, and the card is a different color in
      // each mode. Same hue and chroma, second lightness.
      expect({ at, sameInk: light["--primary-text"] === dark["--primary-text"] }).toEqual({
        at,
        sameInk: false,
      });
    }
  });

  it("leaves every other token byte-identical to the single-seed derivation", () => {
    // The scoping assertion, and the reason the accent gets its own generator
    // call rather than a raised seed. `generateThemeTokens` derives the whole
    // neutral ladder from its seed's chroma — every rung, and every foreground
    // solved against a rung — so seeding it at the accent's number would put a
    // visible warmth into all 24 hexes below. These are the values the shipped
    // canvas produced BEFORE the accent was split off, transcribed.
    const expected: Record<ResolvedAppearance, Record<string, string>> = {
      dark: {
        "--rail": "#170f0b",
        "--background": "#1c1310",
        "--card": "#211815",
        "--popover": "#251b18",
        "--secondary": "#271d1a",
        "--muted": "#271d1a",
        "--accent": "#2d2220",
        "--sidebar": "#211815",
        "--foreground": "#e8e4e2",
        "--card-foreground": "#e8e4e2",
        "--popover-foreground": "#e8e4e2",
        "--secondary-foreground": "#e8e4e2",
        "--muted-foreground": "#bdbab8",
        "--accent-foreground": "#e8e4e2",
        "--sidebar-foreground": "#d0cdcb",
        "--sidebar-accent": "#2d2220",
        "--sidebar-accent-foreground": "#e8e4e2",
        "--border": "#312623",
        "--border-hover": "#3c312c",
        "--border-strong": "#423632",
        "--input": "#312623",
        "--sidebar-border": "#2d241f",
        "--destructive": "#e5484d",
        "--destructive-foreground": "#ffffff",
        "--positive": "#27d496",
        "--positive-foreground": "#001c10",
        "--attention": "#ffaa2f",
        "--attention-foreground": "#221200",
        "--info": "#65c6ff",
        "--info-foreground": "#001827",
      },
      light: {
        "--rail": "#edd1c6",
        "--background": "#fdded2",
        "--card": "#f4d4c8",
        "--popover": "#f7d8cc",
        "--secondary": "#eacabd",
        "--muted": "#eacabd",
        "--accent": "#dab9ad",
        "--sidebar": "#e2c3b7",
        "--foreground": "#120906",
        "--card-foreground": "#120906",
        "--popover-foreground": "#120906",
        "--secondary-foreground": "#120906",
        "--muted-foreground": "#514541",
        "--accent-foreground": "#120906",
        "--sidebar-foreground": "#080302",
        "--sidebar-accent": "#dab9ad",
        "--sidebar-accent-foreground": "#120906",
        "--border": "#d8b6a9",
        "--border-hover": "#d3b0a3",
        "--border-strong": "#d5b2a5",
        "--input": "#d8b6a9",
        "--sidebar-border": "#ddbbad",
        "--destructive": "#e5484d",
        "--destructive-foreground": "#ffffff",
        "--positive": "#005f40",
        "--positive-foreground": "#ffffff",
        "--attention": "#764900",
        "--attention-foreground": "#ffffff",
        "--info": "#005880",
        "--info-foreground": "#ffffff",
      },
    };
    for (const resolved of MODES) {
      const tokens = deriveCanvasTokens(DEFAULT_CANVAS, resolved);
      const neutrals = Object.fromEntries(
        THEME_TOKEN_NAMES.filter((name) => !ACCENT_TOKENS.includes(name)).map((name) => [
          name,
          tokens[name],
        ]),
      );
      expect({ resolved, neutrals }).toEqual({ resolved, neutrals: expected[resolved] });
    }
    // The two lists together are the whole token set: nothing is asserted twice
    // and nothing is left unasserted between this test and the table above.
    expect(ACCENT_TOKENS.length + Object.keys(expected.dark).length).toBe(THEME_TOKEN_NAMES.length);
  });

  it("out-saturates every surface it sits on, at the vibrancy where it reaches the brand", () => {
    // The same statement seen from the other end: at vibrancy 1 the accent IS
    // ember, and the page and the card behind it are still greys with a warmth
    // you can sense rather than name. If a later edit ever lets the seeds cross,
    // this is what says so.
    const canvas = { ...DEFAULT_CANVAS, vibrancy: 1 };
    for (const resolved of MODES) {
      const tokens = deriveCanvasTokens(canvas, resolved);
      const primary = hexToOklch(tokens["--primary"]).C;
      for (const surface of ["--background", "--card", "--rail", "--sidebar"] as const) {
        const at = `${surface} @ ${resolved}`;
        expect({ at, quieter: hexToOklch(tokens[surface]).C < primary / 2 }).toEqual({
          at,
          quieter: true,
        });
      }
    }
  });
});

describe("windowBackground", () => {
  it("is the canvas's own base fill — the color the window actually shows", () => {
    // What Chromium paints before first paint and during a resize is the layer
    // BEHIND everything, not the card's rung. The two are far apart with a canvas
    // armed: `--background` is paper in light and near-black in dark, while the
    // window is a vivid wash in both.
    for (const resolved of MODES) {
      expect(windowBackground(DEFAULT_CANVAS, resolved)).toBe(
        baseFillHex(DEFAULT_CANVAS, resolved),
      );
      expect(windowBackground(DEFAULT_CANVAS, resolved)).not.toBe(
        deriveCanvasTokens(DEFAULT_CANVAS, resolved)["--background"],
      );
    }
  });

  it("always produces a color, because a window is created before any UI can report a failure", () => {
    for (const resolved of MODES) {
      expect(windowBackground(null, resolved)).toBe(windowBackground(DEFAULT_CANVAS, resolved));
    }
  });
});

/**
 * The numbers the tuning pass ended on, pinned to what they were solved FOR
 * rather than to the value that produces them.
 *
 * This is the block that makes the freeze legible. Each of `surfaceSpread` and
 * `textWeight` is a position on a range whose endpoints are argued at length
 * elsewhere; nothing about the position itself says why 0.943 and not 0.9. What
 * says it is the measurement underneath — a rail gap, an Lc, a percentage — so
 * that is what is asserted here, and the constant is left free to move if the
 * range under it is ever retuned to keep the same measurement.
 */
describe("the settled settings", () => {
  it("puts the rail ΔL where `surfaceSpread` was solved to put it", () => {
    // Two targets, because perceptual step size is not symmetric about mid-grey:
    // 0.042 reads near paper, 0.020 reads near black, and the same number in both
    // would leave one mode's tab strip invisible.
    //
    // Dark's is 0.0197 rather than 0.0200 because the rungs are 8-bit and that is
    // the nearest one — the plateau either side of it spans spread 0.571–0.683,
    // and 0.627 is its middle.
    expect(railGap("light")).toBeCloseTo(0.042, 3);
    expect(railGap("dark")).toBeCloseTo(0.0197, 3);
  });

  it("holds the light rail gap ABOVE the dark one, which is the reason for two numbers", () => {
    // The relationship, not just the pair: if a retune ever collapses these to one
    // value, this is what says the mirror's defect has been forgotten.
    expect(railGap("light")).toBeGreaterThan(railGap("dark") * 1.8);
  });

  it("puts secondary copy and the label tier where `textWeight` was solved to put them", () => {
    // The two halves of one choice, and both have to hold: the weight is a single
    // position on two ranges, so a value that hits the secondary target and misses
    // the label one is not the value that was picked. The band satisfying both is
    // 0.122–0.144 in light and 0.211–0.233 in dark.
    expect(shownFloors("light")).toEqual({ secondary: 70, labelTowardBody: 51 });
    expect(shownFloors("dark")).toEqual({ secondary: 64, labelTowardBody: 55 });
  });

  it("delivers those floors as actual measured contrast on the card", () => {
    // The floors are an ask; this is what the solver returned. They agree to
    // within a rounding step on the ember default, which is what says the ask was
    // reachable rather than clamped.
    for (const resolved of MODES) {
      const tokens = deriveCanvasTokens(DEFAULT_CANVAS, resolved);
      const measured = Math.abs(apcaLc(tokens["--muted-foreground"], tokens["--card"]));
      expect({ resolved, measured }).toEqual({
        resolved,
        measured: expect.closeTo(copyFloors(resolved).secondary, 0),
      });
    }
  });
});

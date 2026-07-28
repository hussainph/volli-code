/**
 * Regenerates the two token blocks at the top of `src/renderer/src/globals.css`.
 *
 *     node apps/desktop/scripts/generate-theme-css.mjs        # rewrite in place
 *     node apps/desktop/scripts/generate-theme-css.mjs --check # fail if stale (CI-able)
 *
 * WHY THIS EXISTS. `globals.css` authors the default canvas's generated values
 * verbatim so the first paint already carries the right palette before any JS
 * runs. CLAUDE.md's rule for that block is *regenerate, never hand-tune* — and
 * light mode turns one block into two, `:root, :root.dark` and `:root.light`,
 * which must move together. A light block that drifts from the dark one is
 * exactly the failure that rule exists to prevent, and two blocks is precisely
 * where hand-tuning starts to look affordable. So it is one command.
 *
 * WHAT IT WRITES. Everything between the BEGIN/END markers below: the 31 app
 * tokens (`generateThemeTokens` → the canvas ladder), the 3 veils solved from
 * them, and the 10 canvas properties (`CANVAS_TOKEN_NAMES` in
 * `renderer/src/theme/canvas-paint.ts`) — the gradient, the on-canvas ink
 * ladder, the lift veils and the shadow tiers. All at `DEFAULT_CANVAS`. Nothing
 * outside the markers is touched, so the hand-authored non-color tokens (radius,
 * type scale, layout) stay where they are: theming moves color, never geometry.
 *
 * HOW IT LOADS `@volli/shared`. That package ships raw TypeScript with
 * extensionless relative imports, which Node's ESM resolver rejects on its own.
 * Node 24 strips the types; the resolve hook below supplies the extension. No
 * bundler, no extra dependency, no second copy of the pipeline.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { dirname, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";

const CANDIDATE_SUFFIXES = [".ts", ".tsx", "/index.ts"];

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith(".") && !/\.[cm]?[jt]sx?$/.test(specifier)) {
      const base = new URL(specifier, context.parentURL);
      for (const suffix of CANDIDATE_SUFFIXES) {
        const candidate = new URL(base.href + suffix);
        if (existsSync(fileURLToPath(candidate))) {
          return { url: candidate.href, shortCircuit: true };
        }
      }
    }
    return nextResolve(specifier, context);
  },
});

const {
  DEFAULT_CANVAS,
  canvasBackground,
  canvasElevation,
  canvasInk,
  deriveCanvasTokens,
  deriveLabelInk,
  generateVeilTokens,
  THEME_TOKEN_NAMES,
  THEME_VEIL_TOKEN_NAMES,
} = await import("@volli/shared");

const HERE = dirname(fileURLToPath(import.meta.url));
const GLOBALS_CSS = resolvePath(HERE, "../src/renderer/src/globals.css");

const BEGIN = "/* GENERATED THEME TOKENS — BEGIN */";
const END = "/* GENERATED THEME TOKENS — END */";

/**
 * Comments that ride along with specific tokens, so regenerating never costs
 * the reasoning attached to a value. Keyed by token name; emitted above it.
 */
const NOTES = {
  "--primary":
    "The accent, derived from the canvas's primary stop on the SAME vibrancy\n" +
    "   curve the gradient rides — a near-neutral wash still yields near-neutral\n" +
    "   chrome — but with neither the per-mode gain nor the per-mode cap, which\n" +
    "   exist to stop a backdrop fighting the ink and have no business holding\n" +
    "   down a button fill. So vibrancy 1 lands on the AUTHORED color exactly\n" +
    "   (ember #e8652a for the shipped canvas); the default ships at 0.6, which\n" +
    "   is why this is a quieter ember rather than the brand hex itself. It is\n" +
    "   the same hex in BOTH blocks: the accent carries no mode, so a light/dark\n" +
    "   flip repaints every surface and leaves it exactly where it is.",
  "--primary-text":
    "The accent solved to APCA Lc 60 on the card, for body-sized accent TEXT.\n" +
    "   `--primary` is below the floor as copy and cannot simply be brightened —\n" +
    "   its lightness is what makes it work as a fill. Fills and icons take\n" +
    "   `--primary`; anything you read takes this.",
  "--destructive":
    "Hue-locked: the semantic escape list never follows the canvas, or a red\n" +
    "   canvas would make “delete” indistinguishable from “primary”.",
  "--rail": "Two-tier sidebar depth: rail darkest, panel between rail and content.",
  "--sidebar-veil":
    "Veils (#74). The canvas paints the whole window behind the chrome, so the\n" +
    "   sidebar cannot keep an opaque fill — but it is a LIGHTER rung than the\n" +
    "   rail, so plain transparency would darken it. Each veil is the color that,\n" +
    "   at 10% over the surface named beside it, composites to the opaque token\n" +
    "   above byte-exactly.",
  "--canvas":
    "THE CANVAS ITSELF, and the nine values derived alongside it\n" +
    "   (`CANVAS_TOKEN_NAMES`, renderer/src/theme/canvas-paint.ts). The gradient\n" +
    "   is a `background` value, grain layer included, so the window can paint\n" +
    "   itself before any JS runs.",
  "--canvas-ink":
    "The on-canvas copy ladder, head first — solved against the gradient and\n" +
    "   the lifted tiers on it, NOT against the card. `--foreground` and\n" +
    "   `--muted-foreground` answer the same question for the other side of the\n" +
    "   card's edge; neither set can serve both surfaces.",
  "--lift-1":
    "Cumulative lift per on-canvas tier. Tier 1 (chrome band, project rail)\n" +
    "   takes a share of zero — the frame reads as a frame only if it is\n" +
    "   uniform — so it is `transparent` by design, not by omission.",
  "--label-ink": "The card's micro-label tier, between body and secondary.",
  "--shadow-raised": "The three shadow tiers: raised on a surface, the card, and overlays.",
};

/** One `--token: value;` line, with its note above it when it has one. */
function declaration(name, value) {
  const note = NOTES[name];
  const comment = note === undefined ? "" : `  /* ${note} */\n`;
  return `${comment}  ${name}: ${value};\n`;
}

/**
 * Every property one appearance implies, in the order they are written.
 *
 * The canvas properties come last and are derived exactly as
 * `deriveCanvasPaint` derives them — elevation before ink, because a lifted
 * tier is a surface the on-canvas text sits on and can be the worst case the
 * ink has to clear. Two implementations of that order would be two answers.
 */
function tokensFor(resolved) {
  const tokens = deriveCanvasTokens(DEFAULT_CANVAS, resolved);
  const veils = generateVeilTokens(tokens);
  const elevation = canvasElevation(DEFAULT_CANVAS, resolved, tokens);
  const ink = canvasInk(DEFAULT_CANVAS, resolved, elevation.surfaces);

  let css = "";
  for (const name of THEME_TOKEN_NAMES) css += declaration(name, tokens[name]);
  // Not a generated token, and not themeable — but it lives in this block
  // because every other value around it does, and a radius stranded outside the
  // markers would be the one line a regeneration silently dropped.
  css += declaration("--radius", "0.625rem");
  for (const name of THEME_VEIL_TOKEN_NAMES) css += declaration(name, veils[name]);
  css += declaration("--canvas", canvasBackground(DEFAULT_CANVAS, resolved));
  css += declaration("--canvas-ink", ink.ink);
  css += declaration("--canvas-ink-label", ink.inkLabel);
  css += declaration("--canvas-ink-muted", ink.inkMuted);
  css += declaration("--lift-1", elevation.tiers[0].veil);
  css += declaration("--lift-2", elevation.tiers[1].veil);
  css += declaration("--label-ink", deriveLabelInk(tokens, resolved));
  css += declaration("--shadow-raised", elevation.shadows.raised);
  css += declaration("--shadow-card", elevation.shadows.card);
  css += declaration("--shadow-overlay", elevation.shadows.overlay);
  return css;
}

function block() {
  return (
    `${BEGIN}\n` +
    "/*\n" +
    " * Every color below is the canvas pipeline's output for the shipped default\n" +
    " * canvas, verbatim: `deriveCanvasTokens(DEFAULT_CANVAS, mode)` and the\n" +
    " * elevation/ink pair solved beside it, at both appearances.\n" +
    " *\n" +
    " * REGENERATE, NEVER HAND-TUNE — and regenerate BOTH blocks together:\n" +
    " *     node apps/desktop/scripts/generate-theme-css.mjs\n" +
    " * A light block that has drifted from the dark one is the exact failure this\n" +
    " * rule exists to prevent, and it is invisible until someone switches mode.\n" +
    " *\n" +
    " * Non-color tokens (the type scale, the layout tokens) are NOT themeable and\n" +
    " * never appear here: theming moves color, never geometry or type.\n" +
    " */\n" +
    "/* Dark, and the no-class fallback. A boot that somehow reaches CSS with no\n" +
    ' * mode class stamped renders dark, exactly as the pinned `class="dark"` did. */\n' +
    ":root,\n:root.dark {\n" +
    "  color-scheme: dark;\n" +
    tokensFor("dark") +
    "}\n\n" +
    "/* Later in the file at equal specificity (0,2,0) to `:root.dark` and higher\n" +
    " * than bare `:root`, so an explicit light choice wins wherever it is stamped —\n" +
    " * by preload before first paint, or by `canvas-paint.ts` on every repaint after. */\n" +
    ":root.light {\n" +
    "  color-scheme: light;\n" +
    tokensFor("light") +
    "}\n" +
    `${END}`
  );
}

const source = readFileSync(GLOBALS_CSS, "utf8");
const start = source.indexOf(BEGIN);
const end = source.indexOf(END);
if (start === -1 || end === -1) {
  throw new Error(`globals.css is missing the ${BEGIN} / ${END} markers`);
}

/**
 * Runs the repo formatter over the file just written.
 *
 * Not a nicety. `vp fmt` normalizes what this emits — `0.0300` → `0.03`,
 * `68.0%` → `68%`, and it wraps the gradient's long value across lines — so a
 * generator that merely WROTE its output would report itself stale the moment
 * anyone ran `vp check`. Formatting here is what makes "regenerate" and "format"
 * agree on one canonical file instead of fighting over it.
 *
 * Prefers the workspace binary and falls back to whatever is on PATH, because
 * `vp` is a global toolchain CLI that may or may not be installed locally.
 */
function format() {
  const local = resolvePath(HERE, "../../../node_modules/.bin/vp");
  const bin = existsSync(local) ? local : "vp";
  const run = spawnSync(bin, ["fmt", GLOBALS_CSS], { stdio: "ignore" });
  if (run.status !== 0) {
    throw new Error(`\`${bin} fmt\` failed on globals.css — cannot verify the generated block`);
  }
}

writeFileSync(GLOBALS_CSS, source.slice(0, start) + block() + source.slice(end + END.length));
format();
const next = readFileSync(GLOBALS_CSS, "utf8");

if (process.argv.includes("--check")) {
  // Written, formatted, compared, and put back: --check must leave the tree
  // exactly as it found it whichever way the answer comes out.
  writeFileSync(GLOBALS_CSS, source);
  if (next !== source) {
    console.error("globals.css is stale — run `node apps/desktop/scripts/generate-theme-css.mjs`.");
    process.exit(1);
  }
  console.log("globals.css is up to date.");
} else {
  console.log(next === source ? "globals.css already up to date." : `Wrote ${GLOBALS_CSS}`);
}

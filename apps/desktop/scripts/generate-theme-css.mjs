/**
 * Regenerates every hand-copy of the shipped canvas's output: the two token
 * blocks at the top of `src/renderer/src/globals.css`, and the terminal's
 * literal fallback tokens in `src/renderer/src/terminal/appearance.ts`.
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
 * The terminal's fallback joined it after proving the point the hard way. That
 * table is the palette a config-less terminal wears before the stylesheet has
 * applied, it carried a note saying to regenerate it alongside these blocks, and
 * it spent the whole canvas migration holding the PREVIOUS system's hexes —
 * because nothing but the note connected them. Now one command writes both, and
 * `terminal/appearance.test.ts` fails if either drifts.
 *
 * WHAT IT WRITES. Everything between the BEGIN/END markers in both files: the 31
 * app tokens (`generateThemeTokens` → the canvas ladder), the 3 veils solved
 * from them, and the 10 canvas properties (`CANVAS_TOKEN_NAMES` in
 * `renderer/src/theme/canvas-paint.ts`) — the gradient, the on-canvas ink
 * ladder, the lift veils and the shadow tiers — plus the four of those the
 * terminal fallback needs. All at `DEFAULT_CANVAS`. Nothing outside the markers
 * is touched, so the hand-authored non-color tokens (radius, type scale, layout)
 * stay where they are: theming moves color, never geometry.
 *
 * HOW IT LOADS `@volli/shared` AND THE RENDERER'S CANVAS PIPELINE. Both ship raw
 * TypeScript with extensionless relative imports, which Node's ESM resolver
 * rejects on its own; Node 24 strips the types, and the resolve hook below
 * supplies the missing extension. The renderer additionally resolves `@renderer/*`
 * through a bundler alias with no Node-native equivalent, so the same hook also
 * maps that prefix onto `src/renderer/src/`. That is what lets this script call
 * `canvas-paint.ts`'s own `deriveCanvasPaint` instead of re-deriving its output —
 * the exact function the renderer paints the DOM with, at both appearances, so
 * the canvas declarations below and a live repaint cannot disagree about what a
 * canvas produces. No bundler, no extra dependency beyond what that import chain
 * already needs (react, restty — both resolve headless; nothing on the path from
 * `canvas-paint.ts` to its imports touches `document` or `window` at module load,
 * only inside functions this script never calls).
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { dirname, resolve as resolvePath } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const CANDIDATE_SUFFIXES = [".ts", ".tsx", "/index.ts"];

const HERE = dirname(fileURLToPath(import.meta.url));

/** `src/renderer/src/`, as a directory URL — where a bare `@renderer/*` points. */
const RENDERER_SRC = pathToFileURL(`${resolvePath(HERE, "../src/renderer/src")}/`);

/** The first `base.href + suffix` that exists on disk, or null. */
function resolveExtensionless(base) {
  for (const suffix of CANDIDATE_SUFFIXES) {
    const candidate = new URL(base.href + suffix);
    if (existsSync(fileURLToPath(candidate))) return candidate.href;
  }
  return null;
}

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith("@renderer/")) {
      const base = new URL(specifier.slice("@renderer/".length), RENDERER_SRC);
      const resolved = resolveExtensionless(base);
      if (resolved !== null) return { url: resolved, shortCircuit: true };
    } else if (specifier.startsWith(".") && !/\.[cm]?[jt]sx?$/.test(specifier)) {
      const base = new URL(specifier, context.parentURL);
      const resolved = resolveExtensionless(base);
      if (resolved !== null) return { url: resolved, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});

const {
  DEFAULT_CANVAS,
  deriveCanvasTokens,
  generateVeilTokens,
  THEME_TOKEN_NAMES,
  THEME_VEIL_TOKEN_NAMES,
} = await import("@volli/shared");

// The single source of truth for which properties a canvas is responsible for,
// and the single function that derives their values — imported rather than
// mirrored, so a name added to one and not the other (the failure mode this
// script used to allow) cannot happen here. See `declaration` below for what
// backs that up when a name IS added without a matching value.
const { CANVAS_TOKEN_NAMES, deriveCanvasPaint } = await import("@renderer/theme/canvas-paint");

const GLOBALS_CSS = resolvePath(HERE, "../src/renderer/src/globals.css");
const TERMINAL_APPEARANCE_TS = resolvePath(HERE, "../src/renderer/src/terminal/appearance.ts");

const BEGIN = "/* GENERATED THEME TOKENS — BEGIN */";
const END = "/* GENERATED THEME TOKENS — END */";

const TERMINAL_BEGIN = "/* GENERATED TERMINAL FALLBACK TOKENS — BEGIN */";
const TERMINAL_END = "/* GENERATED TERMINAL FALLBACK TOKENS — END */";

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

/**
 * One `--token: value;` line, with its note above it when it has one.
 *
 * Throws on a missing value rather than emitting `undefined` into the
 * stylesheet. The one caller this actually guards is the `CANVAS_TOKEN_NAMES`
 * loop below: `canvas-paint.test.ts` already keeps that list and
 * `deriveCanvasPaint`'s output in lockstep on the renderer side, but this is
 * what turns the same mistake into a loud failure HERE too, rather than a
 * `--new-token: undefined;` line that `--check` would wave through.
 */
function declaration(name, value) {
  if (value === undefined) throw new Error(`no value derived for ${name}`);
  const note = NOTES[name];
  const comment = note === undefined ? "" : `  /* ${note} */\n`;
  return `${comment}  ${name}: ${value};\n`;
}

/**
 * Every property one appearance implies, in the order they are written.
 *
 * The canvas properties come last and are `deriveCanvasPaint`'s own output —
 * called directly, not re-derived, so this script and a live repaint read off
 * the same function rather than two copies of the same pipeline that could
 * disagree about elevation-before-ink or anything else.
 */
function tokensFor(resolved) {
  const { tokens, canvasTokens } = deriveCanvasPaint(DEFAULT_CANVAS, resolved);
  const veils = generateVeilTokens(tokens);

  let css = "";
  for (const name of THEME_TOKEN_NAMES) css += declaration(name, tokens[name]);
  // Not a generated token, and not themeable — but it lives in this block
  // because every other value around it does, and a radius stranded outside the
  // markers would be the one line a regeneration silently dropped.
  css += declaration("--radius", "0.75rem");
  for (const name of THEME_VEIL_TOKEN_NAMES) css += declaration(name, veils[name]);
  for (const name of CANVAS_TOKEN_NAMES) css += declaration(name, canvasTokens[name]);
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

/** `#rrggbb` → the `rgb(0x…, 0x…, 0x…)` call `terminal/appearance.ts` is written in. */
function rgbCall(hex) {
  const parts = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (parts === null) throw new Error(`expected a 6-digit hex, got ${hex}`);
  return `rgb(0x${parts[1]}, 0x${parts[2]}, 0x${parts[3]})`;
}

/**
 * The four app tokens the terminal's config-less palette is assembled from —
 * `FallbackTokens` in `terminal/appearance.ts`, field by field, beside the token
 * each field stands in for. Kept in that order so a regeneration is a value
 * diff and never a reordering.
 */
const TERMINAL_FALLBACK_FIELDS = [
  ["background", "--background"],
  ["foreground", "--foreground"],
  ["cursor", "--primary"],
  ["ansiRed", "--destructive"],
];

/** One appearance's entry in the `FALLBACK_TOKENS` record. */
function terminalFallbackEntry(resolved) {
  const tokens = deriveCanvasTokens(DEFAULT_CANVAS, resolved);
  let body = "";
  for (const [field, name] of TERMINAL_FALLBACK_FIELDS) {
    body += `    ${field}: ${rgbCall(tokens[name])}, // ${name}\n`;
  }
  return `  ${resolved}: {\n${body}  },\n`;
}

function terminalBlock() {
  return (
    `${TERMINAL_BEGIN}\n` +
    "export const FALLBACK_TOKENS: Record<ResolvedAppearance, FallbackTokens> = {\n" +
    terminalFallbackEntry("dark") +
    terminalFallbackEntry("light") +
    "};\n" +
    TERMINAL_END
  );
}

/** Every file this command owns a marked block in. */
const TARGETS = [
  { path: GLOBALS_CSS, name: "globals.css", begin: BEGIN, end: END, body: block() },
  {
    path: TERMINAL_APPEARANCE_TS,
    name: "terminal/appearance.ts",
    begin: TERMINAL_BEGIN,
    end: TERMINAL_END,
    body: terminalBlock(),
  },
];

/** Replaces one file's marked block, answering with what the file said BEFORE. */
function rewrite({ path, name, begin, end, body }) {
  const source = readFileSync(path, "utf8");
  const start = source.indexOf(begin);
  const stop = source.indexOf(end);
  if (start === -1 || stop === -1) {
    throw new Error(`${name} is missing the ${begin} / ${end} markers`);
  }
  writeFileSync(path, source.slice(0, start) + body + source.slice(stop + end.length));
  return source;
}

/**
 * Runs the repo formatter over the files just written.
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
function format(paths) {
  const local = resolvePath(HERE, "../../../node_modules/.bin/vp");
  const bin = existsSync(local) ? local : "vp";
  const run = spawnSync(bin, ["fmt", ...paths], { stdio: "ignore" });
  if (run.status !== 0) {
    throw new Error(`\`${bin} fmt\` failed — cannot verify the generated blocks`);
  }
}

const isCheck = process.argv.includes("--check");
const before = TARGETS.map(rewrite);
let moved = [];
try {
  format(TARGETS.map(({ path }) => path));
  const after = TARGETS.map(({ path }) => readFileSync(path, "utf8"));
  moved = TARGETS.filter((_, index) => after[index] !== before[index]);
} finally {
  // --check must leave the tree exactly as it found it whichever way the
  // answer comes out — INCLUDING when `format()` throws (`vp fmt` exiting
  // non-zero). That is why this restore is a `finally`, not a step at the top
  // of the `--check` branch below: this is the one place both the success
  // path and the thrown-error path pass through on their way out.
  if (isCheck) TARGETS.forEach(({ path }, index) => writeFileSync(path, before[index]));
}

if (isCheck) {
  if (moved.length > 0) {
    console.error(
      `${moved.map(({ name }) => name).join(", ")} stale — run \`node apps/desktop/scripts/generate-theme-css.mjs\`.`,
    );
    process.exit(1);
  }
  console.log(`${TARGETS.map(({ name }) => name).join(", ")} are up to date.`);
} else {
  console.log(
    moved.length === 0
      ? "already up to date."
      : `Wrote ${moved.map(({ path }) => path).join(", ")}`,
  );
}

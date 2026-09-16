/**
 * Regenerates `packages/shared/src/ghostty-theme-sources.generated.ts` — the
 * vendored copy of Ghostty's own bundled theme collection, one entry per
 * theme file under Ghostty.app's `Contents/Resources/ghostty/themes/`, keyed
 * by filename (the theme's name) and sorted case-insensitively so the picker
 * order matches what restty's bundled catalog gave the app before this file
 * existed (VC-107: the app owns this vocabulary now, restty no longer ships
 * it to us).
 *
 *     node apps/desktop/scripts/generate-ghostty-themes.mjs         # rewrite in place
 *     node apps/desktop/scripts/generate-ghostty-themes.mjs --check # fail if stale (CI-able)
 *
 * The themes directory defaults to Ghostty.app's bundled location and is
 * overridable — `--themes-dir <path>` or `GHOSTTY_THEMES_DIR` — for a machine
 * without Ghostty.app installed (this script does not run in this repo's
 * Linux CI job for exactly that reason: there is nothing to point it at
 * there, so regeneration and `--check` are a local, pre-commit step, same as
 * a person running it after installing/updating Ghostty.app).
 *
 * Modeled on `generate-theme-css.mjs`: same `--check` convention (diff
 * in-memory, restore the file exactly, never leave `--check` with a dirty
 * tree), and the same "run `vp fmt` over what was written" step so the
 * generated file and the repo formatter cannot disagree about what "up to
 * date" looks like.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUTPUT = resolvePath(HERE, "../../../packages/shared/src/ghostty-theme-sources.generated.ts");

const DEFAULT_THEMES_DIR = "/Applications/Ghostty.app/Contents/Resources/ghostty/themes";

/** `--themes-dir <path>` from argv, or null when the flag is absent. */
function themesDirFlag(argv) {
  const index = argv.indexOf("--themes-dir");
  if (index === -1) return null;
  const value = argv[index + 1];
  if (value === undefined) throw new Error("--themes-dir needs a path argument");
  return value;
}

function resolveThemesDir(argv) {
  return themesDirFlag(argv) ?? process.env["GHOSTTY_THEMES_DIR"] ?? DEFAULT_THEMES_DIR;
}

/**
 * Every theme name paired with its raw file text, sorted case-insensitively
 * (locale-aware compare matches how the previous, restty-supplied catalog was
 * ordered — same rule `Intl.Collator` gives for a plain alphabetical list).
 */
function readThemes(themesDir) {
  if (!existsSync(themesDir)) {
    throw new Error(
      `Ghostty themes directory not found: ${themesDir}\n` +
        "Install Ghostty.app, or point this script at a themes directory with " +
        "--themes-dir <path> or GHOSTTY_THEMES_DIR.",
    );
  }
  const names = readdirSync(themesDir, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .toSorted((a, b) => a.localeCompare(b, "en", { sensitivity: "base" }));

  return names.map((name) => [name, readFileSync(resolvePath(themesDir, name), "utf8")]);
}

/** The generated module's full source text. */
function render(themes, themesDir) {
  const entries = themes
    .map(([name, text]) => `  ${JSON.stringify(name)}: ${JSON.stringify(text)},`)
    .join("\n");

  return (
    "// GENERATED — do not hand-edit. Regenerate with:\n" +
    "//     node apps/desktop/scripts/generate-ghostty-themes.mjs\n" +
    "//\n" +
    `// Vendored verbatim from Ghostty.app's bundled theme collection (${themes.length} files\n` +
    `// at generation time), read from:\n` +
    `//     ${themesDir}\n` +
    "// One entry per theme file, keyed by filename (the theme's own name) and\n" +
    "// sorted case-insensitively. `ghostty-theme.ts` parses these lazily through\n" +
    "// `getGhosttyTheme`; nothing here is hand-authored.\n" +
    "export const GHOSTTY_THEME_SOURCES: Record<string, string> = {\n" +
    `${entries}\n` +
    "};\n"
  );
}

/** Runs the repo formatter over `path` — see `generate-theme-css.mjs` for why. */
function format(path) {
  const local = resolvePath(HERE, "../../../node_modules/.bin/vp");
  const bin = existsSync(local) ? local : "vp";
  const run = spawnSync(bin, ["fmt", path], { stdio: "ignore" });
  if (run.status !== 0) {
    throw new Error(`\`${bin} fmt\` failed — cannot verify the generated file`);
  }
}

const argv = process.argv.slice(2);
const isCheck = argv.includes("--check");
const themesDir = resolveThemesDir(argv);

const themes = readThemes(themesDir);
const body = render(themes, themesDir);

const before = existsSync(OUTPUT) ? readFileSync(OUTPUT, "utf8") : null;
writeFileSync(OUTPUT, body);

let moved = before !== body;
try {
  format(OUTPUT);
  const after = readFileSync(OUTPUT, "utf8");
  moved = before !== after;
} finally {
  // --check must leave the tree exactly as it found it: restore the prior
  // content when there was one, or remove the file this run wrote when there
  // was not (a fresh checkout with no generated file yet).
  if (isCheck) {
    if (before !== null) writeFileSync(OUTPUT, before);
    else rmSync(OUTPUT, { force: true });
  }
}

if (isCheck) {
  if (moved) {
    console.error(
      `ghostty-theme-sources.generated.ts stale — run \`node apps/desktop/scripts/generate-ghostty-themes.mjs\`.`,
    );
    process.exit(1);
  }
  console.log("ghostty-theme-sources.generated.ts is up to date.");
} else {
  console.log(moved ? `Wrote ${OUTPUT}` : "already up to date.");
}

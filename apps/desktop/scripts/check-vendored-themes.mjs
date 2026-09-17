/**
 * Refuses a source tree that has started redistributing terminal themes again.
 *
 *     node apps/desktop/scripts/check-vendored-themes.mjs             # the gate
 *     node apps/desktop/scripts/check-vendored-themes.mjs --self-test # the detector's own tests
 *
 * WHY THIS EXISTS (VC-413). The app used to ship
 * `packages/shared/src/ghostty-theme-sources.generated.ts`: 463 theme files
 * copied verbatim out of Ghostty.app's bundled collection, most of them
 * originally iTerm2 color schemes, none of whose individual license status
 * anybody had verified — one of them, Monokai Pro, a known problem. The owner's
 * call was to remove all of it. That removal is a commit; what this file
 * protects is the month after, because every force that produced the catalog is
 * still there. A picker wants a list. A generator script is eleven lines. The
 * material is sitting on the developer's own disk at a stable path, and pasting
 * it in looks exactly like a normal feature commit in review.
 *
 * WHAT IT LOOKS FOR, and why it is content and not a filename. Blocking the old
 * paths would be trivially defeated by a new one, and blocking theme NAMES would
 * mean shipping a list of the very names that must not be shipped. So the gate
 * reads what a vendored terminal-theme catalog actually IS: a file carrying many
 * `palette = <index>=<color>` entries, which is Ghostty/iTerm2 theme grammar and
 * nothing else in this codebase. A parser test with a couple of palette lines is
 * far under the threshold; a pasted theme file blows past it on its own, and a
 * catalog of them is not close.
 *
 * It also fails on a file that merely NAMES the deleted catalog module or its
 * generator, so a half-restored wiring is reported at the door rather than as a
 * module-not-found at build time.
 *
 * The user's own Ghostty config and theme files are untouched by any of this:
 * they live on their machine, this gate reads only what the repository tracks.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "../../..");

/**
 * How many `palette = N=<color>` entries one file may carry before it is a
 * vendored theme rather than a test for the parser.
 *
 * A Ghostty theme file defines all sixteen ANSI slots, so any real one is at or
 * over sixteen; the parser's own tests use one or two lines at a time. Twelve
 * sits in the empty space between those two populations, far from both.
 */
export const PALETTE_ENTRY_LIMIT = 12;

/** `palette = 0=#ffffff` and the `\n`-escaped spelling a vendored string literal uses. */
const PALETTE_ENTRY = /palette\s*=\s*\d{1,3}\s*=\s*#?[0-9a-fA-F]{6,8}/g;

/** Identifiers of the catalog that was deleted, so a partial restore is named early. */
const RETIRED_CATALOG_REFERENCES = [
  "ghostty-theme-sources",
  "generate-ghostty-themes",
  "GHOSTTY_THEME_SOURCES",
];

/**
 * Every reason `text` looks like redistributed terminal-theme material, or an
 * empty array.
 *
 * Exported for {@link selfTest}: the detector is the whole gate, so it is what
 * has to be proven against known-good and known-bad inputs rather than trusted.
 */
export function vendoredThemeFindings(text) {
  const findings = [];

  const entries = text.match(PALETTE_ENTRY) ?? [];
  if (entries.length > PALETTE_ENTRY_LIMIT) {
    findings.push(
      `${entries.length} \`palette = N=<color>\` entries (limit ${PALETTE_ENTRY_LIMIT}) — ` +
        `this is a terminal theme's own colors, not a test fixture`,
    );
  }

  for (const reference of RETIRED_CATALOG_REFERENCES) {
    if (text.includes(reference)) findings.push(`names the retired catalog (\`${reference}\`)`);
  }

  return findings;
}

/**
 * Every file git tracks, minus this one.
 *
 * Tracked files rather than a directory walk: what matters is what the
 * repository would distribute, and it keeps the gate away from `node_modules`
 * (which legitimately contains other people's themes) and untracked scratch
 * work without a second ignore list to maintain. This file is excluded because
 * it describes what it forbids and would otherwise convict itself.
 */
function trackedFiles() {
  const self = "apps/desktop/scripts/check-vendored-themes.mjs";
  return execFileSync("git", ["-C", REPO_ROOT, "ls-files", "-z"], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  })
    .split("\0")
    .filter((path) => path.length > 0 && path !== self);
}

/** Reads a tracked file as text; a binary or unreadable file simply has no findings. */
function readTracked(path) {
  try {
    return readFileSync(resolve(REPO_ROOT, path), "utf8");
  } catch {
    return null;
  }
}

/** Runs the gate over the tracked tree; returns `path -> reasons` for every offender. */
export function scanRepository() {
  const offenders = new Map();
  for (const path of trackedFiles()) {
    const text = readTracked(path);
    if (text === null) continue;
    const findings = vendoredThemeFindings(text);
    if (findings.length > 0) offenders.set(path, findings);
  }
  return offenders;
}

/**
 * The detector against both populations it has to tell apart. Run in CI before
 * the gate itself, on the same argument as `check-node-version.mjs`: a detector
 * nobody tests is a gate that can quietly start passing everything.
 */
function selfTest() {
  const failures = [];
  const expect = (label, actual, wanted) => {
    if (actual !== wanted) failures.push(`${label}: expected ${wanted}, got ${actual}`);
  };

  // A whole vendored theme — sixteen slots plus the semantic keys.
  const theme = [
    ...Array.from({ length: 16 }, (_, index) => `palette = ${index}=#0a0b0c`),
    "background = #101010",
    "foreground = #f0f0f0",
  ].join("\n");
  expect("a vendored theme is caught", vendoredThemeFindings(theme).length > 0, true);

  // The same material as a JS string literal, which is the shape the deleted
  // generated module used and the shape a re-vendoring would most likely take.
  const asLiteral = `const x = ${JSON.stringify(`${theme}\n`)};`;
  expect(
    "a vendored theme in a string literal is caught",
    vendoredThemeFindings(asLiteral).length > 0,
    true,
  );

  // The parser's own fixtures must stay legal — this gate is worthless if it
  // makes testing the parser impossible.
  const fixture = 'parseGhosttyTheme("palette = 0=#000000\\npalette = 15=#ffffff")';
  expect("a small parser fixture passes", vendoredThemeFindings(fixture).length, 0);
  expect("ordinary source passes", vendoredThemeFindings("export const a = 1;\n").length, 0);

  // Exactly at the limit is still a fixture; one past it is a theme.
  const atLimit = Array.from(
    { length: PALETTE_ENTRY_LIMIT },
    (_, index) => `palette = ${index}=#000000`,
  ).join("\n");
  expect("the limit itself passes", vendoredThemeFindings(atLimit).length, 0);
  expect(
    "one past the limit fails",
    vendoredThemeFindings(`${atLimit}\npalette = 99=#000000`).length > 0,
    true,
  );

  // A restored import of the deleted module, with no palette data of its own.
  expect(
    "a reference to the retired catalog is caught",
    vendoredThemeFindings('import { X } from "./ghostty-theme-sources.generated";').length > 0,
    true,
  );

  if (failures.length > 0) {
    console.error(`check-vendored-themes self-test failed:\n  ${failures.join("\n  ")}`);
    process.exit(1);
  }
  console.log("check-vendored-themes self-test passed");
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  if (process.argv.includes("--self-test")) {
    selfTest();
  } else {
    const offenders = scanRepository();
    if (offenders.size > 0) {
      console.error(
        "Redistributed terminal-theme material is back in the tree (VC-413):\n" +
          [...offenders]
            .map(([path, reasons]) => `  ${path}\n${reasons.map((r) => `    - ${r}`).join("\n")}`)
            .join("\n") +
          "\n\nVolli ships no terminal theme catalog. A theme belongs on the user's own\n" +
          "machine, read from their Ghostty config; the app's own fallback is derived\n" +
          "from its design tokens (renderer/src/terminal/appearance.ts).",
      );
      process.exit(1);
    }
    console.log("check-vendored-themes: no redistributed terminal themes in the tree.");
  }
}

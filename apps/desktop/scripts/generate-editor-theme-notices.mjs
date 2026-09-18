#!/usr/bin/env node
/**
 * Generate apps/desktop/notices/editor-themes.NOTICE from upstream tm-themes
 * NOTICE — the theme-DATA fragment that generate-third-party-notices.mjs folds
 * into the shipped THIRD-PARTY-NOTICES.
 *
 * Usage:
 *   node apps/desktop/scripts/generate-editor-theme-notices.mjs <path-to-upstream-NOTICE>
 *
 * Upstream source:
 *   https://github.com/shikijs/textmate-grammars-themes/blob/main/packages/tm-themes/NOTICE
 *
 * WHY IT IS A FRAGMENT (VC-407). The Shiki runtime packages this used to list
 * by hand are ordinary production dependencies, so the notice generator already
 * reaches them through the dependency closure and reads their licence files
 * itself. What no dependency walk can see is the theme JSON's own upstream
 * copyrights, which live in tm-themes' NOTICE rather than in any package's
 * LICENSE. That is all this script extracts, and the upstream NOTICE is the one
 * input it cannot derive — hence the path argument, and hence a checked-in
 * fragment instead of a step in the offline generator.
 *
 * Theme ids are read from `EDITOR_THEME_BY_APPEARANCE` in
 * `packages/shared/src/theme/editor-themes.ts` so this script cannot drift from
 * the fixed light/dark pair Monaco bootstraps.
 *
 * The map holds the only theme-id literals. Read that one source instead of
 * duplicating the pair in this plain-Node script.
 *
 * EDITOR themes only, and the header says so out loud (VC-413). Volli used to
 * ship a second body of other people's color work — 463 Ghostty/iTerm2 terminal
 * themes vendored into @volli/shared — which this file never covered and never
 * could, because nobody had established what any of it was licensed under. It
 * was removed rather than documented. The header states the absence so that a
 * reader of the notices learns it from the notices, and so that a future
 * terminal theme arriving with no notice entry reads as the omission it would
 * be; `check-vendored-themes.mjs` is the gate that keeps it true.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(root, "../..");
const sharedEditorThemesPath = resolve(repoRoot, "packages/shared/src/theme/editor-themes.ts");

/**
 * Parse `EDITOR_THEME_BY_APPEARANCE`'s values from shared source (plain Node, no
 * TS loader). Order follows the map, which is light-then-dark.
 * @returns {string[]}
 */
function readShippedEditorThemeIdsFromShared() {
  const source = readFileSync(sharedEditorThemesPath, "utf8");
  const match = source.match(/const EDITOR_THEME_BY_APPEARANCE\s*=\s*\{([\s\S]*?)\}\s*as const/);
  if (match === null) {
    throw new Error(`Could not find EDITOR_THEME_BY_APPEARANCE in ${sharedEditorThemesPath}`);
  }
  // `light: "vitesse-light",` — take the VALUE of each entry.
  const ids = [...match[1].matchAll(/:\s*"([^"]+)"/g)].map((m) => m[1]);
  if (ids.length === 0) {
    throw new Error(`EDITOR_THEME_BY_APPEARANCE parsed empty from ${sharedEditorThemesPath}`);
  }
  if (new Set(ids).size !== ids.length) {
    throw new Error(
      `EDITOR_THEME_BY_APPEARANCE in ${sharedEditorThemesPath} maps two appearances to one theme`,
    );
  }
  return ids;
}

/** Sole theme-id source — must stay identical to the shared appearance map. */
const SHIPPED_THEME_IDS = readShippedEditorThemeIdsFromShared();

const noticePath = process.argv[2];
if (!noticePath) {
  console.error(
    "Usage: node apps/desktop/scripts/generate-editor-theme-notices.mjs <path-to-upstream-NOTICE>",
  );
  process.exit(1);
}

const outPath = resolve(root, "notices/editor-themes.NOTICE");
const text = readFileSync(resolve(noticePath), "utf8");
const blocks = text
  .split(/^=+$/m)
  .map((block) => block.trim())
  .filter(Boolean);

const selected = [];
for (const block of blocks) {
  const filesLine = block.split("\n").find((line) => line.startsWith("Files: "));
  if (filesLine === undefined) continue;
  const files = new Set(
    filesLine
      .slice("Files: ".length)
      .split(",")
      .map((file) => file.trim().replace(/\.json$/, "")),
  );
  const hits = SHIPPED_THEME_IDS.filter((id) => files.has(id));
  if (hits.length === 0) continue;
  const narrowedFiles = hits.map((id) => `${id}.json`).join(", ");
  selected.push(block.replace(/^Files:.*$/m, `Files: ${narrowedFiles}`));
}

const missing = SHIPPED_THEME_IDS.filter(
  (id) => !selected.some((block) => block.includes(`${id}.json`)),
);
if (missing.length > 0) {
  throw new Error(`Missing NOTICE coverage for: ${missing.join(", ")}`);
}

// Hard assert: NOTICE Files: lines cover exactly the shared id set.
const covered = new Set();
for (const block of selected) {
  const filesLine = block.split("\n").find((line) => line.startsWith("Files: "));
  if (filesLine === undefined) continue;
  for (const file of filesLine.slice("Files: ".length).split(",")) {
    covered.add(file.trim().replace(/\.json$/, ""));
  }
}
const sharedSet = new Set(SHIPPED_THEME_IDS);
if (
  covered.size !== sharedSet.size ||
  [...sharedSet].some((id) => !covered.has(id)) ||
  [...covered].some((id) => !sharedSet.has(id))
) {
  throw new Error(
    "NOTICE theme ids must equal EDITOR_THEME_BY_APPEARANCE's values from @volli/shared exactly",
  );
}

const header = `Licence notices for the TextMate theme data bundled with Volli Code's Monaco
editor (via @shikijs/themes). Extracted from the upstream shikijs/textmate-
grammars-themes packages/tm-themes/NOTICE for only the themes Volli ships; the
Shiki runtime packages that load them are ordinary dependencies and are covered
by the package index in THIRD-PARTY-NOTICES.

Regenerate with:

  node apps/desktop/scripts/generate-editor-theme-notices.mjs <path-to-upstream-NOTICE>

Shipped theme ids:
${SHIPPED_THEME_IDS.map((id) => `  - ${id}`).join("\n")}

No terminal themes are bundled. Volli Code ships no Ghostty or iTerm2 color
schemes: the terminal is painted from the user's own Ghostty configuration,
read from their machine, or from a palette derived from Volli's own design
tokens. Nothing in that path is redistributed, so nothing in it appears below.
`;

const body = selected
  .map(
    (block) =>
      `=========================================================================================================\n${block}\n`,
  )
  .join("\n");

writeFileSync(outPath, `${header}\n${body}`);
console.log(
  `Wrote ${outPath} (${selected.length} theme license blocks, ${SHIPPED_THEME_IDS.length} themes)`,
);

#!/usr/bin/env node
/**
 * Generate apps/desktop/THIRD-PARTY-NOTICES from upstream tm-themes NOTICE.
 *
 * Usage:
 *   node apps/desktop/scripts/generate-editor-theme-notices.mjs <path-to-upstream-NOTICE>
 *
 * Upstream source:
 *   https://github.com/shikijs/textmate-grammars-themes/blob/main/packages/tm-themes/NOTICE
 *
 * Theme ids are read from `SHIPPED_EDITOR_THEME_IDS` in
 * `packages/shared/src/theme/editor-themes.ts` so this script cannot drift from
 * the IPC vocabulary / renderer catalog.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(root, "../..");
const sharedEditorThemesPath = resolve(repoRoot, "packages/shared/src/theme/editor-themes.ts");
const SHIKI_RUNTIME_PACKAGES = [
  { name: "shiki", licenseFile: "LICENSE" },
  { name: "@shikijs/monaco", licenseFile: "LICENSE" },
  { name: "@shikijs/langs", licenseFile: "LICENSE" },
  { name: "@shikijs/themes", licenseFile: "LICENSE" },
  { name: "@shikijs/vscode-textmate", licenseFile: "LICENSE.md" },
];

/**
 * Parse `SHIPPED_EDITOR_THEME_IDS` from shared source (plain Node, no TS loader).
 * @returns {string[]}
 */
function readShippedEditorThemeIdsFromShared() {
  const source = readFileSync(sharedEditorThemesPath, "utf8");
  const match = source.match(
    /export const SHIPPED_EDITOR_THEME_IDS\s*=\s*\[([\s\S]*?)\]\s*as const/,
  );
  if (match === null) {
    throw new Error(`Could not find SHIPPED_EDITOR_THEME_IDS in ${sharedEditorThemesPath}`);
  }
  const ids = [...match[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  if (ids.length === 0) {
    throw new Error(`SHIPPED_EDITOR_THEME_IDS parsed empty from ${sharedEditorThemesPath}`);
  }
  if (new Set(ids).size !== ids.length) {
    throw new Error(`SHIPPED_EDITOR_THEME_IDS in ${sharedEditorThemesPath} contains duplicate ids`);
  }
  return ids;
}

/** Sole theme-id source — must stay identical to `@volli/shared`'s export. */
const SHIPPED_THEME_IDS = readShippedEditorThemeIdsFromShared();

const noticePath = process.argv[2];
if (!noticePath) {
  console.error(
    "Usage: node apps/desktop/scripts/generate-editor-theme-notices.mjs <path-to-upstream-NOTICE>",
  );
  process.exit(1);
}

const outPath = resolve(root, "THIRD-PARTY-NOTICES");
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
    "NOTICE theme ids must equal SHIPPED_EDITOR_THEME_IDS from @volli/shared exactly",
  );
}

const header = `THIRD-PARTY SOFTWARE NOTICES AND INFORMATION

This file lists license notices for TextMate themes bundled with Volli Code's
Monaco editor (via @shikijs/themes), plus the Shiki runtime packages used to
load them. Theme notices are extracted from the upstream shikijs/textmate-
grammars-themes packages/tm-themes/NOTICE for only the themes Volli ships.
Regenerate with:

  node apps/desktop/scripts/generate-editor-theme-notices.mjs <path-to-upstream-NOTICE>

Shipped theme ids:
${SHIPPED_THEME_IDS.map((id) => `  - ${id}`).join("\n")}
`;

const runtimeLicenseGroups = new Map();
for (const { name, licenseFile } of SHIKI_RUNTIME_PACKAGES) {
  const licenseText = readFileSync(resolve(root, "node_modules", name, licenseFile), "utf8").trim();
  const packageNames = runtimeLicenseGroups.get(licenseText) ?? [];
  packageNames.push(name);
  runtimeLicenseGroups.set(licenseText, packageNames);
}
const runtimeBlocks = [...runtimeLicenseGroups].map(
  ([licenseText, packageNames]) => `Packages: ${packageNames.join(", ")}
SPDX: MIT
---------------------------------------------------------------------------------------------------------
${licenseText}`,
);

const body = [...runtimeBlocks, ...selected]
  .map(
    (block) =>
      `=========================================================================================================\n${block}\n`,
  )
  .join("\n");

writeFileSync(outPath, `${header}\n${body}`);
console.log(
  `Wrote ${outPath} (${selected.length} theme license blocks, ${SHIPPED_THEME_IDS.length} themes, ${SHIKI_RUNTIME_PACKAGES.length} runtime packages)`,
);

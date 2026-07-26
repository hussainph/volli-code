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
 * Theme ids are kept in sync with editor-theme-catalog.ts by listing the same
 * set here — update both when the catalog changes.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Must match `listEditorThemes()` ids in editor-theme-catalog.ts. */
const SHIPPED_THEME_IDS = [
  "catppuccin-mocha",
  "catppuccin-macchiato",
  "catppuccin-frappe",
  "tokyo-night",
  "rose-pine",
  "rose-pine-moon",
  "nord",
  "gruvbox-dark-medium",
  "dracula",
  "one-dark-pro",
  "ayu-dark",
  "ayu-mirage",
  "solarized-dark",
  "night-owl",
  "github-dark",
  "vitesse-dark",
  "everforest-dark",
  "kanagawa-wave",
  "kanagawa-dragon",
  "monokai",
  "dark-plus",
  "material-theme-palenight",
];

const noticePath = process.argv[2];
if (!noticePath) {
  console.error(
    "Usage: node apps/desktop/scripts/generate-editor-theme-notices.mjs <path-to-upstream-NOTICE>",
  );
  process.exit(1);
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
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

const header = `THIRD-PARTY SOFTWARE NOTICES AND INFORMATION

This file lists license notices for TextMate themes bundled with Volli Code's
Monaco editor (via @shikijs/themes). Notices are extracted from the upstream
shikijs/textmate-grammars-themes packages/tm-themes/NOTICE for only the themes
Volli ships. Regenerate with:

  node apps/desktop/scripts/generate-editor-theme-notices.mjs <path-to-upstream-NOTICE>

Shipped theme ids:
${SHIPPED_THEME_IDS.map((id) => `  - ${id}`).join("\n")}
`;

const body = selected
  .map(
    (block) =>
      `=========================================================================================================\n${block}\n`,
  )
  .join("\n");

writeFileSync(outPath, `${header}\n${body}`);
console.log(
  `Wrote ${outPath} (${selected.length} license blocks, ${SHIPPED_THEME_IDS.length} themes)`,
);

/**
 * Verifies that the packed preload can actually run under Electron's sandbox
 * — and repairs the one vestigial line the bundler adds that would stop it.
 *
 * The sandboxed preload (Electron ≥20 default) cannot `require()` sibling
 * chunk files; `vite.config.ts`'s pack CAUTION keeps the main and preload
 * entries dependency-disjoint for exactly that reason. The bundler defeats
 * the intent from the other side: whenever MAIN's graph needs the shared
 * `rolldown-runtime-*.cjs` helper chunk, the emitted `preload.cjs` gets a
 * `require("./rolldown-runtime-*.cjs")` prepended even when preload uses none
 * of the helpers that chunk defines. Under the sandbox that require throws
 * ("module not found"), the whole preload is skipped, `window.api` never
 * exists, and the renderer dies on its first bridge read — which is how every
 * packed build's window came up blank while `verify-packed-requires.mjs`
 * (which only checks that required files EXIST) kept passing.
 *
 * Two outcomes, matching the two situations honestly:
 *  - preload references NONE of the runtime chunk's helpers → the require is
 *    vestigial, and it is stripped (replaced by a same-line comment so the
 *    sourcemap's line numbering stays true).
 *  - preload references ANY of them → a shared chunk has genuinely split out
 *    of preload.cjs, stripping would break it at a distance, and the build
 *    FAILS with the CAUTION's own instruction: make the entries disjoint again.
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const DESKTOP_DIR = resolve(import.meta.dirname, "..");

// `--dir <path>` mirrors verify-packed-requires.mjs: point the check at a
// scratch directory to test it without corrupting a real build.
function parseDirFlag(argv) {
  const flagIndex = argv.indexOf("--dir");
  if (flagIndex === -1) return resolve(DESKTOP_DIR, "dist-electron");
  const value = argv[flagIndex + 1];
  if (!value) throw new Error("--dir requires a path argument");
  return resolve(process.cwd(), value);
}

/** Top-level identifiers the runtime chunk defines (`var __x = …`, `function __x`). */
function runtimeChunkDefinitions(source) {
  const names = new Set();
  for (const match of source.matchAll(/^(?:var|let|const|function)\s+([A-Za-z_$][\w$]*)/gm)) {
    names.add(match[1]);
  }
  return names;
}

export function verifyPreloadStandalone(targetDir) {
  const preloadPath = join(targetDir, "preload.cjs");
  const preload = readFileSync(preloadPath, "utf8");

  const runtimeRequire = /^require\("\.\/(rolldown-runtime-[\w-]+\.cjs)"\);\s*$/m;
  const match = preload.match(runtimeRequire);
  if (!match) {
    console.log("verify-preload-standalone: OK — preload.cjs requires no runtime chunk.");
    return;
  }

  const runtimeSource = readFileSync(join(targetDir, match[1]), "utf8");
  const withoutRequire = preload.replace(runtimeRequire, "");
  const used = [...runtimeChunkDefinitions(runtimeSource)].filter((name) =>
    // Identifier-boundary search over the require-free body: a helper NAMED is
    // a helper needed, wherever it appears.
    new RegExp(`(?<![\\w$])${name}(?![\\w$])`).test(withoutRequire),
  );
  if (used.length > 0) {
    throw new Error(
      `verify-preload-standalone: preload.cjs actually USES runtime-chunk helper(s) ` +
        `${used.join(", ")} from ${match[1]}. A shared chunk has split out of the sandboxed ` +
        `preload, which cannot require sibling files — make the main and preload entries ` +
        `dependency-disjoint again (see the pack CAUTION in vite.config.ts) instead of stripping.`,
    );
  }

  // Same line count, so preload.cjs.map keeps meaning what it says.
  writeFileSync(
    preloadPath,
    preload.replace(
      runtimeRequire,
      "/* verify-preload-standalone: vestigial runtime require stripped */",
    ),
  );
  console.log(
    `verify-preload-standalone: stripped vestigial require of ${match[1]} from preload.cjs ` +
      `(no helper from it is referenced).`,
  );
}

// Runnable directly (the build pipeline) and importable (dev-electron.mjs).
if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const targetDir = parseDirFlag(process.argv.slice(2));
  try {
    verifyPreloadStandalone(targetDir);
    if (readdirSync(targetDir).length === 0) throw new Error("empty dist-electron");
  } catch (error) {
    console.error(String(error?.message ?? error));
    process.exit(1);
  }
}

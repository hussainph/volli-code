#!/usr/bin/env node
/**
 * VC-632 PR A: host-core files import each other by relative path.
 *
 *   node scripts/codemods/host-core-relative-imports.mjs           # rewrite in place
 *   node scripts/codemods/host-core-relative-imports.mjs --check   # list, change nothing
 *
 * Every `@volli/host-core[/<subpath>]` specifier inside `packages/host-core/src`
 * (static and dynamic imports, re-exports, `vi.mock`/`importActual`, `require`,
 * in any quoting; found by `scripts/module-edges.mjs`, the scanner the guard
 * uses) is resolved through the package's own `exports` map, exactly as Node resolves
 * a self-reference, and replaced by the relative path to the same file. Only the
 * specifier changes, so the module graph is identical. Idempotent: a re-run
 * after a main sync rewrites only what main added.
 *
 * `.pinned` copies (frozen N-1 sources, checked by git blob id) are not `.ts`
 * files and are left byte-identical.
 */
import { spawnSync } from "node:child_process";
import { globSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { moduleEdges, namesPackage } from "../module-edges.mjs";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const PKG = resolve(REPO, "packages/host-core");
const NAME = "@volli/host-core";
const exportsMap = JSON.parse(readFileSync(resolve(PKG, "package.json"), "utf8")).exports;
const check = process.argv.includes("--check");

const exportTarget = (entry) =>
  typeof entry === "string" ? entry : (entry.import ?? entry.default);

/** `@volli/host-core/<sub>` → absolute file, as Node's exports resolution answers it. */
function resolveSelf(specifier) {
  const key = specifier === NAME ? "." : `.${specifier.slice(NAME.length)}`;
  if (exportsMap[key]) return resolve(PKG, exportTarget(exportsMap[key]));
  for (const [pattern, entry] of Object.entries(exportsMap)) {
    const star = pattern.indexOf("*");
    if (star < 0) continue;
    const prefix = pattern.slice(0, star);
    const suffix = pattern.slice(star + 1);
    if (key.startsWith(prefix) && key.endsWith(suffix) && key.length >= pattern.length - 1) {
      const middle = key.slice(prefix.length, key.length - suffix.length);
      return resolve(PKG, exportTarget(entry).replaceAll("*", middle));
    }
  }
  throw new Error(`${specifier} is not exported by ${NAME}`);
}

/** The extensionless relative specifier this directory already uses for `target`. */
function relativeSpecifier(fromFile, target) {
  let rel = relative(dirname(fromFile), target).split("\\").join("/");
  rel = rel.replace(/\.ts$/, "");
  if (!rel.startsWith("../")) rel = `./${rel}`;
  const stripped = rel.replace(/\/index$/, "");
  // `./db/index` → `./db`, but `./index` and `../index` stay spelled out.
  if (stripped !== rel && !/(^|\/)\.\.?$/.test(stripped)) rel = stripped;
  return rel;
}

const touched = [];
let edits = 0;
for (const file of globSync("src/**/*.{ts,tsx,mts}", { cwd: PKG })) {
  const path = resolve(PKG, file);
  const before = readFileSync(path, "utf8");
  // The guard's own scanner finds the edges, so the codemod rewrites exactly
  // what `package-interface.test.ts` flags. Rewritten from the end, so earlier
  // offsets stay valid.
  let after = before;
  for (const edge of moduleEdges(before).toReversed()) {
    if (!namesPackage(edge, NAME)) continue;
    if (edge.interpolated)
      throw new Error(`${file}: cannot resolve the interpolated import \`${edge.specifier}\``);
    edits += 1;
    const replacement = relativeSpecifier(path, resolveSelf(edge.specifier));
    after = `${after.slice(0, edge.start)}${edge.quote}${replacement}${edge.quote}${after.slice(edge.end)}`;
  }
  if (after === before) continue;
  touched.push(path);
  if (check) console.log(file);
  else writeFileSync(path, after);
}
console.log(
  `${check ? "would rewrite" : "rewrote"} ${edits} specifiers in ${touched.length} files`,
);
// A shorter specifier can let a wrapped import fit on one line: format only what changed.
if (!check && touched.length > 0)
  spawnSync("vp", ["fmt", ...touched], { stdio: "inherit", cwd: REPO });
if (check && edits > 0) process.exitCode = 1;

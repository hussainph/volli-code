/**
 * Verifies that every require() a packed Electron main/preload chunk can
 * reach at runtime is either a sibling chunk that actually exists, a Node
 * builtin, `electron`, or a package electron-builder.yml has chosen to keep
 * in the shipped node_modules tree.
 *
 * This exists because tsdown bundles workspace packages (and jsdom, which is
 * unbundleable — see the `neverBundle` comment in vite.config.ts) but leaves
 * their OWN internal require()s untouched. Those specifiers were written
 * assuming the package's normal on-disk layout; once the code that contains
 * them is inlined into dist-electron/*.cjs, a relative one resolves against
 * dist-electron/ instead. That is exactly how css-tree's
 * `require('../data/patch.json')` shipped: it resolved fine in dev (the file
 * still lived next to css-tree's own module) and crashed the packaged app at
 * boot, because nothing else in the build graph — not tsc, not the renderer
 * build, not a desktop smoke (manual-only, see CLAUDE.md) — ever loads
 * dist-electron/main.cjs in a tree pruned down to electron-builder.yml's
 * whitelist. This script is the thing that does.
 *
 * Two checks, matching the two ways a require() can go missing in the packed
 * app: (1) every relative specifier must resolve to a real file inside
 * dist-electron, the same directory Node will actually look in; (2) every
 * bare specifier's package must be in electron-builder.yml's node_modules
 * whitelist, walked transitively through each kept package's own production
 * `dependencies` — the automated version of the "KEEP IN SYNC" comment above
 * that whitelist, so a whitelisted package quietly gaining a new dependency
 * doesn't produce the same class of crash one layer down.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { builtinModules } from "node:module";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { parse as parseYaml } from "yaml";

const require = createRequire(import.meta.url);
const DESKTOP_DIR = resolve(import.meta.dirname, "..");

// `--dir <path>` overrides the directory scanned, defaulting to the real
// build output. Exists so this script can be pointed at a scratch directory
// containing a deliberately broken chunk — the only way to test "does this
// catch the bug" without corrupting a real build.
function parseDirFlag(argv) {
  const flagIndex = argv.indexOf("--dir");
  if (flagIndex === -1) return resolve(DESKTOP_DIR, "dist-electron");
  const value = argv[flagIndex + 1];
  if (!value) throw new Error("--dir requires a path argument");
  return resolve(process.cwd(), value);
}
const TARGET_DIR = parseDirFlag(process.argv.slice(2));

// Bare package names that legitimately appear in a require() call inside a
// bundled chunk but must NOT be checked against the electron-builder
// whitelist. Keep this list small and evidenced — every entry below was
// confirmed by reading the require site before being added, not guessed.
const IGNORED_PACKAGES = new Set([
  // `ws` (bundled transitively into google-shared-*.cjs via the Google AI
  // provider) requests its optional native accelerators inside
  // `if (!process.env.WS_NO_BUFFER_UTIL) try { require("bufferutil") } catch`
  // and the equivalent WS_NO_UTF_8_VALIDATE guard for "utf-8-validate".
  // Neither package is installed anywhere in this repo's node_modules — the
  // require always throws, is caught, and ws falls back to its pure-JS
  // mask/UTF-8 routines. This is the standard optional-native-binding
  // pattern, not an unconditional require that can crash boot the way the
  // css-tree/patch.json bug did, so it does not belong in the packaging
  // whitelist.
  "bufferutil",
  "utf-8-validate",
  // better-sqlite3 declares this as a regular (non-dev) dependency because
  // npm's install lifecycle needs it regardless of NODE_ENV — its package.json
  // "install" script is `prebuild-install || node-gyp rebuild --release`,
  // fetching or building the native binary. Nothing under better-sqlite3's
  // `lib/` (its actual runtime code) ever require()s it; the packaged app
  // uses the binary rebuild:native already produced (npmRebuild: false, see
  // electron-builder.yml), never prebuild-install's fetch/build path.
  "prebuild-install",
  // node-pty declares this as a regular dependency, but it is C++ headers for
  // node-gyp: nothing under node-pty's lib/ (its runtime code) ever
  // require()s it — it exists so `node-gyp rebuild` can compile the addon.
  // The packaged app ships the binary rebuild:native already produced.
  "node-addon-api",
]);

if (!existsSync(TARGET_DIR) || !statSync(TARGET_DIR).isDirectory()) {
  throw new Error(
    `verify-packed-requires: ${TARGET_DIR} does not exist — run \`vp pack\` (or the full build) before this script.`,
  );
}
const chunkFiles = readdirSync(TARGET_DIR).filter((name) => name.endsWith(".cjs"));
if (chunkFiles.length === 0) {
  throw new Error(
    `verify-packed-requires: ${TARGET_DIR} has no .cjs files — run \`vp pack\` (or the full build) before this script.`,
  );
}

// electron-builder.yml's node_modules whitelist is the single source of truth
// for what ships. Parsed rather than hand-mirrored so this script fails when
// the whitelist and the packed requires drift, instead of silently agreeing
// with a stale copy of the list.
const buildYamlPath = resolve(DESKTOP_DIR, "electron-builder.yml");
const buildConfig = parseYaml(readFileSync(buildYamlPath, "utf8"));
const filesEntries = Array.isArray(buildConfig.files) ? buildConfig.files : [];
const keepSetEntry = filesEntries.find(
  (entry) => typeof entry === "string" && /^!node_modules\/!\(.*\)\/\*\*$/.test(entry),
);
if (!keepSetEntry) {
  throw new Error(
    `verify-packed-requires: could not find the "!node_modules/!(...)/**" whitelist entry in ${buildYamlPath}'s files: list.`,
  );
}
const keepSet = new Set(keepSetEntry.match(/^!node_modules\/!\((.*)\)\/\*\*$/)[1].split("|"));

// Strips // and /* */ comments while leaving string/template contents intact,
// so a JSDoc example like `* const keys = require('/path/to/key.json');`
// (real text sitting in google-shared-*.cjs, copied in from google-auth-
// library's own doc comments) never gets extracted as a real specifier.
const STRING_OR_COMMENT =
  /"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`|\/\/[^\n]*|\/\*[\s\S]*?\*\//g;
function stripComments(source) {
  return source.replace(STRING_OR_COMMENT, (match) =>
    match.startsWith("//") || match.startsWith("/*") ? "" : match,
  );
}

// Dynamic import() literals are load-bearing too: the chunks keep them as
// real native imports (node-pty arrives via a lazy `import("node-pty")`), so
// a package reached ONLY that way must still be in the shipped tree — and
// must seed the transitive walk below like any require()d package. BARE
// specifiers only: a relative dynamic import of an internal module comes out
// of the CJS build as a require() (already scanned), while JSDoc type
// annotations like `{import('./request').default}` — real text in bundled
// node-fetch comments that the stripper cannot always win against — are
// exactly relative-shaped. Bare-only keeps the signal without the lexer.
const REQUIRE_CALL = /\brequire\(\s*(['"])((?:\\.|(?!\1).)*)\1\s*\)/g;
const IMPORT_CALL = /\bimport\(\s*(['"])((?:\\.|(?!\1).)*)\1\s*\)/g;
function extractRequireSpecifiers(source) {
  const specifiers = [];
  const stripped = stripComments(source);
  for (const match of stripped.matchAll(REQUIRE_CALL)) {
    specifiers.push(match[2]);
  }
  for (const match of stripped.matchAll(IMPORT_CALL)) {
    if (!match[2].startsWith(".")) specifiers.push(match[2]);
  }
  return specifiers;
}

function packageNameFromSpecifier(specifier) {
  const segments = specifier.split("/");
  return specifier.startsWith("@") ? segments.slice(0, 2).join("/") : segments[0];
}

function isBuiltinOrElectron(specifier) {
  return (
    specifier.startsWith("node:") || specifier === "electron" || builtinModules.includes(specifier)
  );
}

function isInKeepSet(packageName) {
  if (keepSet.has(packageName)) return true;
  const scope = packageName.split("/")[0];
  return packageName.startsWith("@") && keepSet.has(scope);
}

// Same candidate order Node's own CJS resolver tries for a relative
// specifier: the literal path, then common CJS extensions, then a directory
// index. `dist-electron` never uses `.mjs`/`.node`, so those aren't candidates.
function resolveRelative(specifier, chunkDir) {
  const target = resolve(chunkDir, specifier);
  const rel = relative(TARGET_DIR, target);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    return { ok: false, reason: "resolves outside dist-electron" };
  }
  const candidates = [
    target,
    `${target}.js`,
    `${target}.cjs`,
    `${target}.json`,
    join(target, "index.js"),
    join(target, "index.cjs"),
    join(target, "index.json"),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate) && statSync(candidate).isFile()) {
      return { ok: true };
    }
  }
  return { ok: false, reason: "does not resolve to any file inside dist-electron" };
}

// Locates a package's directory to read its own package.json even when the
// package doesn't export "./package.json" (ERR_PACKAGE_PATH_NOT_EXPORTED) —
// walk up from its resolved entry file to the nearest package.json instead.
// Resolution starts FROM THE DEPENDENT PACKAGE'S OWN DIRECTORY (`fromDir`),
// exactly like Node would at runtime: under pnpm's isolated node_modules a
// transitive package (jsdom → @asamuzakjp/dom-selector → bidi-js) has no path
// reachable from apps/desktop at all, only from its parent. The first version
// of this script resolved everything from apps/desktop, so the walk stopped
// one level deep — and bidi-js, missing from the whitelist, sailed through
// while the packaged canary.7 died on it at boot. Returns null (skip, not a
// violation) only for names Node itself couldn't resolve from the dependent —
// "electron" being the standing example (a devDependency, provided by the
// runtime).
function resolvePackageDir(packageName, fromDir) {
  const paths = [fromDir, DESKTOP_DIR];
  try {
    return dirname(require.resolve(`${packageName}/package.json`, { paths }));
  } catch (err) {
    if (err?.code !== "ERR_PACKAGE_PATH_NOT_EXPORTED") return null;
  }
  try {
    let dir = dirname(require.resolve(packageName, { paths }));
    while (true) {
      if (existsSync(join(dir, "package.json"))) return dir;
      const parent = dirname(dir);
      if (parent === dir) return null;
      dir = parent;
    }
  } catch {
    return null;
  }
}

function productionDependencyNames(packageDir) {
  const pkgJson = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8"));
  return pkgJson.dependencies ? Object.keys(pkgJson.dependencies) : [];
}

const violations = [];
let relativeVerifiedCount = 0;
/** Bare package names confirmed present in the whitelist — seeds + transitive reach, deduped for the summary. */
const externalPackages = new Set();
const directSeeds = new Set();

for (const chunkFile of chunkFiles) {
  const chunkPath = join(TARGET_DIR, chunkFile);
  const chunkDir = dirname(chunkPath);
  const source = readFileSync(chunkPath, "utf8");

  for (const specifier of extractRequireSpecifiers(source)) {
    if (specifier.startsWith("./") || specifier.startsWith("../")) {
      const result = resolveRelative(specifier, chunkDir);
      if (result.ok) {
        relativeVerifiedCount += 1;
      } else {
        violations.push(`${chunkFile} → ${specifier} → ${result.reason}`);
      }
      continue;
    }

    if (isBuiltinOrElectron(specifier)) continue;

    const packageName = packageNameFromSpecifier(specifier);
    if (IGNORED_PACKAGES.has(packageName)) continue;

    if (isInKeepSet(packageName)) {
      externalPackages.add(packageName);
      directSeeds.add(packageName);
    } else {
      violations.push(
        `${chunkFile} → ${specifier} → package "${packageName}" not in electron-builder.yml whitelist`,
      );
    }
  }
}

// Transitive completeness: walk every kept, directly-required package's own
// production dependencies, asserting every reached package is kept too. This
// is what would have caught css-tree's patch.json require one layer up — if
// css-tree had stayed an external require of jsdom instead of getting bundled,
// this walk is what proves jsdom's dependency tree is fully whitelisted.
const visited = new Set(directSeeds);
const queue = [...directSeeds].map((name) => ({ name, fromDir: DESKTOP_DIR }));
while (queue.length > 0) {
  const { name: packageName, fromDir } = queue.shift();
  const packageDir = resolvePackageDir(packageName, fromDir);
  if (!packageDir) continue;

  for (const depName of productionDependencyNames(packageDir)) {
    if (IGNORED_PACKAGES.has(depName) || visited.has(depName)) continue;
    if (!isInKeepSet(depName)) {
      violations.push(
        `${packageName} → ${depName} → transitive dependency not in electron-builder.yml whitelist`,
      );
      continue;
    }
    visited.add(depName);
    externalPackages.add(depName);
    // The dep resolves from ITS parent's directory, not from apps/desktop —
    // that chaining is what lets the walk cross pnpm's isolation boundary.
    queue.push({ name: depName, fromDir: packageDir });
  }
}

if (violations.length > 0) {
  console.error("verify-packed-requires: found require()s the packaged app cannot satisfy:\n");
  for (const violation of violations) console.error(`  ${violation}`);
  console.error(`\n${violations.length} violation(s).`);
  process.exit(1);
}

console.log(
  `verify-packed-requires: OK — ${chunkFiles.length} chunk(s) scanned, ${relativeVerifiedCount} relative require(s) verified, ${externalPackages.size} external package(s) verified.`,
);

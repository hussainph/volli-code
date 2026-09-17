#!/usr/bin/env node
/**
 * Holds the workspace's dependency licenses to a reviewed record.
 *
 *     node apps/desktop/scripts/check-dependency-licenses.mjs             # the gate
 *     node apps/desktop/scripts/check-dependency-licenses.mjs --self-test # the matchers' own tests
 *     node apps/desktop/scripts/check-dependency-licenses.mjs --report    # what is installed, by license
 *
 * WHY THIS EXISTS (VC-409). An audit found three dependencies whose licenses
 * are not the permissive default everything else in this tree carries: an LGPL
 * libvips inside the packaged desktop app, a bespoke non-commercial license on
 * a test-only contrast oracle (whose own dependency is AGPL v3), and GSAP's
 * custom terms on the website. Each was fine for a reason — and every one of
 * those reasons was a fact about the tree that nothing was holding still.
 *
 * So this gate does not grade licenses. It asserts that the tree still matches
 * `dependency-license-policy.json`, the record of what someone actually read:
 *
 *   1. Every installed package whose license is not plainly permissive has a
 *      reviewed entry. A new restricted dependency fails here, by name.
 *   2. Every reviewed entry still describes reality — the package is installed,
 *      at a recorded version, under the recorded license. A silent relicense or
 *      an unreviewed bump fails rather than riding in on a lockfile update.
 *   3. The containment each review RELIED ON still holds: which workspace
 *      packages may depend on it and in which field, which source files may
 *      import it, and — for the LGPL library — that it is still dynamically
 *      linked and still shipped unpacked, so it remains replaceable.
 *
 * It lives beside check-node-version.mjs and check-design-tokens.mjs, which are
 * also plain-Node gates that reach past apps/desktop into the whole repository,
 * and it follows their `--self-test` convention so the matchers themselves are
 * covered in CI rather than trusted.
 *
 * WHAT IT DOES NOT DO. It is not a legal opinion and it does not write notices.
 * Attribution text belongs to the centralized notice files, and the questions
 * that need a human answer are named in
 * docs/licensing/dependency-license-review.md — not resolved here.
 */

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const DESKTOP_ROOT = resolve(HERE, "..");
const REPO_ROOT = resolve(DESKTOP_ROOT, "../..");
const POLICY_PATH = resolve(HERE, "dependency-license-policy.json");

/** Manifest fields that make a dependency part of what we ship or run. */
const RUNTIME_FIELDS = ["dependencies", "optionalDependencies", "peerDependencies"];
/** Every manifest field a dependency can be declared in. */
const ALL_FIELDS = [...RUNTIME_FIELDS, "devDependencies"];
/** Source extensions the import scan reads. */
const SOURCE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".mjs", ".cjs", ".astro"];
/** Directories the import scan never descends into. */
const SKIPPED_DIRECTORIES = new Set(["node_modules", "dist", "dist-electron", ".git", "release"]);
/**
 * The one file the import scan must not read: this one. Its `--self-test`
 * fixtures are import statements for the very packages it confines, because
 * that is what the matcher under test takes as input. Scanning them reports
 * this gate as the violator of its own rules — which it was, on first run.
 */
const IMPORT_SCAN_EXEMPT = new Set(["apps/desktop/scripts/check-dependency-licenses.mjs"]);

// ---------------------------------------------------------------------------
// Pure matchers
// ---------------------------------------------------------------------------

/**
 * Splits an SPDX-ish expression into its disjuncts. `(MPL-2.0 OR Apache-2.0)`
 * becomes `["MPL-2.0", "Apache-2.0"]`; anything without a top-level `OR`
 * returns as a single element. `AND` is deliberately NOT split: a conjunction
 * binds us to every part, so it can never be satisfied by one permissive half
 * and must fall through to a reviewed entry.
 * @param {string} expression
 * @returns {string[]}
 */
export function splitLicenseChoices(expression) {
  const trimmed = expression
    .trim()
    .replace(/^\((.*)\)$/s, "$1")
    .trim();
  if (/\bAND\b/i.test(trimmed)) return [trimmed];
  return trimmed
    .split(/\bOR\b/i)
    .map((part) =>
      part
        .trim()
        .replace(/^\((.*)\)$/s, "$1")
        .trim(),
    )
    .filter((part) => part.length > 0);
}

/**
 * Whether a license expression leaves Volli free — i.e. at least one option we
 * may elect is on the permissive list. Returns the elected id so the caller can
 * report WHICH half a dual license was satisfied by.
 * @param {string | null} expression
 * @param {readonly string[]} permissiveIds
 * @returns {{ permissive: boolean, elected: string | null }}
 */
export function electPermissiveLicense(expression, permissiveIds) {
  if (expression === null) return { permissive: false, elected: null };
  const allowed = new Set(permissiveIds.map((id) => id.toLowerCase()));
  for (const choice of splitLicenseChoices(expression)) {
    // `MIT+`/`Apache-2.0-only` style suffixes are not in play in this tree; an
    // exact match keeps a near-miss ("LGPL-3.0-or-later") from ever passing.
    if (allowed.has(choice.toLowerCase())) return { permissive: true, elected: choice };
  }
  return { permissive: false, elected: null };
}

/**
 * The license a manifest declares, as a plain string. Handles the legacy
 * `{ type }` object and the older `licenses: [...]` array so an old package
 * does not read as unlicensed. Returns `null` when the manifest says nothing —
 * which this gate treats as "a human must record what they read", not as a
 * cue to go guessing from license files.
 * @param {Record<string, unknown>} manifest
 * @returns {string | null}
 */
export function declaredLicense(manifest) {
  const { license, licenses } = manifest;
  if (typeof license === "string" && license.trim().length > 0) return license.trim();
  if (license !== null && typeof license === "object" && typeof license.type === "string") {
    return license.type.trim();
  }
  if (Array.isArray(licenses)) {
    const types = licenses
      .map((entry) => (typeof entry === "string" ? entry : entry?.type))
      .filter((type) => typeof type === "string" && type.length > 0);
    if (types.length > 0) return types.join(" OR ");
  }
  return null;
}

/**
 * Reads a pnpm store directory name into the package it holds.
 * `@img+sharp-libvips-darwin-arm64@1.3.3` -> `@img/sharp-libvips-darwin-arm64` at `1.3.3`;
 * `astro@7.2.8_jiti@2.7.0` -> `astro` at `7.2.8` (the peer suffix is dropped).
 * Returns `null` for a directory that is not a store entry, such as the
 * hoisted `node_modules` pnpm keeps beside them.
 * @param {string} directoryName
 * @returns {{ name: string, version: string } | null}
 */
export function parseStoreDirectoryName(directoryName) {
  const scoped = directoryName.startsWith("@");
  const body = scoped ? directoryName.slice(1) : directoryName;
  const at = body.indexOf("@");
  if (at <= 0) return null;
  const name = (scoped ? "@" : "") + body.slice(0, at).replace("+", "/");
  // Everything from the first `_` on is pnpm's peer/patch suffix, not a version.
  const version = body.slice(at + 1).split("_")[0];
  if (version.length === 0) return null;
  return { name, version };
}

/**
 * Tiny glob matcher for the containment patterns in the policy: `*` matches
 * within one path segment, `**` crosses separators. Deliberately not a glob
 * library — the patterns are a handful of repo-relative paths, and a dependency
 * whose only job is matching four strings is a dependency to explain.
 * @param {string} path repo-relative, `/`-separated
 * @param {string} pattern
 */
export function matchesPathPattern(path, pattern) {
  const expression = pattern
    .split(/(\*\*\/|\*\*|\*)/)
    .map((piece) => {
      if (piece === "**/") return "(?:.*/)?";
      if (piece === "**") return ".*";
      if (piece === "*") return "[^/]*";
      return piece.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
    })
    .join("");
  return new RegExp(`^${expression}$`).test(path);
}

/**
 * Whether `source` actually imports `packageName`, as opposed to merely
 * mentioning it. The distinction matters: `packages/shared/src/theme/color.ts`
 * discusses apca-w3 in its header comment and `apca-w3.d.ts` declares ambient
 * types for it, and neither is a use of the package.
 * @param {string} source
 * @param {string} packageName
 */
export function importsPackage(source, packageName) {
  const name = packageName.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
  // A `declare module "x"` is a type declaration, never an import, so it is
  // stripped before the scan rather than matched and excused afterwards.
  const scannable = source.replaceAll(/declare\s+module\s+["'][^"']+["']/g, "");
  const specifier = String.raw`["']${name}(?:/[^"']*)?["']`;
  return new RegExp(
    String.raw`(?:from\s*${specifier})` +
      String.raw`|(?:\bimport\s*\(\s*${specifier})` +
      String.raw`|(?:\brequire\s*\(\s*${specifier})` +
      String.raw`|(?:\bimport\s+${specifier})`,
  ).test(scannable);
}

/** Whether a dependency range is a caret range, which is what "keep current" needs. */
export function isCaretRange(range) {
  return /^\^\d+\.\d+\.\d+/.test(range.trim());
}

/**
 * Whether a package name is covered by a policy key. A key may end in `*` to
 * cover a family of per-platform packages.
 *
 * This exists because the installed tree is not the same on every machine. An
 * npm package with native code publishes one sibling per platform and pnpm
 * installs only the matching one, so `@img/sharp-libvips-darwin-arm64` here is
 * `@img/sharp-libvips-linux-x64` on CI. Keying the LGPL review to the darwin
 * name would have made the gate pass on macOS and fail on Linux for a reason
 * that has nothing to do with licensing. Three families in this tree need it:
 * the libvips binaries (LGPL), the lightningcss binaries (MPL), and the yuku
 * bindings (no license field). Every other platform family is MIT or Apache.
 * @param {string} name
 * @param {string} pattern
 */
export function matchesPackagePattern(name, pattern) {
  if (!pattern.includes("*")) return name === pattern;
  const expression = pattern
    .split("*")
    .map((piece) => piece.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`))
    .join(".*");
  return new RegExp(`^${expression}$`).test(name);
}

// ---------------------------------------------------------------------------
// The audit, as a pure function over gathered facts
// ---------------------------------------------------------------------------

/**
 * @typedef {object} WorkspaceFacts
 * @property {Array<{ name: string, version: string, license: string | null }>} installed
 * @property {Array<{ name: string, path: string, deps: Record<string, Record<string, string>> }>} manifests
 * @property {Array<{ path: string, source: string }>} sources
 * @property {{ asarUnpack: string[], files: string[] } | null} packaging
 * @property {Array<{ package: string, resolved: boolean, loadPaths: string[] }>} nativeLibraries
 */

/**
 * @param {WorkspaceFacts} facts
 * @param {{ permissive: { ids: string[] }, reviewed: Record<string, any> }} policy
 * @returns {{ problems: string[], notes: string[] }}
 */
export function auditDependencyLicenses(facts, policy) {
  const problems = [];
  const notes = [];
  const permissiveIds = policy.permissive.ids;
  const reviewed = policy.reviewed;

  // --- 1. Nothing restricted arrives unreviewed -----------------------------
  const installedByName = new Map();
  for (const pkg of facts.installed) {
    const versions = installedByName.get(pkg.name) ?? new Map();
    versions.set(pkg.version, pkg.license);
    installedByName.set(pkg.name, versions);
  }

  /** The reviewed key covering `name`, or undefined. */
  const reviewFor = (name) =>
    Object.keys(reviewed).find((pattern) => matchesPackagePattern(name, pattern));

  for (const pkg of facts.installed) {
    if (reviewFor(pkg.name) !== undefined) continue;
    const { permissive } = electPermissiveLicense(pkg.license, permissiveIds);
    if (permissive) continue;
    problems.push(
      `${pkg.name}@${pkg.version} is licensed "${pkg.license ?? "(none declared)"}", which is not on ` +
        `the permissive list and has no entry in dependency-license-policy.json. Read the license, ` +
        `then record what it says — do not add an entry to make this pass.`,
    );
  }

  // --- 2. Every reviewed entry still describes reality -----------------------
  for (const [name, entry] of Object.entries(reviewed)) {
    const matched = [...installedByName].filter(([installed]) =>
      matchesPackagePattern(installed, name),
    );
    if (matched.length === 0) {
      problems.push(
        `dependency-license-policy.json reviews ${name}, but nothing matching it is installed. Drop ` +
          `the entry if the dependency is gone, so the record keeps only claims it can still be ` +
          `read against.`,
      );
      continue;
    }
    // Across a per-platform family every sibling ships the same version set, so
    // the union is what the recorded versions are checked against.
    const versions = new Map();
    for (const [, siblingVersions] of matched) {
      for (const [version, license] of siblingVersions) versions.set(version, license);
    }

    for (const [version, license] of versions) {
      if (!entry.versions.includes(version)) {
        problems.push(
          `${name}@${version} is installed but the review covers ${entry.versions.join(", ")}. ` +
            `Re-read the license for the new version before recording it${
              entry.blocked ? ` (see ${entry.blocked})` : ""
            }.`,
        );
      }
      if (license !== null && license !== entry.license) {
        problems.push(
          `${name}@${version} now declares "${license}"; the review recorded "${entry.license}". ` +
            `A dependency that relicenses under us is exactly what this check exists to catch.`,
        );
      }
      if (license === null && entry.licenseSource === undefined) {
        problems.push(
          `${name}@${version} declares no license in its manifest and its entry gives no ` +
            `licenseSource. Record where the license was actually read from.`,
        );
      }
    }

    for (const version of entry.versions) {
      if (!versions.has(version)) {
        problems.push(
          `dependency-license-policy.json reviews ${name}@${version}, which is no longer installed. ` +
            `Drop the version from the entry.`,
        );
      }
    }
  }

  // --- 3. The containment each review relied on still holds ------------------
  for (const [name, entry] of Object.entries(reviewed)) {
    if (entry.direct !== undefined) {
      const actual = {};
      for (const manifest of facts.manifests) {
        for (const field of ALL_FIELDS) {
          const declared = Object.keys(manifest.deps[field] ?? {}).some((dependency) =>
            matchesPackagePattern(dependency, name),
          );
          if (declared) actual[manifest.name] = field;
        }
      }
      for (const [workspace, field] of Object.entries(entry.direct)) {
        if (actual[workspace] === undefined) {
          problems.push(
            `${name} is reviewed as a ${field} of ${workspace}, but ${workspace} no longer declares it.`,
          );
        } else if (actual[workspace] !== field) {
          problems.push(
            `${name} is declared in ${workspace}'s ${actual[workspace]}, but the review depends on it ` +
              `being a ${field}. ${
                field === "devDependencies"
                  ? "Moving it out of devDependencies puts it in a distributed artifact, which is what " +
                    "the review said would not happen."
                  : "Re-read the review before moving it."
              }`,
          );
        }
      }
      for (const [workspace, field] of Object.entries(actual)) {
        if (entry.direct[workspace] === undefined) {
          problems.push(
            `${workspace} declares ${name} in ${field}, which no review covers. ` +
              `${name} is licensed "${entry.license}" — record the new use or remove it.`,
          );
        }
      }
    }

    if (entry.rangeMustBeCaret === true) {
      for (const manifest of facts.manifests) {
        for (const field of ALL_FIELDS) {
          for (const [dependency, range] of Object.entries(manifest.deps[field] ?? {})) {
            if (!matchesPackagePattern(dependency, name)) continue;
            if (!isCaretRange(range)) {
              problems.push(
                `${manifest.name} pins ${dependency} at "${range}". Its license obliges a licensee ` +
                  `to track the latest non-breaking release, so the range must stay a caret range.`,
              );
            }
          }
        }
      }
    }

    if (entry.imports !== undefined) {
      // Import sites are matched against the concrete installed names, since a
      // source file imports a real specifier and never a family pattern.
      const specifiers = [...installedByName.keys()].filter((installed) =>
        matchesPackagePattern(installed, name),
      );
      for (const { path, source } of facts.sources) {
        if (!specifiers.some((specifier) => importsPackage(source, specifier))) continue;
        const allowed = entry.imports.some((pattern) => matchesPathPattern(path, pattern));
        if (!allowed) {
          problems.push(
            `${path} imports ${name}, which the review confines to ` +
              `${entry.imports.length === 0 ? "no source file at all" : entry.imports.join(", ")}. ` +
              `${name} is licensed "${entry.license}"${
                entry.blocked ? ` — see ${entry.blocked}` : ""
              }.`,
          );
        }
      }
    }
  }

  // --- 4. The LGPL library stays replaceable --------------------------------
  for (const [name, entry] of Object.entries(reviewed)) {
    const rule = entry.nativeLibrary;
    if (rule === undefined) continue;

    if (facts.packaging === null) {
      notes.push(`${name}: packaging config unreadable, so the asar/unpack checks did not run.`);
    } else {
      if (!facts.packaging.asarUnpack.includes(rule.electronBuilderAsarUnpackPattern)) {
        problems.push(
          `electron-builder.yml no longer unpacks ${rule.electronBuilderAsarUnpackPattern} from the ` +
            `asar. ${name} is LGPL: sealing it inside the archive removes the user's ability to ` +
            `substitute their own build of the library, which is what LGPLv3 section 4(d) preserves.`,
        );
      }
      if (!facts.packaging.files.some((line) => line.includes(rule.electronBuilderFilesToken))) {
        problems.push(
          `electron-builder.yml's files list no longer keeps "${rule.electronBuilderFilesToken}". ` +
            `Without it the packaged app ships no libvips at all.`,
        );
      }
    }

    const native = facts.nativeLibraries.find((candidate) => candidate.package === name);
    if (native === undefined || !native.resolved) {
      notes.push(
        `${name}: the ${rule.consumerPackage} addon is not installed on this platform, so the ` +
          `dynamic-linking check did not run. It runs on macOS arm64, where the app is built.`,
      );
    } else if (!native.loadPaths.some((path) => path.includes(rule.dynamicLoadPathContains))) {
      problems.push(
        `${rule.consumerPackage}'s native addon no longer loads "${rule.dynamicLoadPathContains}" as ` +
          `a shared library. A statically linked ${name} would put the combined work under LGPLv3 ` +
          `section 4(d)(0)'s relinkable-object obligation instead of 4(d)(1)'s shared-library one.`,
      );
    }
  }

  return { problems, notes };
}

// ---------------------------------------------------------------------------
// Gathering the facts from disk
// ---------------------------------------------------------------------------

/** Every package in the pnpm store, with the license its manifest declares. */
function readInstalledPackages() {
  const storeRoot = resolve(REPO_ROOT, "node_modules/.pnpm");
  const found = [];
  for (const directoryName of readdirSync(storeRoot)) {
    const parsed = parseStoreDirectoryName(directoryName);
    if (parsed === null) continue;
    const manifestPath = join(
      storeRoot,
      directoryName,
      "node_modules",
      parsed.name,
      "package.json",
    );
    if (!existsSync(manifestPath)) continue;
    let manifest;
    try {
      manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    } catch {
      continue;
    }
    found.push({ name: parsed.name, version: parsed.version, license: declaredLicense(manifest) });
  }
  return found;
}

/** Every workspace manifest, with its declared dependencies by field. */
function readWorkspaceManifests() {
  const manifests = [];
  const roots = [
    REPO_ROOT,
    ...["apps", "packages"].flatMap((group) => {
      const dir = resolve(REPO_ROOT, group);
      return existsSync(dir)
        ? readdirSync(dir)
            .map((entry) => resolve(dir, entry))
            .filter((entry) => statSync(entry).isDirectory())
        : [];
    }),
  ];
  for (const root of roots) {
    const manifestPath = resolve(root, "package.json");
    if (!existsSync(manifestPath)) continue;
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    const deps = {};
    for (const field of ALL_FIELDS) deps[field] = manifest[field] ?? {};
    manifests.push({ name: manifest.name, path: relative(REPO_ROOT, manifestPath), deps });
  }
  return manifests;
}

/** Every first-party source file, repo-relative. */
function readSources() {
  const sources = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      if (SKIPPED_DIRECTORIES.has(entry)) continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
      } else if (SOURCE_EXTENSIONS.some((extension) => entry.endsWith(extension))) {
        const path = relative(REPO_ROOT, full).replaceAll("\\", "/");
        if (IMPORT_SCAN_EXEMPT.has(path)) continue;
        sources.push({ path, source: readFileSync(full, "utf8") });
      }
    }
  };
  for (const group of ["apps", "packages"]) {
    const dir = resolve(REPO_ROOT, group);
    if (existsSync(dir)) walk(dir);
  }
  return sources;
}

/**
 * electron-builder's asar and files lists. Parsed with the `yaml` package the
 * desktop app already depends on rather than by regex — a packaging list read
 * loosely is how a check of this kind quietly stops matching.
 */
async function readPackagingConfig() {
  try {
    const { parse } = await import("yaml");
    const config = parse(readFileSync(resolve(DESKTOP_ROOT, "electron-builder.yml"), "utf8"));
    return {
      asarUnpack: Array.isArray(config.asarUnpack) ? config.asarUnpack : [],
      files: Array.isArray(config.files) ? config.files : [],
    };
  } catch {
    return null;
  }
}

/**
 * The dylibs a native addon loads, read straight out of the Mach-O file.
 *
 * Load-command paths are stored as plain NUL-terminated strings, so the check
 * is a substring scan rather than a Mach-O parse: it needs to answer "is
 * libvips reached as a separate shared library", and the presence of its
 * `@rpath/...` load path is exactly that evidence. A statically linked libvips
 * would leave no such string.
 */
function readNativeLibraryLoadPaths(policy) {
  const results = [];
  for (const [name, entry] of Object.entries(policy.reviewed)) {
    const rule = entry.nativeLibrary;
    if (rule === undefined) continue;
    const consumerRoot = resolve(DESKTOP_ROOT, "node_modules", rule.consumerPackage);
    const manifestPath = join(consumerRoot, "package.json");
    if (!existsSync(manifestPath)) {
      results.push({ package: name, resolved: false, loadPaths: [] });
      continue;
    }
    const consumerVersion = JSON.parse(readFileSync(manifestPath, "utf8")).version;
    const addonPath = join(
      consumerRoot,
      rule.addonPath.replace("{consumerVersion}", consumerVersion),
    );
    if (!existsSync(addonPath)) {
      results.push({ package: name, resolved: false, loadPaths: [] });
      continue;
    }
    const binary = readFileSync(addonPath).toString("latin1");
    const loadPaths = [...binary.matchAll(/@rpath\/[\w.+-]+\.dylib/g)].map((match) => match[0]);
    results.push({ package: name, resolved: true, loadPaths: [...new Set(loadPaths)] });
  }
  return results;
}

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

function readPolicy() {
  return JSON.parse(readFileSync(POLICY_PATH, "utf8"));
}

async function gate() {
  const policy = readPolicy();
  const facts = {
    installed: readInstalledPackages(),
    manifests: readWorkspaceManifests(),
    sources: readSources(),
    packaging: await readPackagingConfig(),
    nativeLibraries: readNativeLibraryLoadPaths(policy),
  };

  if (facts.installed.length === 0) {
    console.error(
      "check-dependency-licenses: no packages found under node_modules/.pnpm — run pnpm install first.",
    );
    process.exit(1);
  }

  const { problems, notes } = auditDependencyLicenses(facts, policy);

  for (const note of notes) console.log(`  note: ${note}`);

  if (problems.length > 0) {
    console.error("\nDependency licenses do not match the reviewed record:\n");
    for (const problem of problems) console.error(`  - ${problem}`);
    console.error(
      "\nThe record is apps/desktop/scripts/dependency-license-policy.json; the reasoning behind it " +
        "is docs/licensing/dependency-license-review.md.",
    );
    process.exit(1);
  }

  const reviewedCount = Object.keys(policy.reviewed).length;
  console.log(
    `check-dependency-licenses: ${facts.installed.length} installed packages checked, ` +
      `${reviewedCount} reviewed non-permissive entries intact.`,
  );
}

function report() {
  const policy = readPolicy();
  const byLicense = new Map();
  for (const pkg of readInstalledPackages()) {
    const key = pkg.license ?? "(none declared)";
    byLicense.set(key, [...(byLicense.get(key) ?? []), `${pkg.name}@${pkg.version}`]);
  }
  const sorted = [...byLicense].toSorted((a, b) => b[1].length - a[1].length);
  for (const [license, packages] of sorted) {
    const { permissive } = electPermissiveLicense(license, policy.permissive.ids);
    console.log(
      `${permissive ? "  " : "! "}${license}  (${packages.length})${
        permissive ? "" : `\n    ${packages.join("\n    ")}`
      }`,
    );
  }
}

function selfTest() {
  const failures = [];
  /** @param {string} what @param {boolean} ok */
  const expect = (what, ok) => {
    if (!ok) failures.push(what);
  };
  const permissive = ["MIT", "Apache-2.0", "BSD-3-Clause"];

  // --- license expressions ---
  expect("splits a dual license", splitLicenseChoices("(MPL-2.0 OR Apache-2.0)").length === 2);
  expect("leaves a single license alone", splitLicenseChoices("MIT").join() === "MIT");
  expect("does not split a conjunction", splitLicenseChoices("MIT AND CC-BY-4.0").length === 1);
  expect(
    "elects the permissive half",
    electPermissiveLicense("(MPL-2.0 OR Apache-2.0)", permissive).elected === "Apache-2.0",
  );
  expect(
    "rejects pure copyleft",
    !electPermissiveLicense("LGPL-3.0-or-later", permissive).permissive,
  );
  expect(
    "rejects a conjunction with a copyleft part",
    !electPermissiveLicense("MIT AND GPL-3.0", permissive).permissive,
  );
  expect("rejects a missing license", !electPermissiveLicense(null, permissive).permissive);
  expect(
    "rejects a bespoke license",
    !electPermissiveLicense("Limited W3 License", permissive).permissive,
  );
  expect(
    "is case-insensitive on OR",
    electPermissiveLicense("GPL-2.0 or MIT", permissive).permissive,
  );
  // The near-miss that makes exact matching worth stating: a prefix match would pass this.
  expect("does not prefix-match", !electPermissiveLicense("MIT-like", permissive).permissive);

  // --- declared license ---
  expect("reads a plain string", declaredLicense({ license: "MIT" }) === "MIT");
  expect("reads the legacy object", declaredLicense({ license: { type: "ISC" } }) === "ISC");
  expect(
    "reads the legacy array",
    declaredLicense({ licenses: [{ type: "MIT" }, { type: "GPL-2.0" }] }) === "MIT OR GPL-2.0",
  );
  expect("reads a legacy string array", declaredLicense({ licenses: ["MIT"] }) === "MIT");
  expect("reports nothing for an empty field", declaredLicense({ license: "  " }) === null);
  expect("reports nothing for no field", declaredLicense({}) === null);
  expect("reports nothing for an empty array", declaredLicense({ licenses: [] }) === null);

  // --- store directory names ---
  expect("parses a plain entry", parseStoreDirectoryName("gsap@3.15.0")?.name === "gsap");
  const scoped = parseStoreDirectoryName("@img+sharp-libvips-darwin-arm64@1.3.3");
  expect(
    "parses a scoped entry",
    scoped?.name === "@img/sharp-libvips-darwin-arm64" && scoped?.version === "1.3.3",
  );
  expect(
    "drops the peer suffix",
    parseStoreDirectoryName("astro@7.2.8_jiti@2.7.0")?.version === "7.2.8",
  );
  expect("rejects the hoisted dir", parseStoreDirectoryName("node_modules") === null);
  expect("rejects a leading-at name with no version", parseStoreDirectoryName("@scope") === null);
  expect("rejects a trailing at", parseStoreDirectoryName("thing@") === null);

  // --- path patterns ---
  expect(
    "matches a segment wildcard",
    matchesPathPattern(
      "packages/shared/src/theme/color.test.ts",
      "packages/shared/src/theme/*.test.ts",
    ),
  );
  expect(
    "a segment wildcard does not cross /",
    !matchesPathPattern(
      "packages/shared/src/theme/deep/color.test.ts",
      "packages/shared/src/theme/*.test.ts",
    ),
  );
  expect(
    "matches a globstar",
    matchesPathPattern("apps/website/src/components/a/b.tsx", "apps/website/src/**"),
  );
  expect("matches a leading globstar segment", matchesPathPattern("a/b/c.ts", "**/c.ts"));
  expect(
    "rejects a non-match",
    !matchesPathPattern("apps/desktop/src/main/index.ts", "apps/website/src/**"),
  );
  expect("escapes regex metacharacters", matchesPathPattern("a+b/c.ts", "a+b/c.ts"));

  // --- import detection ---
  expect("sees a static import", importsPackage('import { x } from "apca-w3";', "apca-w3"));
  expect("sees a subpath import", importsPackage('import { Flip } from "gsap/Flip";', "gsap"));
  expect("sees a dynamic import", importsPackage('const m = await import("sharp");', "sharp"));
  expect("sees a require", importsPackage('const m = require("sharp");', "sharp"));
  expect("sees a bare side-effect import", importsPackage('import "gsap";', "gsap"));
  expect(
    "ignores prose",
    importsPackage("// verified against `apca-w3` itself", "apca-w3") === false,
  );
  expect(
    "ignores an ambient declaration",
    importsPackage('declare module "apca-w3" { export function f(): void; }', "apca-w3") === false,
  );
  expect(
    "does not match a longer name",
    importsPackage('import x from "gsap-extra";', "gsap") === false,
  );

  // --- package-name patterns ---
  expect("an exact key matches itself", matchesPackagePattern("gsap", "gsap"));
  expect("an exact key does not prefix-match", !matchesPackagePattern("gsap-extra", "gsap"));
  expect(
    "a family key matches a sibling",
    matchesPackagePattern("@img/sharp-libvips-linux-x64", "@img/sharp-libvips-*"),
  );
  expect(
    "a family key matches the darwin sibling",
    matchesPackagePattern("@img/sharp-libvips-darwin-arm64", "@img/sharp-libvips-*"),
  );
  expect(
    "a family key does not reach a neighbour",
    !matchesPackagePattern("@img/sharp-darwin-arm64", "@img/sharp-libvips-*"),
  );
  expect(
    "a bare-suffix key matches the base package",
    matchesPackagePattern("lightningcss", "lightningcss*"),
  );
  expect(
    "a bare-suffix key matches a binary",
    matchesPackagePattern("lightningcss-linux-x64-gnu", "lightningcss*"),
  );

  // --- caret ranges ---
  expect("accepts a caret range", isCaretRange("^0.1.9"));
  expect("rejects an exact pin", !isCaretRange("0.1.9"));
  expect("rejects a tilde range", !isCaretRange("~0.1.9"));

  // --- the audit itself ---
  const basePolicy = {
    permissive: { ids: permissive },
    reviewed: {
      "restricted-lib": {
        license: "Bespoke",
        versions: ["1.0.0"],
        direct: { "@app/one": "devDependencies" },
        imports: ["apps/one/*.test.ts"],
        blocked: null,
      },
    },
  };
  const baseFacts = {
    installed: [
      { name: "restricted-lib", version: "1.0.0", license: "Bespoke" },
      { name: "fine-lib", version: "2.0.0", license: "MIT" },
    ],
    manifests: [
      {
        name: "@app/one",
        path: "apps/one/package.json",
        deps: {
          dependencies: {},
          optionalDependencies: {},
          peerDependencies: {},
          devDependencies: { "restricted-lib": "^1.0.0" },
        },
      },
    ],
    sources: [{ path: "apps/one/a.test.ts", source: 'import x from "restricted-lib";' }],
    packaging: { asarUnpack: [], files: [] },
    nativeLibraries: [],
  };
  const clone = () => JSON.parse(JSON.stringify(baseFacts));

  expect(
    "a matching tree is clean",
    auditDependencyLicenses(clone(), basePolicy).problems.length === 0,
  );

  const unreviewed = clone();
  unreviewed.installed.push({ name: "surprise", version: "1.0.0", license: "AGPL v3" });
  expect(
    "a new restricted dependency is caught",
    auditDependencyLicenses(unreviewed, basePolicy).problems.some((p) =>
      p.includes("surprise@1.0.0"),
    ),
  );

  const noLicense = clone();
  noLicense.installed.push({ name: "silent", version: "1.0.0", license: null });
  expect(
    "an undeclared license is caught",
    auditDependencyLicenses(noLicense, basePolicy).problems.some((p) =>
      p.includes("(none declared)"),
    ),
  );

  const bumped = clone();
  bumped.installed[0].version = "1.1.0";
  const bumpedProblems = auditDependencyLicenses(bumped, basePolicy).problems;
  expect(
    "an unreviewed bump is caught",
    bumpedProblems.some((p) => p.includes("the review covers 1.0.0")),
  );
  expect(
    "the dropped version is caught",
    bumpedProblems.some((p) => p.includes("no longer installed")),
  );

  const relicensed = clone();
  relicensed.installed[0].license = "AGPL v3";
  expect(
    "a silent relicense is caught",
    auditDependencyLicenses(relicensed, basePolicy).problems.some((p) =>
      p.includes("relicenses under us"),
    ),
  );

  const uninstalled = clone();
  uninstalled.installed = uninstalled.installed.filter((p) => p.name !== "restricted-lib");
  expect(
    "a stale review entry is caught",
    auditDependencyLicenses(uninstalled, basePolicy).problems.some((p) =>
      p.includes("nothing matching it is installed"),
    ),
  );

  const promoted = clone();
  promoted.manifests[0].deps.devDependencies = {};
  promoted.manifests[0].deps.dependencies = { "restricted-lib": "^1.0.0" };
  expect(
    "a dev dependency promoted to a runtime one is caught",
    auditDependencyLicenses(promoted, basePolicy).problems.some((p) =>
      p.includes("distributed artifact"),
    ),
  );

  const dropped = clone();
  dropped.manifests[0].deps.devDependencies = {};
  expect(
    "a review pointing at a dependency nobody declares is caught",
    auditDependencyLicenses(dropped, basePolicy).problems.some((p) =>
      p.includes("no longer declares it"),
    ),
  );

  const extraWorkspace = clone();
  extraWorkspace.manifests.push({
    name: "@app/two",
    path: "apps/two/package.json",
    deps: {
      dependencies: { "restricted-lib": "^1.0.0" },
      optionalDependencies: {},
      peerDependencies: {},
      devDependencies: {},
    },
  });
  expect(
    "a second workspace picking it up is caught",
    auditDependencyLicenses(extraWorkspace, basePolicy).problems.some((p) =>
      p.includes("which no review covers"),
    ),
  );

  const strayImport = clone();
  strayImport.sources.push({
    path: "apps/one/src/index.ts",
    source: 'import x from "restricted-lib";',
  });
  expect(
    "an import outside the reviewed files is caught",
    auditDependencyLicenses(strayImport, basePolicy).problems.some((p) =>
      p.includes("apps/one/src/index.ts imports"),
    ),
  );

  const noImportsPolicy = {
    ...basePolicy,
    reviewed: { "restricted-lib": { ...basePolicy.reviewed["restricted-lib"], imports: [] } },
  };
  expect(
    "an empty imports list reads well",
    auditDependencyLicenses(clone(), noImportsPolicy).problems.some((p) =>
      p.includes("no source file at all"),
    ),
  );

  const caretPolicy = {
    ...basePolicy,
    reviewed: {
      "restricted-lib": { ...basePolicy.reviewed["restricted-lib"], rangeMustBeCaret: true },
    },
  };
  const pinned = clone();
  pinned.manifests[0].deps.devDependencies = { "restricted-lib": "1.0.0" };
  expect(
    "a caret requirement is enforced",
    auditDependencyLicenses(pinned, caretPolicy).problems.some((p) => p.includes("caret range")),
  );
  expect(
    "a caret range satisfies it",
    auditDependencyLicenses(clone(), caretPolicy).problems.length === 0,
  );

  // A per-platform family: the reviewed key covers whichever sibling is installed.
  const familyPolicy = {
    permissive: { ids: permissive },
    reviewed: {
      "native-lib-*": {
        license: "LGPL-3.0-or-later",
        versions: ["1.0.0"],
        direct: { "@app/one": "optionalDependencies" },
        blocked: null,
      },
    },
  };
  const linuxTree = {
    installed: [{ name: "native-lib-linux-x64", version: "1.0.0", license: "LGPL-3.0-or-later" }],
    manifests: [
      {
        name: "@app/one",
        path: "apps/one/package.json",
        deps: {
          dependencies: {},
          optionalDependencies: { "native-lib-darwin-arm64": "1.0.0" },
          peerDependencies: {},
          devDependencies: {},
        },
      },
    ],
    sources: [],
    packaging: { asarUnpack: [], files: [] },
    nativeLibraries: [],
  };
  expect(
    "a family entry accepts whichever platform sibling is installed",
    auditDependencyLicenses(linuxTree, familyPolicy).problems.length === 0,
  );
  const emptyFamily = { ...linuxTree, installed: [] };
  expect(
    "a family entry matching nothing is caught",
    auditDependencyLicenses(emptyFamily, familyPolicy).problems.some((p) =>
      p.includes("nothing matching it is installed"),
    ),
  );
  const familyRelicensed = JSON.parse(JSON.stringify(linuxTree));
  familyRelicensed.installed[0].license = "AGPL v3";
  expect(
    "a family sibling that relicensed is caught",
    auditDependencyLicenses(familyRelicensed, familyPolicy).problems.some((p) =>
      p.includes("relicenses under us"),
    ),
  );

  const sourcePolicy = {
    permissive: { ids: permissive },
    reviewed: {
      "no-source-entry": {
        license: "Bespoke",
        versions: ["1.0.0"],
        licenseSource: "license-file",
        blocked: null,
      },
    },
  };
  const undeclared = {
    ...clone(),
    installed: [{ name: "no-source-entry", version: "1.0.0", license: null }],
  };
  expect(
    "a recorded licenseSource excuses a silent manifest",
    auditDependencyLicenses(undeclared, sourcePolicy).problems.length === 0,
  );
  const sourcelessPolicy = {
    permissive: { ids: permissive },
    reviewed: { "no-source-entry": { license: "Bespoke", versions: ["1.0.0"], blocked: null } },
  };
  expect(
    "a silent manifest with no licenseSource is caught",
    auditDependencyLicenses(undeclared, sourcelessPolicy).problems.some((p) =>
      p.includes("no licenseSource"),
    ),
  );

  // --- the LGPL packaging invariants ---
  const nativePolicy = {
    permissive: { ids: permissive },
    reviewed: {
      "lgpl-lib": {
        license: "LGPL-3.0-or-later",
        versions: ["1.0.0"],
        blocked: null,
        nativeLibrary: {
          consumerPackage: "addon-pkg",
          addonPath: "lib/addon-{consumerVersion}.node",
          dynamicLoadPathContains: "@rpath/liblgpl",
          electronBuilderAsarUnpackPattern: "**/node_modules/@img/**",
          electronBuilderFilesToken: "@img",
        },
      },
    },
  };
  const nativeFacts = {
    installed: [{ name: "lgpl-lib", version: "1.0.0", license: "LGPL-3.0-or-later" }],
    manifests: [],
    sources: [],
    packaging: {
      asarUnpack: ["**/node_modules/@img/**"],
      files: ["!node_modules/!(@img|yaml)/**"],
    },
    nativeLibraries: [
      { package: "lgpl-lib", resolved: true, loadPaths: ["@rpath/liblgpl.1.dylib"] },
    ],
  };
  expect(
    "intact packaging is clean",
    auditDependencyLicenses(nativeFacts, nativePolicy).problems.length === 0,
  );

  const sealed = JSON.parse(JSON.stringify(nativeFacts));
  sealed.packaging.asarUnpack = [];
  expect(
    "sealing the library into the asar is caught",
    auditDependencyLicenses(sealed, nativePolicy).problems.some((p) => p.includes("section 4(d)")),
  );

  const unshipped = JSON.parse(JSON.stringify(nativeFacts));
  unshipped.packaging.files = ["!node_modules/!(yaml)/**"];
  expect(
    "dropping it from the files list is caught",
    auditDependencyLicenses(unshipped, nativePolicy).problems.some((p) =>
      p.includes("no libvips at all"),
    ),
  );

  const statically = JSON.parse(JSON.stringify(nativeFacts));
  statically.nativeLibraries = [
    { package: "lgpl-lib", resolved: true, loadPaths: ["@rpath/libother.dylib"] },
  ];
  expect(
    "static linking is caught",
    auditDependencyLicenses(statically, nativePolicy).problems.some((p) => p.includes("4(d)(0)")),
  );

  const otherPlatform = JSON.parse(JSON.stringify(nativeFacts));
  otherPlatform.nativeLibraries = [{ package: "lgpl-lib", resolved: false, loadPaths: [] }];
  const skipped = auditDependencyLicenses(otherPlatform, nativePolicy);
  expect("a foreign platform skips rather than fails", skipped.problems.length === 0);
  expect(
    "and says that it skipped",
    skipped.notes.some((n) => n.includes("not installed on this platform")),
  );

  const unreadable = JSON.parse(JSON.stringify(nativeFacts));
  unreadable.packaging = null;
  const unreadableResult = auditDependencyLicenses(unreadable, nativePolicy);
  expect(
    "unreadable packaging config notes rather than fails",
    unreadableResult.problems.length === 0,
  );
  expect(
    "and says so",
    unreadableResult.notes.some((n) => n.includes("packaging config unreadable")),
  );

  if (failures.length > 0) {
    console.error("check-dependency-licenses self-test failed:");
    for (const failure of failures) console.error(`  - ${failure}`);
    process.exit(1);
  }
  console.log("check-dependency-licenses self-test passed");
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.includes("--self-test")) {
    selfTest();
  } else if (process.argv.includes("--report")) {
    report();
  } else {
    await gate();
  }
}

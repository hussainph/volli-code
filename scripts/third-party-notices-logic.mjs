/**
 * The pure half of the workspace licence-notice pipeline: dependency-closure
 * walking, licence grouping, document rendering, and the packaging-coverage
 * rules. No filesystem, no process, no absolute paths — every input arrives as
 * an argument, so `generate-third-party-notices.mjs --self-test` can drive all
 * of it against fixtures instead of against whatever happens to be installed.
 *
 * WHY THE SPLIT (VC-407). The notice that ships has to be reproducible and it
 * has to be checkable in CI, and those two want different inputs: the real
 * generator reads node_modules, while the check that the RULES still hold must
 * run against data a test can author. Keeping the rules here means a change to
 * "what counts as shipped" is a change to one testable function, not to a
 * script that only speaks to the disk.
 *
 * WHY IT LIVES AT THE REPOSITORY ROOT and not under apps/desktop. Nothing in
 * this file knows about Electron. It walks a dependency closure from ROOTS THE
 * CALLER NAMES and renders a document from a model the caller builds, which is
 * what lets one artifact (today the macOS .app) be described without the rules
 * being owned by it. `scripts/check-workspace-licenses.mjs` (VC-411) already
 * established this seam for repository-wide licensing gates. When a second
 * client or a standalone server needs its own notice, it supplies its own
 * roots and its own packaging adapter and reuses everything here — the
 * alternative was a copy of 700 lines per artifact, each drifting on its own.
 *
 * The one Electron-shaped thing left is {@link keptNodeModulePackages} and
 * {@link unpackedPackages}, which read electron-builder's grammar. They are
 * the ADAPTER: `packagingFailures` takes the shipped-name set as data, so a
 * future artifact swaps those two functions and keeps the rule.
 *
 * WHAT COUNTS AS SHIPPED is decided in {@link collectPackageClosure}: the
 * production dependency closure (dependencies + optionalDependencies + peer
 * dependencies, transitively) of the roots the caller names. For the desktop
 * artifact those are the desktop app itself and @volli/cli, whose bundle
 * copy-cli.mjs drops into dist-electron. It is a deliberate SUPERSET of the
 * bytes in the artifact: a package in the closure may end up tree-shaken out
 * of a renderer chunk, but nothing that ships can be missing from it.
 * Over-listing a notice is harmless; under-listing it is the compliance
 * failure this exists to prevent.
 *
 * PLATFORM PACKAGES ARE EXCLUDED from that walk (`os`/`cpu` in their manifest)
 * and come from the checked-in registry instead. They are the one input that
 * is not the same on two machines — Linux CI installs @esbuild/linux-x64 where
 * this mac installs @esbuild/darwin-arm64, and the three darwin-arm64 native
 * packages the app actually ships do not install on Linux at all. A generated
 * file that differed by host could not be checked in, so the registry pins the
 * ones that ship (with their licence text) and the walk skips the rest.
 * {@link uncoveredPlatformPackages} is what stops that exclusion from becoming
 * a hole: a skipped package that the packaging config actually ships, and that
 * the registry does not pin, is a failure rather than a silent omission.
 */

/** Packages whose licence declaration is not a plain permissive grant. */
const REVIEW_LICENSE_PATTERN = /\b(?:[AL]?GPL|MPL|EPL|CDDL|CPL|SSPL|OSL|CC-BY-SA|Ms-PL)\b/i;

/** Root-level files a package may publish its licence terms in. */
const LICENSE_FILE_PATTERN = /^(licen[cs]e|copying)([-._][^/]*)?$/i;
/** Root-level NOTICE files (Apache-2.0 §4(d) content travels with the licence). */
const NOTICE_FILE_PATTERN = /^notice([-._][^/]*)?$/i;
/** Extensions a document of TERMS never has — see {@link hasCodeExtension}. */
const CODE_EXTENSIONS = new Set([
  "js",
  "mjs",
  "cjs",
  "jsx",
  "ts",
  "mts",
  "cts",
  "tsx",
  "json",
  "json5",
  "map",
  "yml",
  "yaml",
  "toml",
  "ini",
  "cfg",
  "xml",
  "lock",
  "sh",
  "bash",
  "zsh",
  "fish",
  "ps1",
  "bat",
  "cmd",
  "py",
  "rb",
  "go",
  "rs",
  "java",
  "kt",
  "swift",
  "c",
  "h",
  "cc",
  "cpp",
  "hpp",
  "cs",
  "php",
  "pl",
  "lua",
  "r",
  "scala",
  "node",
  "wasm",
  "exe",
  "dll",
  "so",
  "dylib",
  "bin",
  "gz",
  "zip",
  "tgz",
]);
/** Extensions a licence document legitimately carries, stripped before matching. */
const DOCUMENT_EXTENSION_PATTERN = /\.(md|markdown|txt|text|rst)$/i;

/**
 * Does this filename end in an extension that means "code", not "terms"?
 *
 * WHY THIS EXISTS. The name patterns above accept an optional `[-._]` tail, so
 * that `LICENSE-MIT`, `LICENSE.APACHE2` and `COPYING.LESSER` — all real, all
 * genuine terms — are found. That same tail also accepted `license-update.mjs`,
 * a BUILD SCRIPT that cytoscape publishes at its package root, and 32 lines of
 * JavaScript were reproduced verbatim into the shipped notice as if they were
 * a grant. Reproducing code as licence text is worse than missing it: it makes
 * the document wrong in a way a reader cannot detect, because everything
 * around it is real.
 *
 * A DENYLIST, not an allowlist, and deliberately: packages publish terms under
 * extensions nobody can enumerate (`LICENSE.APACHE2`, `LICENSE.BSD`, bare
 * `COPYING`), so an allowlist would silently DROP real grants — the failure
 * direction this whole pipeline exists to prevent. A denylist can only ever
 * admit a file that is not code, which the reviewer reading the document sees.
 * @param {string} name
 */
function hasCodeExtension(name) {
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return false;
  return CODE_EXTENSIONS.has(name.slice(dot + 1).toLowerCase());
}

/** @param {string} name */
export function isLicenseFileName(name) {
  if (hasCodeExtension(name)) return false;
  return LICENSE_FILE_PATTERN.test(name.replace(DOCUMENT_EXTENSION_PATTERN, ""));
}

/** @param {string} name */
export function isNoticeFileName(name) {
  if (hasCodeExtension(name)) return false;
  return NOTICE_FILE_PATTERN.test(name.replace(DOCUMENT_EXTENSION_PATTERN, ""));
}

/**
 * Normalise licence text for reproducible output: strip a BOM, fold CRLF, and
 * remove trailing horizontal whitespace from every line. Line breaks and every
 * other character are otherwise untouched — reproducing a licence means
 * reproducing it, not reflowing it.
 * @param {string} text
 */
export function normalizeLicenseText(text) {
  return text
    .replace(/^\uFEFF/, "")
    .replaceAll("\r\n", "\n")
    .replace(/[ \t]+(?=\n|$)/g, "");
}

/**
 * Read the project's copyright line out of its own Apache-2.0 LICENSE.
 *
 * WHY IT IS READ AND NEVER WRITTEN HERE (VC-407 / VC-414). Naming a copyright
 * holder is an ownership decision, not a value a build script may derive. So
 * this reports one of exactly two states and invents neither:
 *
 *   - the appendix still carries Apache's `[yyyy] [name of copyright owner]`
 *     placeholder → `{ holder: null }`, and the document says so plainly;
 *   - the appendix names a holder → `{ holder: "<that line, verbatim>" }`.
 *
 * The consequence is that VC-414's edit to one line of LICENSE flows into the
 * shipped notice by regenerating it, with no second copy of the owner's name
 * anywhere in this pipeline to drift. A hardcoded holder here would be a
 * second source of truth for the one fact the LICENSE exists to state.
 *
 * @param {string} licenseText
 * @returns {{ holder: string | null, line: string | null }}
 */
export function copyrightHolder(licenseText) {
  const match = /^[ \t]*Copyright[ \t]+(.+?)[ \t]*$/m.exec(licenseText);
  if (match === null) return { holder: null, line: null };
  const value = match[1].trim();
  // Apache's own appendix placeholder, in the bracket form the template ships.
  if (/\[.*\]/.test(value)) return { holder: null, line: value };
  return { holder: value, line: value };
}

/**
 * The SPDX-ish declaration a manifest makes, in the shapes npm has used over
 * the years. Returns `null` when the package declares nothing at all, which is
 * a fact the document reports rather than a value to invent.
 * @param {Record<string, unknown>} manifest
 * @returns {string | null}
 */
export function declaredLicense(manifest) {
  const { license, licenses } = /** @type {any} */ (manifest);
  if (typeof license === "string" && license.trim() !== "") return license.trim();
  // Legacy `license: { type }` and `licenses: [{ type }]` (npm pre-2014, still
  // in the wild in the deep transitive tail).
  if (license !== null && typeof license === "object" && typeof license.type === "string") {
    return license.type.trim();
  }
  if (Array.isArray(licenses)) {
    const types = licenses
      .map((entry) => (typeof entry === "string" ? entry : entry?.type))
      .filter((type) => typeof type === "string" && type.trim() !== "");
    if (types.length > 0) return types.length === 1 ? types[0].trim() : `(${types.join(" OR ")})`;
  }
  return null;
}

/** Repository URL as a plain string, whatever manifest shape carries it. */
export function repositoryUrl(manifest) {
  const { repository, homepage } = /** @type {any} */ (manifest);
  const raw =
    typeof repository === "string"
      ? repository
      : typeof repository?.url === "string"
        ? repository.url
        : typeof homepage === "string"
          ? homepage
          : null;
  if (raw === null) return null;
  return raw.replace(/^git\+/, "").replace(/\.git$/, "");
}

/**
 * Walk the production dependency closure of `roots`.
 *
 * IO arrives injected: `readManifest(dir)` returns a parsed package.json (or
 * null), `resolveDependency(fromDir, name)` answers with the directory Node
 * would resolve that name to from that package (or null when this host did not
 * install it). Both are trivial to fake, which is what the self-test does.
 *
 * PEER DEPENDENCIES ARE WALKED, and that is not belt-and-braces. A peer is
 * code the dependent EXECUTES; npm 7+ installs it automatically, so it is
 * present in the artifact whether or not any manifest also lists it as a
 * direct dependency. Walking only `dependencies` rested on the assumption
 * that every shipped peer is someone's direct dependency too — true today by
 * luck, and silently false the first time it is not.
 *
 * PEERS MARKED OPTIONAL ARE NOT WALKED. `peerDependenciesMeta[name].optional`
 * is the package's own declaration that it runs without that peer, and in
 * practice it is the type-only case: every Radix primitive declares
 * `@types/react` optional, and walking those dragged @types/react,
 * @types/react-dom and csstype into a list whose whole claim is that its
 * members reach the artifact. Over-listing is cheap but not free — padding
 * the list with packages that provably cannot ship teaches a reader to
 * discount it.
 *
 * A REQUIRED peer still enters the list even when the requirement is only a
 * type-level one — @trpc/client and @trpc/server require `typescript`, which
 * no bundle executes. That is deliberate: the alternative is a hand-kept
 * denylist of "peers we judge not to ship", which is the drift this file
 * exists to avoid, and the document already states that the list is a
 * superset. Erring here costs a reader one extra entry; erring the other way
 * costs an unlicensed redistribution.
 *
 * @param {{
 *   roots: { name: string, dir: string }[],
 *   readManifest: (dir: string) => Record<string, unknown> | null,
 *   resolveDependency: (fromDir: string, name: string) => string | null,
 *   isFirstParty?: (name: string) => boolean,
 * }} options
 */
export function collectPackageClosure({
  roots,
  readManifest,
  resolveDependency,
  isFirstParty = (name) => name.startsWith("@volli/"),
}) {
  /** @type {Map<string, { name: string, version: string, dir: string, manifest: Record<string, unknown> }>} */
  const thirdParty = new Map();
  /** @type {Map<string, { name: string, version: string, dir: string }>} */
  const firstParty = new Map();
  /** @type {Map<string, { name: string, version: string, os: string[], cpu: string[] }>} */
  const platformSpecific = new Map();
  /** @type {Set<string>} */
  const notInstalled = new Set();

  const queue = roots.map((root) => ({ ...root, manifest: readManifest(root.dir) }));
  const visited = new Set();

  while (queue.length > 0) {
    const current = queue.shift();
    if (current.manifest === null) {
      throw new Error(`third-party-notices: no package.json at ${current.dir}`);
    }
    const meta = /** @type {any} */ (current.manifest).peerDependenciesMeta ?? {};
    const requiredPeers = Object.fromEntries(
      Object.entries(/** @type {any} */ (current.manifest).peerDependencies ?? {}).filter(
        ([name]) => meta[name]?.optional !== true,
      ),
    );
    const dependencies = {
      .../** @type {any} */ (current.manifest).dependencies,
      .../** @type {any} */ (current.manifest).optionalDependencies,
      ...requiredPeers,
    };
    for (const name of Object.keys(dependencies).toSorted()) {
      const dir = resolveDependency(current.dir, name);
      if (dir === null) {
        // Almost always another platform's optional package (@esbuild/linux-x64
        // on a mac). Recorded, never fatal: the registry, not this walk, is
        // what covers the platform packages that do ship.
        notInstalled.add(name);
        continue;
      }
      const manifest = readManifest(dir);
      if (manifest === null) continue;
      const version = String(/** @type {any} */ (manifest).version ?? "0.0.0");
      const key = `${name}@${version}`;
      if (visited.has(key)) continue;
      visited.add(key);
      const { os, cpu } = /** @type {any} */ (manifest);
      if (os || cpu) {
        platformSpecific.set(key, {
          name,
          version,
          os: Array.isArray(os) ? os : [],
          cpu: Array.isArray(cpu) ? cpu : [],
        });
        continue;
      }
      if (isFirstParty(name)) {
        firstParty.set(key, { name, version, dir });
      } else {
        thirdParty.set(key, { name, version, dir, manifest });
      }
      queue.push({ name, dir, manifest });
    }
  }

  return {
    thirdParty: [...thirdParty.values()].toSorted(comparePackages),
    firstParty: [...firstParty.values()].toSorted(comparePackages),
    platformSpecific: [...platformSpecific.values()].toSorted(comparePackages),
    notInstalled: [...notInstalled].toSorted(),
  };
}

/** @param {{ name: string, version: string }} a @param {{ name: string, version: string }} b */
function comparePackages(a, b) {
  if (a.name !== b.name) return a.name < b.name ? -1 : 1;
  return a.version < b.version ? -1 : a.version > b.version ? 1 : 0;
}

/**
 * Group packages that carry byte-identical licence text into one block, so 434
 * MIT packages do not print 434 copies of the same paragraph. The SPDX id is
 * part of the grouping key: two packages sharing a text but declaring
 * different ids stay apart, because the declaration is part of what is being
 * reported.
 *
 * @param {{ name: string, version: string, spdx: string | null, files: { file: string, text: string, kind: "license" | "notice" }[] }[]} entries
 */
export function groupLicenseBlocks(entries) {
  /** @type {Map<string, { spdx: string | null, files: { file: string, text: string, kind: string }[], packages: { name: string, version: string }[] }>} */
  const groups = new Map();
  for (const entry of entries) {
    if (entry.files.length === 0) continue;
    const body = entry.files.map((file) => `${file.file}\u0000${file.text}`).join("\u0001");
    const key = `${entry.spdx ?? "(undeclared)"}\u0002${body}`;
    const existing = groups.get(key);
    if (existing === undefined) {
      groups.set(key, {
        spdx: entry.spdx,
        files: entry.files,
        packages: [{ name: entry.name, version: entry.version }],
      });
    } else {
      existing.packages.push({ name: entry.name, version: entry.version });
    }
  }
  const blocks = [];
  for (const group of groups.values()) {
    blocks.push({
      spdx: group.spdx,
      files: group.files,
      packages: group.packages.toSorted(comparePackages),
    });
  }
  // Sorted by the first package in each block: stable output that does not
  // reshuffle the whole file when one dependency is added.
  return blocks.toSorted((a, b) => comparePackages(a.packages[0], b.packages[0]));
}

/** Packages whose declaration is not a plain permissive grant, in file order. */
export function licensesNeedingReview(entries) {
  return entries
    .filter((entry) => entry.spdx !== null && REVIEW_LICENSE_PATTERN.test(entry.spdx))
    .map((entry) => ({ name: entry.name, version: entry.version, spdx: entry.spdx }));
}

/**
 * The package names electron-builder keeps in the shipped node_modules tree,
 * read out of the one `!node_modules/!(a|b|c)/**` negation in `files:`.
 *
 * Parsed rather than mirrored, for the reason verify-packed-requires.mjs parses
 * the same entry: a hand-copied list agrees with a stale idea of what ships.
 * @param {{ files?: unknown }} builderConfig
 */
export function keptNodeModulePackages(builderConfig) {
  const entries = Array.isArray(builderConfig.files) ? builderConfig.files : [];
  const keepEntry = entries.find(
    (entry) => typeof entry === "string" && /^!node_modules\/!\(.*\)\/\*\*$/.test(entry),
  );
  if (keepEntry === undefined) {
    throw new Error(
      'third-party-notices: electron-builder.yml has no "!node_modules/!(...)/**" whitelist entry to read.',
    );
  }
  return keepEntry
    .match(/^!node_modules\/!\((.*)\)\/\*\*$/)[1]
    .split("|")
    .toSorted();
}

/**
 * Package (or scope) names electron-builder unpacks out of the asar — the
 * native trees whose binaries ship as files. Every one of them must be covered
 * by the notice, which is what makes `asarUnpack` gaining an entry a check
 * failure rather than a silent omission.
 * @param {{ asarUnpack?: unknown }} builderConfig
 */
export function unpackedPackages(builderConfig) {
  const entries = Array.isArray(builderConfig.asarUnpack) ? builderConfig.asarUnpack : [];
  const names = new Set();
  for (const entry of entries) {
    if (typeof entry !== "string") continue;
    const match = /node_modules\/((?:@[^/*]+\/)?[^/*]+)\//.exec(entry);
    if (match !== null) names.add(match[1]);
  }
  return [...names].toSorted();
}

/**
 * Does `name` (a package or a scope like `@img`) appear in the shipped set?
 * Scope entries in electron-builder's whitelist keep every package under the
 * scope, so a scope is covered when any package under it is covered.
 * @param {string} name @param {Set<string>} coveredNames
 */
export function isNameCovered(name, coveredNames) {
  if (coveredNames.has(name)) return true;
  if (!name.startsWith("@") || name.includes("/")) return false;
  const prefix = `${name}/`;
  for (const covered of coveredNames) if (covered.startsWith(prefix)) return true;
  return false;
}

/**
 * The packaging half of the gate: everything electron-builder promises to put
 * in the .app must exist, and everything it ships must be named in the notice.
 * A resource may allow a missing source so the stale-notice check remains
 * offline-friendly before Electron's lazily downloaded distribution exists;
 * electron-builder still requires that source when it packages the app.
 *
 * @param {{
 *   builderConfig: Record<string, unknown>,
 *   coveredNames: Set<string>,
 *   requiredResources: { from: string, to: string, allowMissing?: boolean, requireNonEmpty?: boolean }[],
 *   resourceExists: (from: string) => boolean,
 *   resourceIsNonEmpty?: (from: string) => boolean,
 * }} options
 * @returns {string[]} one line per failure, empty when the packaging holds
 */
export function packagingFailures({
  builderConfig,
  coveredNames,
  requiredResources,
  resourceExists,
  resourceIsNonEmpty = () => true,
}) {
  const failures = [];
  const extraResources = Array.isArray(/** @type {any} */ (builderConfig).extraResources)
    ? /** @type {any} */ (builderConfig).extraResources
    : [];
  const declared = new Map(
    extraResources
      .filter((entry) => entry !== null && typeof entry === "object")
      .map((entry) => [String(entry.from), String(entry.to)]),
  );
  for (const required of requiredResources) {
    const to = declared.get(required.from);
    if (to === undefined) {
      failures.push(
        `electron-builder.yml extraResources does not ship "${required.from}" — the packaged .app would carry no ${required.to}.`,
      );
      continue;
    }
    if (to !== required.to) {
      failures.push(
        `electron-builder.yml ships "${required.from}" to "${to}"; the notice document names "${required.to}".`,
      );
    }
    const exists = resourceExists(required.from);
    if (!exists) {
      if (!required.allowMissing) {
        failures.push(
          `electron-builder.yml extraResources points at a missing file: ${required.from}`,
        );
      }
      continue;
    }
    if (required.requireNonEmpty && !resourceIsNonEmpty(required.from)) {
      failures.push(
        `electron-builder.yml extraResources source has empty content: ${required.from}`,
      );
    }
  }
  for (const name of [
    ...keptNodeModulePackages(builderConfig),
    ...unpackedPackages(builderConfig),
  ].toSorted()) {
    if (name.startsWith("!")) continue;
    if (!isNameCovered(name, coveredNames)) {
      failures.push(
        `${name} ships in the packaged app (electron-builder.yml) but no licence notice covers it.`,
      );
    }
  }
  return [...new Set(failures)];
}

/**
 * Platform packages the walk skipped that the packaging config nevertheless
 * ships ON THE ARTIFACT'S TARGET PLATFORM, and that the registry does not pin.
 *
 * WHY THIS RULE EXISTS. Excluding every `os`/`cpu` package is what makes the
 * document render identically on macOS and on Linux CI, but on its own it is
 * indistinguishable from a hole: the three darwin-arm64 packages the .app
 * really ships are excluded by exactly the same test as @esbuild/linux-x64,
 * which ships nowhere. The registry closes it for the three we know about; a
 * FOURTH native package added tomorrow would be skipped by the walk, absent
 * from the registry, and covered by nothing — with every check green. This
 * turns that into a named failure at the moment the packaging config starts
 * shipping it.
 *
 * WHY THE TARGET, NOT THE HOST. The first version of this rule asked only
 * "does the packaging config ship this name", and went red on Linux CI: the
 * runner installs @img/sharp-linux-x64, the `@img` scope is shipped, and the
 * registry pins only the darwin-arm64 set — so the host's own irrelevant
 * variants were reported as uncovered. The artifact is macOS arm64 whatever
 * machine builds it, so a skipped package is only interesting when its own
 * `os`/`cpu` say it would be installed FOR THAT TARGET. A package declaring
 * neither is treated as matching, because it constrains nothing.
 *
 * @param {{
 *   skipped: { name: string, version: string, os: string[], cpu: string[] }[],
 *   target: { os: string, cpu: string },
 *   shippedNames: Set<string>,         // what the packaging config ships
 *   registeredNames: Set<string>,      // what the reviewed registry pins
 * }} options
 * @returns {string[]}
 */
export function uncoveredPlatformPackages({ skipped, target, shippedNames, registeredNames }) {
  const failures = [];
  for (const pkg of skipped) {
    if (registeredNames.has(pkg.name)) continue;
    if (!constraintAdmits(pkg.os, target.os) || !constraintAdmits(pkg.cpu, target.cpu)) {
      continue;
    }
    if (!isNameCovered(pkg.name, shippedNames) && !isNameShipped(pkg.name, shippedNames)) continue;
    failures.push(
      `${pkg.name}@${pkg.version} installs on this artifact's target (${target.os}/${target.cpu}), ` +
        `the dependency walk skips it as platform-specific, it ships in the packaged app ` +
        `(electron-builder.yml), and no entry in notices/sources.json pins its licence text. ` +
        `Add it to platformNative, or stop shipping it.`,
    );
  }
  return [...new Set(failures)].toSorted();
}

/**
 * Does an npm `os`/`cpu` constraint admit `value`?
 *
 * Empty admits everything (the package constrains nothing). A list of `!x`
 * negations means "every platform except those"; a positive list means "only
 * these". npm does not mix the two forms, and neither does this.
 * @param {string[]} declared @param {string} value
 */
function constraintAdmits(declared, value) {
  if (declared.length === 0) return true;
  if (declared.some((entry) => entry.startsWith("!"))) return !declared.includes(`!${value}`);
  return declared.includes(value);
}

/**
 * Is `name` shipped because the config names its SCOPE or the package itself?
 * The mirror of {@link isNameCovered}: there we ask whether a shipped scope is
 * covered by a notice, here whether a skipped package falls under a shipped
 * scope (`@img/sharp-darwin-arm64` under a shipped `@img`).
 * @param {string} name @param {Set<string>} shippedNames
 */
function isNameShipped(name, shippedNames) {
  if (shippedNames.has(name)) return true;
  const slash = name.indexOf("/");
  return slash > 0 && shippedNames.has(name.slice(0, slash));
}

/**
 * Decide what a workspace package's OWN declared notices contribute, and what
 * about them is broken.
 *
 * THIS REPLACES A MAGIC-STRING GREP (VC-407 review). The first design had the
 * desktop registry name a file owned by another package plus a marker word,
 * and decided by reading every shipped source file looking for that word. The
 * real case walked straight through the hole: the Ghostty theme catalog landed
 * as `ghostty-theme-sources.generated.ts`, 463 entries whose text says
 * "iTerm2 Dark Background" and never the marker `iTerm2-Color-Schemes`. Marker
 * not found, so the rule concluded the material had not shipped, stayed green,
 * and would have packaged 463 vendored themes with no attribution. A grep for
 * a word is a guess about how someone else will spell something.
 *
 * WHAT REPLACES IT IS THE FILE ITSELF. A package declares, in its own
 * `package.json`, which of its files are vendored third-party material and
 * which notice covers them:
 *
 *     "volli": { "notices": [ { "title": ..., "covers": [...], "document": ... } ] }
 *
 * The rule then keys on presence, not on prose: the material is shipped if and
 * only if its file is in the tree, which is the same question the packaging
 * asks. There is no string to get wrong and no tree to scan.
 *
 * WHY IT LIVES IN THE OWNING PACKAGE. Before, the desktop registry named paths
 * inside @volli/shared and @volli/agent-runtime, so an ordinary rename in
 * either package broke the DESKTOP gate, with the declaration to fix three
 * directories away. Declared here, the path and the file it names move
 * together in one package, under one review.
 *
 * Both directions are failures, and deliberately:
 *   - material present, notice file absent  → the artifact would ship
 *     unattributed material. This is the case the grep missed.
 *   - notice declared, material absent      → the declaration has rotted (a
 *     typo, or material deleted without its entry). Silence here would let a
 *     mistyped path masquerade as coverage.
 *
 * @param {{
 *   packageName: string,
 *   entries: unknown,
 *   materialExists: (relativePath: string) => boolean,
 *   noticeExists: (relativePath: string) => boolean,
 * }} options
 * @returns {{ include: { title: string, packageName: string, document: string | null, entry: any }[], failures: string[] }}
 */
export function packageNoticeDecisions({ packageName, entries, materialExists, noticeExists }) {
  const include = [];
  const failures = [];
  if (entries === undefined || entries === null) return { include, failures };
  if (!Array.isArray(entries)) {
    failures.push(`${packageName}: "volli.notices" must be an array.`);
    return { include, failures };
  }

  for (const [index, entry] of entries.entries()) {
    const label = typeof entry?.title === "string" ? entry.title : `entry ${index}`;
    const where = `${packageName} "${label}"`;
    if (entry === null || typeof entry !== "object") {
      failures.push(`${where}: notice entry must be an object.`);
      continue;
    }
    if (typeof entry.title !== "string" || entry.title.trim() === "") {
      failures.push(`${where}: notice entry has no title.`);
      continue;
    }
    if (!Array.isArray(entry.covers) || entry.covers.length === 0) {
      failures.push(
        `${where}: notice entry records no "covers" paths, so nothing ties it to shipped ` +
          `material. Name the vendored files it covers.`,
      );
      continue;
    }

    let rotted = false;
    for (const path of entry.covers) {
      if (typeof path !== "string" || path.trim() === "") {
        failures.push(`${where}: "covers" holds an entry that is not a path.`);
        rotted = true;
      } else if (!materialExists(path)) {
        failures.push(
          `${where}: "covers" names ${path}, which is not in this package. Fix the path, ` +
            `or drop the entry if the material is gone.`,
        );
        rotted = true;
      }
    }
    if (rotted) continue;

    // The material is here. From this point the notice is REQUIRED.
    const document = typeof entry.document === "string" ? entry.document : null;
    if (document !== null && !noticeExists(document)) {
      failures.push(
        `${where}: the material in "covers" is in this tree but its notice ${document} is ` +
          `not — the packaged app would carry it with no attribution.`,
      );
      continue;
    }
    if (document === null && typeof entry.text === "string" && !noticeExists(entry.text)) {
      failures.push(`${where}: licence text ${entry.text} is not in this package.`);
      continue;
    }
    if (document === null && entry.text === undefined && entry.unresolved === undefined) {
      failures.push(
        `${where}: records neither a licence text, a notice document, nor an "unresolved" ` +
          `statement. One of the three must be true of any vendored material.`,
      );
      continue;
    }
    include.push({ title: entry.title, packageName, document, entry });
  }
  return { include, failures };
}

const RULE = "=".repeat(105);
const THIN_RULE = "-".repeat(105);
/** Columns the document's own prose wraps at; licence texts are never rewrapped. */
const WRAP_COLUMNS = 88;

/**
 * Greedy wrap for the document's own prose, so a registry note written as one
 * long sentence does not render as one long line. Deterministic: same input,
 * same lines, on every machine. Existing newlines are kept as paragraph breaks.
 * @param {string} text @param {string} [indent] @param {number} [columns]
 */
export function wrapText(text, indent = "", columns = WRAP_COLUMNS) {
  const lines = [];
  for (const paragraph of text.split("\n")) {
    if (paragraph.trim() === "") {
      lines.push("");
      continue;
    }
    let current = indent;
    for (const word of paragraph.trim().split(/\s+/)) {
      if (current.trim() !== "" && `${current} ${word}`.length > columns) {
        lines.push(current);
        current = `${indent}${word}`;
      } else {
        current = current.trim() === "" ? `${indent}${word}` : `${current} ${word}`;
      }
    }
    lines.push(current);
  }
  return lines;
}

/** `Note: …` with continuation lines aligned under the first. */
function noteLines(note) {
  const wrapped = wrapText(note, "      ");
  return wrapped.map((line, index) => (index === 0 ? `Note: ${line.trimStart()}` : line));
}

/**
 * Render the whole document. Everything it prints comes from `model`; there is
 * no ambient state, so the same model renders the same bytes anywhere.
 *
 * @param {{
 *   projectLicenseName: string,
 *   projectLicenseFile: string,
 *   ownershipNote: string,
 *   shippedResources: { from: string, to: string }[],
 *   firstParty: string[],
 *   entries: { name: string, version: string, spdx: string | null, shippedAs: string, files: { file: string, text: string, kind: string }[], repository: string | null }[],
 *   platformNative: { name: string, version: string, spdx: string | null, note: string, text: string }[],
 *   toolchain: { name: string, version: string, spdx: string | null, note: string, files: { file: string, text: string, kind: string }[] }[],
 *   vendored: { title: string, paths: string[], owner: string | null, upstream: string | null, spdx: string | null, evidence: string, text: string | null, unresolved: string | null }[],
 *   patched: { name: string, version: string, patch: string }[],
 *   fragments: { title: string, source: string, text: string }[],
 * }} model
 */
export function renderNoticeDocument(model) {
  const out = [];
  const section = (title) => {
    out.push(RULE, title, RULE, "");
  };

  const totalPackages = model.entries.length + model.platformNative.length + model.toolchain.length;
  out.push(
    "VOLLI CODE — THIRD-PARTY SOFTWARE NOTICES AND INFORMATION",
    "",
    "Generated file. Do not edit by hand.",
    "  regenerate:  node scripts/generate-third-party-notices.mjs",
    "  verify:      pnpm run check:notices",
    "",
    "Scope: the macOS arm64 Volli Code application bundle (app id app.volli.desktop).",
    `It covers ${totalPackages} third-party packages: the production dependency closure`,
    "of the desktop app and of the bundled `volli` CLI, the native platform packages",
    "electron-builder ships as binaries, the build-time sources whose output is part of",
    "the bundle, and the vendored material recorded in apps/desktop/notices/sources.json.",
    "",
    "The package list is a deliberate superset of the bytes in the bundle: a dependency",
    "may be tree-shaken out of a chunk, but nothing that ships is missing from the list.",
    "Licence texts are reproduced from the packages as installed, with CRLF folded to LF",
    "and trailing whitespace trimmed; nothing else is rewritten.",
    "",
    "This document reports what each package declares and publishes. It draws no legal",
    "conclusion about any of it — see the final section for declarations that need one.",
    "",
  );

  section("1. VOLLI CODE'S OWN LICENCE");
  out.push(
    `Volli Code is distributed under the ${model.projectLicenseName} licence. The complete text is`,
    `at ${model.projectLicenseFile} in the repository and ships inside the application bundle at:`,
    "",
    ...model.shippedResources.map((resource) => `  Contents/Resources/${resource.to}`),
    "",
    model.ownershipNote,
    "",
    "The workspace packages below are part of Volli Code itself and carry that licence;",
    "they are listed so the index accounts for every module in the bundle.",
    "",
    ...model.firstParty.map((name) => `  ${name}`),
    "",
  );

  section(`2. PACKAGE INDEX (${totalPackages} packages)`);
  out.push(
    "  <package>@<version>  <licence declared by the package>  [how it reaches the .app]",
    "",
    ...[
      ...model.entries.map((entry) => ({
        name: entry.name,
        version: entry.version,
        spdx: entry.spdx,
        how: entry.shippedAs,
      })),
      ...model.platformNative.map((entry) => ({
        name: entry.name,
        version: entry.version,
        spdx: entry.spdx,
        how: "native binary, unpacked",
      })),
      ...model.toolchain.map((entry) => ({
        name: entry.name,
        version: entry.version,
        spdx: entry.spdx,
        how: "build-time source",
      })),
    ]
      .toSorted(comparePackages)
      .map(
        (entry) =>
          `  ${entry.name}@${entry.version}  ${entry.spdx ?? "(undeclared)"}  [${entry.how}]`,
      ),
    "",
  );

  const withText = model.entries.filter((entry) => entry.files.length > 0);
  const withoutText = model.entries.filter((entry) => entry.files.length === 0);
  const blocks = groupLicenseBlocks(withText);

  section(`3. PACKAGE LICENCES (${blocks.length} distinct licence texts)`);
  out.push(
    "Packages carrying byte-identical terms share one block; the package line names",
    "every one of them. A block reproduces each licence file the package publishes.",
    "",
  );
  for (const block of blocks) {
    out.push(
      RULE,
      `Packages: ${block.packages.map((pkg) => `${pkg.name}@${pkg.version}`).join(", ")}`,
      `SPDX: ${block.spdx ?? "(undeclared)"}`,
      ...block.files.map((file) => `File: ${file.file}`),
      THIN_RULE,
      ...block.files.map((file) => file.text),
      "",
    );
  }

  section(`4. PACKAGES THAT PUBLISH NO LICENCE FILE (${withoutText.length})`);
  out.push(
    "These packages declare a licence in their manifest but ship no licence file in the",
    "published tarball. The declaration and the upstream source are recorded verbatim;",
    "no licence text is substituted for them here.",
    "",
    ...withoutText.flatMap((entry) => [
      `  ${entry.name}@${entry.version}`,
      `    declared: ${entry.spdx ?? "(nothing)"}`,
      `    source:   ${entry.repository ?? "(not recorded in its manifest)"}`,
    ]),
    "",
  );

  section(`5. NATIVE PLATFORM PACKAGES (${model.platformNative.length})`);
  out.push(
    "Binaries electron-builder ships and unpacks beside the asar. They install only on",
    "the target platform, so their notices are pinned in apps/desktop/notices/sources.json",
    "and verified against the installed package whenever this runs on that platform.",
    "",
  );
  for (const native of model.platformNative) {
    out.push(
      RULE,
      `Package: ${native.name}@${native.version}`,
      `SPDX: ${native.spdx ?? "(undeclared)"}`,
      ...noteLines(native.note),
      THIN_RULE,
      native.text,
      "",
    );
  }

  section(`6. BUILD-TIME SOURCES WHOSE OUTPUT SHIPS (${model.toolchain.length})`);
  out.push(
    "Development dependencies are not part of the bundle, with these exceptions: their",
    "own code or generated output is part of what the build emits into the application.",
    "",
  );
  for (const tool of model.toolchain) {
    out.push(
      RULE,
      `Package: ${tool.name}@${tool.version}`,
      `SPDX: ${tool.spdx ?? "(undeclared)"}`,
      ...noteLines(tool.note),
      THIN_RULE,
      ...(tool.files.length > 0
        ? tool.files.map((file) => file.text)
        : ["(the package publishes no licence file)"]),
      "",
    );
  }

  section(`7. VENDORED SOURCES (${model.vendored.length})`);
  out.push(
    "Third-party source copied into this repository rather than installed. Each entry",
    "records where it came from and what evidence in the repository establishes that.",
    "",
  );
  for (const vendored of model.vendored) {
    out.push(
      RULE,
      `Source: ${vendored.title}`,
      `Paths: ${vendored.paths.join(", ")}`,
      ...(vendored.owner === null ? [] : [`Declared by: ${vendored.owner}`]),
      `Upstream: ${vendored.upstream ?? "(not recorded)"}`,
      `SPDX: ${vendored.spdx ?? "(unresolved)"}`,
      "Evidence:",
      ...wrapText(vendored.evidence, "  "),
      THIN_RULE,
      ...(vendored.unresolved === null
        ? [vendored.text ?? "(no licence text recorded)"]
        : [
            "PROVENANCE UNRESOLVED — no licence text is reproduced for this entry, and no",
            "licence is asserted for it. What is known and what is missing:",
            "",
            ...wrapText(vendored.unresolved, "  "),
          ]),
      "",
    );
  }

  section(`8. MODIFIED PACKAGES (${model.patched.length})`);
  out.push(
    "These packages are modified before they are bundled, by the pnpm patches recorded",
    "in pnpm-workspace.yaml. The patch files are in the repository and state the change.",
    "",
    ...model.patched.map((patch) => `  ${patch.name}@${patch.version} — ${patch.patch}`),
    "",
  );

  section(`9. ADDITIONAL NOTICES (${model.fragments.length})`);
  out.push(
    "Notices for material no package manifest describes: data bundled inside a package,",
    "and the attribution files workspace packages keep beside their own vendored",
    "material. Each is reproduced verbatim from the file named under it. A package that",
    "declares such a notice cannot ship the material without it — the notice check fails",
    "when the covered files are present and the notice file is not.",
    "",
  );
  for (const fragment of model.fragments) {
    out.push(
      RULE,
      `Notice: ${fragment.title}`,
      "Source:",
      ...wrapText(fragment.source, "  "),
      THIN_RULE,
      fragment.text,
      "",
    );
  }

  const review = licensesNeedingReview([
    ...model.entries,
    ...model.platformNative.map((native) => ({ ...native, files: [] })),
    ...model.toolchain,
  ]).toSorted(comparePackages);
  section(`10. DECLARATIONS FLAGGED FOR REVIEW (${review.length})`);
  out.push(
    "Declarations above that are not a plain permissive grant, listed so a reviewer can",
    "find them without reading the whole file. Their presence here is a fact about the",
    "manifest, not a conclusion about obligations — that review is tracked separately,",
    "and apps/desktop/notices/README.md records what is open.",
    "",
    ...(review.length === 0
      ? ["  (none)"]
      : review.map((entry) => `  ${entry.name}@${entry.version} — ${entry.spdx}`)),
    "",
  );

  return out.join("\n").replace(/\n+$/, "\n");
}

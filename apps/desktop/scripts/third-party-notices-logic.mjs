/**
 * The pure half of the desktop licence-notice pipeline: dependency-closure
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
 * WHAT COUNTS AS SHIPPED is decided in {@link collectPackageClosure}: the
 * production dependency closure (dependencies + optionalDependencies,
 * transitively) of the two roots whose code reaches the .app — the desktop app
 * itself and @volli/cli, whose bundle copy-cli.mjs drops into dist-electron.
 * It is a deliberate SUPERSET of the bytes in the artifact: a package in the
 * closure may end up tree-shaken out of a renderer chunk, but nothing that
 * ships can be missing from it. Over-listing a notice is harmless; under-
 * listing it is the compliance failure this exists to prevent.
 *
 * PLATFORM PACKAGES ARE EXCLUDED from that walk (`os`/`cpu` in their manifest)
 * and come from the checked-in registry instead. They are the one input that
 * is not the same on two machines — Linux CI installs @esbuild/linux-x64 where
 * this mac installs @esbuild/darwin-arm64, and the three darwin-arm64 native
 * packages the app actually ships do not install on Linux at all. A generated
 * file that differed by host could not be checked in, so the registry pins the
 * ones that ship (with their licence text) and the walk skips the rest.
 */

/** Packages whose licence declaration is not a plain permissive grant. */
const REVIEW_LICENSE_PATTERN = /\b(?:[AL]?GPL|MPL|EPL|CDDL|CPL|SSPL|OSL|CC-BY-SA|Ms-PL)\b/i;

/** Root-level files a package may publish its licence terms in. */
const LICENSE_FILE_PATTERN = /^(licen[cs]e|copying)([-._][^/]*)?$/i;
/** Root-level NOTICE files (Apache-2.0 §4(d) content travels with the licence). */
const NOTICE_FILE_PATTERN = /^notice([-._][^/]*)?$/i;

/** @param {string} name */
export function isLicenseFileName(name) {
  return LICENSE_FILE_PATTERN.test(name.replace(/\.(md|txt|rst)$/i, ""));
}

/** @param {string} name */
export function isNoticeFileName(name) {
  return NOTICE_FILE_PATTERN.test(name.replace(/\.(md|txt|rst)$/i, ""));
}

/**
 * Normalise licence text for reproducible output: strip a BOM, fold CRLF, drop
 * trailing whitespace at end of file. The body is otherwise untouched —
 * reproducing a licence means reproducing it, not reflowing it.
 * @param {string} text
 */
export function normalizeLicenseText(text) {
  return text
    .replace(/^\uFEFF/, "")
    .replaceAll("\r\n", "\n")
    .replace(/\s+$/, "");
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
  /** @type {Set<string>} */
  const platformSpecific = new Set();
  /** @type {Set<string>} */
  const notInstalled = new Set();

  const queue = roots.map((root) => ({ ...root, manifest: readManifest(root.dir) }));
  const visited = new Set();

  while (queue.length > 0) {
    const current = queue.shift();
    if (current.manifest === null) {
      throw new Error(`third-party-notices: no package.json at ${current.dir}`);
    }
    const dependencies = {
      .../** @type {any} */ (current.manifest).dependencies,
      .../** @type {any} */ (current.manifest).optionalDependencies,
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
      if (/** @type {any} */ (manifest).os || /** @type {any} */ (manifest).cpu) {
        platformSpecific.add(key);
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
    platformSpecific: [...platformSpecific].toSorted(),
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
 * Return one failure for every vendored registry path that is absent.
 *
 * The registry is reviewed input, but a typo there would otherwise leave the
 * document claiming to cover source that the bundle does not contain. Keep the
 * filesystem lookup injected so the self-test can exercise the rule without
 * touching this checkout.
 *
 * @param {{ title: string, paths: unknown }[]} entries
 * @param {(path: string) => boolean} pathExists
 * @returns {string[]}
 */
export function vendoredPathFailures(entries, pathExists) {
  const failures = [];
  for (const entry of entries) {
    if (!Array.isArray(entry.paths) || entry.paths.length === 0) {
      failures.push(`vendored source "${entry.title}" has no paths recorded.`);
      continue;
    }
    for (const path of entry.paths) {
      if (typeof path !== "string" || path.trim() === "") {
        failures.push(`vendored source "${entry.title}" has an invalid path.`);
      } else if (!pathExists(path)) {
        failures.push(`vendored source "${entry.title}" names a missing path: ${path}`);
      }
    }
  }
  return [...new Set(failures)];
}

/**
 * What to do with a notice this repository expects to exist but does not own:
 * today, the shared terminal theme catalog's iTerm2-Color-Schemes attribution,
 * which is being written on another ticket's branch (VC-407 coordination).
 *
 * The rule has to hold in three states and cannot wait for any of them:
 *   - the file is here → fold it into the shipped document, whatever else is true;
 *   - the file is absent and nothing in the shipped source refers to the material
 *     → the catalog has not landed yet, so the document says pending and the
 *     check stays green;
 *   - the file is absent while shipped source DOES refer to the material → the
 *     catalog landed without its attribution, and the packaged app would ship
 *     the themes with nothing covering them. That is the failure.
 *
 * `markerFound` is the caller's answer to "does shipped source mention this?",
 * kept out of here so the search stays testable and this stays a decision.
 *
 * @param {{ title: string, path: string, present: boolean, markerFound: boolean, marker: string }} fragment
 * @returns {{ include: boolean, failure: string | null }}
 */
export function pendingFragmentDecision({ title, path, present, markerFound, marker }) {
  if (present) return { include: true, failure: null };
  if (!markerFound) return { include: false, failure: null };
  return {
    include: false,
    failure:
      `shipped source refers to "${marker}" (${title}) but ${path} is not in this tree — ` +
      `the packaged app would carry that material with no attribution. Land the notice ` +
      `file, or record an equivalent entry in apps/desktop/notices/sources.json, then ` +
      `regenerate.`,
  };
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
 *   vendored: { title: string, paths: string[], upstream: string | null, spdx: string | null, evidence: string, text: string | null, unresolved: string | null }[],
 *   patched: { name: string, version: string, patch: string }[],
 *   fragments: { title: string, source: string, text: string }[],
 *   pendingFragments: { title: string, path: string, marker: string, pending: string }[],
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
    "  regenerate:  node apps/desktop/scripts/generate-third-party-notices.mjs",
    "  verify:      pnpm -C apps/desktop run check:notices",
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

  section(`9. ADDITIONAL NOTICES (${model.fragments.length + model.pendingFragments.length})`);
  out.push(
    "Notices for material no package manifest describes: data bundled inside a package,",
    "and catalogs another workspace package carries with its own attribution file. A",
    "notice recorded here but not yet present in the tree is printed as pending rather",
    "than omitted — see apps/desktop/notices/sources.json.",
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
  for (const pending of model.pendingFragments) {
    out.push(
      RULE,
      `Notice: ${pending.title}`,
      `Source: ${pending.path}`,
      `Marker: ${pending.marker}`,
      "Status: PENDING — that file is not in this tree, so nothing is reproduced for it.",
      THIN_RULE,
      ...wrapText(pending.pending, "  "),
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

  return `${out.join("\n").replace(/\n{3,}$/, "\n")}\n`;
}

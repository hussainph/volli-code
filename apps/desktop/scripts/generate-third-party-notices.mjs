#!/usr/bin/env node
/**
 * Generates apps/desktop/THIRD-PARTY-NOTICES — the licence notice that ships
 * inside the macOS application bundle — from the resolved production
 * dependency set, and verifies that electron-builder still puts it there.
 *
 *     node apps/desktop/scripts/generate-third-party-notices.mjs             # write it
 *     node apps/desktop/scripts/generate-third-party-notices.mjs --check     # CI gate
 *     node apps/desktop/scripts/generate-third-party-notices.mjs --self-test # the rules' own tests
 *
 * WHY THIS EXISTS (VC-407). The file it replaces covered two Shiki themes and
 * the packages that load them, and electron-builder shipped neither it nor the
 * project's own LICENSE — so the distributed .app carried no notice for ~600
 * production packages, two OFL fonts, three native binaries and a vendored UI
 * layer. A prose list would have gone stale on the first dependency bump. This
 * derives the list instead, checks the derivation in CI, and fails when the
 * packaging config stops shipping what it produced.
 *
 * WHAT IT READS, all locally and with no network:
 *   - apps/desktop and packages/cli package.json, walked transitively through
 *     dependencies + optionalDependencies (see third-party-notices-logic.mjs
 *     for why that closure is the right superset),
 *   - each resolved package's own licence and NOTICE files,
 *   - apps/desktop/notices/sources.json: the reviewed registry of things the
 *     walk cannot see — platform-native packages that install on one OS only,
 *     build-time sources whose output ships, vendored source, and the editor
 *     theme fragment generate-editor-theme-notices.mjs produces,
 *   - pnpm-workspace.yaml's patchedDependencies, for the statement of
 *     modification that a patched dependency requires,
 *   - apps/desktop/electron-builder.yml, for what actually ships.
 *
 * WHAT IT NEVER DOES is decide a licence. A package that publishes no licence
 * file is reported as publishing none; vendored material whose provenance is
 * not recorded is reported as unresolved. Substituting a plausible text would
 * turn a gap a reviewer must close into one nobody can see.
 */

import assert from "node:assert/strict";
import {
  existsSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

import {
  collectPackageClosure,
  declaredLicense,
  groupLicenseBlocks,
  isLicenseFileName,
  isNameCovered,
  isNoticeFileName,
  keptNodeModulePackages,
  licensesNeedingReview,
  normalizeLicenseText,
  packagingFailures,
  pendingFragmentDecision,
  renderNoticeDocument,
  repositoryUrl,
  unpackedPackages,
  vendoredPathFailures,
  wrapText,
} from "./third-party-notices-logic.mjs";

const DESKTOP_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPO_ROOT = resolve(DESKTOP_DIR, "../..");
const NOTICES_DIR = resolve(DESKTOP_DIR, "notices");
const OUTPUT_PATH = resolve(DESKTOP_DIR, "THIRD-PARTY-NOTICES");
const BUILDER_CONFIG_PATH = resolve(DESKTOP_DIR, "electron-builder.yml");

/**
 * What the packaged .app must carry, and where. `from` is relative to
 * apps/desktop (electron-builder's project directory), `to` is relative to
 * Contents/Resources inside the bundle — the location a user reaches through
 * Finder's "Show Package Contents", which is where a desktop app's notices are
 * conventionally found.
 */
const REQUIRED_RESOURCES = [
  { from: "../../LICENSE", to: "LICENSE.txt" },
  { from: "THIRD-PARTY-NOTICES", to: "THIRD-PARTY-NOTICES.txt" },
];

/**
 * The root LICENSE keeps the Apache-2.0 appendix placeholder and no manifest
 * names a holder, so the document says so instead of inventing one. Naming a
 * copyright owner is the project's decision to record, not this script's to
 * guess — apps/desktop/notices/README.md carries it as an open item.
 */
const OWNERSHIP_NOTE = [
  "Copyright holder: not recorded in this repository. The root LICENSE carries the",
  'Apache-2.0 appendix placeholder ("[yyyy] [name of copyright owner]"), no package',
  "manifest names an author, and there is no NOTICE file. That is an ownership",
  "decision to record rather than a value to derive, so nothing is asserted here;",
  "apps/desktop/notices/README.md tracks it as open.",
].join("\n");

const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const repoRelative = (path) => relative(REPO_ROOT, path).split(sep).join("/");

/**
 * Node's own resolution, run from `fromDir`: walk up the directory chain
 * looking for `node_modules/<name>`, skipping directories that are themselves
 * node_modules. Answers are realpath'd, which is what makes this work under
 * pnpm — a dependency's own dependencies live beside its real directory in the
 * store, not beside the symlink that points at it.
 * @param {string} fromDir @param {string} name
 */
function resolveDependencyDir(fromDir, name) {
  let dir = fromDir;
  for (;;) {
    if (dir.split(sep).pop() !== "node_modules") {
      const candidate = resolve(dir, "node_modules", name);
      if (existsSync(join(candidate, "package.json"))) return realpathSync(candidate);
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** @param {string} dir */
function readManifest(dir) {
  const manifestPath = join(dir, "package.json");
  return existsSync(manifestPath) ? readJson(manifestPath) : null;
}

/**
 * Licence and NOTICE files a package publishes at its root, in name order.
 * Root only: a `licenses/` directory in the wild is as often the package's own
 * test fixtures as it is its terms, and a fixture reproduced as a licence is
 * worse than an honest "publishes no licence file".
 * @param {string} dir
 */
function licenseFilesIn(dir) {
  return readdirSync(dir)
    .filter((name) => isLicenseFileName(name) || isNoticeFileName(name))
    .filter((name) => statSync(join(dir, name)).isFile())
    .toSorted()
    .map((name) => ({
      file: name,
      kind: isNoticeFileName(name) ? "notice" : "license",
      text: normalizeLicenseText(readFileSync(join(dir, name), "utf8")),
    }))
    .filter((entry) => entry.text !== "");
}

/**
 * Registry notes are authored as arrays of lines so sources.json stays readable
 * at its own width; the document, not the registry, decides how they wrap.
 */
function noteOf(entry) {
  return Array.isArray(entry.note) ? entry.note.join(" ") : entry.note;
}

/** The registry of everything the dependency walk cannot see. */
function readSourcesRegistry() {
  const registry = readJson(join(NOTICES_DIR, "sources.json"));
  const readText = (relativePath) =>
    normalizeLicenseText(readFileSync(join(NOTICES_DIR, relativePath), "utf8"));

  const platformNative = registry.platformNative.map((entry) => {
    const text = readText(entry.text);
    // When the platform package IS installed (a mac running the real build),
    // the pinned copy must still match what shipped. Drift fails here rather
    // than travelling into a release as a stale notice.
    const installedDir = resolveDependencyDir(DESKTOP_DIR, entry.name);
    if (installedDir !== null) {
      const manifest = readManifest(installedDir);
      if (manifest.version !== entry.version) {
        throw new Error(
          `notices/sources.json pins ${entry.name}@${entry.version} but ${manifest.version} is installed — ` +
            `update the pin and its text under notices/texts/.`,
        );
      }
      const installedText = normalizeLicenseText(
        readFileSync(join(installedDir, entry.verify.file), "utf8"),
      );
      const matches =
        entry.verify.mode === "contains" ? installedText.includes(text) : installedText === text;
      if (!matches) {
        throw new Error(
          `notices/${entry.text} no longer matches ${entry.name}'s ${entry.verify.file} as installed — ` +
            `refresh the recorded text.`,
        );
      }
    }
    return { ...entry, note: noteOf(entry), text };
  });

  const toolchain = registry.toolchain.map((entry) => {
    const dir = resolveDependencyDir(DESKTOP_DIR, entry.name);
    if (dir === null) {
      throw new Error(
        `notices/sources.json lists build-time source ${entry.name}, which is not installed — ` +
          `run pnpm install, or drop the entry if the dependency is gone.`,
      );
    }
    const manifest = readManifest(dir);
    return {
      name: entry.name,
      version: String(manifest.version),
      spdx: declaredLicense(manifest),
      note: noteOf(entry),
      files: licenseFilesIn(dir),
    };
  });

  const vendored = registry.vendored.map((entry) => ({
    title: entry.title,
    paths: entry.paths,
    upstream: entry.upstream ?? null,
    spdx: entry.spdx ?? null,
    evidence: entry.evidence,
    text: entry.text === undefined ? null : readText(entry.text),
    unresolved: entry.unresolved ?? null,
  }));
  const pathFailures = vendoredPathFailures(vendored, (path) =>
    existsSync(resolve(REPO_ROOT, path)),
  );
  if (pathFailures.length > 0) {
    throw new Error(
      `notices/sources.json has vendored paths that are not present:\n${pathFailures
        .map((failure) => `  - ${failure}`)
        .join("\n")}`,
    );
  }

  const fragments = registry.fragments.map((entry) => ({
    title: entry.title,
    source: entry.source,
    text: normalizeLicenseText(readFileSync(join(NOTICES_DIR, entry.file), "utf8")),
  }));

  const pendingFragments = [];
  const pendingFailures = [];
  for (const entry of registry.expectedFragments ?? []) {
    const absolute = resolve(REPO_ROOT, entry.file);
    const present = existsSync(absolute);
    const decision = pendingFragmentDecision({
      title: entry.title,
      path: entry.file,
      marker: entry.marker,
      present,
      // Only asked when the file is missing: the search is the expensive half,
      // and its answer changes nothing once the notice itself is here.
      markerFound: present ? false : shippedSourceMentions(entry.marker, entry.scan),
    });
    if (decision.failure !== null) pendingFailures.push(decision.failure);
    if (decision.include) {
      fragments.push({
        title: entry.title,
        source: `${entry.file} — ${entry.source}`,
        text: normalizeLicenseText(readFileSync(absolute, "utf8")),
      });
    } else {
      pendingFragments.push({
        title: entry.title,
        path: entry.file,
        marker: entry.marker,
        pending: noteOf({ note: entry.pending }),
      });
    }
  }

  return { platformNative, toolchain, vendored, fragments, pendingFragments, pendingFailures };
}

/**
 * Does any shipped source file under `roots` mention `marker`?
 *
 * This is the evidence half of {@link pendingFragmentDecision}: a catalog that
 * landed without its attribution file announces itself in the source that
 * carries it. Only source trees that reach the bundle are searched, and build
 * output and dependencies are skipped — a match inside node_modules would say
 * nothing about what this repository ships.
 *
 * @param {string} marker @param {string[]} roots repo-relative directories
 */
function shippedSourceMentions(marker, roots) {
  const skip = new Set(["node_modules", "dist", "dist-electron", "release", ".git"]);
  const stack = roots.map((root) => resolve(REPO_ROOT, root)).filter((dir) => existsSync(dir));
  while (stack.length > 0) {
    const dir = stack.pop();
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (skip.has(entry.name)) continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(path);
        continue;
      }
      if (!entry.isFile()) continue;
      if (readFileSync(path, "utf8").includes(marker)) return true;
    }
  }
  return false;
}

/**
 * Patched dependencies, read from the workspace manifest so the statement of
 * modification cannot drift from the patches actually applied.
 */
function readPatchedDependencies() {
  const workspace = parseYaml(readFileSync(join(REPO_ROOT, "pnpm-workspace.yaml"), "utf8"));
  const patched = workspace.patchedDependencies ?? {};
  return Object.entries(patched)
    .map(([specifier, patchFile]) => {
      const at = specifier.lastIndexOf("@");
      return {
        name: specifier.slice(0, at),
        version: specifier.slice(at + 1),
        patch: String(patchFile),
      };
    })
    .toSorted((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

function buildModel() {
  const builderConfig = parseYaml(readFileSync(BUILDER_CONFIG_PATH, "utf8"));
  const keptNames = new Set(keptNodeModulePackages(builderConfig));

  const closure = collectPackageClosure({
    roots: [
      { name: "@volli/desktop", dir: DESKTOP_DIR },
      // The CLI is not a dependency of the desktop app: copy-cli.mjs drops its
      // bundle into dist-electron, so its production closure ships too.
      { name: "@volli/cli", dir: resolve(REPO_ROOT, "packages/cli") },
    ],
    readManifest,
    resolveDependency: resolveDependencyDir,
  });

  const skippedPlatformPackages = closure.platformSpecific;
  const entries = closure.thirdParty.map((pkg) => ({
    name: pkg.name,
    version: pkg.version,
    spdx: declaredLicense(pkg.manifest),
    repository: repositoryUrl(pkg.manifest),
    // The whitelist is the set electron-builder keeps in the shipped
    // node_modules tree; everything else reaches the .app inside a chunk.
    shippedAs: isNameCovered(pkg.name, keptNames) ? "node_modules tree" : "bundled into a chunk",
    files: licenseFilesIn(pkg.dir),
  }));

  const registry = readSourcesRegistry();
  return {
    projectLicenseName: "Apache-2.0",
    projectLicenseFile: "LICENSE",
    ownershipNote: OWNERSHIP_NOTE,
    shippedResources: REQUIRED_RESOURCES,
    // Names without versions: these are this repository's own modules, and
    // pinning the app's release version here would churn the notice on every
    // canary bump without telling a reader anything about licensing.
    firstParty: [
      ...closure.firstParty.map((pkg) => pkg.name),
      "@volli/cli",
      "@volli/desktop",
    ].toSorted(),
    entries,
    patched: readPatchedDependencies(),
    ...registry,
    builderConfig,
    skippedPlatformPackages,
  };
}

/** Every package name the rendered document accounts for. */
function coveredNamesOf(model) {
  return new Set([
    ...model.entries.map((entry) => entry.name),
    ...model.platformNative.map((entry) => entry.name),
    ...model.toolchain.map((entry) => entry.name),
    ...model.firstParty,
  ]);
}

function generate() {
  const model = buildModel();
  const document = renderNoticeDocument(model);
  const failures = [
    ...packagingFailures({
      builderConfig: model.builderConfig,
      coveredNames: coveredNamesOf(model),
      requiredResources: REQUIRED_RESOURCES,
      resourceExists: (from) => existsSync(resolve(DESKTOP_DIR, from)),
    }),
    // A notice this repository expects but does not own — the shared theme
    // catalog's attribution — whose material has landed without it.
    ...model.pendingFailures,
  ];
  return { model, document, failures };
}

/** `  name@version  SPDX  [how it ships]` — the document's own package index. */
const INDEX_LINE = /^ {2}\S+@\S+ {2}.+ {2}\[.+\]$/;

/**
 * Name what moved, not just that something did. A bare "out of date" in CI
 * sends someone to a 700 kB diff; the packages that entered or left the shipped
 * set are the whole answer most of the time — and when neither list explains it,
 * the difference is in a licence text or in the reviewed registry, which is
 * what the closing line says.
 */
function reportIndexLines(label, lines) {
  if (lines.length === 0) return;
  console.error(`\n${label} (${lines.length}):`);
  for (const line of lines.slice(0, 20)) console.error(` ${line.trim()}`);
  if (lines.length > 20) console.error(`  … and ${lines.length - 20} more`);
}

function reportIndexDrift(current, generated) {
  const indexOf = (document) =>
    new Set(document.split("\n").filter((line) => INDEX_LINE.test(line)));
  const before = indexOf(current);
  const after = indexOf(generated);
  const added = [...after].filter((line) => !before.has(line));
  const removed = [...before].filter((line) => !after.has(line));
  reportIndexLines("In the shipped set but not in the committed notice", added);
  reportIndexLines("In the committed notice but no longer shipped", removed);
  if (added.length === 0 && removed.length === 0) {
    console.error(
      "\nThe package index is identical, so the change is in a licence text, in\n" +
        "apps/desktop/notices/, or in the document's own prose.",
    );
  }
}

function reportPackagingFailures(failures) {
  console.error("Packaging coverage check failed:");
  for (const failure of failures) console.error(`  - ${failure}`);
  console.error(
    "\nFix apps/desktop/electron-builder.yml (or notices/sources.json) so every shipped\n" +
      "package is covered and the notices reach Contents/Resources.",
  );
}

function main({ check }) {
  const { model, document, failures } = generate();
  if (failures.length > 0) {
    reportPackagingFailures(failures);
    process.exit(1);
  }
  const packageCount = model.entries.length + model.platformNative.length + model.toolchain.length;

  if (check) {
    const current = existsSync(OUTPUT_PATH) ? readFileSync(OUTPUT_PATH, "utf8") : null;
    if (current === document) {
      console.log(
        `${repoRelative(OUTPUT_PATH)} is current (${packageCount} packages, ` +
          `${model.vendored.length} vendored sources) and electron-builder ships it.`,
      );
      return;
    }
    console.error(
      current === null
        ? `${repoRelative(OUTPUT_PATH)} is missing.`
        : `${repoRelative(OUTPUT_PATH)} is out of date with the installed production dependency set.`,
    );
    if (current !== null) reportIndexDrift(current, document);
    console.error(
      "\nRegenerate it and commit the result:\n" +
        "  node apps/desktop/scripts/generate-third-party-notices.mjs\n",
    );
    process.exit(1);
  }

  writeFileSync(OUTPUT_PATH, document);
  console.log(
    `Wrote ${repoRelative(OUTPUT_PATH)}: ${packageCount} packages ` +
      `(${model.entries.length} resolved, ${model.platformNative.length} native, ` +
      `${model.toolchain.length} build-time), ${model.firstParty.length} first-party modules, ` +
      `${model.vendored.length} vendored sources, ${model.patched.length} patched packages.`,
  );
  // Named rather than silent: these are this host's platform variants, left out
  // so the document renders the same on macOS and on Linux CI. The ones that
  // actually ship are the pinned entries in notices/sources.json.
  console.log(
    `Skipped ${model.skippedPlatformPackages.length} platform-specific package(s) ` +
      `installed here: ${model.skippedPlatformPackages.join(", ")}`,
  );
}

/* ------------------------------------------------------------------------- *
 * Self-test: the rules, against fixtures. Runs in CI ahead of the real check
 * so a rule that stopped working fails by name here, instead of quietly
 * passing a notice that covers nothing.
 * ------------------------------------------------------------------------- */

function fakeTree(tree) {
  return {
    readManifest: (dir) => tree[dir] ?? null,
    resolveDependency: (fromDir, name) => {
      const direct = `${fromDir}/node_modules/${name}`;
      if (tree[direct] !== undefined) return direct;
      const shared = `/store/${name}`;
      return tree[shared] === undefined ? null : shared;
    },
  };
}

function selfTestClosure() {
  const tree = {
    "/app": { name: "app", dependencies: { alpha: "1" }, optionalDependencies: { native: "1" } },
    "/store/alpha": { name: "alpha", version: "1.0.0", dependencies: { beta: "1" } },
    "/store/beta": { name: "beta", version: "2.0.0", dependencies: { alpha: "1" } },
    "/store/native": { name: "native", version: "3.0.0", os: ["darwin"], cpu: ["arm64"] },
    "/cli": { name: "cli", dependencies: { "@volli/shared": "workspace:*", gone: "1" } },
    "/cli/node_modules/@volli/shared": { name: "@volli/shared", version: "0.0.1" },
  };
  const closure = collectPackageClosure({
    roots: [
      { name: "app", dir: "/app" },
      { name: "cli", dir: "/cli" },
    ],
    ...fakeTree(tree),
  });
  assert.deepEqual(
    closure.thirdParty.map((pkg) => `${pkg.name}@${pkg.version}`),
    ["alpha@1.0.0", "beta@2.0.0"],
    "closure follows transitive dependencies and terminates on a cycle",
  );
  assert.deepEqual(
    closure.firstParty.map((pkg) => pkg.name),
    ["@volli/shared"],
  );
  assert.deepEqual(closure.platformSpecific, ["native@3.0.0"], "os/cpu packages leave the walk");
  assert.deepEqual(
    closure.notInstalled,
    ["gone"],
    "an uninstalled optional is recorded, not fatal",
  );
}

function selfTestDeclarations() {
  assert.equal(declaredLicense({ license: "MIT" }), "MIT");
  assert.equal(declaredLicense({ license: { type: "ISC", url: "x" } }), "ISC");
  assert.equal(
    declaredLicense({ licenses: [{ type: "MIT" }, { type: "Apache-2.0" }] }),
    "(MIT OR Apache-2.0)",
  );
  assert.equal(declaredLicense({}), null, "an undeclared licence stays undeclared");
  assert.equal(declaredLicense({ license: "  " }), null);
  assert.equal(repositoryUrl({ repository: { url: "git+https://x/y.git" } }), "https://x/y");
  assert.equal(repositoryUrl({ homepage: "https://x/y" }), "https://x/y");
  assert.equal(repositoryUrl({}), null);
  assert.equal(normalizeLicenseText("\uFEFFa\r\nb\n\n  "), "a\nb");
  assert.ok(isLicenseFileName("LICENSE") && isLicenseFileName("license.md"));
  assert.ok(isLicenseFileName("LICENSE-MPL") && isLicenseFileName("COPYING.txt"));
  assert.ok(!isLicenseFileName("licensed-code.js") && !isLicenseFileName("index.js"));
  assert.ok(isNoticeFileName("NOTICE") && isNoticeFileName("NOTICE.md"));
  assert.ok(!isNoticeFileName("notices.js"));
  assert.deepEqual(wrapText("one two three four", "", 9), ["one two", "three", "four"]);
  assert.deepEqual(wrapText("one two", "  ", 9), ["  one two"]);
  assert.deepEqual(wrapText("a\n\nb", "", 9), ["a", "", "b"], "paragraph breaks survive");
  assert.deepEqual(
    wrapText("averylongword tail", "", 5),
    ["averylongword", "tail"],
    "a word longer than the column budget is never broken",
  );
}

function selfTestGrouping() {
  const mit = [{ file: "LICENSE", kind: "license", text: "MIT text" }];
  const blocks = groupLicenseBlocks([
    { name: "zeta", version: "1.0.0", spdx: "MIT", files: mit },
    { name: "alpha", version: "1.0.0", spdx: "MIT", files: mit },
    { name: "beta", version: "1.0.0", spdx: "ISC", files: mit },
    { name: "gamma", version: "1.0.0", spdx: "MIT", files: [] },
  ]);
  assert.equal(blocks.length, 2, "identical text under one SPDX id collapses into one block");
  assert.deepEqual(
    blocks[0].packages.map((pkg) => pkg.name),
    ["alpha", "zeta"],
  );
  assert.equal(blocks[1].spdx, "ISC", "a different declaration keeps its own block");
  assert.deepEqual(
    licensesNeedingReview([
      { name: "a", version: "1", spdx: "MIT" },
      { name: "b", version: "1", spdx: "LGPL-3.0-or-later" },
      { name: "c", version: "1", spdx: "(MPL-2.0 OR Apache-2.0)" },
      { name: "d", version: "1", spdx: null },
    ]).map((entry) => entry.name),
    ["b", "c"],
    "copyleft-ish declarations are flagged; permissive ones are not",
  );
}

function selfTestPackagingRules() {
  const builderConfig = {
    files: ["dist/**", "!node_modules/!(better-sqlite3|@img|node-pty)/**"],
    asarUnpack: ["**/node_modules/@vscode/**"],
    extraResources: [
      { from: "../../LICENSE", to: "LICENSE.txt" },
      { from: "THIRD-PARTY-NOTICES", to: "THIRD-PARTY-NOTICES.txt" },
    ],
  };
  assert.deepEqual(keptNodeModulePackages(builderConfig), ["@img", "better-sqlite3", "node-pty"]);
  assert.deepEqual(unpackedPackages(builderConfig), ["@vscode"]);
  assert.throws(() => keptNodeModulePackages({ files: ["dist/**"] }), /whitelist entry/);
  assert.ok(
    isNameCovered("@img", new Set(["@img/sharp-darwin-arm64"])),
    "a scope is covered by a member",
  );
  assert.ok(!isNameCovered("@img", new Set(["@imgx/other"])));

  const covered = new Set([
    "better-sqlite3",
    "node-pty",
    "@img/sharp-darwin-arm64",
    "@vscode/ripgrep",
  ]);
  const ok = packagingFailures({
    builderConfig,
    coveredNames: covered,
    requiredResources: REQUIRED_RESOURCES,
    resourceExists: () => true,
  });
  assert.deepEqual(ok, [], "a config that ships both files and covers every package passes");

  assert.deepEqual(
    vendoredPathFailures(
      [
        { title: "present", paths: ["one", "two"] },
        { title: "missing", paths: ["gone"] },
      ],
      (path) => path !== "gone",
    ),
    ['vendored source "missing" names a missing path: gone'],
    "a vendored path that disappears fails the notice check",
  );
  assert.deepEqual(
    vendoredPathFailures([{ title: "malformed", paths: [] }], () => true),
    ['vendored source "malformed" has no paths recorded.'],
    "a vendored entry without paths fails the notice check",
  );

  const missingResource = packagingFailures({
    builderConfig: { ...builderConfig, extraResources: [] },
    coveredNames: covered,
    requiredResources: REQUIRED_RESOURCES,
    resourceExists: () => true,
  });
  assert.equal(missingResource.length, 2, "dropping extraResources fails for both files");
  assert.ok(missingResource.every((failure) => failure.includes("extraResources")));

  const wrongDestination = packagingFailures({
    builderConfig: {
      ...builderConfig,
      extraResources: [
        { from: "../../LICENSE", to: "LICENSE.txt" },
        { from: "THIRD-PARTY-NOTICES", to: "somewhere-else.txt" },
      ],
    },
    coveredNames: covered,
    requiredResources: REQUIRED_RESOURCES,
    resourceExists: () => true,
  });
  assert.equal(wrongDestination.length, 1, "shipping the notice to another path is a failure");

  const absentFile = packagingFailures({
    builderConfig,
    coveredNames: covered,
    requiredResources: REQUIRED_RESOURCES,
    resourceExists: (from) => from !== "THIRD-PARTY-NOTICES",
  });
  assert.equal(absentFile.length, 1, "extraResources pointing at a missing file is a failure");

  const uncovered = packagingFailures({
    builderConfig,
    coveredNames: new Set(["better-sqlite3", "@img/sharp-darwin-arm64", "@vscode/ripgrep"]),
    requiredResources: REQUIRED_RESOURCES,
    resourceExists: () => true,
  });
  assert.deepEqual(
    uncovered,
    ["node-pty ships in the packaged app (electron-builder.yml) but no licence notice covers it."],
    "a shipped package with no notice is named",
  );
}

function renderFixtureModel() {
  return {
    projectLicenseName: "Apache-2.0",
    projectLicenseFile: "LICENSE",
    ownershipNote: "ownership note",
    shippedResources: REQUIRED_RESOURCES,
    firstParty: ["@volli/shared"],
    entries: [
      {
        name: "alpha",
        version: "1.0.0",
        spdx: "MIT",
        shippedAs: "bundled into a chunk",
        repository: "https://example.invalid/alpha",
        files: [{ file: "LICENSE", kind: "license", text: "ALPHA LICENCE TEXT" }],
      },
      {
        name: "beta",
        version: "2.0.0",
        spdx: "ISC",
        shippedAs: "node_modules tree",
        repository: null,
        files: [],
      },
    ],
    platformNative: [
      {
        name: "native",
        version: "3.0.0",
        spdx: "LGPL-3.0-or-later",
        note: "n",
        text: "NATIVE TEXT",
      },
    ],
    toolchain: [
      {
        name: "tool",
        version: "4.0.0",
        spdx: "MIT",
        note: "t",
        files: [{ file: "LICENSE", kind: "license", text: "TOOL TEXT" }],
      },
    ],
    vendored: [
      {
        title: "Known",
        paths: ["a/b"],
        upstream: "https://example.invalid/known",
        spdx: "MIT",
        evidence: "e",
        text: "VENDORED TEXT",
        unresolved: null,
      },
      {
        title: "Unknown",
        paths: ["c/d"],
        upstream: null,
        spdx: null,
        evidence: "e",
        text: null,
        unresolved: "what is missing",
      },
    ],
    patched: [{ name: "alpha", version: "1.0.0", patch: "patches/alpha.patch" }],
    fragments: [{ title: "Editor theme data", source: "s", text: "FRAGMENT TEXT" }],
    pendingFragments: [
      {
        title: "Catalog notice",
        path: "packages/shared/NOTICE.md",
        marker: "Upstream-Catalog",
        pending: "why it is pending",
      },
    ],
  };
}

function selfTestRendering() {
  const document = renderNoticeDocument(renderFixtureModel());
  for (const expected of [
    "ALPHA LICENCE TEXT",
    "NATIVE TEXT",
    "TOOL TEXT",
    "VENDORED TEXT",
    "FRAGMENT TEXT",
    "alpha@1.0.0  MIT  [bundled into a chunk]",
    "beta@2.0.0  ISC  [node_modules tree]",
    "Contents/Resources/THIRD-PARTY-NOTICES.txt",
    "PROVENANCE UNRESOLVED",
    "native@3.0.0 — LGPL-3.0-or-later",
    "patches/alpha.patch",
    "9. ADDITIONAL NOTICES (2)",
    "Marker: Upstream-Catalog",
    "Status: PENDING",
    "why it is pending",
  ]) {
    assert.ok(document.includes(expected), `rendered document is missing: ${expected}`);
  }
  assert.ok(
    document.includes("4. PACKAGES THAT PUBLISH NO LICENCE FILE (1)") &&
      document.includes("declared: ISC"),
    "a package with no licence file is reported as such, with its declaration",
  );
  assert.ok(!document.includes("\n\n\n\n"), "no runaway blank space — the output must be stable");
  assert.equal(
    document,
    renderNoticeDocument(renderFixtureModel()),
    "rendering is a pure function of the model",
  );
}

function selfTestExpectedFragments() {
  const fragment = {
    title: "Shared theme catalog",
    path: "packages/shared/THIRD-PARTY-THEMES.md",
    marker: "iTerm2-Color-Schemes",
  };
  assert.deepEqual(
    pendingFragmentDecision({ ...fragment, present: true, markerFound: true }),
    { include: true, failure: null },
    "a notice that is here is folded in",
  );
  assert.deepEqual(
    pendingFragmentDecision({ ...fragment, present: true, markerFound: false }),
    { include: true, failure: null },
    "a notice that is here is folded in even before its material ships",
  );
  assert.deepEqual(
    pendingFragmentDecision({ ...fragment, present: false, markerFound: false }),
    { include: false, failure: null },
    "neither the material nor its notice: pending, and the check stays green",
  );
  const landedWithout = pendingFragmentDecision({
    ...fragment,
    present: false,
    markerFound: true,
  });
  assert.equal(landedWithout.include, false);
  assert.match(
    landedWithout.failure,
    /iTerm2-Color-Schemes.*THIRD-PARTY-THEMES\.md/s,
    "material shipping without its notice fails, naming both the marker and the file",
  );
}

function selfTest() {
  selfTestClosure();
  selfTestDeclarations();
  selfTestGrouping();
  selfTestPackagingRules();
  selfTestExpectedFragments();
  selfTestRendering();
  console.log("generate-third-party-notices self-test passed");
}

if (process.argv.includes("--self-test")) selfTest();
else main({ check: process.argv.includes("--check") });

#!/usr/bin/env node
/**
 * Generates apps/desktop/THIRD-PARTY-NOTICES — the licence notice that ships
 * inside the macOS application bundle — from the resolved production
 * dependency set, and verifies that electron-builder still puts it there.
 *
 *     node scripts/generate-third-party-notices.mjs             # write it
 *     node scripts/generate-third-party-notices.mjs --check     # CI gate
 *     node scripts/generate-third-party-notices.mjs --self-test # the rules' own tests
 *
 * WHY THIS EXISTS (VC-407). The file it replaces covered two Shiki themes and
 * the packages that load them, and electron-builder shipped neither it nor the
 * project's own LICENSE — so the distributed .app carried no notice for ~600
 * production packages, two OFL fonts, three native binaries and a vendored UI
 * layer. A prose list would have gone stale on the first dependency bump. This
 * derives the list instead, checks the derivation in CI, and fails when the
 * packaging config stops shipping what it produced.
 *
 * WHY IT IS A ROOT SCRIPT and not `apps/desktop/scripts/` (VC-407 review). It
 * reads pnpm-workspace.yaml, walks @volli/cli, and collects notices that
 * @volli/shared and @volli/agent-runtime declare about their own material — a
 * workspace-wide job that happened to have one consumer. `ARTIFACTS` below is
 * the whole of what is desktop-specific; a second client or a standalone
 * server adds an entry there rather than a second copy of this file.
 * `scripts/check-workspace-licenses.mjs` (VC-411) set this seam.
 *
 * WHAT IT READS, all locally and with no network:
 *   - the artifact's roots (apps/desktop, packages/cli) walked transitively
 *     through dependencies + optionalDependencies + peerDependencies (see
 *     third-party-notices-logic.mjs for why that closure is the right
 *     superset),
 *   - each resolved package's own licence and NOTICE files,
 *   - `volli.notices` in each first-party package the walk reaches: the
 *     notices a package keeps beside its OWN vendored material,
 *   - apps/desktop/notices/sources.json: the reviewed registry of what the
 *     walk cannot see — platform-native packages that install on one OS only,
 *     build-time sources whose output ships, and the material this app itself
 *     vendored,
 *   - the root LICENSE, for the project's own grant and its copyright line,
 *   - pnpm-workspace.yaml's patchedDependencies, for the statement of
 *     modification that a patched dependency requires,
 *   - apps/desktop/electron-builder.yml, for what actually ships.
 *
 * WHAT IT NEVER DOES is decide a licence, or name an owner. A package that
 * publishes no licence file is reported as publishing none; vendored material
 * whose provenance is not recorded is reported as unresolved; the copyright
 * holder is read from LICENSE or reported absent. Substituting a plausible
 * value would turn a gap a reviewer must close into one nobody can see.
 */

import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

import {
  collectPackageClosure,
  copyrightHolder,
  declaredLicense,
  groupLicenseBlocks,
  isLicenseFileName,
  isNameCovered,
  isNoticeFileName,
  keptNodeModulePackages,
  licensesNeedingReview,
  normalizeLicenseText,
  packageNoticeDecisions,
  packagingFailures,
  renderNoticeDocument,
  repositoryUrl,
  uncoveredPlatformPackages,
  unpackedPackages,
  wrapText,
} from "./third-party-notices-logic.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DESKTOP_DIR = resolve(REPO_ROOT, "apps/desktop");
const NOTICES_DIR = resolve(DESKTOP_DIR, "notices");
const OUTPUT_PATH = resolve(DESKTOP_DIR, "THIRD-PARTY-NOTICES");
const BUILDER_CONFIG_PATH = resolve(DESKTOP_DIR, "electron-builder.yml");
const LICENSE_PATH = resolve(REPO_ROOT, "LICENSE");

/**
 * What the packaged .app must carry, and where. `from` is relative to
 * apps/desktop (electron-builder's project directory), `to` is relative to
 * Contents/Resources inside the bundle — the location a user reaches through
 * Finder's "Show Package Contents", which is where a desktop app's notices are
 * conventionally found. Electron's distribution is downloaded lazily, so its
 * Chromium catalogue may be absent when the offline stale-notice check runs;
 * electron-builder still requires it when packaging the app.
 */
const REQUIRED_RESOURCES = [
  { from: "../../LICENSE", to: "LICENSE.txt" },
  { from: "THIRD-PARTY-NOTICES", to: "THIRD-PARTY-NOTICES.txt" },
  {
    from: "node_modules/electron/dist/LICENSES.chromium.html",
    to: "LICENSES.chromium.html",
    allowMissing: true,
    requireNonEmpty: true,
  },
];

/**
 * Every distributable this repository produces a notice for. One entry today;
 * the point of the shape is that a second client or a standalone server is an
 * entry here, with its own roots and its own packaging adapter, rather than a
 * fork of this script. Adding one does not touch a rule in the logic module.
 */
const ARTIFACTS = [
  {
    id: "desktop",
    description: "the macOS arm64 Volli Code application bundle (app id app.volli.desktop)",
    // What the ARTIFACT targets, never what the build host happens to be: this
    // check runs on Linux CI, and the .app is macOS arm64 either way.
    target: { os: "darwin", cpu: "arm64" },
    // The two roots whose code reaches the bundle. The CLI is not a dependency
    // of the desktop app: copy-cli.mjs drops its bundle into dist-electron, so
    // its production closure ships too.
    roots: [
      { name: "@volli/desktop", dir: DESKTOP_DIR },
      { name: "@volli/cli", dir: resolve(REPO_ROOT, "packages/cli") },
    ],
    projectDir: DESKTOP_DIR,
    noticesDir: NOTICES_DIR,
    outputPath: OUTPUT_PATH,
    builderConfigPath: BUILDER_CONFIG_PATH,
    requiredResources: REQUIRED_RESOURCES,
  },
];

const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const repoRelative = (path) => relative(REPO_ROOT, path).split(sep).join("/");

/**
 * The ownership paragraph, built from whatever the root LICENSE actually says.
 * Neither branch names a holder this script chose: one reports the recorded
 * line, the other reports that no line is recorded. See {@link copyrightHolder}.
 * @param {string} licenseText
 */
function ownershipNoteFrom(licenseText) {
  const { holder } = copyrightHolder(licenseText);
  if (holder === null) {
    return [
      "Copyright holder: not recorded in this repository. The root LICENSE carries the",
      'Apache-2.0 appendix placeholder ("[yyyy] [name of copyright owner]"), no package',
      "manifest names an author, and there is no NOTICE file. That is an ownership",
      "decision to record rather than a value to derive, so nothing is asserted here;",
      "apps/desktop/notices/README.md tracks it as open.",
    ].join("\n");
  }
  return [
    `Copyright ${holder}, as recorded in the root LICENSE's Apache-2.0 appendix. This`,
    "document reproduces that line rather than restating it, so the LICENSE remains the",
    "single place the holder is named.",
  ].join("\n");
}

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

  // This app's OWN vendored material. Anything another workspace package
  // vendored is declared by that package — see collectPackageOwnedNotices.
  const vendored = registry.vendored.map((entry) => ({
    title: entry.title,
    paths: entry.paths,
    owner: null,
    upstream: entry.upstream ?? null,
    spdx: entry.spdx ?? null,
    evidence: entry.evidence,
    text: entry.text === undefined ? null : readText(entry.text),
    unresolved: entry.unresolved ?? null,
  }));
  const ownFailures = registry.vendored.flatMap(
    (entry) =>
      packageNoticeDecisions({
        packageName: "apps/desktop/notices/sources.json",
        entries: [{ ...entry, covers: entry.paths, text: entry.text }],
        materialExists: (path) => existsSync(resolve(REPO_ROOT, path)),
        noticeExists: (path) => existsSync(join(NOTICES_DIR, path)),
      }).failures,
  );

  const fragments = registry.fragments.map((entry) => ({
    title: entry.title,
    source: entry.source,
    text: normalizeLicenseText(readFileSync(join(NOTICES_DIR, entry.file), "utf8")),
  }));

  return { platformNative, toolchain, vendored, fragments, registryFailures: ownFailures };
}

/**
 * Collect the notices each first-party package declares about its OWN vendored
 * material, and the failures in those declarations.
 *
 * Only packages the dependency walk actually reached are asked, which is what
 * makes the coverage structural: a package whose code is in the artifact is a
 * package whose declarations are read, and one that dropped out of the closure
 * stops contributing notices in the same step it stops shipping.
 *
 * @param {{ name: string, dir: string }[]} firstParty
 */
function collectPackageOwnedNotices(firstParty) {
  const vendored = [];
  const documents = [];
  const failures = [];

  for (const pkg of firstParty.toSorted((a, b) => (a.name < b.name ? -1 : 1))) {
    const manifest = readManifest(pkg.dir);
    if (manifest === null) continue;
    const decisions = packageNoticeDecisions({
      packageName: pkg.name,
      entries: manifest.volli?.notices,
      materialExists: (path) => existsSync(resolve(pkg.dir, path)),
      noticeExists: (path) => existsSync(resolve(pkg.dir, path)),
    });
    failures.push(...decisions.failures);

    for (const { title, entry, document } of decisions.include) {
      const covers = entry.covers.map((path) => `${repoRelative(resolve(pkg.dir, path))}`);
      if (document !== null) {
        documents.push({
          title,
          source: `${repoRelative(resolve(pkg.dir, document))} — ${pkg.name}'s own attribution for ${covers.join(", ")}`,
          text: normalizeLicenseText(readFileSync(resolve(pkg.dir, document), "utf8")),
        });
        continue;
      }
      vendored.push({
        title,
        paths: covers,
        owner: pkg.name,
        upstream: entry.upstream ?? null,
        spdx: entry.spdx ?? null,
        evidence: Array.isArray(entry.evidence) ? entry.evidence.join(" ") : entry.evidence,
        text:
          typeof entry.text === "string"
            ? normalizeLicenseText(readFileSync(resolve(pkg.dir, entry.text), "utf8"))
            : null,
        unresolved: Array.isArray(entry.unresolved)
          ? entry.unresolved.join(" ")
          : (entry.unresolved ?? null),
      });
    }
  }
  return { vendored, documents, failures };
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

function buildModel(artifact) {
  const builderConfig = parseYaml(readFileSync(artifact.builderConfigPath, "utf8"));
  const keptNames = new Set(keptNodeModulePackages(builderConfig));

  const closure = collectPackageClosure({
    roots: artifact.roots,
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
  // The roots are themselves first-party and can declare their own notices,
  // but the walk records DEPENDENCIES, never the roots it started from.
  const owned = collectPackageOwnedNotices([...closure.firstParty, ...artifact.roots]);
  return {
    projectLicenseName: "Apache-2.0",
    projectLicenseFile: "LICENSE",
    ownershipNote: ownershipNoteFrom(readFileSync(LICENSE_PATH, "utf8")),
    shippedResources: artifact.requiredResources,
    // Names without versions: these are this repository's own modules, and
    // pinning the app's release version here would churn the notice on every
    // canary bump without telling a reader anything about licensing.
    firstParty: [
      ...closure.firstParty.map((pkg) => pkg.name),
      ...artifact.roots.map((root) => root.name),
    ].toSorted(),
    entries,
    patched: readPatchedDependencies(),
    ...registry,
    // A package's own declarations sit beside the desktop registry's, sorted
    // together so the document does not depend on which source supplied them.
    vendored: [...registry.vendored, ...owned.vendored].toSorted((a, b) =>
      a.title < b.title ? -1 : a.title > b.title ? 1 : 0,
    ),
    fragments: [...registry.fragments, ...owned.documents].toSorted((a, b) =>
      a.title < b.title ? -1 : a.title > b.title ? 1 : 0,
    ),
    noticeFailures: [...registry.registryFailures, ...owned.failures],
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

function generate(artifact) {
  const model = buildModel(artifact);
  const document = renderNoticeDocument(model);
  const shippedNames = new Set([
    ...keptNodeModulePackages(model.builderConfig),
    ...unpackedPackages(model.builderConfig),
  ]);
  const failures = [
    ...packagingFailures({
      builderConfig: model.builderConfig,
      coveredNames: coveredNamesOf(model),
      requiredResources: artifact.requiredResources,
      resourceExists: (from) => existsSync(resolve(artifact.projectDir, from)),
      resourceIsNonEmpty: (from) =>
        readFileSync(resolve(artifact.projectDir, from), "utf8").trim().length > 0,
    }),
    // A platform package the walk skipped, that the packaging config ships, and
    // that no reviewed entry pins.
    ...uncoveredPlatformPackages({
      skipped: model.skippedPlatformPackages,
      target: artifact.target,
      shippedNames,
      registeredNames: new Set(model.platformNative.map((entry) => entry.name)),
    }),
    // A workspace package whose declared notice and vendored material disagree.
    ...model.noticeFailures,
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

function reportCoverageFailures(failures) {
  console.error("Notice coverage check failed:");
  for (const failure of failures) console.error(`  - ${failure}`);
  console.error(
    "\nFix apps/desktop/electron-builder.yml, apps/desktop/notices/sources.json, or the\n" +
      'owning package\'s "volli.notices", so every shipped package is covered and the\n' +
      "notices reach Contents/Resources.",
  );
}

function main({ check }) {
  const artifact = ARTIFACTS[0];
  const { model, document, failures } = generate(artifact);
  const packageCount = model.entries.length + model.platformNative.length + model.toolchain.length;

  if (check) {
    if (failures.length > 0) {
      reportCoverageFailures(failures);
      process.exit(1);
    }
    const current = existsSync(artifact.outputPath)
      ? readFileSync(artifact.outputPath, "utf8")
      : null;
    if (current === document) {
      console.log(
        `${repoRelative(artifact.outputPath)} is current (${packageCount} packages, ` +
          `${model.vendored.length} vendored sources) and electron-builder ships it.`,
      );
      return;
    }
    console.error(
      current === null
        ? `${repoRelative(artifact.outputPath)} is missing.`
        : `${repoRelative(artifact.outputPath)} is out of date with the installed production dependency set.`,
    );
    if (current !== null) reportIndexDrift(current, document);
    console.error(
      "\nRegenerate it and commit the result:\n" +
        "  node scripts/generate-third-party-notices.mjs\n",
    );
    process.exit(1);
  }

  // WRITE FIRST, THEN REPORT (VC-407 review). Refusing to write while a
  // coverage failure stands made the one command that fixes a stale notice
  // unavailable exactly when something else was also wrong — and the two
  // faults are independent: a package with no notice does not make the
  // regenerated document less correct than the committed one. The exit code
  // still fails, so nothing becomes green by regenerating; the difference is
  // that the author can now fix both in one pass instead of being blocked on
  // the order they happened to appear.
  writeFileSync(artifact.outputPath, document);
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
      `installed here: ${model.skippedPlatformPackages
        .map((pkg) => `${pkg.name}@${pkg.version}`)
        .join(", ")}`,
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
    "/store/alpha": {
      name: "alpha",
      version: "1.0.0",
      dependencies: { beta: "1" },
      // A required peer is code alpha executes, so it ships. An optional peer
      // is the type-only case (@types/react under every Radix primitive) and
      // must not enter a document that says everything in it is in the bundle.
      peerDependencies: { needed: "1", types: "1" },
      peerDependenciesMeta: { types: { optional: true } },
    },
    "/store/beta": { name: "beta", version: "2.0.0", dependencies: { alpha: "1" } },
    "/store/needed": { name: "needed", version: "5.0.0" },
    "/store/types": { name: "types", version: "6.0.0" },
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
    ["alpha@1.0.0", "beta@2.0.0", "needed@5.0.0"],
    "transitive deps and REQUIRED peers ship; the walk terminates on a cycle",
  );
  assert.ok(
    !closure.thirdParty.some((pkg) => pkg.name === "types"),
    "an optional peer is the type-only case and never enters the shipped list",
  );
  assert.deepEqual(
    closure.firstParty.map((pkg) => pkg.name),
    ["@volli/shared"],
  );
  assert.deepEqual(
    closure.platformSpecific,
    [{ name: "native", version: "3.0.0", os: ["darwin"], cpu: ["arm64"] }],
    "os/cpu packages leave the walk, carrying the constraints the target is judged against",
  );
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
  assert.equal(
    normalizeLicenseText("\uFEFFa  \r\nb\t\n\n  c  \n"),
    "a\nb\n\n  c\n",
    "only trailing horizontal whitespace is removed; line breaks and other spaces stay",
  );
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
      {
        from: "node_modules/electron/dist/LICENSES.chromium.html",
        to: "LICENSES.chromium.html",
      },
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
    resourceIsNonEmpty: () => true,
  });
  assert.deepEqual(ok, [], "a config that ships all resources and covers every package passes");

  // Vendored-path validation moved onto packageNoticeDecisions, which now runs
  // over both the desktop registry and each package's own declarations — see
  // selfTestPackageNotices for the rot and missing-notice cases.

  const missingResource = packagingFailures({
    builderConfig: { ...builderConfig, extraResources: [] },
    coveredNames: covered,
    requiredResources: REQUIRED_RESOURCES,
    resourceExists: () => true,
  });
  assert.equal(missingResource.length, 3, "dropping extraResources fails for all three files");
  assert.ok(missingResource.every((failure) => failure.includes("extraResources")));

  const wrongDestination = packagingFailures({
    builderConfig: {
      ...builderConfig,
      extraResources: [
        { from: "../../LICENSE", to: "LICENSE.txt" },
        { from: "THIRD-PARTY-NOTICES", to: "somewhere-else.txt" },
        {
          from: "node_modules/electron/dist/LICENSES.chromium.html",
          to: "LICENSES.chromium.html",
        },
      ],
    },
    coveredNames: covered,
    requiredResources: REQUIRED_RESOURCES,
    resourceExists: () => true,
  });
  assert.equal(wrongDestination.length, 1, "shipping a notice to another path is a failure");

  const chromiumWrongDestination = packagingFailures({
    builderConfig: {
      ...builderConfig,
      extraResources: builderConfig.extraResources.map((resource) =>
        resource.from === "node_modules/electron/dist/LICENSES.chromium.html"
          ? { ...resource, to: "somewhere-else.html" }
          : resource,
      ),
    },
    coveredNames: covered,
    requiredResources: REQUIRED_RESOURCES,
    resourceExists: () => true,
  });
  assert.deepEqual(
    chromiumWrongDestination,
    [
      'electron-builder.yml ships "node_modules/electron/dist/LICENSES.chromium.html" to "somewhere-else.html"; ' +
        'the notice document names "LICENSES.chromium.html".',
    ],
    "Chromium's catalogue must land at the exact Resources path",
  );

  const chromiumSourceMissing = packagingFailures({
    builderConfig,
    coveredNames: covered,
    requiredResources: REQUIRED_RESOURCES,
    resourceExists: (from) => from !== "node_modules/electron/dist/LICENSES.chromium.html",
    resourceIsNonEmpty: () => {
      throw new Error("offline checks must not read an absent Electron distribution");
    },
  });
  assert.deepEqual(
    chromiumSourceMissing,
    [],
    "the stale-notice check stays green when Electron's distribution is absent",
  );

  const chromiumSourceEmpty = packagingFailures({
    builderConfig,
    coveredNames: covered,
    requiredResources: REQUIRED_RESOURCES,
    resourceExists: () => true,
    resourceIsNonEmpty: (from) => from !== "node_modules/electron/dist/LICENSES.chromium.html",
  });
  assert.deepEqual(
    chromiumSourceEmpty,
    [
      "electron-builder.yml extraResources source has empty content: " +
        "node_modules/electron/dist/LICENSES.chromium.html",
    ],
    "an installed Chromium catalogue must contain content",
  );

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
        owner: null,
        upstream: "https://example.invalid/known",
        spdx: "MIT",
        evidence: "e",
        text: "VENDORED TEXT",
        unresolved: null,
      },
      {
        title: "Owned by a package",
        paths: ["packages/thing/src/x.ts"],
        owner: "@volli/thing",
        upstream: "https://example.invalid/owned",
        spdx: "MIT",
        evidence: "e",
        text: "OWNED VENDORED TEXT",
        unresolved: null,
      },
      {
        title: "Unknown",
        paths: ["c/d"],
        owner: null,
        upstream: null,
        spdx: null,
        evidence: "e",
        text: null,
        unresolved: "what is missing",
      },
    ],
    patched: [{ name: "alpha", version: "1.0.0", patch: "patches/alpha.patch" }],
    fragments: [
      { title: "Editor theme data", source: "s", text: "FRAGMENT TEXT" },
      { title: "Theme catalog", source: "packages/thing/NOTICE.md", text: "CATALOG TEXT" },
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
    "CATALOG TEXT",
    "OWNED VENDORED TEXT",
    "Declared by: @volli/thing",
    "7. VENDORED SOURCES (3)",
  ]) {
    assert.ok(document.includes(expected), `rendered document is missing: ${expected}`);
  }
  assert.ok(
    !/Status: PENDING|Marker:/.test(document),
    "the pending-fragment concept is gone: a notice is folded in or its absence fails",
  );
  assert.ok(
    document.indexOf("Declared by: @volli/thing") > document.indexOf("Source: Known"),
    "a package-owned vendored entry renders beside the registry's own",
  );
  assert.ok(
    document.includes("4. PACKAGES THAT PUBLISH NO LICENCE FILE (1)") &&
      document.includes("declared: ISC"),
    "a package with no licence file is reported as such, with its declaration",
  );
  assert.ok(!document.includes("\n\n\n\n"), "no runaway blank space — the output must be stable");
  assert.ok(!document.endsWith("\n\n"), "the generated document ends with one newline");
  assert.equal(
    document,
    renderNoticeDocument(renderFixtureModel()),
    "rendering is a pure function of the model",
  );
}

/**
 * Run the declaration rule against a fixture package whose tree is exactly
 * `present`. Both existence probes read the same list, because on disk a
 * notice and the material it covers live in the same package directory.
 */
function decideFixtureNotices(entries, present) {
  return packageNoticeDecisions({
    packageName: "@volli/shared",
    entries,
    materialExists: (path) => present.includes(path),
    noticeExists: (path) => present.includes(path),
  });
}

/**
 * The rule that replaced the marker grep. The case that matters most is the
 * one the grep got wrong: material in the tree, notice file absent.
 */
function selfTestPackageNotices() {
  const themeEntry = {
    title: "Ghostty terminal theme catalog",
    covers: ["src/ghostty-theme-sources.generated.ts"],
    document: "THIRD-PARTY-THEMES.md",
  };
  const run = decideFixtureNotices;

  const bothHere = run(
    [themeEntry],
    ["src/ghostty-theme-sources.generated.ts", "THIRD-PARTY-THEMES.md"],
  );
  assert.deepEqual(bothHere.failures, []);
  assert.deepEqual(
    bothHere.include.map((item) => item.document),
    ["THIRD-PARTY-THEMES.md"],
    "material and notice both present: the notice is folded in",
  );

  // THE REGRESSION THIS RULE EXISTS FOR. The Ghostty catalog shipped as
  // `ghostty-theme-sources.generated.ts`, whose 463 entries say "iTerm2 Dark
  // Background" and never the marker "iTerm2-Color-Schemes". The old grep
  // therefore concluded the material had not shipped, stayed green, and would
  // have packaged the catalog with no attribution. Keyed on the file instead,
  // the same state is a failure that names both sides.
  const materialWithoutNotice = run([themeEntry], ["src/ghostty-theme-sources.generated.ts"]);
  assert.deepEqual(materialWithoutNotice.include, [], "nothing is folded in");
  assert.equal(materialWithoutNotice.failures.length, 1);
  assert.match(
    materialWithoutNotice.failures[0],
    /THIRD-PARTY-THEMES\.md.*no attribution/s,
    "material present with its notice absent fails, naming the missing notice",
  );

  // The mirror: a declaration whose material is gone has rotted. Silence here
  // would let a mistyped path masquerade as coverage.
  const noticeWithoutMaterial = run([themeEntry], ["THIRD-PARTY-THEMES.md"]);
  assert.deepEqual(noticeWithoutMaterial.include, []);
  assert.match(
    noticeWithoutMaterial.failures[0],
    /covers.*not in this package/s,
    "a covers path that no longer exists is named, not ignored",
  );

  // A package that declares nothing contributes nothing, and is not an error.
  assert.deepEqual(
    packageNoticeDecisions({
      packageName: "@volli/quiet",
      entries: undefined,
      materialExists: () => true,
      noticeExists: () => true,
    }),
    { include: [], failures: [] },
    "most packages declare no notices and must stay silent",
  );

  // Malformed declarations fail rather than silently covering nothing.
  const malformed = [
    [{ title: "no covers", document: "N.md" }, /records no "covers" paths/],
    [{ covers: ["a"], document: "N.md" }, /has no title/],
    [{ title: "bare", covers: ["a"] }, /neither a licence text, a notice document/],
    [{ title: "bad path", covers: [42] }, /not a path/],
  ];
  for (const [entry, pattern] of malformed) {
    const result = run([entry], ["a", "N.md"]);
    assert.deepEqual(result.include, [], `${JSON.stringify(entry)} must contribute nothing`);
    assert.match(result.failures[0], pattern);
  }
  assert.match(
    packageNoticeDecisions({
      packageName: "@volli/x",
      entries: "not an array",
      materialExists: () => true,
      noticeExists: () => true,
    }).failures[0],
    /must be an array/,
  );

  // An "unresolved" entry is legitimate and needs no licence text: that is how
  // provenance nobody has established travels without being invented.
  const unresolved = run(
    [{ title: "APCA", covers: ["src/theme/color.ts"], unresolved: "what is missing" }],
    ["src/theme/color.ts"],
  );
  assert.deepEqual(unresolved.failures, []);
  assert.equal(unresolved.include.length, 1);
  assert.equal(unresolved.include[0].document, null, "it renders as vendored, not as a document");
}

/** A skipped package that installs for the desktop artifact's own target. */
function darwinArm64(name, version) {
  return { name, version, os: ["darwin"], cpu: ["arm64"] };
}

/** The platform-exclusion hole: skipped, shipped on the TARGET, pinned by nobody. */
function selfTestPlatformCoverage() {
  const shippedNames = new Set(["@img", "node-pty"]);
  const target = { os: "darwin", cpu: "arm64" };
  const run = (skipped, registered) =>
    uncoveredPlatformPackages({
      skipped,
      target,
      shippedNames,
      registeredNames: new Set(registered),
    });

  assert.deepEqual(
    run([darwinArm64("@img/sharp-darwin-arm64", "0.35.4")], ["@img/sharp-darwin-arm64"]),
    [],
    "a skipped platform package the registry pins is covered",
  );

  // THE LINUX-CI REGRESSION. The runner installs its own @img variant, which
  // falls under the shipped `@img` scope and is pinned by nobody — but it does
  // not install for darwin/arm64, so it ships in no artifact this describes.
  assert.deepEqual(
    run([{ name: "@img/sharp-linux-x64", version: "0.35.4", os: ["linux"], cpu: ["x64"] }], []),
    [],
    "the BUILD HOST's own platform variants are not the artifact's, and never fail",
  );
  assert.deepEqual(
    run([{ name: "@img/sharp-darwin-x64", version: "0.35.4", os: ["darwin"], cpu: ["x64"] }], []),
    [],
    "right OS, wrong CPU: still not this artifact",
  );

  const uncovered = run(
    [darwinArm64("@img/sharp-libvips-darwin-arm64", "1.3.3")],
    ["@img/sharp-darwin-arm64"],
  );
  assert.equal(uncovered.length, 1, "a fourth native package under a shipped scope is named");
  assert.match(uncovered[0], /@img\/sharp-libvips-darwin-arm64@1\.3\.3.*platformNative/s);
  assert.equal(
    run([{ name: "node-pty", version: "1.0.0", os: [], cpu: [] }], []).length,
    1,
    "a package constraining neither os nor cpu matches every target",
  );
  assert.equal(
    run([{ name: "node-pty", version: "1.0.0", os: ["!win32"], cpu: [] }], []).length,
    1,
    "a negated constraint that does not exclude the target still matches it",
  );
  assert.deepEqual(
    run([{ name: "node-pty", version: "1.0.0", os: ["!darwin"], cpu: [] }], []),
    [],
    "a negated constraint that excludes the target is not the artifact's package",
  );
  assert.deepEqual(
    run([{ name: "lonely", version: "1.0.0", os: ["darwin"], cpu: ["arm64"] }], []),
    [],
    "a target-matching platform package the config does not ship needs no notice",
  );
}

/** Ownership is read from LICENSE and never chosen here (VC-407 / VC-414). */
function selfTestOwnership() {
  const placeholder = "   Copyright [yyyy] [name of copyright owner]\n\n   Licensed under";
  assert.deepEqual(
    copyrightHolder(placeholder),
    { holder: null, line: "[yyyy] [name of copyright owner]" },
    "Apache's own appendix placeholder is not a holder",
  );
  assert.deepEqual(copyrightHolder("   Copyright 2026 Hussain Phalasiya\n"), {
    holder: "2026 Hussain Phalasiya",
    line: "2026 Hussain Phalasiya",
  });
  assert.deepEqual(copyrightHolder("no copyright line here"), { holder: null, line: null });

  assert.match(ownershipNoteFrom(placeholder), /not recorded in this repository/);
  assert.ok(!/Hussain/.test(ownershipNoteFrom(placeholder)), "the placeholder branch names nobody");
  const named = ownershipNoteFrom("   Copyright 2026 Hussain Phalasiya\n");
  assert.match(named, /Copyright 2026 Hussain Phalasiya/);
  assert.ok(
    !/not recorded/.test(named),
    "once LICENSE names a holder the document stops saying it is unrecorded",
  );
}

/**
 * The IO half, against real directories in a temp tree. These functions read
 * the disk, so a fixture that is not on disk tests nothing about them; the two
 * defects this pipeline actually shipped (a build script reproduced as a
 * licence, a marker that never matched) both lived here rather than in a rule.
 */
function selfTestFilesystem() {
  const root = mkdtempSync(join(tmpdir(), "volli-notices-"));
  try {
    const pkg = join(root, "node_modules", "widget");
    mkdirSync(pkg, { recursive: true });
    writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "widget", version: "1.0.0" }));
    writeFileSync(join(pkg, "LICENSE"), "WIDGET TERMS\r\n");
    writeFileSync(join(pkg, "NOTICE"), "WIDGET NOTICE\n");
    // The cytoscape case, exactly: a build script at the package root whose
    // name begins with "license-".
    writeFileSync(join(pkg, "license-update.mjs"), "import fs from 'fs';\n");
    writeFileSync(join(pkg, "LICENSE-MIT"), "SECOND GRANT\n");
    writeFileSync(join(pkg, "licence.txt"), "");
    mkdirSync(join(pkg, "LICENSES"));

    const files = licenseFilesIn(pkg);
    assert.deepEqual(
      files.map((entry) => entry.file),
      ["LICENSE", "LICENSE-MIT", "NOTICE"],
      "a real licence, a suffixed one and a NOTICE are read; a .mjs build script is not",
    );
    assert.equal(
      files.find((entry) => entry.file === "NOTICE").kind,
      "notice",
      "NOTICE files are classified as notices, so Apache-2.0 §4(d) text travels",
    );
    assert.equal(files[0].text, "WIDGET TERMS\n", "CRLF is folded on read");
    assert.ok(
      !files.some((entry) => entry.file === "licence.txt"),
      "an empty licence file is dropped rather than printed as blank terms",
    );
    assert.ok(
      !files.some((entry) => entry.file === "LICENSES"),
      "a directory named like a licence is not read as one",
    );

    // resolveDependencyDir walks up and skips node_modules segments.
    const nested = join(pkg, "sub");
    mkdirSync(nested);
    assert.equal(resolveDependencyDir(nested, "widget"), realpathSync(pkg));
    assert.equal(resolveDependencyDir(root, "absent"), null);

    // collectPackageOwnedNotices, end to end against a real package directory.
    const owner = join(root, "owned");
    mkdirSync(join(owner, "src"), { recursive: true });
    writeFileSync(join(owner, "src", "vendored.ts"), "// material\n");
    writeFileSync(join(owner, "NOTICE.md"), "OWNED NOTICE TEXT\n");
    writeFileSync(
      join(owner, "package.json"),
      JSON.stringify({
        name: "@volli/owned",
        volli: {
          notices: [{ title: "Owned catalog", covers: ["src/vendored.ts"], document: "NOTICE.md" }],
        },
      }),
    );
    const collected = collectPackageOwnedNotices([{ name: "@volli/owned", dir: owner }]);
    assert.deepEqual(collected.failures, []);
    assert.equal(collected.documents.length, 1);
    assert.equal(collected.documents[0].text, "OWNED NOTICE TEXT\n");
    assert.match(collected.documents[0].source, /NOTICE\.md/);

    // Delete the notice, keep the material: the failure the grep could not see.
    rmSync(join(owner, "NOTICE.md"));
    const broken = collectPackageOwnedNotices([{ name: "@volli/owned", dir: owner }]);
    assert.deepEqual(broken.documents, []);
    assert.match(broken.failures[0], /@volli\/owned.*no attribution/s);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/**
 * The live tree has to satisfy the rules too. A self-test that only ever sees
 * fixtures can pass while this repository's own declarations are malformed.
 */
function selfTestLiveDeclarations() {
  const owned = collectPackageOwnedNotices(
    ["packages/shared", "packages/agent-runtime"].map((dir) => ({
      name: dir,
      dir: resolve(REPO_ROOT, dir),
    })),
  );
  assert.deepEqual(
    owned.failures,
    [],
    "this repository's own package-declared notices must satisfy the rule",
  );
  assert.ok(
    owned.documents.length + owned.vendored.length >= 3,
    "shared declares the theme catalog and APCA; agent-runtime declares pi-automode",
  );
  assert.ok(
    owned.documents.some((doc) => /THIRD-PARTY-THEMES\.md/.test(doc.source)),
    "the Ghostty theme attribution is collected from @volli/shared, not grepped for",
  );
}

function selfTest() {
  selfTestClosure();
  selfTestDeclarations();
  selfTestGrouping();
  selfTestPackagingRules();
  selfTestPackageNotices();
  selfTestPlatformCoverage();
  selfTestOwnership();
  selfTestFilesystem();
  selfTestLiveDeclarations();
  selfTestRendering();
  console.log("generate-third-party-notices self-test passed");
}

/**
 * Whether this file is the entry point rather than an import, compared through
 * `realpathSync` on BOTH sides. The obvious `import.meta.url === argv[1]` form
 * answers "no" whenever the invoking path crosses a symlink (macOS /tmp ->
 * /private/tmp, a worktree behind a link), and a gate that answers "no" exits 0
 * — a silent pass, the one outcome a gate must never produce. Same reasoning,
 * and same shape, as scripts/check-workspace-licenses.mjs.
 */
function invokedAsScript() {
  if (process.argv[1] === undefined) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (invokedAsScript()) {
  if (process.argv.includes("--self-test")) selfTest();
  else main({ check: process.argv.includes("--check") });
}

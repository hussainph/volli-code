/**
 * Ensures the packages this repository has decided not to carry stay out of
 * it — out of every workspace manifest, out of the lockfile, and out of every
 * import in the tree.
 *
 *     vp run check:excluded-dependencies                       # the gate, after its own tests
 *     node scripts/check-excluded-dependencies.mjs             # the gate
 *     node scripts/check-excluded-dependencies.mjs --self-test # the matchers' own tests
 *
 * WHY THIS EXISTS (VC-412). `apca-w3` was a devDependency of `@volli/desktop`
 * and `@volli/shared`, imported by three test paths as a second implementation
 * to cross-check this repository's own APCA math against. Its own manifest
 * declares `"license": "Limited W3 License"`, and it depends on `colorparsley`,
 * whose manifest declares `"license": "AGPL v3"`. The owner's decision for
 * VC-412 is that a project shipping as commercial OSS downstream carries
 * neither, so both are gone and the verification they carried is now owned
 * here: frozen reference vectors, a second transcription of the published
 * formula, and behavioural invariants in
 * `packages/shared/src/theme/color.test.ts`.
 *
 * Removing them was a one-time edit. The risk this gate answers is the reverse
 * of the usual one: an `apca-w3` reached for in six months by someone solving
 * the same cross-checking problem, or dragged back in as a transitive
 * dependency of something else. Both land silently \u2014 a devDependency is not
 * visible in a diff unless you read the lockfile \u2014 so the check is mechanical.
 *
 * THREE ANGLES, because a package can arrive three ways:
 *
 *   (1) DECLARED \u2014 named in any dependency field of any workspace manifest.
 *   (2) RESOLVED \u2014 present in `pnpm-lock.yaml`, which is how a TRANSITIVE
 *       arrival shows up: nothing declares it, every install produces it, and
 *       whatever it lands under is what would ship.
 *   (3) IMPORTED \u2014 named in an `import`/`require` anywhere in the source, which
 *       is how a reintroduction looks in the minutes before someone runs the
 *       install that would make (1) and (2) true.
 *
 * Like `check-workspace-licenses.mjs` beside it, this fails closed: the
 * workspace enumeration is shared with that gate rather than re-globbed here,
 * and an unreadable manifest or a missing lockfile is a failure, never a pass.
 */

import { globSync, readFileSync, realpathSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { enumerateWorkspaceProjects } from "./check-workspace-licenses.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..");

/**
 * The packages that must not come back, each with the reason recorded where
 * the reason is enforced. A name is added here by a decision, never by a
 * preference: this list is a statement about what this repository may carry.
 */
export const EXCLUDED_PACKAGES = [
  {
    name: "apca-w3",
    reason:
      "VC-412: declares 'Limited W3 License' and depends on colorparsley (AGPL v3). " +
      "The APCA math it used to cross-check lives in packages/shared/src/theme/color.ts, " +
      "verified by the frozen vectors in apca-reference.ts and the invariants in color.test.ts.",
  },
  {
    name: "colorparsley",
    reason: "VC-412: declares 'AGPL v3'; it is how apca-w3 would arrive transitively.",
  },
];

/** Every manifest field pnpm resolves a dependency from. */
const DEPENDENCY_FIELDS = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
];

/**
 * Where source is scanned for an import. Deliberately the three directories
 * this repository keeps first-party code in, rather than a walk from the root
 * that would spend its time in `node_modules`, `dist` and `.git`.
 */
const SOURCE_GLOBS = [
  "apps/**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}",
  "packages/**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}",
  "scripts/**/*.{ts,mts,cts,js,mjs,cjs}",
];

const SOURCE_IGNORE = ["**/node_modules/**", "**/dist/**", "**/dist-electron/**", "**/out/**"];

/**
 * This file, which is exempt from the import scan for the obvious reason: it
 * is where the excluded names are written down, and its self-test fixtures
 * quote every import shape it looks for. Exempting it by path rather than by
 * skipping `scripts/` keeps every other gate in that directory scanned.
 */
const SELF_RELATIVE_PATH = "scripts/check-excluded-dependencies.mjs";

/** A package name as a regex fragment; names carry `-`, `.`, `/` and `@`. */
function escapeForRegex(name) {
  return name.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
}

/**
 * Every excluded package declared in a dependency field of a workspace
 * manifest. An unreadable manifest is reported rather than skipped — a gate
 * that cannot read a file has not cleared it.
 */
export function findManifestDeclarations(projects, excluded, readManifest = readManifestFromDisk) {
  return projects.flatMap((project) => {
    const { manifestPath } = project;
    let manifest;
    try {
      manifest = readManifest(manifestPath);
      if (manifest === null || typeof manifest !== "object" || Array.isArray(manifest)) {
        throw new Error(`manifest is not an object (${JSON.stringify(manifest) ?? "undefined"})`);
      }
    } catch (error) {
      return [{ manifestPath, name: "(any)", field: `unreadable manifest (${error.message})` }];
    }

    return excluded.flatMap(({ name }) =>
      DEPENDENCY_FIELDS.filter((field) => {
        const block = manifest[field];
        return (
          block !== null &&
          typeof block === "object" &&
          !Array.isArray(block) &&
          Object.hasOwn(block, name)
        );
      }).map((field) => ({ manifestPath, name, field })),
    );
  });
}

/**
 * Every line of `pnpm-lock.yaml` that names an excluded package, with its line
 * number.
 *
 * Matched on the two shapes a lockfile names a package in — a YAML key whose
 * whole name is the package (`  colorparsley:`, importer and snapshot
 * dependency entries, catalog entries) and a versioned key (`  apca-w3@0.1.9:`,
 * the `packages`/`snapshots` sections). Anchoring on the whole key is what
 * keeps `apca-w3-shim` or a base64 integrity hash from reading as a hit, and
 * what makes a real transitive arrival impossible to miss: pnpm cannot install
 * a package it does not write into one of those two shapes.
 *
 * Throws on a lockfile that is empty or has no `lockfileVersion` header:
 * scanning nothing and reporting "clean" is the one answer this must not give.
 */
export function findLockfileReferences(lockText, excluded) {
  if (typeof lockText !== "string" || !/^lockfileVersion:/m.test(lockText)) {
    throw new Error(
      "pnpm-lock.yaml does not look like a pnpm lockfile (no `lockfileVersion:` header) — " +
        "refusing to report a vacuous pass.",
    );
  }

  const lines = lockText.split(/\r?\n/);
  const found = [];
  for (const { name } of excluded) {
    const escaped = escapeForRegex(name);
    // `'name@1.2.3':` / `name@1.2.3:` — a resolved package or snapshot key.
    const versioned = new RegExp(`^\\s*'?${escaped}'?@[^\\s:]+'?:`);
    // `name:` — an importer dependency, catalog entry, or snapshot dependency.
    const bare = new RegExp(`^\\s*'?${escaped}'?:(\\s|$)`);
    lines.forEach((line, index) => {
      if (versioned.test(line) || bare.test(line)) {
        found.push({ name, line: index + 1, text: line.trim() });
      }
    });
  }
  return found.toSorted((a, b) => a.line - b.line);
}

/**
 * Every source file that imports an excluded package. Matches the specifier
 * exactly, including a deep import (`apca-w3/dist/...`), in `import`,
 * `export ... from`, dynamic `import()` and `require()`.
 *
 * Only `"` and `'` count as quotes, never a backtick. A backticked specifier
 * is not valid in a static import and would be a contrived `require()`, while
 * prose in this codebase writes package names in backticks constantly — "read
 * from `apca-w3`" is a sentence, not an import, and a scanner that could not
 * tell them apart would make every comment about this removal a failure. An
 * actual dependency still cannot hide: it would have to reach the manifest or
 * the lockfile to be installable, and both are checked.
 */
export function findSourceImports(files, excluded, readFile = readTextFromDisk) {
  const patterns = excluded.map(({ name }) => ({
    name,
    pattern: new RegExp(
      `(?:from|import|require)\\s*\\(?\\s*["']${escapeForRegex(name)}(?:/[^"']*)?["']`,
    ),
  }));

  return files.flatMap((file) => {
    const text = readFile(file);
    const lines = text.split(/\r?\n/);
    return patterns.flatMap(({ name, pattern }) =>
      lines.flatMap((line, index) =>
        pattern.test(line) ? [{ file, name, line: index + 1, text: line.trim() }] : [],
      ),
    );
  });
}

function readManifestFromDisk(manifestPath) {
  return JSON.parse(readFileSync(manifestPath, "utf8"));
}

function readTextFromDisk(filePath) {
  return readFileSync(filePath, "utf8");
}

function relativeToRepo(absolutePath) {
  return relative(REPO_ROOT, absolutePath) || absolutePath;
}

/** Every first-party source file, as absolute paths, sorted for a stable report. */
function enumerateSourceFiles(repoRoot = REPO_ROOT) {
  const self = resolve(repoRoot, SELF_RELATIVE_PATH);
  const matches = new Set();
  for (const glob of SOURCE_GLOBS) {
    for (const match of globSync(glob, { cwd: repoRoot, exclude: SOURCE_IGNORE })) {
      const absolute = resolve(repoRoot, match);
      if (absolute !== self) matches.add(absolute);
    }
  }
  if (matches.size === 0) {
    throw new Error(
      `no source files matched (${SOURCE_GLOBS.join(", ")}) — the matcher is broken or the ` +
        `tree moved; refusing to report a vacuous pass.`,
    );
  }
  return [...matches].toSorted();
}

function runCheck() {
  const projects = enumerateWorkspaceProjects();
  const declarations = findManifestDeclarations(projects, EXCLUDED_PACKAGES);
  const lockReferences = findLockfileReferences(
    readFileSync(resolve(REPO_ROOT, "pnpm-lock.yaml"), "utf8"),
    EXCLUDED_PACKAGES,
  );
  const sourceFiles = enumerateSourceFiles();
  const imports = findSourceImports(sourceFiles, EXCLUDED_PACKAGES);

  const failures = [
    ...declarations.map(
      ({ manifestPath, name, field }) =>
        `  - declared: ${relativeToRepo(manifestPath)} → ${field}.${name}`,
    ),
    ...lockReferences.map(
      ({ name, line, text }) => `  - resolved: pnpm-lock.yaml:${line} names ${name} (${text})`,
    ),
    ...imports.map(
      ({ file, name, line }) => `  - imported: ${relativeToRepo(file)}:${line} imports ${name}`,
    ),
  ];

  if (failures.length > 0) {
    console.error(
      [
        `[volli] Excluded dependency check failed: this repository must not carry`,
        ...EXCLUDED_PACKAGES.map(({ name, reason }) => `  ${name} — ${reason}`),
        ``,
        ...failures,
        ``,
        `Fix: remove the dependency and the code that reaches for it. If it arrived`,
        `transitively, the package that pulled it in is the one to change. If the`,
        `decision itself has changed, EXCLUDED_PACKAGES in this file is where that`,
        `is recorded — editing it is the deliberate act this gate exists to require.`,
      ].join("\n"),
    );
    process.exitCode = 1;
    return;
  }

  console.log(
    `[volli] Excluded dependency check passed: ${EXCLUDED_PACKAGES.map((p) => p.name).join(", ")} ` +
      `absent from ${projects.length} workspace manifests, the lockfile, and ${sourceFiles.length} source files.`,
  );
}

function selfTest() {
  const failures = [];
  const check = (what, actual, expected) => {
    const a = JSON.stringify(actual);
    const e = JSON.stringify(expected);
    if (a !== e) failures.push(`${what}: expected ${e}, received ${a}`);
  };
  const throws = (what, run, expectedFragment) => {
    try {
      run();
      failures.push(`${what}: expected a throw, nothing was thrown`);
    } catch (error) {
      if (!String(error.message).includes(expectedFragment)) {
        failures.push(
          `${what}: expected the error to mention ${JSON.stringify(expectedFragment)}, ` +
            `received ${JSON.stringify(error.message)}`,
        );
      }
    }
  };

  // Fixtures name the excluded packages literally rather than reading
  // EXCLUDED_PACKAGES, so a test cannot be defined in terms of the list it is
  // meant to police.
  const EXCLUDED = [{ name: "apca-w3", reason: "fixture" }, { name: "colorparsley" }];
  const project = [{ manifestPath: "/f/p/package.json" }];

  // --- (1) declared in a manifest ----------------------------------------
  for (const field of [
    "dependencies",
    "devDependencies",
    "optionalDependencies",
    "peerDependencies",
  ]) {
    check(
      `${field} is scanned`,
      findManifestDeclarations(project, EXCLUDED, () => ({ [field]: { "apca-w3": "^0.1.9" } })).map(
        (v) => `${v.field}.${v.name}`,
      ),
      [`${field}.apca-w3`],
    );
  }
  check(
    "a clean manifest passes",
    findManifestDeclarations(project, EXCLUDED, () => ({
      dependencies: { culori: "^4.0.2" },
      devDependencies: { typescript: "catalog:" },
    })),
    [],
  );
  check(
    "a similarly named package is not a hit",
    findManifestDeclarations(project, EXCLUDED, () => ({
      devDependencies: { "apca-w3-shim": "^1.0.0", "not-colorparsley": "^1.0.0" },
    })),
    [],
  );
  check(
    "both packages are reported, not just the first",
    findManifestDeclarations(project, EXCLUDED, () => ({
      dependencies: { "apca-w3": "^0.1.9", colorparsley: "^0.1.8" },
    })).map((v) => v.name),
    ["apca-w3", "colorparsley"],
  );
  // A dependency block that is not an object must not throw the gate over —
  // it is malformed, and nothing is declared in it.
  check(
    "a non-object dependency block is not a hit",
    findManifestDeclarations(project, EXCLUDED, () => ({ dependencies: ["apca-w3"] })),
    [],
  );
  // Fail closed: a manifest that cannot be read is a violation, because the
  // alternative is a package hiding behind a parse error.
  check(
    "a throwing reader is reported",
    findManifestDeclarations(project, EXCLUDED, () => {
      throw new Error("ENOENT: no such file");
    }).map((v) => v.field),
    ["unreadable manifest (ENOENT: no such file)"],
  );
  for (const [what, value] of [
    ["undefined", undefined],
    ["null", null],
    ["a string", "not-a-manifest"],
    ["an array", []],
  ]) {
    check(
      `a reader returning ${what} is reported as unreadable`,
      findManifestDeclarations(project, EXCLUDED, () => value).map((v) => v.field),
      [`unreadable manifest (manifest is not an object (${JSON.stringify(value) ?? "undefined"}))`],
    );
  }

  // --- (2) resolved in the lockfile --------------------------------------
  const LOCK_HEADER = "lockfileVersion: '9.0'\n";
  const lockCases = [
    [
      "an importer dependency entry",
      "importers:\n  packages/shared:\n    devDependencies:\n      apca-w3:\n        specifier: ^0.1.9\n        version: 0.1.9\n",
      ["apca-w3"],
    ],
    [
      "a packages section key",
      "packages:\n  apca-w3@0.1.9:\n    resolution: {integrity: sha512-Zrf6}\n",
      ["apca-w3"],
    ],
    [
      "a snapshot dependency line — the transitive arrival",
      "snapshots:\n  apca-w3@0.1.9:\n    dependencies:\n      colorparsley: 0.1.8\n  colorparsley@0.1.8: {}\n",
      ["apca-w3", "colorparsley", "colorparsley"],
    ],
    [
      "a catalog entry",
      "catalogs:\n  default:\n    apca-w3:\n      specifier: ^0.1.9\n",
      ["apca-w3"],
    ],
  ];
  for (const [what, body, expected] of lockCases) {
    check(
      `lockfile: ${what} is found`,
      findLockfileReferences(LOCK_HEADER + body, EXCLUDED).map((r) => r.name),
      expected,
    );
  }
  check(
    "lockfile: a clean lockfile passes",
    findLockfileReferences(
      `${LOCK_HEADER}packages:\n  culori@4.0.2:\n    resolution: {}\n`,
      EXCLUDED,
    ),
    [],
  );
  check(
    "lockfile: a longer name that merely starts the same is not a hit",
    findLockfileReferences(
      `${LOCK_HEADER}packages:\n  apca-w3-shim@1.0.0:\n    resolution: {}\n  colorparsley-fork@1.0.0: {}\n`,
      EXCLUDED,
    ),
    [],
  );
  check(
    "lockfile: the name inside an integrity hash or a URL is not a hit",
    findLockfileReferences(
      `${LOCK_HEADER}packages:\n  x@1.0.0:\n    resolution: {tarball: https://example.test/apca-w3.tgz, integrity: sha512-colorparsley}\n`,
      EXCLUDED,
    ),
    [],
  );
  check(
    "lockfile: the reported line number is the offending one",
    findLockfileReferences(`${LOCK_HEADER}packages:\n  apca-w3@0.1.9:\n`, EXCLUDED).map(
      (r) => r.line,
    ),
    [3],
  );
  for (const [what, text] of [
    ["empty", ""],
    ["not a lockfile", "packages:\n  - apps/*\n"],
    ["not a string", undefined],
  ]) {
    throws(
      `lockfile: a ${what} lockfile is refused`,
      () => findLockfileReferences(text, EXCLUDED),
      "refusing to report a vacuous pass",
    );
  }

  // --- (3) imported from source ------------------------------------------
  const importCases = [
    ['import { APCAcontrast } from "apca-w3";', true],
    ["import x from 'apca-w3';", true],
    ['export { sRGBtoY } from "apca-w3";', true],
    ['const m = await import("apca-w3");', true],
    ['const m = require("apca-w3");', true],
    ['import "apca-w3/dist/apca-w3.esm.js";', true],
    ['import { parse } from "colorparsley";', true],
    // Not imports: prose, and a package whose name merely contains one.
    ["// apca-w3 was removed by VC-412; see color.test.ts", false],
    // The shape this repository's comments actually use — a backticked name
    // after the word "from" is a sentence, not a specifier.
    ["// They used to be read from `apca-w3`, a second implementation.", false],
    ['import { x } from "apca-w3-shim";', false],
    ['import { x } from "@scope/colorparsley-fork";', false],
    ['const name = "apca-w3";', false],
  ];
  for (const [line, expected] of importCases) {
    check(
      `import scan: ${JSON.stringify(line)}`,
      findSourceImports(["/f/a.ts"], EXCLUDED, () => line).length > 0,
      expected,
    );
  }
  check(
    "import scan: the reported line number is the offending one",
    findSourceImports(["/f/a.ts"], EXCLUDED, () => 'const a = 1;\n\nimport "apca-w3";\n').map(
      (v) => v.line,
    ),
    [3],
  );

  // --- the live tree: the enumerators must actually select something -----
  const sourceFiles = enumerateSourceFiles();
  if (sourceFiles.length < 100) {
    failures.push(`source enumeration found only ${sourceFiles.length} files — matcher is broken`);
  }
  if (!sourceFiles.some((file) => file.endsWith("packages/shared/src/theme/color.ts"))) {
    failures.push("source enumeration missed packages/shared/src/theme/color.ts");
  }
  // The one exemption, and proof it is one file rather than a directory: this
  // gate is skipped, the gate beside it is not.
  if (sourceFiles.some((file) => file.endsWith(SELF_RELATIVE_PATH))) {
    failures.push(`source enumeration did not exempt ${SELF_RELATIVE_PATH}`);
  }
  if (!sourceFiles.some((file) => file.endsWith("scripts/check-workspace-licenses.mjs"))) {
    failures.push("source enumeration exempted more than itself under scripts/");
  }
  findLockfileReferences(readFileSync(resolve(REPO_ROOT, "pnpm-lock.yaml"), "utf8"), EXCLUDED);

  if (failures.length > 0) {
    console.error(
      ["check-excluded-dependencies self-test failed:", ...failures.map((f) => `  - ${f}`)].join(
        "\n",
      ),
    );
    process.exit(1);
  }
  console.log("check-excluded-dependencies self-test passed");
}

/**
 * Whether this file is the entry point rather than an import — compared
 * through `realpathSync` on both sides, for the reason
 * `check-workspace-licenses.mjs` documents at length: a comparison that a
 * symlinked path (`/tmp`, a worktree behind a link) answers "no" to turns a
 * gate into a silent pass. This repository's ticket worktrees live behind
 * exactly such a path.
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
  if (process.argv.includes("--self-test")) {
    selfTest();
  } else {
    runCheck();
  }
}

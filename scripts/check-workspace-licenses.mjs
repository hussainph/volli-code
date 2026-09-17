/**
 * Ensures every project in this pnpm workspace declares the repository
 * license in its own package manifest.
 *
 *     vp run check:workspace-licenses                       # the gate, after its own tests
 *     node scripts/check-workspace-licenses.mjs             # the gate
 *     node scripts/check-workspace-licenses.mjs --self-test # the matcher's own tests
 *
 * WHY THIS EXISTS (VC-411). The root manifest declared Apache-2.0 while all
 * nine workspace manifests declared nothing, so every package in the tree was
 * unlicensed as far as tooling — SBOM scanners, `pnpm licenses`, any future
 * publish — could tell. Fixing the nine is a one-time edit; the tenth package
 * added next month is the actual risk, which is why this is a gate and not a
 * commit.
 *
 * TWO DELIBERATE CHOICES, both about failing closed:
 *
 * (1) The required license is READ FROM the root manifest, never hardcoded
 *     here. The root `license` field is the one declaration; every other
 *     manifest must agree with it. A relicense is then an edit to the root
 *     plus the workspace set, and this gate is what proves the set moved
 *     together — a second hardcoded copy in this file could only ever drift
 *     from the thing it claims to enforce. Same rule as
 *     `apps/desktop/scripts/check-node-version.mjs`, which reads `engines.node`
 *     from the root manifest for the same reason.
 *
 * (2) The project list is derived from `pnpm-workspace.yaml` — the same file
 *     pnpm reads — rather than a second hand-maintained glob, so a newly added
 *     workspace package cannot silently skip the gate. It is parsed HERE
 *     rather than by shelling out to `pnpm ls`, because the CI runner that
 *     runs this check has no `pnpm` on its PATH (vite-plus manages the package
 *     manager internally), and a gate that cannot start is a gate that does
 *     not gate. The parser understands exactly the shape this repo's
 *     `packages:` block uses and THROWS on anything else, so a future
 *     workspace shape this file cannot read fails loudly here instead of
 *     quietly enumerating nothing and reporting success.
 */

import {
  globSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..");

/**
 * The `packages:` globs from a `pnpm-workspace.yaml`.
 *
 * A deliberately narrow parser, not a YAML implementation: it reads the one
 * block shape this repo uses (a top-level `packages:` key followed by an
 * indented `- glob` list) and throws on everything else. Throwing is the
 * point — an unreadable workspace file must stop the gate, because the
 * alternative is enumerating zero projects and calling that a pass.
 */
export function parseWorkspaceGlobs(yamlText) {
  const lines = yamlText.split(/\r?\n/);
  const headerIndex = lines.findIndex((line) => line.startsWith("packages:"));
  if (headerIndex === -1) {
    throw new Error("pnpm-workspace.yaml has no top-level `packages:` key");
  }

  const header = lines[headerIndex];
  const inlineValue = header.slice("packages:".length).trim();
  if (inlineValue !== "") {
    throw new Error(
      `check-workspace-licenses.mjs only understands a block \`packages:\` list; ` +
        `found inline value "${inlineValue}" — teach the parser alongside the change.`,
    );
  }

  const globs = [];
  for (const line of lines.slice(headerIndex + 1)) {
    if (line.trim() === "" || /^\s*#/.test(line)) continue;
    // A non-indented, non-comment line ends the block: it is the next key.
    if (!/^\s/.test(line)) break;

    const item = /^\s+-\s*(.+?)\s*$/.exec(line);
    if (item === null) {
      throw new Error(
        `check-workspace-licenses.mjs cannot read this \`packages:\` entry: ${JSON.stringify(line)}`,
      );
    }
    const glob = item[1].replace(/^["']|["']$/g, "");
    if (glob === "" || /[\s#]/.test(glob)) {
      throw new Error(
        `check-workspace-licenses.mjs cannot read this \`packages:\` glob: ${JSON.stringify(item[1])}`,
      );
    }
    if (glob.startsWith("!")) {
      throw new Error(
        `check-workspace-licenses.mjs does not understand negated workspace globs ` +
          `(${JSON.stringify(glob)}) — teach the matcher alongside the change, so the ` +
          `gate never silently checks a package pnpm excludes.`,
      );
    }
    globs.push(glob);
  }

  if (globs.length === 0) {
    throw new Error("pnpm-workspace.yaml declares an empty `packages:` list");
  }
  return globs;
}

/**
 * Every project in the workspace: the root, plus each manifest the
 * `packages:` globs resolve to. Returns absolute manifest paths, de-duplicated
 * and sorted, so two globs matching one package yield one project and the
 * report reads in the same order on every machine.
 */
export function enumerateWorkspaceProjects({ repoRoot = REPO_ROOT } = {}) {
  const workspaceFile = resolve(repoRoot, "pnpm-workspace.yaml");
  const globs = parseWorkspaceGlobs(readFileSync(workspaceFile, "utf8"));

  const manifestPaths = new Set([resolve(repoRoot, "package.json")]);
  for (const glob of globs) {
    for (const match of globSync(`${glob}/package.json`, { cwd: repoRoot })) {
      manifestPaths.add(resolve(repoRoot, match));
    }
  }

  const projects = [...manifestPaths].toSorted().map((manifestPath) => ({ manifestPath }));
  if (projects.length < 2) {
    throw new Error(
      `pnpm-workspace.yaml globs (${globs.join(", ")}) resolved to no workspace packages — ` +
        `the matcher is broken or the workspace moved; refusing to report a vacuous pass.`,
    );
  }
  return projects;
}

/**
 * The license every manifest must declare, taken from the root manifest.
 * Throws rather than defaulting: a gate with no declared subject is a gate
 * that passes everything.
 */
export function requiredLicense(rootManifest) {
  const license = rootManifest?.license;
  if (typeof license !== "string" || license.trim() === "") {
    throw new Error(
      `the root package.json must declare a non-empty string \`license\`; found ` +
        `${JSON.stringify(license)} — this gate has nothing to enforce without it.`,
    );
  }
  return license;
}

/** Every project whose manifest does not declare exactly `expected`. */
export function findLicenseViolations(projects, expected, readManifest = readManifestFromDisk) {
  return projects.flatMap((project) => {
    const { manifestPath } = project;
    let actual;
    try {
      const manifest = readManifest(manifestPath);
      if (manifest === null || typeof manifest !== "object" || Array.isArray(manifest)) {
        throw new Error(`manifest is not an object (${JSON.stringify(manifest) ?? "undefined"})`);
      }
      if (manifest.license === expected) return [];
      actual = manifest.license === undefined ? "missing" : JSON.stringify(manifest.license);
    } catch (error) {
      actual = `unreadable manifest (${error.message})`;
    }
    return [{ manifestPath, actual }];
  });
}

function readManifestFromDisk(manifestPath) {
  return JSON.parse(readFileSync(manifestPath, "utf8"));
}

function relativeManifestPath(manifestPath) {
  return relative(REPO_ROOT, manifestPath) || "package.json";
}

function runCheck() {
  const projects = enumerateWorkspaceProjects();
  const expected = requiredLicense(readManifestFromDisk(resolve(REPO_ROOT, "package.json")));
  const violations = findLicenseViolations(projects, expected);

  if (violations.length > 0) {
    console.error(
      [
        `[volli] Workspace license check failed: every workspace manifest must declare`,
        `  "license": ${JSON.stringify(expected)}  (the value the root package.json declares).`,
        ``,
        ...violations.map(
          ({ manifestPath, actual }) => `  - ${relativeManifestPath(manifestPath)}: ${actual}`,
        ),
        ``,
        `Fix: add the license field to each manifest above, or — if the repository is`,
        `being relicensed — change the root package.json and the whole workspace set`,
        `together, which is the disagreement this gate exists to catch.`,
      ].join("\n"),
    );
    process.exitCode = 1;
    return;
  }

  console.log(
    `[volli] Workspace license check passed: ${projects.length} workspace projects declare ${expected}.`,
  );
}

function selfTest() {
  const failures = [];
  const check = (what, actual, expected) => {
    const a = JSON.stringify(actual);
    const e = JSON.stringify(expected);
    if (a !== e) failures.push(`${what}: expected ${e}, received ${a}`);
  };
  // Asserts WHY it threw, not merely that it did. Several of these inputs
  // fail somewhere downstream anyway if their own guard is removed, so a bare
  // "did it throw" would pass while the diagnostic the caller reads silently
  // became the wrong one.
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

  // --- the matcher: what counts as a violation ---------------------------
  // Fixtures use the LITERAL license, never the value the gate reads from the
  // root manifest. A fixture defined in terms of the subject under test can
  // never disagree with it, and an assertion that cannot fail is not a test.
  const EXPECTED = "Apache-2.0";
  const cases = [
    ["exact match passes", { license: "Apache-2.0" }, null],
    ["missing license", {}, "missing"],
    ["divergent license", { license: "MIT" }, '"MIT"'],
    ["case variant is not a match", { license: "apache-2.0" }, '"apache-2.0"'],
    ["SPDX expression is not a match", { license: "Apache-2.0 OR MIT" }, '"Apache-2.0 OR MIT"'],
    ["padded value is not a match", { license: " Apache-2.0 " }, '" Apache-2.0 "'],
    ["deprecated object form", { license: { type: "Apache-2.0" } }, '{"type":"Apache-2.0"}'],
    ["null license", { license: null }, "null"],
    ["non-string license", { license: 1 }, "1"],
    ["deprecated `licenses` array is not a license", { licenses: ["Apache-2.0"] }, "missing"],
  ];
  for (const [what, manifest, expectedActual] of cases) {
    const violations = findLicenseViolations(
      [{ manifestPath: "/f/p/package.json" }],
      EXPECTED,
      () => structuredClone(manifest),
    );
    check(what, violations.length === 0 ? null : violations[0].actual, expectedActual);
  }

  // A reader that throws, and one that returns a non-object, must both be
  // reported as violations rather than crashing the run or passing silently.
  const unreadable = findLicenseViolations(
    [{ manifestPath: "/f/p/package.json" }],
    EXPECTED,
    () => {
      throw new Error("ENOENT: no such file");
    },
  );
  check("throwing reader is reported", unreadable.length, 1);
  check(
    "throwing reader explains itself",
    unreadable[0]?.actual,
    "unreadable manifest (ENOENT: no such file)",
  );
  // A reader that returns something that is not a manifest must be reported
  // as unreadable. Asserting the MESSAGE, not just the count: "not an object"
  // and "declares no license" are different faults, and a check that cannot
  // tell them apart would let a JSON string through as a merely-missing field.
  for (const [what, value] of [
    ["undefined", undefined],
    ["null", null],
    ["a string", "not-a-manifest"],
    ["an array", []],
  ]) {
    const result = findLicenseViolations(
      [{ manifestPath: "/f/p/package.json" }],
      EXPECTED,
      () => value,
    );
    check(
      `reader returning ${what} is reported as unreadable, not thrown`,
      result.map((v) => v.actual),
      [`unreadable manifest (manifest is not an object (${JSON.stringify(value) ?? "undefined"}))`],
    );
  }

  // Reporting is per-project and order-independent: several bad manifests are
  // all named, not just the first.
  const many = findLicenseViolations(
    [
      { manifestPath: "/f/a/package.json" },
      { manifestPath: "/f/b/package.json" },
      { manifestPath: "/f/c/package.json" },
    ],
    EXPECTED,
    (path) => (path === "/f/b/package.json" ? { license: "Apache-2.0" } : { license: "MIT" }),
  );
  check("every violating project is named", many.map((v) => v.manifestPath).toSorted(), [
    "/f/a/package.json",
    "/f/c/package.json",
  ]);

  // --- the subject: where the required license comes from ----------------
  check(
    "required license is read from the root manifest",
    requiredLicense({ license: "MIT" }),
    "MIT",
  );
  for (const [what, manifest] of [
    ["missing", {}],
    ["empty", { license: "   " }],
    ["non-string", { license: { type: "MIT" } }],
    ["absent manifest", undefined],
  ]) {
    throws(
      `a ${what} root license is refused`,
      () => requiredLicense(manifest),
      "must declare a non-empty string",
    );
  }

  // --- the enumerator: which projects are in scope -----------------------
  check(
    "block list is parsed",
    parseWorkspaceGlobs("packages:\n  - apps/*\n  - packages/*\n\nengineStrict: true\n"),
    ["apps/*", "packages/*"],
  );
  check(
    "comments and quotes are tolerated",
    parseWorkspaceGlobs('packages:\n  # a comment\n  - "apps/*"\n'),
    ["apps/*"],
  );
  check(
    "the list stops at the next top-level key",
    parseWorkspaceGlobs("packages:\n  - apps/*\nonlyBuiltDependencies:\n  - esbuild\n"),
    ["apps/*"],
  );
  throws(
    "a missing `packages:` key is refused",
    () => parseWorkspaceGlobs("engineStrict: true\n"),
    "no top-level `packages:` key",
  );
  throws(
    "an empty `packages:` list is refused",
    () => parseWorkspaceGlobs("packages:\n"),
    "empty `packages:` list",
  );
  throws(
    "an inline flow list is refused",
    () => parseWorkspaceGlobs("packages: [apps/*]\n"),
    "only understands a block",
  );
  throws(
    "a negated glob is refused",
    () => parseWorkspaceGlobs("packages:\n  - '!apps/legacy'\n"),
    "does not understand negated workspace globs",
  );
  throws(
    "an entry that is not a list item is refused",
    () => parseWorkspaceGlobs("packages:\n  apps/*\n"),
    "cannot read this `packages:` entry",
  );
  throws(
    "a glob carrying an inline comment is refused",
    () => parseWorkspaceGlobs("packages:\n  - apps/* # trailing\n"),
    "cannot read this `packages:` glob",
  );

  // Enumeration, against a throwaway workspace on disk. This is the half that
  // decides WHICH manifests the gate is even looking at, so a bug here is a
  // gate that silently checks fewer projects than the workspace holds.
  const fixtureRoot = mkdtempSync(resolve(tmpdir(), "volli-license-check-"));
  try {
    const write = (relativePath, contents) => {
      const target = resolve(fixtureRoot, relativePath);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, contents);
    };
    write("pnpm-workspace.yaml", "packages:\n  - apps/*\n");
    write("package.json", "{}");
    write("apps/a/package.json", "{}");
    write("apps/b/package.json", "{}");
    // Outside every glob: proof the enumerator selects rather than walks.
    write("other/c/package.json", "{}");
    // Nested below a matched package: pnpm treats apps/a as one project.
    write("apps/a/node_modules/dep/package.json", "{}");

    check(
      "enumeration finds the root and every globbed package, and nothing else",
      enumerateWorkspaceProjects({ repoRoot: fixtureRoot }).map((p) =>
        relative(fixtureRoot, p.manifestPath),
      ),
      ["apps/a/package.json", "apps/b/package.json", "package.json"],
    );

    // A glob set that matches no package must STOP the gate. Reporting "0
    // projects, all fine" is the one failure this check cannot be allowed to
    // produce, because it looks exactly like success.
    rmSync(resolve(fixtureRoot, "apps"), { recursive: true, force: true });
    throws(
      "globs matching no workspace package are refused",
      () => enumerateWorkspaceProjects({ repoRoot: fixtureRoot }),
      "refusing to report a vacuous pass",
    );
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }

  // The live workspace file must be a shape this parser can actually read.
  parseWorkspaceGlobs(readFileSync(resolve(REPO_ROOT, "pnpm-workspace.yaml"), "utf8"));

  if (failures.length > 0) {
    console.error(
      ["check-workspace-licenses self-test failed:", ...failures.map((f) => `  - ${f}`)].join("\n"),
    );
    process.exit(1);
  }
  console.log(`check-workspace-licenses self-test passed (${cases.length + 21} assertions)`);
}

/**
 * Whether this file is the entry point, rather than an import.
 *
 * Compared through `realpathSync` on BOTH sides: the obvious
 * `import.meta.url === pathToFileURL(process.argv[1]).href` form silently
 * answers "no" whenever the invoking path crosses a symlink (macOS `/tmp` ->
 * `/private/tmp`, a symlinked checkout, a worktree behind a link), and a gate
 * that answers "no" does nothing and exits 0 — a silent pass, which is the
 * one outcome a gate must never produce. An argv[1] that cannot be resolved
 * means this file was not launched as a script, so it is an import.
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

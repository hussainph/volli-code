/**
 * Ensures every project pnpm discovers in this workspace declares the
 * repository license in its own package manifest.
 *
 *     pnpm run check:workspace-licenses
 *
 * The project list comes from pnpm rather than a second hand-maintained glob,
 * so a newly added workspace package cannot silently skip the metadata gate.
 * The root project is included in pnpm's project list and is checked too.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..");
const REQUIRED_LICENSE = "Apache-2.0";
const PNPM_PROJECT_LIST_ARGS = ["ls", "--recursive", "--json", "--depth", "-1", "--only-projects"];

/** Enumerate projects through pnpm's workspace resolver. */
export function enumerateWorkspaceProjects({ cwd = REPO_ROOT, pnpm = "pnpm" } = {}) {
  const output = execFileSync(pnpm, PNPM_PROJECT_LIST_ARGS, {
    cwd,
    encoding: "utf8",
  });
  const projects = JSON.parse(output);
  if (!Array.isArray(projects)) {
    throw new Error("pnpm returned a workspace project list that was not an array");
  }
  return projects;
}

/** Return every workspace project whose manifest does not declare the exact license. */
export function findLicenseViolations(projects, readManifest = readManifestFromDisk) {
  return projects.flatMap((project) => {
    const manifestPath = resolve(project.path, "package.json");
    let manifest;
    try {
      manifest = readManifest(manifestPath);
    } catch (error) {
      return [
        {
          name: project.name ?? "(unnamed project)",
          manifestPath,
          actual: `unreadable manifest (${error.message})`,
        },
      ];
    }

    if (manifest.license === REQUIRED_LICENSE) return [];
    return [
      {
        name: project.name ?? "(unnamed project)",
        manifestPath,
        actual: manifest.license === undefined ? "missing" : JSON.stringify(manifest.license),
      },
    ];
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
  const violations = findLicenseViolations(projects);
  if (violations.length > 0) {
    console.error(
      [
        `[volli] Workspace license check failed: expected ${JSON.stringify(REQUIRED_LICENSE)}.`,
        ...violations.map(
          ({ name, manifestPath, actual }) =>
            `  - ${relativeManifestPath(manifestPath)} (${name}): ${actual}`,
        ),
      ].join("\n"),
    );
    process.exitCode = 1;
    return;
  }

  console.log(
    `[volli] Workspace license check passed: ${projects.length} pnpm projects declare ${REQUIRED_LICENSE}.`,
  );
}

function selfTest() {
  const fixtureRoot = "/fixture";
  const projects = [
    { name: "@fixture/ok", path: `${fixtureRoot}/ok` },
    { name: "@fixture/missing", path: `${fixtureRoot}/missing` },
    { name: "@fixture/divergent", path: `${fixtureRoot}/divergent` },
  ];
  const manifests = new Map([
    [`${fixtureRoot}/ok/package.json`, { license: REQUIRED_LICENSE }],
    [`${fixtureRoot}/missing/package.json`, {}],
    [`${fixtureRoot}/divergent/package.json`, { license: "MIT" }],
  ]);
  const violations = findLicenseViolations(projects, (manifestPath) => manifests.get(manifestPath));

  if (violations.length !== 2) {
    throw new Error(`expected two fixture violations, received ${violations.length}`);
  }
  const details = violations.map(({ name, actual }) => `${name}:${actual}`).join(", ");
  if (details !== '@fixture/missing:missing, @fixture/divergent:"MIT"') {
    throw new Error(`unexpected fixture violation details: ${details}`);
  }

  console.log("check-workspace-licenses self-test passed");
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  if (process.argv.includes("--self-test")) {
    selfTest();
  } else {
    runCheck();
  }
}

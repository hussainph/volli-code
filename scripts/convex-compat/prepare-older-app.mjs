#!/usr/bin/env node
/**
 * Materializes the newest shipped build from its own git tree, for the
 * older-app live lane (VC-1019).
 *
 *   node scripts/convex-compat/prepare-older-app.mjs --latest    --out <dir>
 *   node scripts/convex-compat/prepare-older-app.mjs --tag v0.3.0-canary.1 --out <dir>
 *
 * `--latest` is the newest `v*` tag by semver with prereleases included (see
 * `./tags.mjs`): the build people are running — the latest stable release when
 * no canary is newer than it, the newest canary otherwise. `--tag` names one
 * explicitly, for reproducing a run from the log.
 *
 * The tag's whole tree is extracted with `git archive` (no checkout, no
 * `.git`, nothing written to this repository), its own lockfile is installed
 * with lifecycle scripts off, and `<out>/<commit>/older-app.json` records what
 * was prepared:
 *
 *   { tag, commit, appVersion, tree, suites, absent, convexApi, generatedApi }
 *
 * `suites` is the lane's suite list filtered to the files that tag actually
 * ships — a build that predates a suite runs the rest, and the manifest says
 * which ones it could not run rather than pretending they passed. The install
 * is the desktop's own dependency tree (`@volli/desktop...`), so the older
 * build's sources, its `@volli/shared`, its `convex/functions/_generated` API
 * and its `convex` npm client all come from the tag.
 *
 * This is `packages/host-core/scripts/n1/prepare.mjs`'s pattern — extract,
 * install the tree's own lockfile, write the manifest last — for a different
 * question: N-1 asks whether an older build can still read and write the
 * profile, this asks whether an older build can still talk to the backend.
 *
 * Prints the manifest path on the last line. Re-running for an
 * already-prepared commit reuses it.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import { appendStepSummary, chooseSuites, olderDependencies, renderPrepared } from "./harness.mjs";
import { latestTag } from "./tags.mjs";
import { extractTree, installTree } from "./materialize.mjs";

/** Written last: its presence is what marks the tree complete. */
const MANIFEST = "older-app.json";
const DESKTOP = "@volli/desktop";

function git(args) {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

/** The tag's desktop version, which must be the tag's own version — that is what shipped. */
function appVersion(tree, tag) {
  const path = join(tree, "apps", "desktop", "package.json");
  if (!existsSync(path)) throw new Error(`${tag} has no apps/desktop/package.json`);
  const { version } = JSON.parse(readFileSync(path, "utf8"));
  const expected = tag.replace(/^v/, "");
  if (version !== expected) {
    throw new Error(`${tag} ships ${DESKTOP} ${version}, not ${expected}: not a released build`);
  }
  return version;
}

/** A prepared tree's manifest, or null when this commit has not been prepared. */
function readManifest(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function main() {
  const { values } = parseArgs({
    options: {
      latest: { type: "boolean", default: false },
      tag: { type: "string" },
      out: { type: "string" },
    },
  });
  const chosen = [values.latest, values.tag !== undefined].filter(Boolean);
  if (chosen.length !== 1 || !values.out) {
    throw new Error("usage: prepare-older-app.mjs (--latest | --tag <tag>) --out <dir>");
  }
  const tag = values.latest ? latestTag(git(["tag", "--list", "v*"]).split("\n")) : values.tag;
  if (!tag) throw new Error("No v* version tag found; fetch tags first (git fetch --tags)");
  let commit;
  try {
    commit = git(["rev-parse", "--verify", `${tag}^{commit}`]);
  } catch {
    throw new Error(`${tag} is not a tag in this checkout; fetch tags first (git fetch --tags)`);
  }
  mkdirSync(resolve(values.out), { recursive: true });
  // Vitest reports realpaths (not macOS /tmp and /var symlink aliases).
  const tree = resolve(realpathSync(resolve(values.out)), commit);
  const manifestPath = join(tree, MANIFEST);

  let manifest = readManifest(manifestPath);
  if (manifest === null || manifest.commit !== commit) {
    extractTree(commit, tree);
    const version = appVersion(tree, tag);
    const { suites, absent } = chooseSuites(tree);
    if (suites.length === 0) {
      throw new Error(`${tag} ships none of the lane's live suites: ${absent.join(", ")}`);
    }
    installTree(tree, DESKTOP);
    const { convexApi, generatedApi } = olderDependencies(tree);
    manifest = { tag, commit, appVersion: version, tree, suites, absent, convexApi, generatedApi };
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  } else if (manifest.tag !== tag) {
    // Same commit, another tag pointing at it: the tree is the same build.
    manifest = { ...manifest, tag };
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  }

  console.log(
    `Older app is ${manifest.tag} (${manifest.commit}), ${DESKTOP} ${manifest.appVersion}, ` +
      `${manifest.suites.length} of ${manifest.suites.length + manifest.absent.length} live suite(s)`,
  );
  appendStepSummary(renderPrepared(manifest));
  console.log(manifestPath);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();

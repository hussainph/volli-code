#!/usr/bin/env node
/**
 * Materializes a previous build (N-1) for the N-1 compatibility job (VC-633).
 *
 *   node packages/host-core/scripts/n1/prepare.mjs --release   --out <dir>
 *   node packages/host-core/scripts/n1/prepare.mjs --canary    --out <dir>
 *   node packages/host-core/scripts/n1/prepare.mjs --ref <git ref> --out <dir>
 *
 * `--release` is the newest stable release tag (`vX.Y.Z`, no `-canary.N`
 * suffix): the build external users run and downgrade to. `--canary` is the
 * newest canary tag (`vX.Y.Z-canary.N`): the build a canary tester drops back
 * to when they hop between canaries. `--ref` is any
 * commit, which CI uses for the pull request's base (the build that knows
 * nothing about the change under test). The commit's whole tree is extracted
 * with `git archive` (no checkout, no `.git`, nothing written to this
 * repository), its own lockfile is installed with lifecycle scripts off, and
 * `<out>/<commit>/n1.json` records what was built:
 *
 *   { ref, commit, tree, hostSrc }
 *
 * `hostSrc` is where that build keeps the host modules the driver imports:
 * `packages/host-core/src` since the host-core extraction, and
 * `apps/desktop/src/main` before it (v0.2.1). Prints the manifest's path on the
 * last line. Re-running for an already-prepared commit reuses it.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const HOST_SOURCES = [
  { hostSrc: "packages/host-core/src", pkg: "@volli/host-core" },
  { hostSrc: "apps/desktop/src/main", pkg: "@volli/desktop" },
];

const STABLE = /^v(\d+)\.(\d+)\.(\d+)$/;
const CANARY = /^v(\d+)\.(\d+)\.(\d+)-canary\.(\d+)$/;

/** The tag among `tags` matching `shape` whose numeric parts are highest, in order. */
function newest(tags, shape) {
  const versioned = tags.flatMap((tag) => {
    const match = shape.exec(tag);
    return match ? [{ tag, parts: match.slice(1).map(Number) }] : [];
  });
  versioned.sort((a, b) => {
    for (let i = 0; i < a.parts.length; i++) {
      if (a.parts[i] !== b.parts[i]) return b.parts[i] - a.parts[i];
    }
    return 0;
  });
  return versioned[0]?.tag ?? null;
}

/** The newest `vX.Y.Z` tag, by version order; prereleases (`-canary.N`) are not releases. */
export function latestReleaseTag(tags) {
  return newest(tags, STABLE);
}

/**
 * The newest `vX.Y.Z-canary.N` tag, by version order and then canary number
 * (numerically: `canary.10` beats `canary.9`). Stable tags are not canaries.
 */
export function latestCanaryTag(tags) {
  return newest(tags, CANARY);
}

function git(args) {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

function install(tree, pkg) {
  // `vp` is the toolchain CI provides (pnpm is not a command on its runners);
  // a dev machine has either. Scripts stay off: N-1 needs only better-sqlite3,
  // whose N-API prebuild ships inside the package.
  const args = ["install", "--frozen-lockfile", "--ignore-scripts", "--filter", `${pkg}...`];
  for (const bin of ["vp", "pnpm"]) {
    const run = spawnSync(bin, args, { cwd: tree, stdio: "inherit" });
    if (run.error?.code === "ENOENT") continue;
    if (run.status !== 0) throw new Error(`${bin} install failed in ${tree}`);
    return;
  }
  throw new Error("Neither vp nor pnpm is on PATH");
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
      release: { type: "boolean", default: false },
      canary: { type: "boolean", default: false },
      ref: { type: "string" },
      out: { type: "string" },
    },
  });
  const chosen = [values.release, values.canary, values.ref !== undefined].filter(Boolean);
  if (chosen.length !== 1 || !values.out) {
    throw new Error("usage: prepare.mjs (--release | --canary | --ref <ref>) --out <dir>");
  }
  const tags = () => git(["tag", "--list", "v*"]).split("\n");
  const ref = values.release
    ? latestReleaseTag(tags())
    : values.canary
      ? latestCanaryTag(tags())
      : values.ref;
  if (!ref) throw new Error("No matching tag found; fetch tags first (git fetch --tags)");
  const commit = git(["rev-parse", "--verify", `${ref}^{commit}`]);
  const tree = resolve(values.out, commit);
  const manifestPath = join(tree, "n1.json");

  let manifest = readManifest(manifestPath);
  if (manifest === null) {
    rmSync(tree, { recursive: true, force: true });
    mkdirSync(tree, { recursive: true });
    const archive = spawnSync("git", ["archive", "--format=tar", commit], {
      maxBuffer: 1 << 30,
    });
    if (archive.status !== 0) throw new Error(`git archive ${commit} failed`);
    execFileSync("tar", ["-x", "-C", tree], { input: archive.stdout });
    const host = HOST_SOURCES.find(({ hostSrc }) =>
      existsSync(join(tree, hostSrc, "db", "migrations.ts")),
    );
    if (!host) throw new Error(`${ref} has no host database modules the driver knows`);
    install(tree, host.pkg);
    manifest = { ref, commit, tree, hostSrc: host.hostSrc };
    // Written last: its presence is what marks the tree complete.
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  }
  console.log(`N-1 is ${manifest.ref} (${manifest.commit}), host sources at ${manifest.hostSrc}`);
  console.log(manifestPath);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();

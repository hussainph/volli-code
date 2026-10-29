#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { contractChanges, latestAppTag, unapprovedChanges } from "./compatibility.mjs";
import { generateSnapshot, serialize } from "./snapshot.mjs";

const workspace = fileURLToPath(new URL("../../", import.meta.url));
const contractPath = "convex/api-contract.json";
const { values } = parseArgs({
  options: {
    check: { type: "boolean", default: false },
    base: { type: "string", multiple: true, default: [] },
  },
});
const root = workspace;
const git = (args) =>
  execFileSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).trim();

/** Pre-guard releases have no committed snapshot. Derive their actual source
 * contract instead of silently bootstrapping an empty baseline. Like the N-1
 * harness, archive an immutable commit and install its own frozen dependency
 * graph, with lifecycle scripts off. Never borrow HEAD's shared validators.
 */
async function baseline(ref) {
  const commit = git(["rev-parse", "--verify", `${ref}^{commit}`]);
  const paths = git(["ls-tree", "--name-only", commit, "--", contractPath]);
  if (paths) return JSON.parse(git(["show", `${commit}:${contractPath}`]));
  const scratch = resolve(root, ".scratch/convex-api");
  mkdirSync(scratch, { recursive: true });
  const tree = mkdtempSync(`${scratch}/baseline-`);
  try {
    const tar = execFileSync("git", ["archive", "--format=tar", commit], {
      cwd: root,
      maxBuffer: 256 * 1024 * 1024,
    });
    execFileSync("tar", ["-x", "-C", tree], { input: tar });
    if (!existsSync(resolve(tree, "convex/functions")))
      throw new Error(`${ref} has no Convex sources`);
    const args = [
      "install",
      "--frozen-lockfile",
      "--ignore-scripts",
      "--filter",
      "@volli/convex...",
    ];
    let installed = false;
    for (const bin of ["vp", "pnpm"]) {
      const result = spawnSync(bin, args, { cwd: tree, stdio: "inherit" });
      if (result.error?.code === "ENOENT") continue;
      if (result.error || result.status !== 0)
        throw new Error(`${bin} install failed for baseline ${ref}`);
      installed = true;
      break;
    }
    if (!installed) throw new Error("Neither vp nor pnpm is available to prepare the baseline");
    console.log(`Deriving pre-snapshot contract from ${ref} (${commit})`);
    return await generateSnapshot(tree);
  } finally {
    rmSync(tree, { recursive: true, force: true });
  }
}

const generated = await generateSnapshot(root);
const content = serialize(generated);
if (!values.check) {
  writeFileSync(resolve(root, contractPath), content);
  console.log(
    `Generated ${contractPath}: ${Object.keys(generated.functions).length} public functions`,
  );
} else {
  if (readFileSync(resolve(root, contractPath), "utf8") !== content)
    throw new Error(`Stale ${contractPath}; run node scripts/convex-api/generate.mjs`);
  console.log(`Fresh contract: ${contractPath}`);
  const released = latestAppTag(git(["tag", "--list", "v*"]).split("\n"));
  if (!released) throw new Error("No released app tag found; fetch full history and tags");
  const allowlist = JSON.parse(
    readFileSync(resolve(root, "convex/api-contract-allowlist.json"), "utf8"),
  );
  for (const ref of new Set([...values.base, released])) {
    const changes = contractChanges(await baseline(ref), generated);
    const unapproved = unapprovedChanges(changes, allowlist, released);
    for (const change of changes)
      console.log(`${ref}: ${change.function} ${change.path}: ${change.code}`);
    if (unapproved.length)
      throw new Error(`Non-additive Convex API changes against ${ref}:\n${serialize(unapproved)}`);
    console.log(
      `Additive Convex API check passed against ${ref} (${changes.length} approved exceptions)`,
    );
  }
}

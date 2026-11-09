/** The N-1 harness pattern, shared by the API baseline and older-app lane:
 * archive an immutable revision without switching this checkout, then install
 * that tree's own frozen dependency graph with lifecycle scripts disabled.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";

export function extractTree(commit, tree, cwd = process.cwd()) {
  const archive = execFileSync("git", ["archive", "--format=tar", commit], {
    cwd,
    maxBuffer: 256 * 1024 * 1024,
  });
  rmSync(tree, { recursive: true, force: true });
  mkdirSync(tree, { recursive: true });
  execFileSync("tar", ["-x", "-C", tree], { input: archive });
}

export function installTree(tree, pkg) {
  const args = ["install", "--frozen-lockfile", "--ignore-scripts", "--filter", `${pkg}...`];
  for (const bin of ["vp", "pnpm"]) {
    const result = spawnSync(bin, args, { cwd: tree, stdio: "inherit" });
    if (result.error?.code === "ENOENT") continue;
    if (result.error || result.status !== 0) throw new Error(`${bin} install failed in ${tree}`);
    return;
  }
  throw new Error("Neither vp nor pnpm is on PATH");
}

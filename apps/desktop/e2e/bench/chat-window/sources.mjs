/** Source snapshots live under this checkout, never modify another worktree.
 * Archives retain the exact product commit. Only measurement/driver files are
 * overlaid; every overlay byte and every product file has a separate digest.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { cp, lstat, mkdir, open, readFile, readdir, readlink, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
const exec = promisify(execFile);
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const overlayRoots = [
  "apps/desktop/e2e/volli-drive",
  "apps/desktop/e2e/bench/chat-window",
  "apps/desktop/e2e/chat-window-bench.mjs",
  "apps/desktop/e2e/lib/smoke-kit.mjs",
  "apps/desktop/e2e/lib/agent-kit.mjs",
];
const overlayPath = (path) =>
  overlayRoots.some((root) => path === root || path.startsWith(root + "/"));
async function files(root, prefix = "") {
  const result = [];
  for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
    if (
      ["dist", "dist-electron", "out", "coverage", "node_modules", ".scratch", ".git"].includes(
        entry.name,
      )
    )
      continue;
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) result.push(...(await files(root, path)));
    else result.push(path);
  }
  return result.toSorted();
}
async function fileDigest(root, path) {
  const absolute = join(root, path);
  let handle;
  try {
    // Refuse symlink traversal atomically. Nonblocking open also lets the
    // descriptor check reject a substituted FIFO without waiting for a writer.
    handle = await open(
      absolute,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  } catch (error) {
    if (error.code !== "ELOOP") throw error;
    // readlink reads the link itself, including links to directories. If it
    // was replaced by a regular file after open refused it, readlink fails.
    return `symlink:${sha256(JSON.stringify([path, await readlink(absolute)]))}`;
  }
  try {
    // Check and read the SAME open descriptor, never reopen a checked path
    // (CodeQL js/file-system-race). Replacement cannot redirect this read.
    if (!(await handle.stat()).isFile()) throw new Error(`unsupported source entry: ${path}`);
    return sha256(await handle.readFile());
  } finally {
    await handle.close();
  }
}
async function digests(root, paths) {
  const result = {};
  for (const path of paths) result[path] = await fileDigest(root, path);
  return result;
}
export async function overlayManifest(repo) {
  const paths = (await files(join(repo, "apps/desktop/e2e")))
    .map((path) => `apps/desktop/e2e/${path}`)
    .filter(overlayPath);
  return digests(repo, paths);
}
export async function prepareSources(repo, refs, root) {
  await mkdir(root, { recursive: true });
  const overlay = await overlayManifest(repo);
  const sides = [];
  for (const [index, ref] of refs.entries()) {
    const { stdout } = await exec(
      "git",
      ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`],
      { cwd: repo },
    );
    const commit = stdout.trim();
    if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error("invalid source commit");
    const dir = join(root, `${index}-${commit}`);
    const metadataPath = join(dir, ".chat-window-source.json");
    let metadata;
    try {
      metadata = JSON.parse(await readFile(metadataPath, "utf8"));
    } catch {
      /* new snapshot */
    }
    if (metadata) {
      if (
        metadata.commit !== commit ||
        JSON.stringify(metadata.overlay.files) !== JSON.stringify(overlay)
      )
        throw new Error(`snapshot/overlay changed: choose a fresh --output directory (${dir})`);
    } else {
      // Do not overwrite a partial or user-created tree.
      await mkdir(dir);
      const archive = join(root, `${index}.tar`);
      await exec("git", ["archive", "--format=tar", `--output=${archive}`, commit], { cwd: repo });
      try {
        await exec("tar", ["-xf", archive, "-C", dir]);
      } finally {
        await rm(archive, { force: true });
      }
      const archivedPaths = await files(dir);
      const product = await digests(
        dir,
        archivedPaths.filter((path) => !overlayPath(path)),
      );
      const removed = [
        ...new Set([
          ...archivedPaths.filter((path) => overlayPath(path) && !(path in overlay)),
          "apps/desktop/e2e/bench/chat-window/electron-main.cjs",
        ]),
      ].toSorted();
      for (const path of overlayRoots) await rm(join(dir, path), { recursive: true, force: true });
      for (const path of Object.keys(overlay)) {
        await mkdir(join(dir, path, ".."), { recursive: true });
        await cp(join(repo, path), join(dir, path), { verbatimSymlinks: true });
      }
      // The historical direct host must not survive even in a prepared tree.
      await rm(join(dir, "apps/desktop/e2e/bench/chat-window/electron-main.cjs"), { force: true });
      metadata = { ref, commit, product, overlay: { files: overlay, removed } };
      await writeFile(metadataPath, JSON.stringify(metadata, null, 2) + "\n");
    }
    await verifySource(dir, metadata);
    sides.push({ dir, metadata });
  }
  return sides;
}
export async function verifySource(dir, metadata) {
  const paths = await files(dir);
  for (const path of paths) {
    if (/^(apps|packages)\/[^/]+\/src\//.test(path) && !(path in metadata.product))
      throw new Error(`unreported product source added: ${path}`);
  }
  for (const [path, digest] of Object.entries({ ...metadata.product, ...metadata.overlay.files })) {
    if ((await fileDigest(dir, path)) !== digest)
      throw new Error(`source changed since preparation: ${path}`);
  }
  for (const path of metadata.overlay.removed) {
    try {
      await lstat(join(dir, path));
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
    throw new Error(`unsafe legacy entry restored: ${path}`);
  }
}

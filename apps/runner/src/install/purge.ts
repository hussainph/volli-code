import { chmodSync, lstatSync, readdirSync, rmdirSync, rmSync } from "node:fs";
import { join } from "node:path";

/** Runs only as the data owner. Module caches commonly leave directories 0555. */
export function purgeOwnedTree(path: string): void {
  const stat = lstatSync(path);
  if (stat.isDirectory()) {
    chmodSync(path, (stat.mode & 0o777) | 0o700);
    for (const name of readdirSync(path)) purgeOwnedTree(join(path, name));
    rmdirSync(path);
  } else {
    // In particular, unlink a symlink rather than traversing its target.
    rmSync(path);
  }
}

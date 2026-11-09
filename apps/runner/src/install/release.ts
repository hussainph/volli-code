import { chmodSync, lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";

/** Root's umask must not make its release unreadable to the service uid. Never follow symlinks. */
export function normalizeReleaseModes(path: string): boolean {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) return false;
  const mode = stat.isDirectory() || (stat.mode & 0o111) !== 0 ? 0o755 : 0o644;
  let changed = (stat.mode & 0o777) !== mode;
  if (changed) chmodSync(path, mode);
  if (stat.isDirectory()) {
    for (const name of readdirSync(path))
      changed = normalizeReleaseModes(join(path, name)) || changed;
  }
  return changed;
}

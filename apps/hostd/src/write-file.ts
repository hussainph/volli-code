/** Whole-file writes for the management commands (VC-700): never half a file, never a needless one. */
import { randomBytes } from "node:crypto";
import { chmodSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";

/** Replaces `path` whole: a temporary file beside it, renamed over. */
export function atomicWrite(path: string, content: string, mode: number): void {
  const temporary = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    writeFileSync(temporary, content, { mode, flag: "wx" });
    // The umask may have narrowed `mode`; a unit file must be readable as asked.
    chmodSync(temporary, mode);
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

/** Writes `content` only when it differs; answers whether it wrote. */
export function writeIfChanged(path: string, content: string, mode: number): boolean {
  let current: string | null;
  try {
    current = readFileSync(path, "utf8");
  } catch {
    current = null;
  }
  if (current === content) return false;
  atomicWrite(path, content, mode);
  return true;
}

/** Whole-file writes for the management commands (VC-700): never half a file. */
import { randomBytes } from "node:crypto";
import { chmodSync, renameSync, rmSync, writeFileSync } from "node:fs";

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

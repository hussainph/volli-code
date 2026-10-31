/** Whole-file writes for management commands (VC-700): never half a file. */
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  fchmodSync,
  fsyncSync,
  openSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

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

/**
 * {@link atomicWrite}, made durable: the temporary file is fsynced before the
 * rename and the directory after it, so a crash or a power cut right after
 * this returns finds the new bytes under `path`, and never half of them.
 * What a rotating credential needs: it is written before it is used.
 */
export function durableWrite(path: string, content: string | Uint8Array, mode: number): void {
  const temporary = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    const fd = openSync(temporary, "wx", mode);
    try {
      fchmodSync(fd, mode);
      writeFileSync(fd, content);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
  const directory = openSync(dirname(path), "r");
  try {
    fsyncSync(directory);
  } finally {
    closeSync(directory);
  }
}

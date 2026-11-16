/**
 * A whole-file copy that shares the source's blocks where the volume can
 * (VC-1105): the migration safety copy of a multi-gigabyte database.
 *
 * Node's `COPYFILE_FICLONE` is a reflink on Linux (btrfs, XFS) and a plain
 * copy everywhere it cannot be, but libuv never asks macOS to clone: on APFS a
 * 2 GB database takes seconds to copy with it, the same as without it, and
 * `COPYFILE_FICLONE_FORCE` fails with `ENOSYS`. macOS's own `cp -c` calls
 * `clonefile(2)`, which on APFS takes milliseconds and on a volume that cannot
 * clone (HFS+, exFAT, a network share) copies the bytes itself. Either way the
 * target holds the source's bytes as they were when the call returned: a
 * clone is copy-on-write, so later writes to the source never reach it.
 *
 * A clone also carries the source's timestamps, where a copy is stamped when
 * it is written. Recovery lists safety copies newest first by modification
 * time, in this build and in older ones, so a clone is restamped: its time is
 * when it was taken, exactly as a copy's was.
 *
 * A failed `cp` is followed by an ordinary copy, so the slowest outcome is
 * what every build before this one did.
 */
import { execFileSync } from "node:child_process";
import { constants, copyFileSync, utimesSync } from "node:fs";

/** How the bytes got there: `cp -c` (a clone on APFS) or Node's copy (a reflink where Linux offers one). */
export type FileCopyMethod = "cp-clone" | "copy";

export interface FileCloneDeps {
  readonly platform: NodeJS.Platform;
  /** `cp -c -- source target`; throws on a non-zero exit. */
  readonly cloneWithCp: (source: string, target: string) => void;
  readonly copyFile: (source: string, target: string, mode: number) => void;
  /** Stamps `target` as modified and accessed at `at`. */
  readonly touch: (target: string, at: Date) => void;
  readonly now: () => Date;
}

const MAC_CP = "/bin/cp";

const nodeDeps: FileCloneDeps = {
  platform: process.platform,
  cloneWithCp: (source, target) => {
    execFileSync(MAC_CP, ["-c", "--", source, target], { stdio: "ignore" });
  },
  copyFile: (source, target, mode) => copyFileSync(source, target, mode),
  touch: (target, at) => utimesSync(target, at, at),
  now: () => new Date(),
};

/**
 * Copies `source` to `target` (overwriting it), cloning where the volume can.
 * The caller makes the result durable; this only puts the bytes there.
 */
export function cloneOrCopyFile(
  source: string,
  target: string,
  deps: FileCloneDeps = nodeDeps,
): FileCopyMethod {
  if (deps.platform === "darwin") {
    let cloned = false;
    try {
      deps.cloneWithCp(source, target);
      cloned = true;
    } catch {
      // A missing or failing `cp` costs only the speed: copy as before.
    }
    if (cloned) {
      deps.touch(target, deps.now());
      return "cp-clone";
    }
  }
  deps.copyFile(source, target, constants.COPYFILE_FICLONE);
  return "copy";
}

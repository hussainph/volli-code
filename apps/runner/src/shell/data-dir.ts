/**
 * The boot checks on where a daemon keeps its state and its socket.
 *
 * The data directory is created 0700 when absent. It is refused when it is
 * not a directory, another user owns it, or every user can write it: any of
 * them could then rename the key or the database out from under the daemon.
 * Group-writable is a warning (user private groups make that group this user
 * alone), as is a `--socket` in a world-writable directory.
 */
import { mkdirSync, statSync } from "node:fs";
import { dirname } from "node:path";

import { BootError } from "./boot-error";
import type { ShellIdentity } from "./identity";
import type { ShellLogger } from "./log";

export function prepareDataDir(
  identity: ShellIdentity,
  dataDir: string,
  logger: ShellLogger,
): void {
  try {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  } catch (error) {
    throw new BootError(
      "data-dir",
      `Could not create the data directory ${dataDir}: ${(error as Error).message}`,
    );
  }
  // `mkdirSync` has already refused a path that is not a directory (EEXIST).
  const stat = statSync(dataDir);
  // The key file's rule (`file-key.ts`), one level up: a directory another
  // user owns is one they can replace the database or key inside.
  const uid = process.getuid!();
  if (stat.uid !== uid) {
    throw new BootError(
      "data-dir",
      `The data directory ${dataDir} belongs to uid ${stat.uid}, not to the user ` +
        `${identity.program} runs as (uid ${uid}), so it will not use it. Run: chown ${uid} ${dataDir}`,
    );
  }
  const mode = stat.mode & 0o777;
  const octal = mode.toString(8).padStart(4, "0");
  if ((mode & 0o002) !== 0) {
    throw new BootError(
      "data-dir",
      `Permissions ${octal} on the data directory ${dataDir} let every user write it, ` +
        `so any of them could replace its database or key. Run: chmod 700 ${dataDir}`,
    );
  }
  // Group-writable is only a warning: with user private groups (Debian and
  // Ubuntu's default umask 002) the group is this user alone.
  if ((mode & 0o020) !== 0) {
    logger.warn(
      "the data directory is group-writable; its group could replace the database or key",
      {
        dataDir,
        mode: octal,
        fix: `chmod 700 ${dataDir}`,
      },
    );
  }
}

/**
 * A socket outside the data directory gets the data directory's warning: in a
 * directory every user can write, another user can unlink it or squat on its
 * path between runs. The socket itself stays mode 0600 either way. A missing
 * directory is left to the socket's own open to report.
 */
export function warnOfSharedSocketDir(
  socketPath: string,
  dataDir: string,
  logger: ShellLogger,
): void {
  const directory = dirname(socketPath);
  if (directory === dataDir) return;
  let mode: number;
  try {
    mode = statSync(directory).mode & 0o777;
  } catch {
    return;
  }
  if ((mode & 0o002) !== 0) {
    logger.warn(
      "the socket's directory is world-writable; another user could unlink or squat on it",
      {
        socketPath,
        mode: mode.toString(8).padStart(4, "0"),
      },
    );
  }
}

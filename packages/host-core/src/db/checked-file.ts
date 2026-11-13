/**
 * The identity of a database file that was just checked and closed (VC-1105):
 * which inode, how big, when it last changed. While a file still has exactly
 * this identity, nothing has written it since, so the check need not be
 * repeated. Two handoffs use it, each within one process's run:
 *
 * - the upgrade worker hands the live file it closed to the host's open, which
 *   then skips the routine quick check (`database-upgrade.ts`);
 * - publishing a migration safety copy hands the copy it verified to
 *   retention in the same upgrade, which then skips re-checking it (VC-1204).
 *
 * Any difference, or an identity that cannot be read, means check again.
 * Nanosecond strings, so the handoff crosses a worker boundary intact. Never
 * stored: a later launch checks again.
 */
import { lstatSync } from "node:fs";

export interface CheckedDatabaseFile {
  readonly dev: string;
  readonly ino: string;
  readonly size: string;
  readonly mtimeNs: string;
  readonly ctimeNs: string;
}

/** The identity of a closed, checkpointed database file; `null` when it has a WAL with frames. */
export function checkedDatabaseFile(dbPath: string): CheckedDatabaseFile | null {
  const wal = lstatSync(`${dbPath}-wal`, { throwIfNoEntry: false });
  if (wal !== undefined && wal.size > 0) return null;
  const info = lstatSync(dbPath, { bigint: true });
  if (!info.isFile()) return null;
  return {
    dev: info.dev.toString(),
    ino: info.ino.toString(),
    size: info.size.toString(),
    mtimeNs: info.mtimeNs.toString(),
    ctimeNs: info.ctimeNs.toString(),
  };
}

/** Whether `dbPath` is still exactly the file `checked` describes. Throws when it cannot be read. */
export function isCheckedDatabaseFile(dbPath: string, checked: CheckedDatabaseFile): boolean {
  const now = checkedDatabaseFile(dbPath);
  return (
    now !== null &&
    now.dev === checked.dev &&
    now.ino === checked.ino &&
    now.size === checked.size &&
    now.mtimeNs === checked.mtimeNs &&
    now.ctimeNs === checked.ctimeNs
  );
}

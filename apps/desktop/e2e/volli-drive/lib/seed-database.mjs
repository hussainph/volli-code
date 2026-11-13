/**
 * `launch --database <file>` (VC-1105): start an instance on a copy of an
 * existing database instead of a fresh one, so a schema upgrade can be
 * replayed and watched on a real-sized profile.
 *
 * The source must be a closed, checkpointed database file: a migration safety
 * copy (`volli.db.backup-v<N>`), or a clone of one. A file with a WAL that
 * holds frames is refused: it is open somewhere (a live profile) or was not
 * checkpointed, and its base file alone is not the whole database. The
 * instance gets a clone (`cp -c`, instant on APFS; a full copy elsewhere), so
 * the source is never opened or written.
 */
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { isAbsolute } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Why `path` cannot seed an instance; empty when it can. */
export async function seedDatabaseProblems(path) {
  if (typeof path !== "string" || !isAbsolute(path)) return ["--database needs an absolute path"];
  const info = await fs.lstat(path).catch(() => null);
  if (info === null || !info.isFile()) return [`${path} is not a regular file`];
  const problems = [];
  const handle = await fs.open(path, "r");
  try {
    const header = Buffer.alloc(16);
    await handle.read(header, 0, 16, 0);
    if (header.toString("latin1") !== "SQLite format 3\0")
      problems.push(`${path} is not a SQLite database`);
  } finally {
    await handle.close();
  }
  for (const suffix of ["-wal", "-journal"]) {
    const sidecar = await fs.lstat(`${path}${suffix}`).catch(() => null);
    if (sidecar !== null && sidecar.size > 0)
      problems.push(
        `${path}${suffix} holds data: the database is open or was not checkpointed; use a closed copy`,
      );
  }
  return problems;
}

/** Clones (or, where the volume cannot, copies) `source` to `target`, private to this user. */
export async function seedDatabase(source, target, platform = process.platform) {
  if (platform === "darwin") await execFileAsync("/bin/cp", ["-c", "--", source, target]);
  else await fs.copyFile(source, target, fs.constants?.COPYFILE_FICLONE ?? 0);
  await fs.chmod(target, 0o600);
}

/** The schema-upgrade window's page: shown before the app's own window, never driven. */
export function isUpdatingPage(url) {
  try {
    const parsed = new URL(url);
    return parsed.pathname === "/updating.html" && parsed.searchParams.get("work") !== "check";
  } catch {
    return false;
  }
}

/**
 * A routine launch's database check, on the app's own window (VC-1203): the
 * same page with `work=check`. The window becomes the app's once the app has
 * loaded into it.
 */
export function isCheckingPage(url) {
  try {
    const parsed = new URL(url);
    return parsed.pathname === "/updating.html" && parsed.searchParams.get("work") === "check";
  } catch {
    return false;
  }
}

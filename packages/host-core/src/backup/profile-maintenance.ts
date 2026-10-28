/** Cross-thread/process pause requests for local-profile maintenance. A move
 * holds this for its WHOLE flow, including verification/commit, not just export.
 * Stale requests from a dead app do not suppress tomorrow's backups.
 */
import { randomUUID } from "node:crypto";
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { BACKUPS_DIRECTORY } from "./automatic";

const PAUSES = ".maintenance";

export async function withProfileMaintenance<Value>(
  dataDir: string,
  work: () => Promise<Value>,
): Promise<Value> {
  const directory = join(dataDir, BACKUPS_DIRECTORY, PAUSES);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, `${process.pid}-${randomUUID()}`);
  await writeFile(path, "", { flag: "wx", mode: 0o600 });
  try {
    return await work();
  } finally {
    await rm(path, { force: true });
  }
}

export async function profileMaintenanceActive(dataDir: string): Promise<boolean> {
  let names: string[];
  try {
    names = await readdir(join(dataDir, BACKUPS_DIRECTORY, PAUSES));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  return names.some((name) => {
    const match = /^(\d+)-[a-f0-9-]{36}$/.exec(name);
    if (!match) return true; // Unknown maintenance markers fail closed.
    return profileOwnerAlive(Number(match[1]));
  });
}

/** Permission errors cannot prove a maintenance owner is gone. */
export function profileOwnerAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

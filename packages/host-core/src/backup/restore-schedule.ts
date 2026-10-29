/** Durable restart intent. Preparing a restore never touches live profile entries. */
import { createHash, randomUUID } from "node:crypto";
import { closeSync, createReadStream, fsyncSync, linkSync, openSync, unlinkSync } from "node:fs";
import { link, lstat, open, readFile, rm } from "node:fs/promises";
import { basename, join } from "node:path";
import { activateStagedBackup, type RestoreReport } from "./restore";
import { hasPendingDatabaseRecovery } from "../db/database-file";

const INTENT = ".volli-restore-on-restart.json";
const PREPARED = ".volli-restore-prepared.json";
interface RestoreIntent {
  staging: string;
  previous: string;
  databaseSha256: string;
}
async function digest(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}
async function syncDirectory(root: string): Promise<void> {
  const file = await open(root, "r");
  try {
    await file.sync();
  } finally {
    await file.close();
  }
}
export async function scheduleBackupRestore(root: string, report: RestoreReport): Promise<void> {
  if (!report.stagedPath || !report.stagedDatabaseSha256)
    throw new Error("Restore has not been staged and fingerprinted.");
  const intent: RestoreIntent = {
    staging: basename(report.stagedPath),
    previous: basename(report.replacedPath),
    databaseSha256: report.stagedDatabaseSha256,
  };
  const path = join(root, PREPARED);
  // One pending restore, never replace a previous accepted intent.
  const temporary = `${path}.${randomUUID()}.tmp`;
  const file = await open(temporary, "wx", 0o600);
  try {
    await file.writeFile(JSON.stringify(intent));
    await file.sync();
  } finally {
    await file.close();
  }
  try {
    await link(temporary, path);
    await syncDirectory(root);
  } finally {
    await rm(temporary, { force: true });
  }
}
async function readIntent(root: string, name = INTENT): Promise<RestoreIntent | null> {
  let value: unknown;
  try {
    if (!(await lstat(join(root, name))).isFile())
      throw new Error("The pending restore record is not a regular local file.");
    value = JSON.parse(await readFile(join(root, name), "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  const intent = value as Partial<RestoreIntent> | null;
  if (
    !intent ||
    typeof intent.staging !== "string" ||
    !/^\.volli-restore-\d+$/.test(intent.staging) ||
    typeof intent.previous !== "string" ||
    !/^\.volli-replaced-\d+$/.test(intent.previous) ||
    typeof intent.databaseSha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(intent.databaseSha256)
  )
    throw new Error(
      "The pending restore record is unreadable. The current profile has not been opened.",
    );
  return intent as RestoreIntent;
}
export async function hasScheduledBackupRestore(root: string): Promise<boolean> {
  return (await readIntent(root)) !== null;
}
/** Called synchronously only after the app's quit gates ACCEPT a requested restart.
 * The prepared record and its checksum are already durable; this publishes a name.
 */
export function acceptPreparedBackupRestore(root: string): void {
  linkSync(join(root, PREPARED), join(root, INTENT));
  const directory = openSync(root, "r");
  try {
    fsyncSync(directory);
  } finally {
    closeSync(directory);
  }
  unlinkSync(join(root, PREPARED));
}
export async function discardPreparedBackupRestore(root: string): Promise<boolean> {
  const prepared = await readIntent(root, PREPARED);
  if (!prepared) return false;
  await rm(join(root, PREPARED));
  await syncDirectory(root);
  await rm(join(root, prepared.staging), { recursive: true, force: true });
  return true;
}
export function hasInterruptedBackupRestore(root: string): boolean {
  return hasPendingDatabaseRecovery(join(root, "volli.db"));
}
export async function canCancelScheduledBackupRestore(root: string): Promise<boolean> {
  if (hasInterruptedBackupRestore(root)) return false;
  try {
    await lstat(join(root, INTENT));
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
export async function cancelScheduledBackupRestore(root: string): Promise<void> {
  if (hasInterruptedBackupRestore(root))
    throw new Error("The interrupted profile switch must be recovered before it can be cancelled.");
  let intent: RestoreIntent | null;
  try {
    intent = await readIntent(root);
  } catch {
    // A malformed outer intent cannot authorize guessing/deleting any profile path.
    // With no DB fence, withdrawing only the known record leaves the current profile safe.
    await rm(join(root, INTENT), { force: true });
    await rm(join(root, PREPARED), { force: true });
    await syncDirectory(root);
    return;
  }
  if (!intent) {
    await discardPreparedBackupRestore(root);
    return;
  }
  await rm(join(root, INTENT));
  await rm(join(root, PREPARED), { force: true });
  await syncDirectory(root);
  await rm(join(root, intent.staging), { recursive: true, force: true });
}
/** Worker-only, BEFORE any host opens SQLite. Existing database-file fences own the swap. */
export async function activateScheduledBackupRestore(root: string): Promise<void> {
  const intent = await readIntent(root);
  if (!intent) return;
  const staging = join(root, intent.staging);
  const stagedDb = join(staging, "volli.db");
  let stagedExists = true;
  try {
    if (!(await lstat(staging)).isDirectory() || !(await lstat(stagedDb)).isFile())
      throw new Error("The staged restore is not a regular local profile.");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    stagedExists = false;
  }
  if (stagedExists) {
    if ((await digest(stagedDb)) !== intent.databaseSha256)
      throw new Error("The staged restore changed. The current profile is unchanged.");
    activateStagedBackup(root, staging, join(root, intent.previous));
  } else {
    // A crash after the fenced swap but before removing this intent is a replay,
    // only if the live database is exactly the prepared one and no fence remains.
    if (
      hasPendingDatabaseRecovery(join(root, "volli.db")) ||
      (await digest(join(root, "volli.db"))) !== intent.databaseSha256
    )
      throw new Error(
        `Restore was interrupted. The previous profile is preserved at ${join(root, intent.previous)}. Volli has not opened the profile.`,
      );
  }
  await rm(join(root, INTENT));
  await rm(join(root, PREPARED), { force: true });
  await rm(join(root, ".volli-restore-attempt.json"), { force: true });
  await syncDirectory(root);
  await rm(staging, { recursive: true, force: true });
}

/** Transfer an interrupted switch to the existing degraded recovery screen.
 * Keep the database fence, staging, and both profiles as evidence. */
export async function handoffInterruptedBackupRestore(root: string): Promise<boolean> {
  if (!hasPendingDatabaseRecovery(join(root, "volli.db"))) return false;
  await rm(join(root, INTENT), { force: true });
  await rm(join(root, PREPARED), { force: true });
  await rm(join(root, ".volli-restore-attempt.json"), { force: true });
  await syncDirectory(root);
  return true;
}

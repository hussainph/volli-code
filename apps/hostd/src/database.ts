/** Local, stopped-host database restore. Never a socket verb or an agent tool. */
import { lstatSync } from "node:fs";
import { join } from "node:path";
import { restoreDatabaseFile } from "@volli/host-core/db";
import { acquireInstanceLock } from "./instance-lock";
import type { InstanceLock } from "./instance-lock";

export interface DatabaseRestoreCommand {
  kind: "database-restore";
  dataDir: string;
  sourcePath: string;
  schemaVersion: number;
  confirmed: boolean;
}

export interface DatabaseRestoreIo {
  out(text: string): void;
  err(text: string): void;
}

/** 0: durable and checked. 1: refused/failed; never starts a host. */
export function runDatabaseRestore(command: DatabaseRestoreCommand, io: DatabaseRestoreIo): number {
  if (!command.confirmed) {
    io.err("Restoring discards later writes. Stop both hostd units, then run again with --yes.\n");
    return 1;
  }
  let lock: InstanceLock | undefined;
  try {
    const stat = lstatSync(command.dataDir);
    if (!stat.isDirectory() || stat.uid !== process.getuid!() || (stat.mode & 0o002) !== 0)
      throw new Error(
        "Restore requires a local data directory owned by this user, not world-writable. Run as the service user.",
      );
    lock = acquireInstanceLock(command.dataDir);
    const result = restoreDatabaseFile({
      dbPath: join(command.dataDir, "volli.db"),
      sourcePath: command.sourcePath,
      schemaVersion: command.schemaVersion,
    });
    io.out(
      `Restored schema ${command.schemaVersion}. This attempt's database family preserved in ${result.preservedDirectory}.\n`,
    );
    if (result.earlierPreservedDirectory !== undefined) {
      io.out(
        `An earlier interrupted attempt preserved the pre-restore database in ${result.earlierPreservedDirectory}.\n`,
      );
    }
    io.out(
      "Keep every rolled-back-* directory until the restore is confirmed; the earliest holds the writes made after the rollback point.\n",
    );
    return 0;
  } catch (error) {
    io.err(
      `volli-hostd: ${(error as Error).message}\nKeep hostd stopped. If a restore was interrupted, retry with the same source and schema. If it refused, fix the cause or replace the source first; see the box runbook's three error cases.\n`,
    );
    return 1;
  } finally {
    lock?.release();
  }
}

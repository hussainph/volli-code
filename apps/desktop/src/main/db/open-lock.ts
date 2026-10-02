import Database from "better-sqlite3";
import { lstatSync } from "node:fs";

/** Serialize boot initialization and recovery before either can open a dormant
 * handle on the profile DB. WAL ownership alone cannot exclude an uninitialized
 * constructor; this stable adjacent lock DB is never moved during restore. */
export function acquireDatabaseOpenLock(dbPath: string): Database.Database {
  const path = `${dbPath}.open-lock`;
  try {
    if (!lstatSync(path).isFile())
      throw new Error("The database opening lock is not a regular file.");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const lock = new Database(path);
  try {
    lock.pragma("busy_timeout = 5000");
    lock.exec("CREATE TABLE IF NOT EXISTS opening_lease (id INTEGER PRIMARY KEY); BEGIN EXCLUSIVE");
    return lock;
  } catch (error) {
    lock.close();
    throw error;
  }
}

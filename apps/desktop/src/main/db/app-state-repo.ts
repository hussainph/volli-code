/**
 * `app_state` key→JSON repo: the storage half of the preload-backed async
 * `StateStorage` the renderer's ui/workspace Zustand persist stores swap
 * localStorage for. Values are opaque JSON strings — this layer never
 * parses them.
 */
import type Database from "better-sqlite3";
import { prepared } from "./prepared";

interface AppStateRow {
  key: string;
  value: string;
  updated_at: number;
}

/** Every `app_state` row, keyed by `key` — the raw payload `volli:data-bootstrap` hands the renderer. */
export function getAllAppState(db: Database.Database): Record<string, string> {
  const rows = prepared<[], AppStateRow>(db, "SELECT * FROM app_state").all();
  const result: Record<string, string> = {};
  for (const row of rows) {
    result[row.key] = row.value;
  }
  return result;
}

/**
 * One `app_state` value, or `undefined` when the key has never been written.
 *
 * Distinct from reading {@link getAllAppState} and indexing it: the bootstrap
 * payload is every persisted store's blob, and a main-process reader that
 * wants one small row should not have to materialize all of them. Still
 * unparsed — this layer never knows what a value means.
 */
export function getAppState(db: Database.Database, key: string): string | undefined {
  return prepared<[string], AppStateRow>(db, "SELECT * FROM app_state WHERE key = ?").get(key)
    ?.value;
}

/** Upserts one `app_state` key. */
export function setAppState(db: Database.Database, key: string, value: string, now: number): void {
  prepared(
    db,
    `INSERT INTO app_state (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(key, value, now);
}

/**
 * Removes one `app_state` key. Absent counts as removed — this is how a key
 * that has stopped existing gets cleaned up (the Zustand persist row a store
 * no longer writes, say), and a caller sweeping a key it isn't sure is there
 * should not have to check first.
 *
 * Deliberately distinct from `setAppState(key, "")`: an empty value is a key
 * whose payload is empty, which every reader here has to parse and reject. A
 * deleted key simply isn't in the bootstrap payload.
 */
export function deleteAppState(db: Database.Database, key: string): void {
  prepared(db, "DELETE FROM app_state WHERE key = ?").run(key);
}

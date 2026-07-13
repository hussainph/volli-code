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

/** Upserts one `app_state` key. */
export function setAppState(db: Database.Database, key: string, value: string, now: number): void {
  prepared(
    db,
    `INSERT INTO app_state (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(key, value, now);
}

/**
 * Migration 059 (VC-643): the web keys' source revision and mirror receipt,
 * step E. Additive, floor unchanged, and every older write still works.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { BRAVE_SEARCH_KEY_SECRET, EXA_SEARCH_KEY_SECRET } from "../web/credential";
import { migrate, MIGRATIONS, SCHEMA_HEAD } from "./migrations";
import {
  checkSchemaCompatibility,
  MIN_READER_VERSION_BASELINE,
  MIN_READER_VERSION_KEY,
  readMinReaderVersion,
} from "./schema-compatibility";
import { deleteSecret, readSecret, writeSecret } from "./secrets-repo";
import { WEB_CREDENTIAL_SOURCE_MIGRATION } from "./web-credential-migration";

let dir: string;
let dbPath: string;
let db: Database.Database;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "volli-migration-059-"));
  dbPath = join(dir, "volli.db");
  db = new Database(dbPath);
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const source = () =>
  db.prepare("SELECT source_id, revision FROM web_credential_source WHERE id = 1").get() as {
    source_id: string;
    revision: number;
  };

describe("migration 059: web credential source revision (step E)", () => {
  it("is the head, additive, and leaves the floor where it was", () => {
    const migration = MIGRATIONS.find((entry) => entry.version === 59)!;
    expect(SCHEMA_HEAD).toBeGreaterThanOrEqual(59);
    expect(migration.sql).toBe(WEB_CREDENTIAL_SOURCE_MIGRATION);
    expect(migration.raisesMinReader).toBeUndefined();
    expect(migration.apply).toBeUndefined();
    migrate(db, dbPath);
    expect(readMinReaderVersion(db)).toBe(MIN_READER_VERSION_BASELINE);
    expect(
      db.prepare("SELECT 1 FROM app_state WHERE key = ?").get(MIN_READER_VERSION_KEY),
    ).toBeUndefined();
  });

  it("seeds one lineage at revision 0 and an empty receipt table", () => {
    migrate(db, dbPath);
    expect(source()).toEqual({ source_id: expect.stringMatching(/^[0-9a-f]{32}$/), revision: 0 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM web_credential_mirror").get()).toEqual({ n: 0 });
    // A fresh database is a fresh lineage: two never share an id.
    const other = new Database(join(dir, "other.db"));
    migrate(other, join(dir, "other.db"));
    expect(
      (other.prepare("SELECT source_id FROM web_credential_source").get() as { source_id: string })
        .source_id,
    ).not.toBe(source().source_id);
    other.close();
  });

  it("advances the revision on every insert, update and delete of secrets, clears included", () => {
    migrate(db, dbPath);
    writeSecret(db, BRAVE_SEARCH_KEY_SECRET, "brave-1", 1);
    expect(source().revision).toBe(1);
    // The upsert's update arm: the same name again.
    writeSecret(db, BRAVE_SEARCH_KEY_SECRET, "brave-2", 2);
    expect(source().revision).toBe(2);
    // Even the same value again is a write, so it is counted.
    writeSecret(db, BRAVE_SEARCH_KEY_SECRET, "brave-2", 3);
    expect(source().revision).toBe(3);
    writeSecret(db, EXA_SEARCH_KEY_SECRET, "exa-1", 4);
    deleteSecret(db, BRAVE_SEARCH_KEY_SECRET);
    expect(source().revision).toBe(5);
    // Clearing nothing changed nothing.
    deleteSecret(db, BRAVE_SEARCH_KEY_SECRET);
    expect(source().revision).toBe(5);
    db.exec("DELETE FROM secrets");
    expect(source().revision).toBe(6);
    // `INSERT OR REPLACE`, which deletes first, is counted too.
    db.prepare("INSERT OR REPLACE INTO secrets (name, value, updated_at) VALUES (?, ?, ?)").run(
      EXA_SEARCH_KEY_SECRET,
      "exa-2",
      7,
    );
    expect(source().revision).toBeGreaterThan(6);
  });

  it("keeps no value, length or hash of a key in its tables", () => {
    migrate(db, dbPath);
    const value = "sk-sentinel-value-0123456789";
    writeSecret(db, BRAVE_SEARCH_KEY_SECRET, value, 1);
    const columns = (table: string) =>
      (db.pragma(`table_info(${table})`) as Array<{ name: string }>).map((column) => column.name);
    expect(columns("web_credential_source")).toEqual(["id", "source_id", "revision"]);
    expect(columns("web_credential_mirror")).toEqual([
      "id",
      "source_id",
      "source_revision",
      "inventory_id",
      "generation",
    ]);
    const dump = JSON.stringify(db.prepare("SELECT * FROM web_credential_source").all());
    expect(dump).not.toContain(value);
  });

  it("upgrades a pre-E profile directly, keys intact, and counts from there", () => {
    migrate(db, dbPath, { toVersion: 58 });
    writeSecret(db, BRAVE_SEARCH_KEY_SECRET, "brave-pre-e", 1);
    writeSecret(db, EXA_SEARCH_KEY_SECRET, "exa-pre-e", 1);
    migrate(db, dbPath);
    expect(db.pragma("user_version", { simple: true })).toBe(SCHEMA_HEAD);
    expect(readSecret(db, BRAVE_SEARCH_KEY_SECRET)).toBe("brave-pre-e");
    expect(readSecret(db, EXA_SEARCH_KEY_SECRET)).toBe("exa-pre-e");
    // No one-shot backfill: the revision starts at 0 and the receipt is empty,
    // so the first boot reconciles from `secrets`.
    expect(source().revision).toBe(0);
    deleteSecret(db, EXA_SEARCH_KEY_SECRET);
    expect(source().revision).toBe(1);
  });

  it("converges when re-offered: every statement is idempotent", () => {
    migrate(db, dbPath);
    writeSecret(db, BRAVE_SEARCH_KEY_SECRET, "brave", 1);
    const before = source();
    db.exec(WEB_CREDENTIAL_SOURCE_MIGRATION);
    expect(source()).toEqual(before);
    writeSecret(db, BRAVE_SEARCH_KEY_SECRET, "brave-again", 2);
    // Still exactly one trigger per operation.
    expect(source().revision).toBe(before.revision + 1);
  });

  it("lets an older build open, save, clear and read keys exactly as before", () => {
    migrate(db, dbPath);
    // The release before this one (head 58) opens a 059 file: the floor allows it.
    expect(checkSchemaCompatibility(db, 58)).toEqual({ schemaVersion: SCHEMA_HEAD, newer: true });
    // Its own statements, unchanged (`secrets-repo.ts` is the same on main).
    writeSecret(db, BRAVE_SEARCH_KEY_SECRET, "written-by-n-1", 1);
    expect(readSecret(db, BRAVE_SEARCH_KEY_SECRET)).toBe("written-by-n-1");
    deleteSecret(db, BRAVE_SEARCH_KEY_SECRET);
    expect(readSecret(db, BRAVE_SEARCH_KEY_SECRET)).toBeNull();
    // A missing source row (never expected) costs an older write nothing.
    db.exec("DELETE FROM web_credential_source");
    writeSecret(db, BRAVE_SEARCH_KEY_SECRET, "still-fine", 2);
    expect(readSecret(db, BRAVE_SEARCH_KEY_SECRET)).toBe("still-fine");
  });
});

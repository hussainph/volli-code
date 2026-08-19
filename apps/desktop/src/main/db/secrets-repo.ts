/**
 * The `secrets` table's three statements, and no opinion about what is in them.
 *
 * Ciphertext in, ciphertext out. This layer never encrypts, never decrypts and
 * never sees a plaintext — that is {@link ../web/credential.WebCredentialStore}'s
 * job, and keeping the two apart is what lets the owner above be tested against
 * a cipher a test controls while this stays a repo like every other one here.
 *
 * `name` is always one of Volli's own constants. Nothing composes a secret name
 * out of caller input, so there is no namespace for a caller to walk.
 */
import type Database from "better-sqlite3";
import { prepared } from "./prepared";

/** The stored ciphertext for one name, or null when nothing is stored under it. */
export function readSecret(db: Database.Database, name: string): Buffer | null {
  const row = prepared<[string], { ciphertext: Buffer }>(
    db,
    "SELECT ciphertext FROM secrets WHERE name = ?",
  ).get(name);
  return row === undefined ? null : row.ciphertext;
}

/** Whether anything is stored under this name. Reads no ciphertext to answer. */
export function hasSecret(db: Database.Database, name: string): boolean {
  return (
    prepared<[string], { name: string }>(db, "SELECT name FROM secrets WHERE name = ?").get(
      name,
    ) !== undefined
  );
}

/** Upserts one name's ciphertext. */
export function writeSecret(
  db: Database.Database,
  name: string,
  ciphertext: Buffer,
  now: number,
): void {
  prepared(
    db,
    `INSERT INTO secrets (name, ciphertext, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(name) DO UPDATE SET ciphertext = excluded.ciphertext, updated_at = excluded.updated_at`,
  ).run(name, ciphertext, now);
}

/** Removes one name. Absent counts as removed — forgetting nothing is not a failure. */
export function deleteSecret(db: Database.Database, name: string): void {
  prepared(db, "DELETE FROM secrets WHERE name = ?").run(name);
}

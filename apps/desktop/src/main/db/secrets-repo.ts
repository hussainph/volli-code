/**
 * The `secrets` table's four statements, and no opinion about what is in them.
 *
 * A string in, the same string out. This layer neither judges nor transforms
 * what it stores — that is {@link ../web/credential.WebCredentialStore}'s job,
 * and keeping the two apart is what lets the owner above be the one place a key
 * is trimmed, refused, or handed to a provider.
 *
 * **What is in `value` is the secret itself.** It used to be `safeStorage`
 * ciphertext; migration 023 retired that, for reasons written out there. So the
 * whole of this table's protection is where it is *not*: not in `app_state`,
 * which ships wholesale to the renderer on every bootstrap and which the
 * renderer can write; and not anywhere outside a user-only `Application Support`
 * directory. A `SELECT *` here is a key on screen, which is precisely why no
 * surface that answers the renderer calls into this module.
 *
 * `name` is always one of Volli's own constants. Nothing composes a secret name
 * out of caller input, so there is no namespace for a caller to walk.
 */
import type Database from "better-sqlite3";
import { prepared } from "./prepared";

/** The stored secret for one name, or null when nothing is stored under it. */
export function readSecret(db: Database.Database, name: string): string | null {
  const row = prepared<[string], { value: string }>(
    db,
    "SELECT value FROM secrets WHERE name = ?",
  ).get(name);
  return row === undefined ? null : row.value;
}

/** Whether anything is stored under this name. Reads no secret to answer. */
export function hasSecret(db: Database.Database, name: string): boolean {
  return (
    prepared<[string], { name: string }>(db, "SELECT name FROM secrets WHERE name = ?").get(
      name,
    ) !== undefined
  );
}

/** Upserts one name's secret. */
export function writeSecret(db: Database.Database, name: string, value: string, now: number): void {
  prepared(
    db,
    `INSERT INTO secrets (name, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(name) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(name, value, now);
}

/** Removes one name. Absent counts as removed — forgetting nothing is not a failure. */
export function deleteSecret(db: Database.Database, name: string): void {
  prepared(db, "DELETE FROM secrets WHERE name = ?").run(name);
}

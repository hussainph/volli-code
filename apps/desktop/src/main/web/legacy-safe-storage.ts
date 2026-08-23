/**
 * The last time Volli ever asks the OS keychain for anything.
 *
 * Until migration 023 the Brave and Exa keys were `safeStorage` ciphertext, and
 * that ciphertext is openable by exactly one party: the same machine, through
 * the same keychain, for a binary whose code identity still satisfies the item's
 * ACL. So the keys could not be carried across by a SQL statement. They wait in
 * `legacy_safe_storage_secrets` for this module, which opens what it can, writes
 * it the new way, and empties the table.
 *
 * **This is the only file in the app that imports `safeStorage`, and it is a
 * leftover rather than a dependency.** It runs once per profile — a `SELECT`
 * against an empty table on every launch after that, and never a keychain call.
 * That is the whole point of the exercise: the prompt this module may raise once
 * is the prompt that used to appear on every Session attach.
 *
 * **A row is never asked about twice.** If `decryptString` fails — a profile
 * carried to another machine, an item replaced underneath it, a person clicking
 * Deny — the row is dropped rather than retried, because retrying is just the
 * same prompt again tomorrow, and Settings already knows how to say "enter it
 * again". The one exception is a keychain that is not answering at all
 * ({@link Electron.SafeStorage.isEncryptionAvailable} false, e.g. a locked login
 * keyring): nothing was asked, no prompt was raised, so the rows are left for a
 * healthier launch.
 *
 * **Nothing here is logged, and nothing here throws.** The cipher's own failure
 * text is dropped rather than wrapped: a layer that was handed the plaintext is
 * not a layer whose words Volli repeats. The counts this returns are facts about
 * how many rows moved, which is all a caller may say out loud. And it runs on
 * the boot path, so a keychain that misbehaves must cost the profile a search
 * key, never its launch.
 *
 * The user's "Volli Code Safe Storage" keychain item is deliberately left in
 * place. Another Volli profile may still be using it, and deleting somebody's
 * keychain entry is not a migration's business.
 */
import { safeStorage } from "electron";
import type Database from "better-sqlite3";

import { prepared } from "../db/prepared";
import { hasSecret, writeSecret } from "../db/secrets-repo";

/** What one pass did. Row counts only — nothing here describes a key. */
export interface LegacySafeStorageOutcome {
  /** Keys opened and rewritten into the profile's own store. */
  carried: number;
  /**
   * Rows this machine will never open, now gone.
   *
   * Two ways in: the ciphertext did not decrypt, or a key is already stored the
   * new way under that name (a person who re-pasted while the keychain was
   * asleep must not have their new key overwritten by the old one).
   */
  dropped: number;
  /** Rows left for another launch, because the keychain was not answering at all. */
  deferred: number;
}

interface LegacyRow {
  name: string;
  ciphertext: Buffer;
}

/**
 * Whether the keychain is answering at all.
 *
 * The one question that raises no prompt, and the one call here that a broken
 * keychain could still throw from — a throw at boot would cost the launch, so it
 * reads as "not answering" and the rows wait.
 */
function keychainAnswers(): boolean {
  try {
    return safeStorage.isEncryptionAvailable();
  } catch {
    return false;
  }
}

/** The plaintext, or null for anything that did not open. The cipher's error is swallowed by design. */
function openOrNull(ciphertext: Buffer): string | null {
  try {
    const plaintext = safeStorage.decryptString(ciphertext).trim();
    return plaintext.length === 0 ? null : plaintext;
  } catch {
    return null;
  }
}

/**
 * Empties `legacy_safe_storage_secrets`, carrying across whatever still opens.
 *
 * Called once at boot, before anything reads a key. Cheap and total on a
 * profile that never had a keychain-stored key: one `SELECT` that returns
 * nothing, and `safeStorage` is not touched at all.
 */
export function migrateLegacySafeStorageSecrets(
  db: Database.Database,
  options: { now?: () => number } = {},
): LegacySafeStorageOutcome {
  const now = options.now ?? Date.now;
  const rows = prepared<[], LegacyRow>(
    db,
    "SELECT name, ciphertext FROM legacy_safe_storage_secrets",
  ).all();
  if (rows.length === 0) return { carried: 0, dropped: 0, deferred: 0 };
  // Asked before decrypting anything: a `false` here means no key material is
  // reachable, so there is nothing to gain from trying the rows and something
  // to lose from deleting them.
  if (!keychainAnswers()) {
    return { carried: 0, dropped: 0, deferred: rows.length };
  }

  const forget = prepared<[string]>(db, "DELETE FROM legacy_safe_storage_secrets WHERE name = ?");
  let carried = 0;
  let dropped = 0;
  for (const row of rows) {
    const key = openOrNull(row.ciphertext);
    if (key !== null && !hasSecret(db, row.name)) {
      writeSecret(db, row.name, key, now());
      carried += 1;
    } else {
      dropped += 1;
    }
    forget.run(row.name);
  }
  return { carried, dropped, deferred: 0 };
}

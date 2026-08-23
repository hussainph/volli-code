/**
 * The one trip to the keychain, and the four ways it can end.
 *
 * `safeStorage` is mocked rather than injected, because "this module is the only
 * thing that imports it" is the property under test as much as the migration is:
 * a fake handed in through an option would be a fake for a call site that could
 * quietly move somewhere else.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const { cipher } = vi.hoisted(() => ({
  cipher: {
    available: true as boolean | "throws",
    /** Names whose ciphertext this machine refuses to open. */
    unopenable: new Set<string>(),
    /** Every ciphertext handed to `decryptString`, in order — the keychain's own call log. */
    asked: [] as string[],
    /** How many times the app asked whether the keychain answers at all. */
    availabilityChecks: 0,
  },
}));

vi.mock("electron", () => ({
  safeStorage: {
    isEncryptionAvailable() {
      cipher.availabilityChecks += 1;
      if (cipher.available === "throws") throw new Error("the keychain is not well");
      return cipher.available;
    },
    decryptString(encrypted: Buffer) {
      const text = encrypted.toString("utf8");
      cipher.asked.push(text);
      const plaintext = Buffer.from(text.slice("v1:".length), "base64").toString("utf8");
      if (cipher.unopenable.has(plaintext)) throw new Error(`cannot decrypt ${plaintext}`);
      return plaintext;
    },
  },
}));

import { openTestDb, type TestDb } from "../db/test-helpers";
import { readSecret, writeSecret } from "../db/secrets-repo";
import { BRAVE_SEARCH_KEY_SECRET, EXA_SEARCH_KEY_SECRET } from "./credential";
import { migrateLegacySafeStorageSecrets } from "./legacy-safe-storage";

const KEY = "BSA-super-secret-brave-key-42";
const EXA_KEY = "exa-super-secret-second-key-77";

let ctx: TestDb;

/** Writes the row a pre-023 profile would have: `safeStorage` ciphertext, waiting. */
function storeTheOldWay(name: string, key: string): void {
  ctx.db
    .prepare(
      "INSERT INTO legacy_safe_storage_secrets (name, ciphertext, updated_at) VALUES (?, ?, ?)",
    )
    .run(name, Buffer.from(`v1:${Buffer.from(key, "utf8").toString("base64")}`, "utf8"), 0);
}

function legacyNames(): string[] {
  return (
    ctx.db.prepare("SELECT name FROM legacy_safe_storage_secrets").all() as { name: string }[]
  ).map((row) => row.name);
}

beforeEach(() => {
  ctx = openTestDb();
  cipher.available = true;
  cipher.unopenable.clear();
  cipher.asked.length = 0;
  cipher.availabilityChecks = 0;
});

afterEach(() => {
  vi.restoreAllMocks();
  ctx.cleanup();
});

describe("carrying the web-search keys out of the keychain", () => {
  it("never touches the keychain on a profile that never stored one there", () => {
    expect(migrateLegacySafeStorageSecrets(ctx.db)).toEqual({
      carried: 0,
      dropped: 0,
      deferred: 0,
    });

    // The whole point of the ticket: the steady state is a `SELECT` that finds
    // nothing, and not one keychain call — not even the availability question,
    // which on macOS is what creates the item in the first place.
    expect(cipher.availabilityChecks).toBe(0);
    expect(cipher.asked).toEqual([]);
  });

  it("rewrites what still opens, and asks once and never again", () => {
    storeTheOldWay(BRAVE_SEARCH_KEY_SECRET, KEY);
    storeTheOldWay(EXA_SEARCH_KEY_SECRET, EXA_KEY);

    expect(migrateLegacySafeStorageSecrets(ctx.db, { now: () => 1_700_000_000_000 })).toEqual({
      carried: 2,
      dropped: 0,
      deferred: 0,
    });

    expect(readSecret(ctx.db, BRAVE_SEARCH_KEY_SECRET)).toBe(KEY);
    expect(readSecret(ctx.db, EXA_SEARCH_KEY_SECRET)).toBe(EXA_KEY);
    expect(legacyNames()).toEqual([]);

    // The second launch is the one that matters: the table is empty, so the
    // prompt that used to arrive on every attach has nothing to arrive for.
    cipher.asked.length = 0;
    cipher.availabilityChecks = 0;
    expect(migrateLegacySafeStorageSecrets(ctx.db)).toEqual({
      carried: 0,
      dropped: 0,
      deferred: 0,
    });
    expect(cipher.availabilityChecks).toBe(0);
    expect(cipher.asked).toEqual([]);
  });

  it("drops a ciphertext this machine cannot open rather than asking again tomorrow", () => {
    storeTheOldWay(BRAVE_SEARCH_KEY_SECRET, KEY);
    cipher.unopenable.add(KEY);

    expect(migrateLegacySafeStorageSecrets(ctx.db)).toEqual({
      carried: 0,
      dropped: 1,
      deferred: 0,
    });

    // Absent, not "stored and broken": Settings asks for a re-paste, and the
    // next launch raises no prompt for bytes nobody here can read.
    expect(readSecret(ctx.db, BRAVE_SEARCH_KEY_SECRET)).toBeNull();
    expect(legacyNames()).toEqual([]);
  });

  it("carries the openable key even when the row beside it will not open", () => {
    storeTheOldWay(BRAVE_SEARCH_KEY_SECRET, KEY);
    storeTheOldWay(EXA_SEARCH_KEY_SECRET, EXA_KEY);
    cipher.unopenable.add(KEY);

    expect(migrateLegacySafeStorageSecrets(ctx.db)).toEqual({
      carried: 1,
      dropped: 1,
      deferred: 0,
    });
    expect(readSecret(ctx.db, BRAVE_SEARCH_KEY_SECRET)).toBeNull();
    expect(readSecret(ctx.db, EXA_SEARCH_KEY_SECRET)).toBe(EXA_KEY);
  });

  it("leaves the rows alone when the keychain is not answering at all", () => {
    storeTheOldWay(BRAVE_SEARCH_KEY_SECRET, KEY);
    cipher.available = false;

    expect(migrateLegacySafeStorageSecrets(ctx.db)).toEqual({
      carried: 0,
      dropped: 0,
      deferred: 1,
    });

    // Nothing was asked, so nothing prompted, so there is no reason to burn the
    // row: a locked login keyring is a state a machine comes back from.
    expect(cipher.asked).toEqual([]);
    expect(legacyNames()).toEqual([BRAVE_SEARCH_KEY_SECRET]);

    cipher.available = true;
    expect(migrateLegacySafeStorageSecrets(ctx.db)).toMatchObject({ carried: 1 });
    expect(readSecret(ctx.db, BRAVE_SEARCH_KEY_SECRET)).toBe(KEY);
  });

  it("costs the profile a search key rather than the launch when the keychain misbehaves", () => {
    storeTheOldWay(BRAVE_SEARCH_KEY_SECRET, KEY);
    cipher.available = "throws";

    // This runs on the boot path. A keychain that throws where it is documented
    // to answer a boolean must not be the reason Volli does not start.
    expect(migrateLegacySafeStorageSecrets(ctx.db)).toEqual({
      carried: 0,
      dropped: 0,
      deferred: 1,
    });
    expect(legacyNames()).toEqual([BRAVE_SEARCH_KEY_SECRET]);
  });

  it("never overwrites a key the person pasted since", () => {
    storeTheOldWay(BRAVE_SEARCH_KEY_SECRET, KEY);
    // The deferred case above, followed by a re-paste: the old key must not
    // come back and displace the one that is actually in use.
    writeSecret(ctx.db, BRAVE_SEARCH_KEY_SECRET, "BSA-the-key-in-use-now", 1);

    expect(migrateLegacySafeStorageSecrets(ctx.db)).toEqual({
      carried: 0,
      dropped: 1,
      deferred: 0,
    });
    expect(readSecret(ctx.db, BRAVE_SEARCH_KEY_SECRET)).toBe("BSA-the-key-in-use-now");
    expect(legacyNames()).toEqual([]);
  });

  it("treats a ciphertext that opens to nothing as no key at all", () => {
    storeTheOldWay(BRAVE_SEARCH_KEY_SECRET, "   ");

    expect(migrateLegacySafeStorageSecrets(ctx.db)).toEqual({
      carried: 0,
      dropped: 1,
      deferred: 0,
    });
    expect(readSecret(ctx.db, BRAVE_SEARCH_KEY_SECRET)).toBeNull();
  });

  it("says nothing about a key, in what it returns or what it prints", () => {
    const printed: unknown[] = [];
    for (const level of ["log", "info", "warn", "error", "debug"] as const) {
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
        printed.push(...args);
      });
    }
    storeTheOldWay(BRAVE_SEARCH_KEY_SECRET, KEY);
    storeTheOldWay(EXA_SEARCH_KEY_SECRET, EXA_KEY);
    cipher.unopenable.add(EXA_KEY);

    const outcome = migrateLegacySafeStorageSecrets(ctx.db);

    // Counts are facts about rows; the cipher's own failure text (which quotes
    // the plaintext here, deliberately) is dropped rather than wrapped.
    expect(JSON.stringify(outcome)).not.toContain(KEY);
    expect(JSON.stringify(printed)).not.toContain(KEY);
    expect(JSON.stringify(printed)).not.toContain(EXA_KEY);
    expect(printed).toEqual([]);
  });
});

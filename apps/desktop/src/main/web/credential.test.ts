import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { openTestDb, type TestDb } from "../db/test-helpers";
import { readSecret } from "../db/secrets-repo";
import {
  BRAVE_SEARCH_KEY_SECRET,
  SecretUnavailableError,
  WebCredentialStore,
  type SecretCipher,
} from "./credential";

/**
 * A stand-in for Electron's `safeStorage`, with the one knob the real one has:
 * whether the OS can encrypt at all right now.
 *
 * The "encryption" is a reversible transform rather than a copy, so a test that
 * asserts the database does not hold the plaintext is asserting something the
 * fake could actually have got wrong.
 */
class FakeCipher implements SecretCipher {
  available = true;
  decryptFailure: Error | null = null;
  readonly encrypted: string[] = [];

  isEncryptionAvailable(): boolean {
    return this.available;
  }

  encryptString(plainText: string): Buffer {
    if (!this.available) throw new Error("Encryption is not available on this system.");
    this.encrypted.push(plainText);
    return Buffer.from(`v1:${Buffer.from(plainText, "utf8").toString("base64")}`, "utf8");
  }

  decryptString(encrypted: Buffer): string {
    if (this.decryptFailure !== null) throw this.decryptFailure;
    return Buffer.from(encrypted.toString("utf8").slice("v1:".length), "base64").toString("utf8");
  }
}

const KEY = "BSA-super-secret-brave-key-42";

let ctx: TestDb;
let cipher: FakeCipher;
let store: WebCredentialStore;

beforeEach(() => {
  ctx = openTestDb();
  cipher = new FakeCipher();
  store = new WebCredentialStore({ db: ctx.db, cipher, now: () => 1_700_000_000_000 });
});

afterEach(() => {
  ctx.cleanup();
});

describe("WebCredentialStore", () => {
  it("holds nothing on a fresh profile", () => {
    expect(store.state()).toBe("absent");
    expect(store.read()).toBeNull();
  });

  it("hands back the key it was given", () => {
    store.save(KEY);

    expect(store.state()).toBe("present");
    expect(store.read()).toBe(KEY);
  });

  it("stores ciphertext, never the key itself", () => {
    store.save(KEY);

    const stored = readSecret(ctx.db, BRAVE_SEARCH_KEY_SECRET);
    expect(stored).not.toBeNull();
    expect(stored?.toString("utf8")).not.toContain(KEY);
    expect(cipher.encrypted).toEqual([KEY]);
  });

  it("keeps no row anywhere else in the database", () => {
    store.save(KEY);

    // Every other table's whole content, as text. A key that leaked into
    // `app_state` would ride the bootstrap payload straight to the renderer.
    const tables = ctx.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name != 'secrets'")
      .all() as { name: string }[];
    for (const { name } of tables) {
      const rows = ctx.db.prepare(`SELECT * FROM "${name}"`).all();
      expect(JSON.stringify(rows)).not.toContain(KEY);
    }
  });

  it("trims what a paste brought with it", () => {
    store.save(`  ${KEY}\n`);

    expect(store.read()).toBe(KEY);
  });

  it("refuses a key that is only whitespace", () => {
    expect(() => store.save("   ")).toThrow(/no key/i);
    expect(store.state()).toBe("absent");
  });

  it("forgets a key on request, and forgetting nothing is not an error", () => {
    store.save(KEY);
    store.clear();

    expect(store.state()).toBe("absent");
    expect(store.read()).toBeNull();
    expect(() => store.clear()).not.toThrow();
  });

  describe("when the OS cannot encrypt", () => {
    beforeEach(() => {
      cipher.available = false;
    });

    it("refuses to store the key rather than writing it in the clear", () => {
      expect(() => store.save(KEY)).toThrow(SecretUnavailableError);

      expect(readSecret(ctx.db, BRAVE_SEARCH_KEY_SECRET)).toBeNull();
      expect(store.state()).toBe("absent");
    });

    it("says so without repeating the key", () => {
      try {
        store.save(KEY);
        expect.unreachable("saving must refuse");
      } catch (error) {
        const refusal = error as Error;
        expect(refusal.message).not.toContain(KEY);
        expect(refusal.message).toMatch(/keychain|encrypt/i);
      }
    });

    it("reports a key stored on a healthier day as unreadable rather than absent", () => {
      cipher.available = true;
      store.save(KEY);
      cipher.available = false;

      expect(store.state()).toBe("unreadable");
      expect(() => store.read()).toThrow(SecretUnavailableError);
    });
  });

  it("refuses a ciphertext this machine can no longer open, in Volli's own words", () => {
    store.save(KEY);
    cipher.decryptFailure = new Error(`could not decrypt payload ${KEY}`);

    expect(store.state()).toBe("present");
    try {
      store.read();
      expect.unreachable("reading must refuse");
    } catch (error) {
      const refusal = error as Error;
      expect(refusal).toBeInstanceOf(SecretUnavailableError);
      // The cipher's own text is dropped: a failure message from a layer that
      // was handed the secret is not a message Volli can repeat.
      expect(refusal.message).not.toContain(KEY);
      expect(refusal.message).toMatch(/could not be read/i);
    }
  });
});

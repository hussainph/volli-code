import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { SecretKeyUnavailableError } from "../ports/secret-key";
import { credentialKeyId } from "./credential-key-id";
import { CredentialLock } from "./credential-lock";
import { CREDENTIAL_INVENTORY_FILE_NAME, SealedInventory } from "./inventory";
import {
  CREDENTIAL_KEYCHAIN_KEY_FILE_NAME,
  keychainCredentialKeyring,
  type CredentialKeychain,
} from "./keychain-keyring";
import { envelopeHeader } from "./sealed-envelope";

const faults = { link: null as ((from: string, to: string) => void) | null };

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    linkSync: (from: string, to: string) => (faults.link ?? actual.linkSync)(from, to),
  };
});

let dir: string;
let path: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "volli-keychain-keyring-"));
  path = join(dir, CREDENTIAL_KEYCHAIN_KEY_FILE_NAME);
});
afterEach(() => {
  faults.link = null;
  new CredentialLock(join(dir, "host-credentials.lock")).close();
  chmodSync(dir, 0o700);
  rmSync(dir, { recursive: true, force: true });
});

/** A stand-in for Electron's safeStorage: reversible, counted, switchable. */
function fakeKeychain(options: { backend?: string } = {}) {
  const state = {
    available: true,
    denied: false,
    encrypts: 0,
    decrypts: 0,
    output: null as Buffer | null,
  };
  const keychain: CredentialKeychain = {
    isEncryptionAvailable: () => state.available,
    encryptString(value) {
      state.encrypts += 1;
      return state.output ?? Buffer.from(`wrapped:${value}`);
    },
    decryptString(value) {
      state.decrypts += 1;
      if (state.denied) throw new Error(`refused-by-keychain ${value.toString()}`);
      const text = value.toString();
      if (!text.startsWith("wrapped:")) throw new Error("not ours");
      return text.slice("wrapped:".length);
    },
    ...(options.backend === undefined ? {} : { getSelectedStorageBackend: () => options.backend! }),
  };
  return { keychain, state };
}

function reason(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (error) {
    if (error instanceof SecretKeyUnavailableError) return error.reason;
    throw error;
  }
  return undefined;
}

describe("keychain credential keyring", () => {
  it("asks nothing until a seal, then wraps one key, once, and reuses it", () => {
    const { keychain, state } = fakeKeychain();
    const keyring = keychainCredentialKeyring({ path, keychain });
    expect(keyring.backend).toBe("keychain");
    keyring.probe();
    expect(state).toMatchObject({ encrypts: 0, decrypts: 0 });
    const key = keyring.active();
    expect(key.key).toHaveLength(32);
    expect(key.id).toBe(credentialKeyId(key.key));
    expect(state.encrypts).toBe(1);
    const file = readFileSync(path);
    expect(file.subarray(0, 4).toString()).toBe("VHK1");
    // Wrapped, never the key in the clear beside its magic.
    expect(file.includes(key.key)).toBe(false);
    expect(keyring.active()).toBe(key);
    expect(keyring.resolve(key.id)).toBe(key.key);
    keyring.probe();
    expect(keyring.resolve(key.id)).toBe(key.key);
    expect(state).toMatchObject({ encrypts: 1, decrypts: 0 });
  });

  it("unwraps a key another launch made once per launch, and refuses another id", () => {
    const first = fakeKeychain();
    const made = keychainCredentialKeyring({ path, keychain: first.keychain }).active();
    const { keychain, state } = fakeKeychain();
    const later = keychainCredentialKeyring({ path, keychain });
    expect(later.resolve(made.id)).toEqual(made.key);
    expect(later.resolve(made.id)).toEqual(made.key);
    expect(later.active().id).toBe(made.id);
    expect(state).toMatchObject({ encrypts: 0, decrypts: 1 });
    expect(reason(() => later.resolve("0".repeat(32)))).toBe("wrong-key");
  });

  it("is locked, never re-keyed, when its wrapped file is gone beside a sealed inventory", () => {
    const { keychain } = fakeKeychain();
    const keyring = keychainCredentialKeyring({ path, keychain });
    const id = keyring.active().id;
    rmSync(path);
    expect(reason(() => keyring.resolve(id))).toBe("missing");
    // The held key is dropped once probe sees the file gone.
    keyring.probe();
    expect(reason(() => keyring.resolve(id))).toBe("missing");
  });

  it("unwraps afresh when another process replaced the wrapped file", () => {
    const { keychain, state } = fakeKeychain();
    const keyring = keychainCredentialKeyring({ path, keychain });
    const first = keyring.active();
    rmSync(path);
    const other = keychainCredentialKeyring({ path, keychain: fakeKeychain().keychain }).active();
    keyring.probe();
    expect(reason(() => keyring.resolve(first.id))).toBe("wrong-key");
    expect(keyring.resolve(other.id)).toEqual(other.key);
    expect(state.decrypts).toBe(1);
  });

  it("fails closed on an unavailable or basic_text keychain and a refused unwrap", () => {
    const made = keychainCredentialKeyring({ path, keychain: fakeKeychain().keychain }).active();
    const { keychain, state } = fakeKeychain();
    const keyring = keychainCredentialKeyring({ path, keychain });
    state.available = false;
    expect(reason(() => keyring.probe())).toBe("unavailable");
    expect(reason(() => keyring.resolve(made.id))).toBe("unavailable");
    state.available = true;
    state.denied = true;
    let message = "";
    try {
      keyring.resolve(made.id);
    } catch (error) {
      message = (error as Error).message;
    }
    // Never the keychain's own text, which can quote its input.
    expect(message).not.toContain("refused-by-keychain");
    expect(message).not.toContain("wrapped");
    const linux = keychainCredentialKeyring({
      path: join(dir, "other.key"),
      keychain: fakeKeychain({ backend: "basic_text" }).keychain,
    });
    // Nothing wrapped yet: a probe asks the keychain nothing at all.
    linux.probe();
    expect(reason(() => linux.active())).toBe("unavailable");
    writeFileSync(join(dir, "other.key"), Buffer.from("VHK1wrapped:x"));
    expect(reason(() => linux.probe())).toBe("unavailable");
    const gnome = keychainCredentialKeyring({
      path: join(dir, "gnome.key"),
      keychain: fakeKeychain({ backend: "gnome_libsecret" }).keychain,
    });
    expect(gnome.active().key).toHaveLength(32);
  });

  it("refuses to make a key the keychain will not wrap, and leaves no file", () => {
    const { keychain, state } = fakeKeychain();
    const keyring = keychainCredentialKeyring({ path, keychain });
    state.output = Buffer.alloc(0);
    expect(reason(() => keyring.active())).toBe("unavailable");
    state.output = Buffer.alloc(64 * 1024 + 1);
    expect(reason(() => keyring.active())).toBe("unavailable");
    state.output = null;
    const throwing = keychainCredentialKeyring({
      path,
      keychain: {
        ...keychain,
        encryptString: () => {
          throw new Error("keychain said no");
        },
      },
    });
    expect(reason(() => throwing.active())).toBe("unavailable");
    expect(() => readFileSync(path)).toThrow();
  });

  it("refuses a damaged, unreadable or non-file wrapped key, naming the fix", () => {
    const { keychain } = fakeKeychain();
    const keyring = keychainCredentialKeyring({ path, keychain });
    for (const bytes of [
      Buffer.from("VHK1"),
      Buffer.from("XXXXwrapped:abc"),
      Buffer.concat([Buffer.from("VHK1"), Buffer.alloc(64 * 1024 + 1)]),
    ]) {
      writeFileSync(path, bytes);
      expect(reason(() => keyring.active())).toBe("malformed");
    }
    // Unwraps to something that is not one 32-byte base64 key.
    for (const text of ["c2hvcnQ=", `${Buffer.alloc(32).toString("base64")}\n`]) {
      writeFileSync(path, Buffer.concat([Buffer.from("VHK1wrapped:"), Buffer.from(text)]));
      expect(reason(() => keyring.active())).toBe("malformed");
    }
    chmodSync(path, 0o000);
    expect(reason(() => keyring.active())).toBe("unreadable");
    rmSync(path);
    mkdirSync(path);
    expect(reason(() => keyring.active())).toBe("not-a-file");
  });

  it("sets an orphaned wrapped key aside only while nothing is sealed under it", () => {
    const inventoryPath = join(dir, CREDENTIAL_INVENTORY_FILE_NAME);
    // Made by another machine's keychain: this one refuses to unwrap it.
    writeFileSync(path, Buffer.from("VHK1foreign-wrapping"));
    const { keychain } = fakeKeychain();
    // Never without being told where the inventory is.
    expect(reason(() => keychainCredentialKeyring({ path, keychain }).active())).toBe(
      "unavailable",
    );
    // A sealed inventory present: never replaced (that is a reset).
    writeFileSync(inventoryPath, "sealed");
    const guarded = keychainCredentialKeyring({ path, keychain, inventoryPath });
    expect(reason(() => guarded.active())).toBe("unavailable");
    expect(readFileSync(path).toString()).toBe("VHK1foreign-wrapping");
    rmSync(inventoryPath);
    // Nothing sealed: set aside, never deleted, and a fresh key made.
    const fresh = keychainCredentialKeyring({ path, keychain, inventoryPath }).active();
    expect(fresh.key).toHaveLength(32);
    const aside = readdirSync(dir).filter((name) =>
      name.startsWith(`${CREDENTIAL_KEYCHAIN_KEY_FILE_NAME}.unused-`),
    );
    expect(aside).toHaveLength(1);
    expect(readFileSync(join(dir, aside[0]!)).toString()).toBe("VHK1foreign-wrapping");
    // A damaged one too; an unreadable one is not ours to move.
    writeFileSync(path, Buffer.from("VHK1"));
    expect(keychainCredentialKeyring({ path, keychain, inventoryPath }).active().key).toHaveLength(
      32,
    );
    chmodSync(path, 0o000);
    expect(
      reason(() => keychainCredentialKeyring({ path, keychain, inventoryPath }).active()),
    ).toBe("unreadable");
    chmodSync(path, 0o600);
    // A locked keychain is never a reason to replace anything.
    const locked = fakeKeychain();
    locked.state.available = false;
    const before = readFileSync(path);
    expect(
      reason(() =>
        keychainCredentialKeyring({ path, keychain: locked.keychain, inventoryPath }).active(),
      ),
    ).toBe("unavailable");
    expect(readFileSync(path)).toEqual(before);
    // When it cannot be set aside, it says so.
    writeFileSync(path, Buffer.from("VHK1foreign-wrapping"));
    faults.link = () => {
      throw Object.assign(new Error("EPERM"), { code: "EPERM" });
    };
    expect(
      reason(() => keychainCredentialKeyring({ path, keychain, inventoryPath }).active()),
    ).toBe("unreadable");
  });

  it("uses the key another process created first, never replacing it", () => {
    const { keychain } = fakeKeychain();
    const first = keychainCredentialKeyring({ path, keychain }).active();
    const bytes = readFileSync(path);
    rmSync(path);
    // The racer reads no file; the other process's link lands while it wraps.
    const racer = keychainCredentialKeyring({
      path,
      keychain: {
        ...keychain,
        encryptString(value) {
          writeFileSync(path, bytes);
          return keychain.encryptString(value);
        },
      },
    });
    expect(racer.active().id).toBe(first.id);
    expect(readFileSync(path)).toEqual(bytes);
  });

  it("says when the wrapped key cannot be written, and leaves no temporary", () => {
    const { keychain } = fakeKeychain();
    chmodSync(dir, 0o500);
    const keyring = keychainCredentialKeyring({ path, keychain });
    expect(reason(() => keyring.active())).toBe("unreadable");
    chmodSync(dir, 0o700);
    const nested = keychainCredentialKeyring({ path: join(dir, "absent", "k"), keychain });
    expect(reason(() => nested.active())).toBe("unreadable");
    for (const [code, expected] of [
      ["EPERM", "no-hard-links"],
      ["ENOSYS", "no-hard-links"],
      ["EIO", "unreadable"],
    ] as const) {
      faults.link = () => {
        throw Object.assign(new Error(code), { code });
      };
      expect(reason(() => keyring.active())).toBe(expected);
    }
    expect(readdirSync(dir)).toEqual([]);
  });

  it("seals and reopens a typed inventory under the keychain backend", () => {
    const { keychain, state } = fakeKeychain();
    const inventoryPath = join(dir, CREDENTIAL_INVENTORY_FILE_NAME);
    const inventory = new SealedInventory({
      path: inventoryPath,
      keyring: keychainCredentialKeyring({ path, keychain }),
    });
    inventory.put("web-search", { provider: "brave" }, "value");
    expect(envelopeHeader(readFileSync(inventoryPath)).backend).toBe("keychain");
    const fresh = fakeKeychain();
    const reopened = new SealedInventory({
      path: inventoryPath,
      keyring: keychainCredentialKeyring({ path, keychain: fresh.keychain }),
    });
    expect(reopened.get("web-search", { provider: "brave" })?.value).toBe("value");
    expect(reopened.get("web-search", { provider: "brave" })?.value).toBe("value");
    expect(fresh.state.decrypts).toBe(1);
    expect(state.encrypts).toBe(1);
    // A locked keychain locks the inventory and leaves the file alone.
    const sealed = readFileSync(inventoryPath);
    const locked = fakeKeychain();
    locked.state.available = false;
    const lockedInventory = new SealedInventory({
      path: inventoryPath,
      keyring: keychainCredentialKeyring({ path, keychain: locked.keychain }),
    });
    expect(lockedInventory.status()).toMatchObject({ state: "locked", reason: "unavailable" });
    expect(readFileSync(inventoryPath)).toEqual(sealed);
  });
});

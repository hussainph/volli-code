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

import { CredentialKeyPendingError } from "../ports/credential-keyring";
import { SecretKeyUnavailableError } from "../ports/secret-key";
import { credentialKeyId } from "./credential-key-id";
import { CredentialLock } from "./credential-lock";
import { CREDENTIAL_INVENTORY_FILE_NAME, SealedInventory } from "./inventory";
import {
  CREDENTIAL_KEYCHAIN_KEY_FILE_NAME,
  keychainCredentialKeyring,
  type CredentialKeychain,
  type KeychainCredentialKeyringOptions,
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
let inventoryPath: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "volli-keychain-keyring-"));
  path = join(dir, CREDENTIAL_KEYCHAIN_KEY_FILE_NAME);
  inventoryPath = join(dir, CREDENTIAL_INVENTORY_FILE_NAME);
});
afterEach(() => {
  faults.link = null;
  new CredentialLock(join(dir, "host-credentials.lock")).close();
  chmodSync(dir, 0o700);
  rmSync(dir, { recursive: true, force: true });
});

/**
 * A stand-in for Electron's asynchronous safeStorage API: reversible,
 * counted, switchable, and able to stall (a keychain prompt nobody answers).
 */
function fakeKeychain(options: { backend?: string | null } = {}) {
  const state = {
    available: true as boolean,
    availabilityThrows: false,
    denied: false,
    encryptThrows: false,
    availabilityChecks: 0,
    encrypts: 0,
    decrypts: 0,
    output: null as unknown,
    /** The call that waits on `stall` after being counted, like an unanswered prompt. */
    stallAt: null as "availability" | "encrypt" | "decrypt" | null,
    stall: null as Promise<void> | null,
    /** Which call is waiting now. */
    stalled: null as "availability" | "encrypt" | "decrypt" | null,
  };
  const wait = async (at: "availability" | "encrypt" | "decrypt") => {
    if (state.stallAt !== at) return;
    state.stalled = at;
    await state.stall;
  };
  const keychain: CredentialKeychain = {
    async isAsyncEncryptionAvailable() {
      state.availabilityChecks += 1;
      await wait("availability");
      if (state.availabilityThrows) throw new Error("keychain broke");
      return state.available;
    },
    async encryptStringAsync(value) {
      state.encrypts += 1;
      await wait("encrypt");
      if (state.encryptThrows) throw new Error(`keychain said no ${value}`);
      return (state.output as Buffer | null) ?? Buffer.from(`wrapped:${value}`);
    },
    async decryptStringAsync(value) {
      state.decrypts += 1;
      await wait("decrypt");
      if (state.denied) throw new Error(`refused-by-keychain ${value.toString()}`);
      const text = value.toString();
      if (!text.startsWith("wrapped:")) throw new Error("not ours");
      return { result: text.slice("wrapped:".length) };
    },
  };
  const backend = options.backend === undefined ? "gnome_libsecret" : options.backend;
  if (backend !== null) keychain.getSelectedStorageBackend = () => backend;
  const calls = () => state.availabilityChecks + state.encrypts + state.decrypts;
  return { keychain, state, calls };
}

/** A keyring on macOS's rules unless told otherwise. */
function ring(
  keychain: CredentialKeychain,
  options: Partial<KeychainCredentialKeyringOptions> = {},
) {
  return keychainCredentialKeyring({ path, keychain, platform: "darwin", ...options });
}

/** A keyring with its key fetched (and written when new), as the inventory's callers leave it. */
async function unlocked(
  keychain: CredentialKeychain,
  options: Partial<KeychainCredentialKeyringOptions> = {},
) {
  const keyring = ring(keychain, options);
  await keyring.unlock!();
  return { keyring, key: keyring.active() };
}

function reason(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (error) {
    if (error instanceof SecretKeyUnavailableError) return error.reason;
    if (error instanceof CredentialKeyPendingError) return "pending";
    throw error;
  }
  return undefined;
}

function deferred() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

describe("keychain credential keyring", () => {
  it("asks nothing synchronously: pending until unlocked, then one wrap, reused", async () => {
    const { keychain, state, calls } = fakeKeychain();
    const keyring = ring(keychain);
    expect(keyring.backend).toBe("keychain");
    keyring.probe();
    expect(reason(() => keyring.active())).toBe("pending");
    expect(calls()).toBe(0);
    await keyring.unlock!();
    expect(state).toMatchObject({ availabilityChecks: 1, encrypts: 1, decrypts: 0 });
    // Wrapped, not yet written: `active` writes it, under the caller's lock.
    expect(readdirSync(dir)).toEqual([]);
    // Asked twice before it is written: still one wrap.
    await keyring.unlock!();
    expect(state.encrypts).toBe(1);
    const key = keyring.active();
    expect(key.key).toHaveLength(32);
    expect(key.id).toBe(credentialKeyId(key.key));
    const file = readFileSync(path);
    expect(file.subarray(0, 4).toString()).toBe("VHK1");
    // Wrapped, never the key in the clear beside its magic.
    expect(file.includes(key.key)).toBe(false);
    expect(keyring.active()).toBe(key);
    expect(keyring.resolve(key.id)).toBe(key.key);
    keyring.probe();
    await keyring.unlock!();
    expect(keyring.resolve(key.id)).toBe(key.key);
    expect(calls()).toBe(2);
  });

  it("unwraps a key another launch made once per launch, and refuses another id", async () => {
    const { key: made } = await unlocked(fakeKeychain().keychain);
    const { keychain, state } = fakeKeychain();
    const later = ring(keychain);
    expect(reason(() => later.resolve(made.id))).toBe("pending");
    expect(reason(() => later.active())).toBe("pending");
    await later.unlock!();
    expect(later.resolve(made.id)).toEqual(made.key);
    expect(later.resolve(made.id)).toEqual(made.key);
    expect(later.active().id).toBe(made.id);
    await later.unlock!();
    expect(state).toMatchObject({ encrypts: 0, decrypts: 1 });
    expect(reason(() => later.resolve("0".repeat(32)))).toBe("wrong-key");
  });

  it("is missing, never re-keyed, when its wrapped file is gone beside a sealed inventory", async () => {
    const { keychain, calls } = fakeKeychain();
    const { keyring, key } = await unlocked(keychain, { inventoryPath });
    writeFileSync(inventoryPath, "sealed");
    rmSync(path);
    expect(reason(() => keyring.resolve(key.id))).toBe("missing");
    // The held key is dropped once probe sees the file gone.
    keyring.probe();
    const before = calls();
    await keyring.unlock!();
    expect(calls()).toBe(before);
    expect(reason(() => keyring.resolve(key.id))).toBe("missing");
    expect(readdirSync(dir)).toEqual([CREDENTIAL_INVENTORY_FILE_NAME]);
  });

  it("fetches afresh when another process replaced the wrapped file", async () => {
    const { keychain, state } = fakeKeychain();
    const { keyring, key: first } = await unlocked(keychain);
    rmSync(path);
    const { key: other } = await unlocked(fakeKeychain().keychain);
    // Without a probe: the held key no longer matches the file.
    expect(reason(() => keyring.resolve(first.id))).toBe("pending");
    await keyring.unlock!();
    keyring.probe();
    expect(reason(() => keyring.resolve(first.id))).toBe("wrong-key");
    const heldOther = keyring.resolve(other.id);
    expect(heldOther).toEqual(other.key);
    expect(state.decrypts).toBe(1);
    // A key held, its file gone, nothing sealed: a new one replaces it.
    rmSync(path);
    await keyring.unlock!();
    const third = keyring.active();
    expect(third.id).not.toBe(other.id);
    // The key it replaced is wiped from memory.
    expect(heldOther.equals(Buffer.alloc(32))).toBe(true);
  });

  it("fails closed on an unavailable keychain and a refused unwrap, asking once", async () => {
    const { key: made } = await unlocked(fakeKeychain().keychain);
    const locked = fakeKeychain();
    locked.state.available = false;
    const keyring = ring(locked.keychain);
    await keyring.unlock!();
    expect(reason(() => keyring.resolve(made.id))).toBe("unavailable");
    expect(reason(() => keyring.active())).toBe("unavailable");
    // Remembered: asked once this launch.
    await keyring.unlock!();
    expect(locked.calls()).toBe(1);
    const broken = fakeKeychain();
    broken.state.availabilityThrows = true;
    const brokenRing = ring(broken.keychain);
    await brokenRing.unlock!();
    expect(reason(() => brokenRing.resolve(made.id))).toBe("unavailable");
    const denied = fakeKeychain();
    denied.state.denied = true;
    const deniedRing = ring(denied.keychain);
    await deniedRing.unlock!();
    let message = "";
    try {
      deniedRing.resolve(made.id);
    } catch (error) {
      message = (error as Error).message;
    }
    // Never the keychain's own text, which can quote its input.
    expect(message).not.toContain("refused-by-keychain");
    expect(message).not.toContain("wrapped");
    await deniedRing.unlock!();
    expect(denied.state.decrypts).toBe(1);
    // Unwraps to something that is not one 32-byte base64 key: refused too.
    for (const text of ["c2hvcnQ=", `${Buffer.alloc(32).toString("base64")}\n`]) {
      writeFileSync(path, Buffer.concat([Buffer.from("VHK1wrapped:"), Buffer.from(text)]));
      const odd = ring(fakeKeychain().keychain);
      await odd.unlock!();
      expect(reason(() => odd.resolve(made.id))).toBe("unavailable");
    }
  });

  it("on Linux, refuses a secret store that protects nothing, without a prompt", async () => {
    for (const backend of ["basic_text", "unknown", null]) {
      const store = fakeKeychain({ backend });
      const linux = ring(store.keychain, { platform: "linux" });
      // Nothing wrapped yet: a probe asks nothing at all.
      linux.probe();
      await linux.unlock!();
      expect(reason(() => linux.active())).toBe("unavailable");
      expect(store.calls()).toBe(0);
      writeFileSync(path, Buffer.from("VHK1wrapped:x"));
      expect(reason(() => linux.probe())).toBe("unavailable");
      rmSync(path);
    }
    // Chromium's async fallback key (`v10` on Linux) is a constant: refused,
    // whether it wraps a new key or an old one.
    const fallback = fakeKeychain();
    fallback.state.output = Buffer.from("v10wrapped-under-a-constant");
    const linux = ring(fallback.keychain, { platform: "linux" });
    await linux.unlock!();
    expect(reason(() => linux.active())).toBe("unavailable");
    writeFileSync(path, Buffer.from("VHK1v10wrapped-under-a-constant"));
    const old = fakeKeychain();
    const reopened = ring(old.keychain, { platform: "linux" });
    await reopened.unlock!();
    expect(reason(() => reopened.resolve("0".repeat(32)))).toBe("unavailable");
    expect(old.state.decrypts).toBe(0);
    rmSync(path);
    // macOS's keychain provider tags `v10` too: there it is a real key.
    const mac = fakeKeychain();
    mac.state.output = Buffer.from("v10wrapped:x");
    const darwin = ring(mac.keychain);
    await darwin.unlock!();
    expect(darwin.active().key).toHaveLength(32);
    rmSync(path);
    // A real secret store on Linux, and this process's own platform by default.
    expect((await unlocked(fakeKeychain().keychain, { platform: "linux" })).key.key).toHaveLength(
      32,
    );
    rmSync(path);
    const native = keychainCredentialKeyring({ path, keychain: fakeKeychain().keychain });
    await native.unlock!();
    expect(native.active().key).toHaveLength(32);
  });

  it("refuses to make a key the keychain will not wrap, and leaves no file", async () => {
    for (const output of [Buffer.alloc(0), Buffer.alloc(64 * 1024 + 1), "not a buffer"]) {
      const { keychain, state } = fakeKeychain();
      state.output = output;
      const keyring = ring(keychain);
      await keyring.unlock!();
      expect(reason(() => keyring.active())).toBe("unavailable");
      // Remembered.
      await keyring.unlock!();
      expect(state.encrypts).toBe(1);
    }
    const { keychain, state } = fakeKeychain();
    state.encryptThrows = true;
    const throwing = ring(keychain);
    await throwing.unlock!();
    expect(reason(() => throwing.active())).toBe("unavailable");
    expect(readdirSync(dir)).toEqual([]);
  });

  it("refuses a damaged, unreadable or non-file wrapped key, naming the fix", async () => {
    const { keychain, calls } = fakeKeychain();
    for (const bytes of [
      Buffer.from("VHK1"),
      Buffer.from("XXXXwrapped:abc"),
      Buffer.concat([Buffer.from("VHK1"), Buffer.alloc(64 * 1024 + 1)]),
    ]) {
      writeFileSync(path, bytes);
      const keyring = ring(keychain);
      await keyring.unlock!();
      expect(reason(() => keyring.active())).toBe("malformed");
      expect(reason(() => keyring.resolve("0".repeat(32)))).toBe("malformed");
    }
    chmodSync(path, 0o000);
    const keyring = ring(keychain, { inventoryPath });
    await keyring.unlock!();
    expect(reason(() => keyring.active())).toBe("unreadable");
    rmSync(path);
    mkdirSync(path);
    await keyring.unlock!();
    expect(reason(() => keyring.active())).toBe("not-a-file");
    // None of these is anything the keychain could help with.
    expect(calls()).toBe(0);
  });

  it("sets an orphaned wrapped key aside only while nothing is sealed under it", async () => {
    // Made by another machine's keychain: this one refuses to unwrap it.
    writeFileSync(path, Buffer.from("VHK1foreign-wrapping"));
    const { keychain, state } = fakeKeychain();
    // Never without being told where the inventory is.
    const untold = ring(keychain);
    await untold.unlock!();
    expect(reason(() => untold.active())).toBe("unavailable");
    expect(state.encrypts).toBe(0);
    // A sealed inventory present: never replaced (that is a reset).
    writeFileSync(inventoryPath, "sealed");
    const guarded = ring(keychain, { inventoryPath });
    await guarded.unlock!();
    expect(reason(() => guarded.active())).toBe("unavailable");
    expect(readFileSync(path).toString()).toBe("VHK1foreign-wrapping");
    expect(state.encrypts).toBe(0);
    rmSync(inventoryPath);
    // Nothing sealed: set aside, never deleted, and a fresh key made.
    const { key: fresh } = await unlocked(keychain, { inventoryPath });
    expect(fresh.key).toHaveLength(32);
    const aside = readdirSync(dir).filter((name) =>
      name.startsWith(`${CREDENTIAL_KEYCHAIN_KEY_FILE_NAME}.unused-`),
    );
    expect(aside).toHaveLength(1);
    expect(readFileSync(join(dir, aside[0]!)).toString()).toBe("VHK1foreign-wrapping");
    // A damaged one too, but never beside a sealed inventory.
    writeFileSync(path, Buffer.from("VHK1"));
    writeFileSync(inventoryPath, "sealed");
    const damaged = ring(keychain, { inventoryPath });
    await damaged.unlock!();
    expect(reason(() => damaged.active())).toBe("malformed");
    rmSync(inventoryPath);
    expect((await unlocked(keychain, { inventoryPath })).key.key).toHaveLength(32);
    // A locked keychain is never a reason to replace anything.
    const locked = fakeKeychain();
    locked.state.available = false;
    const before = readFileSync(path);
    const lockedRing = ring(locked.keychain, { inventoryPath });
    await lockedRing.unlock!();
    expect(reason(() => lockedRing.active())).toBe("unavailable");
    expect(readFileSync(path)).toEqual(before);
    // When it cannot be set aside, it says so.
    writeFileSync(path, Buffer.from("VHK1foreign-wrapping"));
    const stuck = ring(keychain, { inventoryPath });
    await stuck.unlock!();
    faults.link = () => {
      throw Object.assign(new Error("EPERM"), { code: "EPERM" });
    };
    expect(reason(() => stuck.active())).toBe("unreadable");
  });

  it("uses the key another process created first, never replacing it", async () => {
    const { key: first } = await unlocked(fakeKeychain().keychain);
    const bytes = readFileSync(path);
    rmSync(path);
    const { keychain, state } = fakeKeychain();
    const racer = ring(keychain);
    await racer.unlock!();
    // The other process's file lands between the wrap and the write...
    writeFileSync(path, bytes);
    expect(reason(() => racer.active())).toBe("pending");
    rmSync(path);
    // ...or between this one's look and its link.
    faults.link = () => {
      writeFileSync(path, bytes);
      throw Object.assign(new Error("EEXIST"), { code: "EEXIST" });
    };
    expect(reason(() => racer.active())).toBe("pending");
    faults.link = null;
    await racer.unlock!();
    expect(racer.active().id).toBe(first.id);
    expect(readFileSync(path)).toEqual(bytes);
    expect(state).toMatchObject({ encrypts: 1, decrypts: 1 });
    expect(readdirSync(dir)).toEqual([CREDENTIAL_KEYCHAIN_KEY_FILE_NAME]);
  });

  it("says when the wrapped key cannot be written, and leaves no temporary", async () => {
    const { keychain } = fakeKeychain();
    chmodSync(dir, 0o500);
    const keyring = ring(keychain);
    await keyring.unlock!();
    expect(reason(() => keyring.active())).toBe("unreadable");
    chmodSync(dir, 0o700);
    const nested = keychainCredentialKeyring({
      path: join(dir, "absent", "k"),
      keychain,
      platform: "darwin",
    });
    await nested.unlock!();
    expect(reason(() => nested.active())).toBe("unreadable");
    for (const [code, expected] of [
      ["EPERM", "no-hard-links"],
      ["ENOSYS", "no-hard-links"],
      ["EIO", "unreadable"],
    ] as const) {
      const once = ring(keychain);
      await once.unlock!();
      faults.link = () => {
        throw Object.assign(new Error(code), { code });
      };
      expect(reason(() => once.active())).toBe(expected);
      faults.link = null;
    }
    expect(readdirSync(dir)).toEqual([]);
  });

  it("starts no keychain call once aborted, and keeps nothing fetched after", async () => {
    const { keychain, state, calls } = fakeKeychain();
    const keyring = ring(keychain);
    // Aborted before it starts: nothing asked.
    await keyring.unlock!({ signal: AbortSignal.abort() });
    expect(calls()).toBe(0);
    // Aborted while the keychain decides availability, or while it wraps: no
    // later call starts, nothing is kept, and nothing is remembered as refused.
    for (const stage of ["availability", "encrypt"] as const) {
      const gate = deferred();
      state.stall = gate.promise;
      state.stallAt = stage;
      const controller = new AbortController();
      const pending = keyring.unlock!({ signal: controller.signal });
      await vi.waitFor(() => expect(state.stalled).toBe(stage));
      controller.abort();
      gate.release();
      await pending;
      state.stalled = null;
      expect(state.encrypts).toBe(stage === "availability" ? 0 : 1);
      expect(reason(() => keyring.active())).toBe("pending");
    }
    state.stallAt = null;
    await keyring.unlock!();
    const key = keyring.active();
    // Unwrapping, abandoned the same way at either await.
    for (const stage of ["availability", "decrypt"] as const) {
      const other = fakeKeychain();
      const later = ring(other.keychain);
      const gate = deferred();
      other.state.stall = gate.promise;
      other.state.stallAt = stage;
      const controller = new AbortController();
      const pending = later.unlock!({ signal: controller.signal });
      await vi.waitFor(() => expect(other.state.stalled).toBe(stage));
      controller.abort();
      gate.release();
      await pending;
      expect(other.state.decrypts).toBe(stage === "decrypt" ? 1 : 0);
      expect(reason(() => later.resolve(key.id))).toBe("pending");
      // Not refused either: the next launch's unlock, unabandoned, opens it.
      other.state.stallAt = null;
      await later.unlock!();
      expect(later.resolve(key.id)).toEqual(key.key);
    }
  });

  it("remembers no refusal an abandoned unlock heard", async () => {
    const { key } = await unlocked(fakeKeychain().keychain);
    for (const wrapped of [true, false]) {
      if (!wrapped) rmSync(path);
      const { keychain, state } = fakeKeychain();
      const keyring = ring(keychain);
      const gate = deferred();
      state.available = false;
      state.stall = gate.promise;
      state.stallAt = "availability";
      const controller = new AbortController();
      const pending = keyring.unlock!({ signal: controller.signal });
      await vi.waitFor(() => expect(state.stalled).toBe("availability"));
      controller.abort();
      gate.release();
      await pending;
      // "Unavailable", heard after the abort, is not this launch's answer.
      expect(reason(() => (wrapped ? keyring.resolve(key.id) : keyring.active()))).toBe("pending");
      state.available = true;
      state.stallAt = null;
      await keyring.unlock!();
      expect(wrapped ? keyring.resolve(key.id) : keyring.active().key).toHaveLength(32);
    }
  });

  it("seals and reopens a typed inventory under the keychain backend", async () => {
    const { keychain, state } = fakeKeychain();
    const keyring = ring(keychain);
    const inventory = new SealedInventory({ path: inventoryPath, keyring });
    // The key is not fetched under the lock: the save says so and is not remembered.
    expect(() => inventory.put("web-search", { provider: "brave" }, "value")).toThrow(
      CredentialKeyPendingError,
    );
    await keyring.unlock!();
    inventory.put("web-search", { provider: "brave" }, "value");
    expect(envelopeHeader(readFileSync(inventoryPath)).backend).toBe("keychain");
    const fresh = fakeKeychain();
    const freshRing = ring(fresh.keychain);
    const reopened = new SealedInventory({ path: inventoryPath, keyring: freshRing });
    // Not fetched yet: `key-pending`, for this read only.
    expect(reopened.status()).toMatchObject({ state: "locked", reason: "key-pending" });
    await freshRing.unlock!();
    expect(reopened.get("web-search", { provider: "brave" })?.value).toBe("value");
    expect(reopened.get("web-search", { provider: "brave" })?.value).toBe("value");
    expect(fresh.state.decrypts).toBe(1);
    expect(state.encrypts).toBe(1);
    // A locked keychain locks the inventory and leaves the file alone.
    const sealed = readFileSync(inventoryPath);
    const locked = fakeKeychain();
    locked.state.available = false;
    const lockedRing = ring(locked.keychain);
    await lockedRing.unlock!();
    const lockedInventory = new SealedInventory({ path: inventoryPath, keyring: lockedRing });
    expect(lockedInventory.status()).toMatchObject({ state: "locked", reason: "unavailable" });
    expect(readFileSync(inventoryPath)).toEqual(sealed);
  });
});

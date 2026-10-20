import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vite-plus/test";
import { fileSecretKey, SecretStore } from "@volli/host-core/secrets";
import { N1SecretStore } from "@volli/host-core/testing";
import { keychainSecretCodec } from "./codec";

/**
 * Ciphertext the keychain adapter wrote BEFORE the secret-key port existed
 * (VC-559), captured from `main` at 3addbe827 with the fixture keychain below.
 * macOS behavior is unchanged only if these still open, byte for byte.
 */
const FIXTURE_KEYCHAIN = {
  isEncryptionAvailable: () => true,
  getSelectedStorageBackend: () => "keychain",
  encryptString: (value: string) => Buffer.from(`fixture-keychain:${value}`),
  decryptString: (value: Buffer) => {
    const text = value.toString();
    if (!text.startsWith("fixture-keychain:")) throw new Error("not this keychain's item");
    return text.slice("fixture-keychain:".length);
  },
};
/** `keychainSecretCodec(FIXTURE_KEYCHAIN).encryptString("a fixture plaintext")`. */
const VSC1_ENVELOPE =
  "VlNDMQAAAD1maXh0dXJlLWtleWNoYWluOnRIa1hCUnk4cDJkVWpXNVlRN1RIM2RId3lPbUU3THJ1Z1JoK1E2SzQxMUk90jFFgZgPWtTcdblxGwdRtIgBdYdotKpViqmZnUwfSANY4N5YoKVbLvbA6VDwQ7o=";
/** A whole `session-secrets.enc`: one Always and one Project secret. */
const VSC1_STORE =
  "VlNDMQAAAD1maXh0dXJlLWtleWNoYWluOitzWW9UNUhlbmNrdEpDVnNIYXFXdGc1ZzBJNWl5b21IYXJISjluUU10dlU9wviighX7zVG9BpVcOAyVm/1ebKBhcFWx67Yee+WK/J4lQU2QQzdNpvX7RMK/4DlIoJlS1aBoQJLy69tNWsNltn52xDXyMm6VgiXSFGqEem/qJmZbW4rAgmw+KC86mgOExEEB0wXn1VThiRMqRTbsRc7pA1gYrvxKAuwWToJpgUfU12tpGmKhT9Z9CSLZLlw5oeZuC6o7BYlMENaDPLwgf2oSSQnlbKrGSXZuN3igMXUKLITGdtg+rn2HjTwFwvaw2HcIV/J6WmR2rZtR3Q2O7Wn364aEU5ixflcc8P9go2kZVa1k7wfueOz5BCNUNZLXw3mlnfB3gTTHqVLfI2/SVQkWV6/VhSeQecJaMOUvyZ+YS8L4rMqcejpj4GjdxnnFdDO9DiM1leHtv6pDvfHvT54V7zR+VUFw7GFfwiwsL4YyjjjbrZ1I3+LNrBwkDr0RqYowjzctJXVY7OajUBpmHA==";

describe("existing keychain ciphertext (VC-559: macOS unchanged)", () => {
  it("opens an envelope written before the port existed", () => {
    const codec = keychainSecretCodec(FIXTURE_KEYCHAIN);
    expect(codec.decryptString(Buffer.from(VSC1_ENVELOPE, "base64"))).toBe("a fixture plaintext");
    // And still writes the same envelope shape: VSC1, the wrapped key's length, the wrapped key.
    const sealed = codec.encryptString("again");
    expect(sealed.subarray(0, 4).toString()).toBe("VSC1");
    expect(sealed.readUInt32BE(4)).toBe(61);
    expect(sealed.subarray(8, 8 + 61).toString()).toMatch(/^fixture-keychain:/);
  });

  it("opens a whole secret store written before the port existed, and rewrites it the same way", () => {
    const dir = mkdtempSync(join(tmpdir(), "volli-keychain-fixture-"));
    try {
      const path = join(dir, "session-secrets.enc");
      writeFileSync(path, Buffer.from(VSC1_STORE, "base64"), { mode: 0o600 });
      const store = new SecretStore(path, keychainSecretCodec(FIXTURE_KEYCHAIN));
      expect(store.environment("session-1", "project-fixture")).toEqual({
        STRIPE_API_KEY: "sk_fixture_always",
        DEPLOY_TOKEN: "fixture-project-token",
      });
      expect(
        store
          .list()
          .map(({ name, scope }) => `${scope}:${name}`)
          .toSorted(),
      ).toEqual(["always:STRIPE_API_KEY", "project:DEPLOY_TOKEN"]);
      // `environment` recorded last use, so the file was resealed: under the same
      // wrapped key, in the same envelope.
      const resealed = readFileSync(path);
      const original = Buffer.from(VSC1_STORE, "base64");
      expect(resealed.subarray(0, 8 + 61).equals(original.subarray(0, 8 + 61))).toBe(true);
      expect(
        new SecretStore(path, keychainSecretCodec(FIXTURE_KEYCHAIN)).list().map((s) => s.name),
      ).toHaveLength(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not open the headless file key's envelope, and calls it another adapter's (VC-641)", () => {
    const dir = mkdtempSync(join(tmpdir(), "volli-keychain-fixture-"));
    try {
      const path = join(dir, "session-secrets.enc");
      new SecretStore(path, fileSecretKey({ path: join(dir, "key") })).put({
        name: "HEADLESS",
        value: "headless-value",
        scope: "always",
      });
      const fileSealed = readFileSync(path);
      const keychain = {
        ...FIXTURE_KEYCHAIN,
        decryptString: vi.fn(FIXTURE_KEYCHAIN.decryptString),
      };
      expect(() => keychainSecretCodec(keychain).decryptString(fileSealed)).toThrow(
        /^The saved secrets were sealed by a headless host's key file/,
      );
      const store = new SecretStore(path, keychainSecretCodec(keychain));
      expect(store.status()).toEqual({
        state: "locked",
        reason: "other-adapter",
        unavailable: ["session-env"],
      });
      expect(store.list()).toEqual([]);
      expect(keychain.decryptString).not.toHaveBeenCalled();
      expect(readFileSync(path).equals(fileSealed)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("launch-cached keychain wrapping", () => {
  it("touches no keychain on construction, wraps once, and unwraps once next launch", () => {
    const keychain = {
      isEncryptionAvailable: () => true,
      encryptString: vi.fn((value: string) => Buffer.from(`wrapped:${value}`)),
      decryptString: vi.fn((value: Buffer) => value.toString().slice(8)),
    };
    const codec = keychainSecretCodec(keychain);
    expect(keychain.encryptString).not.toHaveBeenCalled();
    const first = codec.encryptString("secret-one");
    const second = codec.encryptString("secret-two");
    expect(keychain.encryptString).toHaveBeenCalledTimes(1);
    expect(second.toString()).not.toContain("secret-two");
    const reopened = keychainSecretCodec(keychain);
    expect(reopened.decryptString(first)).toBe("secret-one");
    expect(reopened.decryptString(second)).toBe("secret-two");
    reopened.encryptString("secret-three");
    expect(keychain.decryptString).toHaveBeenCalledTimes(1);
    expect(keychain.encryptString).toHaveBeenCalledTimes(1);
    const corrupt = Buffer.from(second);
    corrupt[corrupt.length - 1]! ^= 1;
    expect(() => reopened.decryptString(corrupt)).toThrow();
  });
  it("refuses a plaintext OS backend and malformed envelopes", () => {
    const keychain = {
      isEncryptionAvailable: () => true,
      getSelectedStorageBackend: () => "basic_text",
      encryptString: vi.fn(),
      decryptString: vi.fn(),
    };
    const codec = keychainSecretCodec(keychain);
    expect(codec.isEncryptionAvailable()).toBe(false);
    expect(() => codec.encryptString("no plaintext fallback")).toThrow();
    expect(keychain.encryptString).not.toHaveBeenCalled();
    for (const value of [Buffer.alloc(0), Buffer.from("plain")])
      expect(() => codec.decryptString(value)).toThrow();
  });
});

describe("a locked or denied keychain (VC-641)", () => {
  function withStore(run: (path: string) => void): void {
    const dir = mkdtempSync(join(tmpdir(), "volli-keychain-locked-"));
    try {
      const path = join(dir, "session-secrets.enc");
      writeFileSync(path, Buffer.from(VSC1_STORE, "base64"), { mode: 0o600 });
      run(path);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it("locks stored secrets, keeps the file, and asks the keychain once until retried", () => {
    withStore((path) => {
      let unlocked = false;
      const keychain = {
        ...FIXTURE_KEYCHAIN,
        decryptString: vi.fn((value: Buffer) => {
          if (!unlocked) throw new Error("User canceled the keychain prompt for fixture-keychain:");
          return FIXTURE_KEYCHAIN.decryptString(value);
        }),
        encryptString: vi.fn(FIXTURE_KEYCHAIN.encryptString),
      };
      const before = readFileSync(path);
      const store = new SecretStore(path, keychainSecretCodec(keychain));
      expect(store.status()).toEqual({
        state: "locked",
        reason: "unavailable",
        unavailable: ["session-env"],
      });
      expect(store.list()).toEqual([]);
      expect(store.environment("session-1", "project-fixture")).toEqual({});
      expect(store.redact("sk_fixture_always")).toBe("sk_fixture_always");
      expect(() => store.put({ name: "NEW", value: "new-value", scope: "always" })).toThrowError(
        /^The keychain did not open the key to saved secrets/,
      );
      store.put({ name: "LIVE", value: "live", scope: "session", sessionId: "session-1" });
      expect(store.environment("session-1", "project-fixture")).toEqual({ LIVE: "live" });
      expect(keychain.decryptString).toHaveBeenCalledTimes(1);
      expect(keychain.encryptString).not.toHaveBeenCalled();
      expect(readFileSync(path).equals(before)).toBe(true);

      unlocked = true;
      expect(store.unlock().state).toBe("ready");
      expect(store.environment("session-1", "project-fixture")).toEqual({
        STRIPE_API_KEY: "sk_fixture_always",
        DEPLOY_TOKEN: "fixture-project-token",
        LIVE: "live",
      });
    });
  });

  it("locks without asking a keychain that is unavailable or plaintext-only", () => {
    withStore((path) => {
      for (const keychain of [
        { ...FIXTURE_KEYCHAIN, isEncryptionAvailable: () => false, decryptString: vi.fn() },
        {
          ...FIXTURE_KEYCHAIN,
          getSelectedStorageBackend: () => "basic_text",
          decryptString: vi.fn(),
        },
      ]) {
        expect(new SecretStore(path, keychainSecretCodec(keychain)).status()).toMatchObject({
          state: "locked",
          reason: "unavailable",
        });
        expect(() => keychainSecretCodec(keychain).decryptString(Buffer.alloc(64))).toThrow(
          /^The keychain did not open/,
        );
        expect(keychain.decryptString).not.toHaveBeenCalled();
      }
    });
  });

  it("calls a file the keychain opened but that does not authenticate corrupt, and reseals under a fresh key after a reset", () => {
    withStore((path) => {
      const bytes = readFileSync(path);
      bytes[bytes.length - 1]! ^= 1;
      writeFileSync(path, bytes);
      const keychain = {
        ...FIXTURE_KEYCHAIN,
        encryptString: vi.fn(FIXTURE_KEYCHAIN.encryptString),
      };
      const store = new SecretStore(path, keychainSecretCodec(keychain));
      expect(store.status()).toEqual({
        state: "corrupt",
        reason: null,
        unavailable: ["session-env"],
      });
      const { archive } = store.reset();
      expect(readFileSync(join(path, "..", archive!)).equals(bytes)).toBe(true);
      store.put({ name: "RE_ENTERED", value: "re-entered", scope: "always" });
      // The damaged file's key was never cached: the new store is wrapped anew.
      expect(keychain.encryptString).toHaveBeenCalledTimes(1);
      expect(
        new SecretStore(path, keychainSecretCodec(FIXTURE_KEYCHAIN)).environment("s", "p"),
      ).toEqual({ RE_ENTERED: "re-entered" });
    });
  });

  it("calls a wrapped key of the wrong size corrupt, not locked", () => {
    const keychain = { ...FIXTURE_KEYCHAIN, decryptString: () => "c2hvcnQ=" };
    expect(() =>
      keychainSecretCodec(keychain).decryptString(Buffer.from(VSC1_ENVELOPE, "base64")),
    ).toThrow("Invalid wrapped key.");
  });
});

/**
 * N-1 on a desktop profile (VC-642): main's exact `SecretStore` at the base
 * commit (`@volli/host-core`'s `test-support/n1/`, pinned there by blob id)
 * with this keychain codec, which is itself unchanged from main (pinned
 * below). An existing store opens with identical contents after the upgrade,
 * and N-1 opens, uses and writes back everything this build writes.
 */
describe("N-1 compatibility on desktop (VC-642)", () => {
  it("keeps this codec byte-identical to main's", () => {
    const bytes = readFileSync(new URL("./codec.ts", import.meta.url));
    const blob = createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
    expect(blob).toBe("ad447b12191a87eb6ddf6579564c7795ceb830f8");
  });

  it("opens the same store as N-1, and each build opens what the other writes", () => {
    const dir = mkdtempSync(join(tmpdir(), "volli-keychain-n1-"));
    vi.spyOn(Date, "now").mockReturnValue(1_791_000_000_000);
    try {
      const path = join(dir, "session-secrets.enc");
      const current = () => new SecretStore(path, keychainSecretCodec(FIXTURE_KEYCHAIN));
      const previous = () => new N1SecretStore(path, keychainSecretCodec(FIXTURE_KEYCHAIN));
      writeFileSync(path, Buffer.from(VSC1_STORE, "base64"), { mode: 0o600 });
      expect(current().list()).toEqual(previous().list());
      current().put({ name: "NEW_TOKEN", value: "new-value", scope: "always" });
      expect(previous().environment("s", "project-fixture")).toEqual(
        current().environment("s", "project-fixture"),
      );
      const old = previous();
      old.revoke(old.list().find((item) => item.name === "NEW_TOKEN")!.id);
      old.put({ name: "N1_TOKEN", value: "n1-value", scope: "always" });
      expect(current().list()).toEqual(previous().list());
      expect(current().environment("s", "elsewhere")).toEqual({
        STRIPE_API_KEY: "sk_fixture_always",
        N1_TOKEN: "n1-value",
      });
      expect(readFileSync(path).subarray(0, 4).toString()).toBe("VSC1");
    } finally {
      vi.restoreAllMocks();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

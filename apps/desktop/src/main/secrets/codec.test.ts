import { describe, expect, it, vi } from "vite-plus/test";
import { keychainSecretCodec } from "./codec";

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

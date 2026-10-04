import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type { SecretKeyPort } from "@volli/host-core/ports";

interface Keychain {
  isEncryptionAvailable(): boolean;
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
  getSelectedStorageBackend?(): string;
}
const MAGIC = Buffer.from("VSC1");
/** A random data key, wrapped by safeStorage, read from the OS keychain at most
 * once per launch. Saves and last-use updates use AES-256-GCM in memory, not
 * another keychain access. Nothing touches the keychain until secrets exist.
 * The wrapped key travels only inside the excluded encrypted credential file.
 */
export function keychainSecretCodec(keychain: Keychain): SecretKeyPort {
  let key: Buffer | undefined;
  let wrapped: Buffer | undefined;
  const available = () =>
    keychain.isEncryptionAvailable() && keychain.getSelectedStorageBackend?.() !== "basic_text";
  return {
    isEncryptionAvailable: available,
    encryptString(value) {
      if (!available()) throw new Error("Secret encryption is unavailable.");
      if (key === undefined) {
        const fresh = randomBytes(32);
        const sealed = keychain.encryptString(fresh.toString("base64"));
        if (sealed.length === 0 || sealed.length > 65536) throw new Error("Invalid wrapped key.");
        key = fresh;
        wrapped = sealed;
      }
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
      const length = Buffer.alloc(4);
      length.writeUInt32BE(wrapped!.length);
      return Buffer.concat([MAGIC, length, wrapped!, iv, cipher.getAuthTag(), encrypted]);
    },
    decryptString(value) {
      if (!available() || value.length < 37 || !value.subarray(0, 4).equals(MAGIC)) {
        throw new Error("Invalid secret storage.");
      }
      const size = value.readUInt32BE(4);
      if (size === 0 || size > 65536 || value.length < 8 + size + 28)
        throw new Error("Invalid secret storage.");
      const sealed = value.subarray(8, 8 + size);
      if (key === undefined) {
        const fresh = Buffer.from(keychain.decryptString(sealed), "base64");
        if (fresh.length !== 32) throw new Error("Invalid wrapped key.");
        key = fresh;
        wrapped = Buffer.from(sealed);
      } else if (!wrapped!.equals(sealed)) throw new Error("Secret storage key changed.");
      const offset = 8 + size;
      const decipher = createDecipheriv("aes-256-gcm", key, value.subarray(offset, offset + 12));
      decipher.setAuthTag(value.subarray(offset + 12, offset + 28));
      return Buffer.concat([
        decipher.update(value.subarray(offset + 28)),
        decipher.final(),
      ]).toString("utf8");
    },
  };
}

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { SecretKeyUnavailableError, type SecretKeyPort } from "@volli/host-core/ports";

interface Keychain {
  isEncryptionAvailable(): boolean;
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
  getSelectedStorageBackend?(): string;
}
const MAGIC = Buffer.from("VSC1");
/** The headless file key's envelope (`@volli/host-core/secrets`, VC-559). */
const FILE_KEY_MAGIC = Buffer.from("VSF1");

/**
 * The keychain would not open the data key (VC-641). The store reports
 * credentials `locked` and keeps the sealed file; it is never read as empty
 * and nothing is sealed over it until the person retries or resets.
 */
function locked(): SecretKeyUnavailableError {
  return new SecretKeyUnavailableError(
    "unavailable",
    "The keychain did not open the key to saved secrets: it is locked, access was denied, " +
      "or it no longer holds the key.",
  );
}
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
      if (!available()) throw locked();
      if (value.subarray(0, 4).equals(FILE_KEY_MAGIC)) {
        // A headless host's key-file store: healthy, just not ours to open.
        throw new SecretKeyUnavailableError(
          "other-adapter",
          "The saved secrets were sealed by a headless host's key file, and this app seals " +
            "with the keychain, so it cannot open them. Reset them and enter the secrets again.",
        );
      }
      if (value.length < 37 || !value.subarray(0, 4).equals(MAGIC)) {
        throw new Error("Invalid secret storage.");
      }
      const size = value.readUInt32BE(4);
      if (size === 0 || size > 65536 || value.length < 8 + size + 28)
        throw new Error("Invalid secret storage.");
      const sealed = value.subarray(8, 8 + size);
      let candidate = key;
      if (candidate === undefined) {
        let unwrapped: string;
        try {
          unwrapped = keychain.decryptString(sealed);
        } catch {
          // Locked, denied, or no longer the keychain item that wrapped it.
          // Never the keychain's own text: it can quote its input.
          throw locked();
        }
        candidate = Buffer.from(unwrapped, "base64");
        if (candidate.length !== 32) throw new Error("Invalid wrapped key.");
      } else if (!wrapped!.equals(sealed)) throw new Error("Secret storage key changed.");
      const offset = 8 + size;
      const decipher = createDecipheriv(
        "aes-256-gcm",
        candidate,
        value.subarray(offset, offset + 12),
      );
      decipher.setAuthTag(value.subarray(offset + 12, offset + 28));
      const plain = Buffer.concat([
        decipher.update(value.subarray(offset + 28)),
        decipher.final(),
      ]).toString("utf8");
      // Cached only once it opened the file: a reset after a corrupt file
      // seals the next inventory under a fresh key.
      key = candidate;
      wrapped = Buffer.from(sealed);
      return plain;
    },
  };
}

/**
 * Desktop's keyring for the typed credential inventory (VC-643): a random
 * data key, wrapped by the OS keychain (Electron's `safeStorage`), kept in
 * `host-credentials.key` beside the inventory. Desktop is the first host with
 * a family in the inventory (the web search keys' sealed mirror), so this is
 * the `keychain` backend whose header byte VC-642 reserved
 * (`ports/credential-keyring.ts`).
 *
 * The `VHC1` envelope has no room for a wrapped key (the legacy `VSC1` one
 * carries it inline), so the wrapped key has its own small file:
 *
 *     "VHK1" | wrapped key (safeStorage's bytes)
 *
 * Wrapped, it opens only through this machine's keychain for this app; it is
 * excluded from backups all the same (`backup/decisions.ts`) and refused to
 * structured reads with every `host-credentials.*` name.
 *
 * - **Lazy, once per key per launch.** Nothing asks the keychain until a
 *   sealed inventory has to be opened ({@link CredentialKeyring.resolve}) or
 *   one is first sealed ({@link CredentialKeyring.active}). An unwrapped key is
 *   held by id for the launch, so later reads and saves never ask again.
 *   {@link CredentialKeyring.probe} never asks the keychain (asking may
 *   prompt): it checks that the keychain answers at all, and reads the wrapped
 *   file again so a key replaced by another process is unwrapped afresh.
 * - **Fail closed, never plaintext.** An unavailable keychain, Electron's
 *   Linux `basic_text` backend, a refused unwrap, a missing or damaged
 *   wrapped file: each is a {@link SecretKeyUnavailableError}, so the
 *   inventory is `locked` and its file byte-identical (VC-641), and boot goes
 *   on. A key is created only to seal, and only while no wrapped file
 *   exists: a missing wrapped file beside a sealed inventory is `missing`,
 *   never a reason to make a new key.
 * - **Created once.** The wrapped key is written whole to a unique `O_EXCL`
 *   0600 temporary, fsynced, then hard-linked into place, which fails rather
 *   than replace a file another process made first; that one is used instead.
 *   The caller holds the credential lock around all of this anyway.
 */
import { randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  linkSync,
  openSync,
  readSync,
  rmSync,
  writeSync,
} from "node:fs";
import { dirname } from "node:path";

import type { CredentialKey, CredentialKeyring } from "../ports/credential-keyring";
import { SecretKeyUnavailableError } from "../ports/secret-key";
import { credentialKeyId } from "./credential-key-id";
import { syncDirectory } from "./durable-file";

/** The wrapped key's file, beside the inventory. */
export const CREDENTIAL_KEYCHAIN_KEY_FILE_NAME = "host-credentials.key";

const MAGIC = Buffer.from("VHK1");
/** `link(2)` answers these on filesystems without hard links (some FUSE, s3fs, container volumes). */
const NO_HARD_LINKS = new Set(["EPERM", "ENOSYS", "ENOTSUP", "EOPNOTSUPP"]);
/** safeStorage's output for a 44-character key is well under this. */
const MAX_WRAPPED_BYTES = 64 * 1024;

/** The part of Electron's `safeStorage` this needs. */
export interface CredentialKeychain {
  isEncryptionAvailable(): boolean;
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
  getSelectedStorageBackend?(): string;
}

export interface KeychainCredentialKeyringOptions {
  /** `<dataDir>/host-credentials.key`. */
  readonly path: string;
  readonly keychain: CredentialKeychain;
}

function unavailable(): SecretKeyUnavailableError {
  return new SecretKeyUnavailableError(
    "unavailable",
    "The keychain did not open the key to saved credentials: it is locked, access was " +
      "denied, or it no longer holds the key.",
  );
}

/** The keychain-wrapped keyring; see this module's comment. */
export function keychainCredentialKeyring(
  options: KeychainCredentialKeyringOptions,
): CredentialKeyring {
  const { path, keychain } = options;
  /** The key unwrapped this launch, and the wrapped bytes it came from. */
  let held: { key: CredentialKey; wrapped: Buffer } | null = null;
  const available = () =>
    keychain.isEncryptionAvailable() && keychain.getSelectedStorageBackend?.() !== "basic_text";
  const unwrap = (wrapped: Buffer): CredentialKey => {
    if (held !== null && held.wrapped.equals(wrapped)) return held.key;
    if (!available()) throw unavailable();
    let text: string;
    try {
      text = keychain.decryptString(wrapped);
    } catch {
      // Never the keychain's own text: it can quote its input.
      throw unavailable();
    }
    const key = Buffer.from(text, "base64");
    if (key.length !== 32 || key.toString("base64") !== text) {
      key.fill(0);
      throw malformed(path);
    }
    held = { key: { id: credentialKeyId(key), key }, wrapped: Buffer.from(wrapped) };
    return held.key;
  };
  return {
    backend: "keychain",
    probe() {
      if (!available()) throw unavailable();
      const wrapped = readWrapped(path);
      // Replaced or removed since it was unwrapped: never use the old key for it.
      if (held !== null && (wrapped === null || !held.wrapped.equals(wrapped))) {
        held.key.key.fill(0);
        held = null;
      }
    },
    resolve(id) {
      const wrapped = readWrapped(path);
      if (wrapped === null) {
        throw new SecretKeyUnavailableError(
          "missing",
          `Saved credentials exist, but the file holding their keychain-wrapped key (${path}) ` +
            "is missing. Put it back to open them. Volli will not make a new key while they exist.",
        );
      }
      const key = unwrap(wrapped);
      if (key.id !== id) {
        throw new SecretKeyUnavailableError(
          "wrong-key",
          `The keychain-wrapped key in ${path} is not the key the saved credentials were ` +
            "sealed with. Put the original file back.",
        );
      }
      return key.key;
    },
    active() {
      const wrapped = readWrapped(path);
      if (wrapped !== null) return unwrap(wrapped);
      if (!available()) throw unavailable();
      const key = randomBytes(32);
      const text = key.toString("base64");
      let sealed: Buffer;
      try {
        sealed = keychain.encryptString(text);
      } catch {
        key.fill(0);
        throw unavailable();
      }
      if (sealed.length === 0 || sealed.length > MAX_WRAPPED_BYTES) {
        key.fill(0);
        throw unavailable();
      }
      if (!createWrapped(path, sealed)) {
        // Another process made one first: use theirs, never replace it.
        key.fill(0);
        return unwrap(readWrapped(path)!);
      }
      held = { key: { id: credentialKeyId(key), key }, wrapped: sealed };
      return held.key;
    },
  };
}

function malformed(path: string): SecretKeyUnavailableError {
  return new SecretKeyUnavailableError(
    "malformed",
    `The file holding the keychain-wrapped key to saved credentials (${path}) is damaged. ` +
      "Reset saved credentials to start again.",
  );
}

/** The wrapped key, or `null` when there is no file. Refuses anything that is not one. */
function readWrapped(path: string): Buffer | null {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new SecretKeyUnavailableError(
      "unreadable",
      `The file holding the keychain-wrapped key to saved credentials (${path}) could not be ` +
        "read. Check its permissions.",
    );
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) {
      throw new SecretKeyUnavailableError(
        "not-a-file",
        `The keychain-wrapped key path ${path} is not a regular file. Move what is there aside.`,
      );
    }
    const buffer = Buffer.alloc(MAGIC.length + MAX_WRAPPED_BYTES + 1);
    const length = readSync(fd, buffer, 0, buffer.length, 0);
    if (
      length <= MAGIC.length ||
      length > MAGIC.length + MAX_WRAPPED_BYTES ||
      !buffer.subarray(0, MAGIC.length).equals(MAGIC)
    ) {
      throw malformed(path);
    }
    return Buffer.from(buffer.subarray(MAGIC.length, length));
  } finally {
    closeSync(fd);
  }
}

/** Writes the wrapped key once. `false` when a file was already there. */
function createWrapped(path: string, wrapped: Buffer): boolean {
  const temporary = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    const fd = openSync(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      const bytes = Buffer.concat([MAGIC, wrapped]);
      writeSync(fd, bytes, 0, bytes.length);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    try {
      linkSync(temporary, path);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EEXIST") return false;
      if (NO_HARD_LINKS.has(code!)) {
        throw new SecretKeyUnavailableError(
          "no-hard-links",
          `The filesystem holding ${path} cannot make hard links, so Volli cannot create the ` +
            "key to saved credentials there safely. Keep the profile on a local filesystem.",
        );
      }
      throw error;
    }
  } catch (error) {
    if (error instanceof SecretKeyUnavailableError) throw error;
    throw new SecretKeyUnavailableError(
      "unreadable",
      `The keychain-wrapped key to saved credentials could not be written beside ${path}. ` +
        "Check that the directory is writable.",
    );
  } finally {
    rmSync(temporary, { force: true });
  }
  // Best effort here: the inventory sealed next lives in this directory and
  // its publish must sync it (`requireDirectorySync`), which makes this link
  // durable too, or fails that save as indeterminate.
  syncDirectory(dirname(path));
  return true;
}

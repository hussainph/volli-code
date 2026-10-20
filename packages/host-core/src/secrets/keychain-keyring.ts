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
 *     "VHK1" | wrapped key (safeStorage's asynchronous API's bytes)
 *
 * Wrapped, it opens only through this machine's keychain for this app; it is
 * excluded from backups all the same (`backup/decisions.ts`) and refused to
 * structured reads with every `host-credentials.*` name.
 *
 * - **Never on the calling thread.** Electron's synchronous `safeStorage`
 *   calls can block the main thread to collect a keychain prompt, and no
 *   deadline interrupts that. So this keyring asks the keychain only through
 *   the asynchronous API (`isAsyncEncryptionAvailable`, `encryptStringAsync`,
 *   `decryptStringAsync`), and only in {@link CredentialKeyring.unlock}.
 *   `probe`, `resolve` and `active`, which run under the credential lock,
 *   answer from what `unlock` fetched, and throw
 *   {@link CredentialKeyPendingError} until it has. One API for this file:
 *   it is new with VC-643 and has never been written by the synchronous one
 *   (the shipped `VSC1` Session-secrets codec keeps the synchronous API).
 *   An `unlock` given an aborted signal starts no keychain call, and one that
 *   aborts keeps nothing it fetched afterwards.
 * - **Lazy, once per key per launch.** Nothing asks the keychain until a
 *   caller unlocks it, which the inventory's callers do only when a sealed
 *   file must be opened or a first one sealed. An unwrapped key is held for
 *   the launch, so later reads and saves never ask again; a key another
 *   process replaced the file with is fetched afresh. A refusal is held too,
 *   so the keychain is asked once.
 * - **Fail closed, never plaintext.** An unavailable keychain, a refused
 *   unwrap, a missing or damaged wrapped file, and on Linux a keychain that is
 *   not a real secret store (the `basic_text` backend, a `safeStorage` without
 *   `getSelectedStorageBackend`, or a wrapping under the async API's fallback
 *   `v10` key, a constant compiled into Chromium): each is a
 *   {@link SecretKeyUnavailableError}, so the inventory is `locked` and its
 *   file byte-identical (VC-641), and boot goes on. A key is made only to
 *   seal, and only while no wrapped file exists: a missing wrapped file
 *   beside a sealed inventory is `missing`, never a reason to make a new key.
 * - **Created once, under the lock.** The new key is wrapped in `unlock`, but
 *   written in `active` (under the credential lock): whole, to a unique
 *   `O_EXCL` 0600 temporary, fsynced, then hard-linked into place, which fails
 *   rather than replace a file another process made first. That one is then
 *   fetched instead.
 */
import { randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  linkSync,
  openSync,
  readSync,
  rmSync,
  writeSync,
} from "node:fs";
import { dirname } from "node:path";

import {
  CredentialKeyPendingError,
  type CredentialKey,
  type CredentialKeyring,
} from "../ports/credential-keyring";
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
/**
 * On Linux, the tag of Chromium's asynchronous fallback key provider, used
 * when no secret service answers: a fixed key, so a wrapping under it
 * protects nothing.
 */
const LINUX_FALLBACK_TAG = Buffer.from("v10");

/** The part of Electron's `safeStorage` this needs: its asynchronous API. */
export interface CredentialKeychain {
  isAsyncEncryptionAvailable(): Promise<boolean>;
  encryptStringAsync(value: string): Promise<Buffer>;
  decryptStringAsync(value: Buffer): Promise<{ result: string }>;
  /** Linux only, in Electron: which secret store it picked. */
  getSelectedStorageBackend?(): string;
}

export interface KeychainCredentialKeyringOptions {
  /** `<dataDir>/host-credentials.key`. */
  readonly path: string;
  readonly keychain: CredentialKeychain;
  /**
   * The inventory this key seals (`<dataDir>/host-credentials.enc`). While
   * nothing is there, a wrapped key this keychain will not open seals
   * nothing, so it is set aside (renamed, never deleted) and a new key made,
   * rather than leave sealing stuck (a profile copied from another machine,
   * a keychain item replaced). With a sealed inventory present it is never
   * replaced: that is a reset, person intent. Omitted: never replaced.
   */
  readonly inventoryPath?: string;
  /** Which platform's rules apply. Defaults to `process.platform`. */
  readonly platform?: NodeJS.Platform;
}

function unavailable(): SecretKeyUnavailableError {
  return new SecretKeyUnavailableError(
    "unavailable",
    "The keychain did not open the key to saved credentials: it is locked, access was " +
      "denied, or it no longer holds the key.",
  );
}

interface Held {
  readonly key: CredentialKey;
  readonly wrapped: Buffer;
}

/** Wipes a key no longer held. Always `null`, for the slot it leaves. */
function drop(entry: Held | null): null {
  entry?.key.key.fill(0);
  return null;
}

/** The keychain-wrapped keyring; see this module's comment. */
export function keychainCredentialKeyring(
  options: KeychainCredentialKeyringOptions,
): CredentialKeyring {
  const { path, keychain } = options;
  const linux = (options.platform ?? process.platform) === "linux";
  /** The key unwrapped (or made and written) this launch, and its wrapped bytes. */
  let held: Held | null = null;
  /** Wrapped bytes this keychain refused to open this launch. */
  let refused: Buffer | null = null;
  /** A new key, wrapped and not yet written: `active` writes it under the lock. */
  let fresh: Held | null = null;
  /** The keychain refused to wrap a new key this launch. */
  let freshRefused = false;

  /**
   * On Linux, whether this is a real secret store, asked without a prompt.
   * Electron's `safeStorage` has `getSelectedStorageBackend` there, so a
   * `safeStorage` without it is not one this can judge: refused.
   */
  const unsafeStore = (): boolean => {
    if (!linux) return false;
    const backend = keychain.getSelectedStorageBackend?.();
    return backend === undefined || backend === "basic_text" || backend === "unknown";
  };
  const fallbackWrapped = (wrapped: Buffer): boolean =>
    linux && wrapped.subarray(0, LINUX_FALLBACK_TAG.length).equals(LINUX_FALLBACK_TAG);
  /** Nothing is sealed under the wrapped key, as far as this keyring is told. */
  const nothingSealed = (): boolean =>
    options.inventoryPath === undefined || !existsSync(options.inventoryPath);
  /** A wrapped key this keychain will not open may be set aside: never untold. */
  const replaceable = (): boolean => options.inventoryPath !== undefined && nothingSealed();
  /** Whether the keychain answers, asked asynchronously; a throw is "no". */
  const answers = async (): Promise<boolean> => {
    if (unsafeStore()) return false;
    try {
      return (await keychain.isAsyncEncryptionAvailable()) === true;
    } catch {
      return false;
    }
  };

  /** Fetches the key `wrapped` holds. Remembers a refusal. */
  const unwrap = async (wrapped: Buffer, signal: AbortSignal | undefined): Promise<void> => {
    if (fallbackWrapped(wrapped) || !(await answers())) {
      if (!signal?.aborted) refused = wrapped;
      return;
    }
    if (signal?.aborted) return;
    let text: string | null = null;
    try {
      text = (await keychain.decryptStringAsync(wrapped)).result;
    } catch {
      // Never the keychain's own text: it can quote its input.
    }
    if (signal?.aborted) return;
    const key = text === null ? null : Buffer.from(text, "base64");
    if (key === null || key.length !== 32 || key.toString("base64") !== text) {
      key?.fill(0);
      refused = wrapped;
      return;
    }
    drop(held);
    held = { key: { id: credentialKeyId(key), key }, wrapped };
  };

  /** Wraps a new key, for `active` to write. Remembers a refusal. */
  const make = async (signal: AbortSignal | undefined): Promise<void> => {
    if (signal?.aborted || fresh !== null || freshRefused) return;
    if (!(await answers())) {
      if (!signal?.aborted) freshRefused = true;
      return;
    }
    if (signal?.aborted) return;
    const key = randomBytes(32);
    let sealed: Buffer | null = null;
    try {
      sealed = await keychain.encryptStringAsync(key.toString("base64"));
    } catch {
      // Refused; never the keychain's text.
    }
    if (signal?.aborted) {
      key.fill(0);
      return;
    }
    if (
      !Buffer.isBuffer(sealed) ||
      sealed.length === 0 ||
      sealed.length > MAX_WRAPPED_BYTES ||
      fallbackWrapped(sealed)
    ) {
      key.fill(0);
      freshRefused = true;
      return;
    }
    fresh = { key: { id: credentialKeyId(key), key }, wrapped: Buffer.from(sealed) };
  };

  return {
    backend: "keychain",
    probe() {
      const wrapped = readWrapped(path);
      // On Linux, a store that protects nothing is locked before anything
      // sealed here is opened. No keychain call: nothing here may prompt.
      if (wrapped !== null && unsafeStore()) throw unavailable();
      // Replaced or removed since it was unwrapped: never use the old key for it.
      if (held !== null && (wrapped === null || !held.wrapped.equals(wrapped))) held = drop(held);
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
      if (held === null || !held.wrapped.equals(wrapped)) {
        if (refused?.equals(wrapped)) throw unavailable();
        throw new CredentialKeyPendingError();
      }
      if (held.key.id !== id) {
        throw new SecretKeyUnavailableError(
          "wrong-key",
          `The keychain-wrapped key in ${path} is not the key the saved credentials were ` +
            "sealed with. Put the original file back.",
        );
      }
      return held.key.key;
    },
    active() {
      let wrapped: Buffer | null;
      let damaged: SecretKeyUnavailableError | null = null;
      try {
        wrapped = readWrapped(path);
      } catch (error) {
        if ((error as SecretKeyUnavailableError).reason !== "malformed") throw error;
        damaged = error as SecretKeyUnavailableError;
        wrapped = null;
      }
      if (wrapped !== null && held?.wrapped.equals(wrapped)) return held.key;
      if (wrapped !== null && !refused?.equals(wrapped)) throw new CredentialKeyPendingError();
      // No file, a damaged one, or one this keychain refused to open. The
      // last two are replaceable only while nothing is sealed under them.
      const replacing = wrapped !== null || damaged !== null;
      if (replacing && !replaceable()) throw damaged ?? unavailable();
      if (fresh === null) {
        if (freshRefused) throw unavailable();
        throw new CredentialKeyPendingError();
      }
      if (replacing) setAside(path);
      const made = fresh;
      fresh = null;
      if (!createWrapped(path, made.wrapped)) {
        // Another process made one first: fetch theirs, never replace it.
        drop(made);
        throw new CredentialKeyPendingError();
      }
      drop(held);
      held = made;
      return made.key;
    },
    async unlock({ signal } = {}) {
      if (signal?.aborted) return;
      let wrapped: Buffer | null;
      let damaged = false;
      try {
        wrapped = readWrapped(path);
      } catch (error) {
        // Unreadable or not a file: nothing the keychain can help with.
        if ((error as SecretKeyUnavailableError).reason !== "malformed") return;
        damaged = true;
        wrapped = null;
      }
      if (wrapped !== null) {
        if (held?.wrapped.equals(wrapped)) return;
        if (!refused?.equals(wrapped)) await unwrap(wrapped, signal);
        if (signal?.aborted || held?.wrapped.equals(wrapped) || !replaceable()) return;
      } else if (damaged ? !replaceable() : !nothingSealed()) {
        // None at all, or a damaged one, beside a sealed inventory: `missing`
        // or `malformed`, never a reason to make a new key.
        return;
      }
      await make(signal);
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

/**
 * Moves an orphaned wrapped key aside under a unique name beside it, never
 * overwriting and never deleting: a hard link, a directory sync, then the old
 * name goes. Excluded from backups by the `host-credentials.key*` rule.
 */
function setAside(path: string): void {
  const aside = `${path}.unused-${Date.now()}-${randomBytes(4).toString("hex")}`;
  try {
    linkSync(path, aside);
    syncDirectory(dirname(path));
    rmSync(path);
  } catch {
    throw new SecretKeyUnavailableError(
      "unreadable",
      `The keychain will not open the key in ${path}, and it could not be set aside. ` +
        "Move it aside; nothing is sealed under it.",
    );
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

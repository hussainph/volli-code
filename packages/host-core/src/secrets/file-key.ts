/**
 * The headless secret-key adapter: a random data key in a mode-0600 file
 * (VC-559).
 *
 * A host with no OS keychain (`apps/hostd` on a Linux box) seals its
 * `session-secrets.enc` with this instead of desktop's
 * `keychainSecretCodec(safeStorage)`. The key is 32 random bytes, base64 on one
 * line, at `<dataDir>/session-secrets.key`, or wherever `VOLLI_SECRET_KEY_FILE`
 * points (an absolute path; a systemd credential or a mounted secret, say).
 *
 * THREAT MODEL. The key file keeps stored secrets from other users on the
 * machine (both files are 0600, and a key file any other user can read is
 * refused, as ssh refuses a private key) and from anyone holding a copy of the
 * data directory without the key: a Volli backup bundle (which never carries
 * either file), a disk snapshot or rsync of the data dir taken while the key
 * lives elsewhere through `VOLLI_SECRET_KEY_FILE`. It does not protect against
 * root, against the user Volli runs as or anything running as that user (every
 * Session's commands included), or against anyone who can read both the data
 * directory and the key file: with the default path, a copy of the whole data
 * directory carries the key beside the ciphertext. That is the same bar as
 * Pi's `auth.json`, which already holds model credentials in plain text under
 * the same user. Keep the key out of the data directory when the data
 * directory is copied somewhere less trusted than the machine.
 *
 * THE RULES IT KEEPS.
 * - **Created once, atomically.** Written whole to a 0600 temporary file,
 *   fsynced, then hard-linked into place, so a reader never sees half a key
 *   and two hosts racing to create it agree on one.
 * - **Never re-keyed silently.** A key is created only to seal, and the store
 *   always opens what exists before it seals anything. So sealed secrets whose
 *   key file is missing, or is a different key, are refused with a sentence
 *   that names the fix, and nothing is written over them.
 * - **Never logged.** No key byte, and no secret, reaches a message, a log
 *   line or an error. Messages name the key file's path, which is
 *   configuration.
 * - **Loaded once per process**, lazily: an empty profile, or one with only
 *   Session-scoped secrets, never touches the file.
 *
 * Its envelope is `VSF1 | key id (8) | iv (12) | tag (16) | ciphertext`,
 * AES-256-GCM with the first twelve bytes as associated data. The key id is a
 * truncated SHA-256 of the key under a fixed label: it tells "wrong key" from
 * "corrupt file" and says nothing usable about a 256-bit key. A keychain
 * envelope (`VSC1`) is refused as sealed by another adapter.
 */
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readSync,
  rmSync,
  type Stats,
  writeSync,
} from "node:fs";
import { dirname, isAbsolute, join } from "node:path";

import { SecretKeyUnavailableError, type SecretKeyPort } from "../ports/secret-key";

/** The secret store's file, beside the database in every host. */
export const SECRET_STORE_FILE_NAME = "session-secrets.enc";
/** The headless key file's default name, in the data directory. */
export const SECRET_KEY_FILE_NAME = "session-secrets.key";
/** Names a key file outside the data directory. Absolute only. */
export const SECRET_KEY_FILE_ENV = "VOLLI_SECRET_KEY_FILE";

const MAGIC = Buffer.from("VSF1");
const KEYCHAIN_MAGIC = Buffer.from("VSC1");
const KEY_BYTES = 32;
const ID_BYTES = 8;
const HEADER_BYTES = MAGIC.length + ID_BYTES;
const IV_BYTES = 12;
const TAG_BYTES = 16;
/** A key line is 45 bytes; anything much larger is not a key file. */
const MAX_KEY_FILE_BYTES = 1024;
/** Durable: changing it makes every sealed store read as sealed under another key. */
const KEY_ID_LABEL = "volli-secret-key-id:v1\0";
const KEY_LINE = /^[A-Za-z0-9+/]{43}=$/;
/** Starting over keeps the sealed file (VC-641): it is set aside, never deleted. */
const START_OVER =
  "To start over without them, run `volli-hostd credentials reset`, which sets " +
  `${SECRET_STORE_FILE_NAME} aside, and enter the secrets again.`;

/**
 * Where a headless host keeps its key: `VOLLI_SECRET_KEY_FILE` when set, else
 * `<dataDir>/session-secrets.key`. A relative override is refused rather than
 * resolved against whatever directory a service manager started in.
 */
export function secretKeyFilePath(
  dataDir: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  const configured = env[SECRET_KEY_FILE_ENV];
  if (configured === undefined || configured.length === 0) {
    return join(dataDir, SECRET_KEY_FILE_NAME);
  }
  if (!isAbsolute(configured)) {
    throw new SecretKeyUnavailableError(
      "relative-path",
      `${SECRET_KEY_FILE_ENV} must be an absolute path, and it is "${configured}".`,
    );
  }
  return configured;
}

export interface FileSecretKeyOptions {
  /** The key file. Resolve it with {@link secretKeyFilePath}. */
  path: string;
}

/** The secret-key port backed by a key file. See this module's comment. */
export function fileSecretKey(options: FileSecretKeyOptions): SecretKeyPort {
  const path = options.path;
  let key: Buffer | undefined;
  let id: Buffer | undefined;
  const adopt = (loaded: Buffer): void => {
    key = loaded;
    id = keyId(loaded);
  };
  return {
    isEncryptionAvailable: () => true,
    probe() {
      inspectSecretKeyFile(path);
    },
    encryptString(value) {
      if (key === undefined) adopt(readKey(path) ?? createKey(path));
      const header = Buffer.concat([MAGIC, id!]);
      const iv = randomBytes(IV_BYTES);
      const cipher = createCipheriv("aes-256-gcm", key!, iv);
      cipher.setAAD(header);
      const sealed = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
      return Buffer.concat([header, iv, cipher.getAuthTag(), sealed]);
    },
    decryptString(value) {
      if (value.subarray(0, KEYCHAIN_MAGIC.length).equals(KEYCHAIN_MAGIC)) {
        throw new SecretKeyUnavailableError(
          "other-adapter",
          "The saved secrets were sealed by the macOS keychain, and this host seals " +
            `with a key file, so it cannot open them. ${START_OVER}`,
        );
      }
      if (
        value.length < HEADER_BYTES + IV_BYTES + TAG_BYTES ||
        !value.subarray(0, MAGIC.length).equals(MAGIC)
      ) {
        throw new Error("Invalid secret storage.");
      }
      let candidate = key;
      let candidateId = id;
      if (candidate === undefined) {
        // Opening never creates: a missing key is a refusal, never a new key.
        const loaded = readKey(path);
        if (loaded === null) {
          throw new SecretKeyUnavailableError(
            "missing",
            `Saved secrets exist, but their key file ${path} is missing. Put the key ` +
              "file back (mode 0600) to open them. Volli will not make a new key while " +
              `they exist. ${START_OVER}`,
          );
        }
        candidate = loaded;
        candidateId = keyId(loaded);
      }
      if (!timingSafeEqual(value.subarray(MAGIC.length, HEADER_BYTES), candidateId!)) {
        // A key that is not this store's is never adopted, so putting the
        // right one back opens on the next try in this process too.
        if (candidate !== key) candidate.fill(0);
        throw new SecretKeyUnavailableError(
          "wrong-key",
          `The key file ${path} is not the key the saved secrets were sealed with. ` +
            `Put the original key file back. ${START_OVER}`,
        );
      }
      adopt(candidate);
      const ivAt = HEADER_BYTES;
      const tagAt = ivAt + IV_BYTES;
      const decipher = createDecipheriv("aes-256-gcm", key!, value.subarray(ivAt, tagAt));
      decipher.setAAD(value.subarray(0, HEADER_BYTES));
      decipher.setAuthTag(value.subarray(tagAt, tagAt + TAG_BYTES));
      return Buffer.concat([
        decipher.update(value.subarray(tagAt + TAG_BYTES)),
        decipher.final(),
      ]).toString("utf8");
    },
  };
}

/**
 * Checks the key file at `path` now, without creating one: `"absent"` when
 * nothing is there, `"present"` when it holds a usable key. Every refusal the
 * adapter would raise later (too open, wrong owner, not a file, malformed,
 * unreadable) is raised here instead, so a headless host can refuse to boot on
 * a bad key rather than on the first save. The key bytes are dropped at once.
 */
export function inspectSecretKeyFile(path: string): "absent" | "present" {
  const key = readKey(path);
  if (key === null) return "absent";
  key.fill(0);
  return "present";
}

function keyId(key: Buffer): Buffer {
  return createHash("sha256").update(KEY_ID_LABEL).update(key).digest().subarray(0, ID_BYTES);
}

/** The key, or `null` when nothing is at `path`. Refuses a key others could read. */
function readKey(path: string): Buffer | null {
  let fd: number;
  try {
    // Symlinks are followed, as ssh follows them for a key: a systemd
    // credential or a mounted secret is often one. The checks below read the
    // file itself. O_NONBLOCK keeps a FIFO from hanging the open.
    fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return null;
    throw unreadable(path, error);
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) {
      throw new SecretKeyUnavailableError(
        "not-a-file",
        `The secret key path ${path} is not a regular file. Point ${SECRET_KEY_FILE_ENV} ` +
          "at a key file, or move what is there aside so Volli can create one.",
      );
    }
    refuseShared(path, stat);
    const buffer = Buffer.alloc(MAX_KEY_FILE_BYTES + 1);
    try {
      const length = readSync(fd, buffer, 0, buffer.length, 0);
      return parseKey(path, buffer.subarray(0, length));
    } finally {
      buffer.fill(0);
    }
  } catch (error) {
    if (error instanceof SecretKeyUnavailableError) throw error;
    throw unreadable(path, error);
  } finally {
    closeSync(fd);
  }
}

/** ssh's rule for a private key: only its owner may have any access to it. */
function refuseShared(path: string, stat: Stats): void {
  // POSIX: hostd runs on Linux and macOS, never Windows.
  const permissions = stat.mode & 0o777;
  if ((permissions & 0o077) !== 0) {
    const octal = permissions.toString(8).padStart(4, "0");
    throw new SecretKeyUnavailableError(
      "too-open",
      `Permissions ${octal} on the secret key file ${path} are too open: other users on ` +
        `this machine could read it, so Volli will not use it. Run: chmod 600 ${path}`,
    );
  }
  const uid = process.getuid!();
  if (stat.uid !== uid) {
    throw new SecretKeyUnavailableError(
      "wrong-owner",
      `The secret key file ${path} belongs to uid ${stat.uid}, not to the user Volli ` +
        `runs as (uid ${uid}), so Volli will not use it. Run: chown ${uid} ${path}`,
    );
  }
}

function parseKey(path: string, bytes: Buffer): Buffer {
  const line = bytes.toString("utf8").trim();
  if (!KEY_LINE.test(line)) {
    throw new SecretKeyUnavailableError(
      "malformed",
      `The secret key file ${path} does not hold a key. It must be one line: 32 random ` +
        "bytes in base64, as `openssl rand -base64 32` prints. If secrets were saved " +
        "with the key this file used to hold, put that key back instead.",
    );
  }
  // The pattern admits exactly 43 base64 digits and one pad: 32 bytes.
  return Buffer.from(line, "base64");
}

/**
 * Makes a fresh key at `path`, or adopts the one another process made first.
 * Called only to seal, and the store has always opened what exists by then.
 */
function createKey(path: string): Buffer {
  const directory = dirname(path);
  const temporary = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  const key = randomBytes(KEY_BYTES);
  let linked: boolean;
  try {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const fd = openSync(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      fchmodSync(fd, 0o600);
      writeSync(fd, `${key.toString("base64")}\n`);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    // A link never replaces an existing file: whoever links first wins, and
    // the loser adopts the winner's key.
    linked = linkOnce(temporary, path);
  } catch (error) {
    if (error instanceof SecretKeyUnavailableError) throw error;
    throw unreadable(path, error);
  } finally {
    rmSync(temporary, { force: true });
  }
  if (!linked) {
    key.fill(0);
    return readKey(path) ?? raise(unreadable(path, null));
  }
  syncDirectory(directory);
  return key;
}

/**
 * What `link(2)` answers on a filesystem that cannot make hard links: some
 * FUSE mounts, s3fs and container volumes. Not a permissions problem, so it
 * gets its own sentence rather than the "must be able to write" one.
 */
const NO_HARD_LINKS = new Set(["EPERM", "ENOSYS", "ENOTSUP", "EOPNOTSUPP"]);

function linkOnce(from: string, to: string): boolean {
  try {
    linkSync(from, to);
    return true;
  } catch (error) {
    const code = errorCode(error);
    if (code === "EEXIST") return false;
    if (code !== undefined && NO_HARD_LINKS.has(code)) {
      throw new SecretKeyUnavailableError(
        "no-hard-links",
        `Volli could not create the secret key file ${to} (${code}): its filesystem ` +
          "cannot make hard links, which Volli uses to create the key atomically. " +
          "Create the key yourself instead, private from its first byte: " +
          `(umask 077 && openssl rand -base64 32 > ${to})`,
      );
    }
    throw error;
  }
}

/** Makes the new name durable. Some filesystems cannot sync a directory; the file is synced. */
function syncDirectory(directory: string): void {
  let handle: number | undefined;
  try {
    handle = openSync(directory, "r");
    fsyncSync(handle);
  } catch {
    // Best effort, as for the secret store's own rename.
  } finally {
    if (handle !== undefined) closeSync(handle);
  }
}

function raise(error: Error): never {
  throw error;
}

function unreadable(path: string, error: unknown): SecretKeyUnavailableError {
  const code = errorCode(error);
  return new SecretKeyUnavailableError(
    "unreadable",
    `Volli could not read or create the secret key file ${path}` +
      `${code === undefined ? "" : ` (${code})`}. The user Volli runs as must be able ` +
      "to read it, and to write its directory the first time.",
  );
}

function errorCode(error: unknown): string | undefined {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return typeof code === "string" ? code : undefined;
}

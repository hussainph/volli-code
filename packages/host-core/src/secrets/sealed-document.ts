/**
 * One sealed credential file, shared safely between processes (VC-642;
 * `docs/plans/sealed-credential-store.md` §6). The engine under every sealed
 * store: the legacy Session-secrets file (`store.ts`) and the typed
 * inventory (`inventory.ts`) differ only in the {@link SealedCodec} they pass.
 *
 * - **Fresh under the lock.** {@link SealedDocument.read} and
 *   {@link SealedDocument.update} take the {@link CredentialLock}, ask the key
 *   backend to look again (`probe`), and read and open the file again. So a
 *   revocation another process committed is seen by the next read here, and a
 *   key removed or replaced while this process runs is noticed by the next
 *   read rather than the next launch. Sealed files are small; opening one is
 *   an AES-GCM pass and a parse, and a key backend caches by key id, so no
 *   read prompts a keychain twice for one key.
 * - **Never a synchronous wait.** Both take the lock with one non-blocking
 *   attempt: another process holding it is {@link CredentialLockBusyError}
 *   at once. A caller that can wait retries asynchronously
 *   (`retryWhileBusy`); Electron's main thread never stalls on another
 *   process.
 * - **Scoped merges.** An update applies the caller's change to the document
 *   it just reloaded, never to a copy cached earlier, so two processes'
 *   changes to different records both survive.
 * - **Durable writes.** {@link publishSealedFile}: compare-before-write,
 *   fsynced temporary, rename, directory sync.
 * - **Sanitized failures.** A key a person must fix keeps its
 *   {@link SecretKeyUnavailableError}; an unreadable file stays
 *   {@link SealedStoreUnreadableError}; lock and durability errors keep their
 *   own types. Anything else becomes one generic sentence: no codec, parser or
 *   filesystem text, cause or path.
 */
import { isSecretKeyUnavailable } from "../ports/secret-key";
import {
  CredentialLockUnusableError,
  SealedStoreNewerError,
  SealedStoreUnreadableError,
} from "./credential-state";
import { CredentialLockBusyError, type CredentialLock } from "./credential-lock";
import {
  publishSealedFile,
  readSealedFile,
  SealedFileChangedError,
  SealedFileIndeterminateError,
  type PublishStep,
} from "./durable-file";

/** How one store's documents become bytes and back. */
export interface SealedCodec<T> {
  /**
   * Checks the key backend now, cheaply: never creating a key and never
   * prompting. Throws the {@link SecretKeyUnavailableError} a later open or
   * seal would.
   */
  probe?(): void;
  /** Authenticates and parses `bytes`, or throws. */
  open(bytes: Buffer): T;
  /** Seals `document`, which will replace `active` (`null` when there is no file yet). */
  seal(document: T, active: Buffer | null): Buffer;
}

export interface SealedDocumentOptions {
  /** See {@link PublishOptions.requireDirectorySync}. */
  readonly requireDirectorySync?: boolean;
  /** Crash-test hook, see {@link PublishOptions.step}. */
  readonly step?: (step: PublishStep) => void;
}

/** What an update did. */
export interface SealedUpdate<T> {
  readonly document: T | null;
  /** Whether a new file was published. */
  readonly written: boolean;
  /** Whether its directory synced; `true` when nothing was written. */
  readonly synced: boolean;
}

/**
 * The sealed file could not be opened as this store: the key opened it and it
 * did not authenticate or parse. Credentials `corrupt`; one generic sentence.
 */
export class SealedStoreCorruptError extends Error {
  constructor() {
    super("Could not decrypt secret storage.");
    this.name = "SealedStoreCorruptError";
  }
}

/** The one sentence for a seal or publish that failed for any other reason. */
const PERSIST_FAILURE = "Could not persist encrypted secrets.";

/**
 * Whether `error`, from a read or an update, means the sealed file cannot be
 * opened here (credentials `locked`, `refused` or `corrupt`), as opposed to a
 * busy lock or a change that failed.
 */
export function isSealedOpenFailure(error: unknown): boolean {
  return (
    isSecretKeyUnavailable(error) ||
    error instanceof SealedStoreUnreadableError ||
    error instanceof CredentialLockUnusableError ||
    error instanceof SealedStoreNewerError ||
    error instanceof SealedStoreCorruptError
  );
}

/** Errors that already say what happened without disclosing anything. */
const PASS_THROUGH = [
  SealedStoreUnreadableError,
  CredentialLockUnusableError,
  SealedStoreNewerError,
  CredentialLockBusyError,
  SealedFileChangedError,
  SealedFileIndeterminateError,
];

export class SealedDocument<T> {
  readonly path: string;
  readonly lock: CredentialLock;
  readonly #codec: SealedCodec<T>;
  readonly #options: SealedDocumentOptions;
  /** The bytes last opened (`null`: no file), or `undefined` when unknown. */
  #bytes: Buffer | null | undefined;

  constructor(
    path: string,
    codec: SealedCodec<T>,
    lock: CredentialLock,
    options: SealedDocumentOptions = {},
  ) {
    this.path = path;
    this.#codec = codec;
    this.lock = lock;
    this.#options = options;
  }

  /** The current document, or `null` when there is no sealed file. Takes the lock. */
  read(): T | null {
    return this.lock.withSync(() => this.#current());
  }

  /**
   * Under the lock: reloads, hands the current document to `change`, and
   * seals what it returns over the file. `change` answering `null` leaves the
   * file alone. It must not await, and should not retain what it was given.
   */
  update(change: (current: T | null) => T | null): SealedUpdate<T> {
    return this.lock.withSync(() => {
      const current = this.#current();
      const next = change(current);
      if (next === null) return { document: current, written: false, synced: true };
      const expected = this.#bytes!;
      let sealed: Buffer;
      try {
        sealed = this.#codec.seal(next, expected);
        if (!Buffer.isBuffer(sealed) || sealed.length === 0) throw new Error();
      } catch (error) {
        throw sanitize(error, () => new Error(PERSIST_FAILURE));
      }
      // Forget the cache first: if publishing fails after its rename, the next
      // read must look at the disk rather than trust either version.
      this.#bytes = undefined;
      let synced: boolean;
      try {
        ({ synced } = publishSealedFile(this.path, sealed, { expected, ...this.#options }));
      } catch (error) {
        throw sanitize(error, () => new Error(PERSIST_FAILURE));
      }
      this.#bytes = sealed;
      return { document: next, written: true, synced };
    });
  }

  /** Forgets what was opened, so nothing is ever published against a stale read. */
  forget(): void {
    this.#bytes = undefined;
  }

  #current(): T | null {
    try {
      this.#codec.probe?.();
      const bytes = readSealedFile(this.path);
      // Opened again even when unchanged: the open is what asks the key
      // backend for the key the header names, which may be gone since.
      this.forget();
      const document = bytes === null ? null : this.#codec.open(bytes);
      this.#bytes = bytes;
      return document;
    } catch (error) {
      this.forget();
      throw sanitize(error, () => new SealedStoreCorruptError());
    }
  }
}

function sanitize(error: unknown, fallback: () => Error): Error {
  if (isSecretKeyUnavailable(error)) return error;
  if (PASS_THROUGH.some((type) => error instanceof type)) return error as Error;
  // Never the codec's, parser's or filesystem's text, its cause, or a path.
  return fallback();
}

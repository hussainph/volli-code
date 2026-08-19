/**
 * The one place a Web Access secret is written, read, or admitted not to exist.
 *
 * Volli had no stored secret of its own before this: Pi owns its provider
 * credentials in its own file store, and every other setting is plain. So this
 * module is a precedent, and it is written as one — a single named owner with
 * four methods, rather than `safeStorage` calls sprinkled across whichever
 * module happened to need a key. Everything that wants the Brave key goes
 * through here, which is what makes "the key never reaches the renderer" a claim
 * a reader can check by looking at this file's callers instead of the whole app.
 *
 * **Encryption is a fact, not a preference.** `safeStorage.isEncryptionAvailable()`
 * is false on a machine whose keychain is locked or missing (a headless Linux
 * box with no libsecret, a broken login keyring), and the tempting response —
 * store it in the clear and carry on — turns a credential into a file anyone
 * with the disk can read, without ever telling the person that happened. This
 * refuses instead: no key is stored, the refusal says why, and Settings shows
 * it. A person who cannot store a key can still run Volli; they cannot run web
 * search, which is a smaller loss than a leaked key they were never told about.
 *
 * **Nothing here appears in a message.** A refusal names the situation and never
 * the secret, never the cipher's own error text (a layer that was handed the
 * plaintext is not a layer whose words Volli repeats), and never how long the
 * key is — every one of those is a fact about the key that a log, a toast or a
 * ledger would then hold.
 */
import type Database from "better-sqlite3";

import { deleteSecret, hasSecret, readSecret, writeSecret } from "../db/secrets-repo";

/**
 * The name the Brave key is stored under.
 *
 * Provider-scoped rather than "the web search key", because a second provider
 * with a credential is a second row and not an overwrite of this one.
 */
export const BRAVE_SEARCH_KEY_SECRET = "web-access.brave.api-key";

/** The name the Exa key is stored under. Its own row, for the reason above. */
export const EXA_SEARCH_KEY_SECRET = "web-access.exa.api-key";

/**
 * The OS-backed cipher, as this module needs it.
 *
 * Exactly the three members of Electron's `safeStorage` that are used, so main
 * passes `safeStorage` itself and a test passes something it can break on
 * purpose. Declared here rather than imported from Electron because this module
 * is tested in plain Node, and an Electron import at the top of it would make
 * that impossible for no gain.
 */
export interface SecretCipher {
  isEncryptionAvailable(): boolean;
  encryptString(plainText: string): Buffer;
  decryptString(encrypted: Buffer): string;
}

/**
 * What this profile can say about a stored key without disclosing it.
 *
 * Three states rather than a boolean, because "there is a key here that this
 * machine cannot open" is a real situation — a profile carried to another
 * machine, or a keychain that stopped answering — and reporting it as `absent`
 * would tell a person to paste a key they already pasted.
 */
export type SecretState = "absent" | "present" | "unreadable";

/** A refusal that is about the machine's ability to hold a secret, never about the secret. */
export class SecretUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SecretUnavailableError";
  }
}

export interface WebCredentialStoreOptions {
  db: Database.Database;
  cipher: SecretCipher;
  /**
   * Which secret this store owns.
   *
   * One store per keyed provider rather than one store that takes a provider
   * on every call: a store that had to be told which key to read on each read
   * is a store that can be told the wrong one, and the caller holding two of
   * them cannot mix them up.
   */
  secretName: string;
  now?: () => number;
}

/** The owner of one provider's key. Main builds one per keyed provider. */
export class WebCredentialStore {
  readonly #db: Database.Database;
  readonly #cipher: SecretCipher;
  readonly #secretName: string;
  readonly #now: () => number;

  constructor(options: WebCredentialStoreOptions) {
    this.#db = options.db;
    this.#cipher = options.cipher;
    this.#secretName = options.secretName;
    this.#now = options.now ?? Date.now;
  }

  /** Whether this machine can encrypt a secret at all right now. */
  encryptionAvailable(): boolean {
    return this.#cipher.isEncryptionAvailable();
  }

  /**
   * What Settings may say about the key: that there is one, that there is one
   * this machine cannot open, or that there is none. Never what it is.
   */
  state(): SecretState {
    if (!hasSecret(this.#db, this.#secretName)) return "absent";
    return this.#cipher.isEncryptionAvailable() ? "present" : "unreadable";
  }

  /**
   * Store one key, or refuse.
   *
   * Trimmed, because a key pasted out of a dashboard arrives with the newline
   * that ended the copy and a provider would reject it — a failure that would
   * surface as "your key is wrong" three layers away from the paste. Nothing
   * else about the shape is checked: a provider decides what its key looks
   * like, and a charset rule invented here would reject the next one.
   */
  save(key: string): void {
    const trimmed = key.trim();
    if (trimmed.length === 0) {
      throw new SecretUnavailableError("There is no key in what was entered.");
    }
    if (!this.#cipher.isEncryptionAvailable()) {
      throw new SecretUnavailableError(
        "This machine's keychain is unavailable, so Volli cannot encrypt an API key. " +
          "Volli will not store one in the clear.",
      );
    }
    writeSecret(this.#db, this.#secretName, this.#cipher.encryptString(trimmed), this.#now());
  }

  /**
   * The key, for the one caller that builds a provider with it.
   *
   * Null means there is nothing stored. A stored key this machine cannot open
   * throws instead, because answering null there would silently turn a
   * configured Session into an unconfigured one.
   */
  read(): string | null {
    const ciphertext = readSecret(this.#db, this.#secretName);
    if (ciphertext === null) return null;
    if (!this.#cipher.isEncryptionAvailable()) {
      throw new SecretUnavailableError(
        "A stored API key could not be read: this machine's keychain is unavailable.",
      );
    }
    try {
      return this.#cipher.decryptString(ciphertext);
    } catch {
      // The cipher's own message is dropped rather than wrapped. It was handed
      // the secret, and a failure it phrases is a failure that could quote it.
      throw new SecretUnavailableError(
        "A stored API key could not be read on this machine. Enter it again.",
      );
    }
  }

  /** Forget the key. Forgetting nothing is not a failure. */
  clear(): void {
    deleteSecret(this.#db, this.#secretName);
  }
}

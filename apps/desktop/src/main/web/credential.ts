/**
 * The one place a Web Access secret is written, read, or admitted not to exist.
 *
 * Volli had no stored secret of its own before this: Pi owns its provider
 * credentials in its own file store, and every other setting is plain. So this
 * module is a precedent, and it is written as one — a single named owner with
 * four methods, rather than reads of the `secrets` table sprinkled across
 * whichever module happened to need a key. Everything that wants the Brave key
 * goes through here, which is what makes "the key never reaches the renderer" a
 * claim a reader can check by looking at this file's callers instead of the
 * whole app.
 *
 * **Where the key rests, and why it is not the keychain.** The key sits in the
 * profile's own `secrets` table, in the clear, under a user-only `Application
 * Support` directory — the same trade Pi already makes for the credentials that
 * actually matter (`~/.pi/agent/auth.json`, 0600), and the same one opencode and
 * Codex make. Electron's `safeStorage` used to encrypt this, and it bought
 * little: it guarded the least sensitive secret in the app while raising a
 * macOS keychain prompt on every Session attach for anyone whose build
 * signature had changed since the item was created. A threat model that accepts
 * a plaintext OAuth token on disk does not get to demand a keychain for a search
 * key. See migration 023 and `legacy-safe-storage.ts` for what became of the
 * keys stored the old way.
 *
 * **Nothing here appears in a message.** A refusal names the situation and never
 * the secret, and never how long the key is — either would be a fact about the
 * key that a log, a toast or a ledger would then hold.
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
 * What this profile can say about a stored key without disclosing it.
 *
 * Two states, because there are only two situations: a key is here or it is
 * not. There used to be a third — "stored, but this machine cannot open it" —
 * which existed entirely because the keychain could refuse to answer for bytes
 * Volli was holding. Nothing can refuse now, so nothing has to be reported.
 */
export type SecretState = "absent" | "present";

/**
 * A refusal about the act of storing a key, never about the key.
 *
 * One arm survives (there was nothing in the paste), which is the point of
 * keeping the type: a caller reaching for this class is reaching for a sentence
 * that has already been checked not to quote a credential.
 */
export class WebCredentialError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebCredentialError";
  }
}

export interface WebCredentialStoreOptions {
  db: Database.Database;
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
  readonly #secretName: string;
  readonly #now: () => number;

  constructor(options: WebCredentialStoreOptions) {
    this.#db = options.db;
    this.#secretName = options.secretName;
    this.#now = options.now ?? Date.now;
  }

  /** What Settings may say about the key: that there is one, or that there is none. Never what it is. */
  state(): SecretState {
    return hasSecret(this.#db, this.#secretName) ? "present" : "absent";
  }

  /**
   * Store one key.
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
      throw new WebCredentialError("There is no key in what was entered.");
    }
    writeSecret(this.#db, this.#secretName, trimmed, this.#now());
  }

  /**
   * The key, for the one caller that builds a provider with it.
   *
   * Null means there is nothing stored, and null is the only other answer this
   * can give: reading is a `SELECT`, so there is no "stored but unavailable"
   * outcome left for a caller to handle.
   */
  read(): string | null {
    return readSecret(this.#db, this.#secretName);
  }

  /** Forget the key. Forgetting nothing is not a failure. */
  clear(): void {
    deleteSecret(this.#db, this.#secretName);
  }
}

/**
 * The key that seals stored secrets (VC-559).
 *
 * `SecretStore` (`@volli/host-core/secrets`) keeps a person's persistent
 * Session secrets in one encrypted file beside the database. It never holds a
 * key itself: it hands the whole file to this port to seal and open. Each host
 * passes the adapter its process can actually back:
 *
 * - **Desktop** passes `keychainSecretCodec(safeStorage)`
 *   (`apps/desktop/src/main/secrets/codec.ts`): a random data key wrapped by the
 *   OS keychain, unchanged since VC-481. Its envelope starts `VSC1`.
 * - **A headless host** passes `fileSecretKey({ path })`
 *   (`@volli/host-core/secrets`): a random data key in a mode-0600 file. Its
 *   envelope starts `VSF1`.
 *
 * Neither adapter opens the other's envelope. Moving secrets between them is
 * re-entering them; see `docs/secrets.md` ("Headless hosts").
 *
 * A key the port cannot use for a reason a person can fix — the key file is
 * readable by other users, missing while secrets exist, or not the key the
 * secrets were sealed with — is a {@link SecretKeyUnavailableError}. The store
 * lets that one error through with its message, which names the fix and never
 * a key byte; every other failure stays the store's generic sentence.
 *
 * The store turns these refusals into its credential status (VC-641,
 * `secrets/credential-state.ts`): a refusal locks or refuses credentials, it
 * never stops a host from booting.
 */

import type { SecretKeyRefusal } from "@volli/shared";

/** A client is told the refusal, so it is client wire vocabulary (`@volli/shared`, VC-632). */
export type { SecretKeyRefusal } from "@volli/shared";

/** Seals and opens the secret store's file. Electron's `safeStorage` has this shape. */
export interface SecretKeyPort {
  /** Whether sealing can work at all here. False means fail closed, never plaintext. */
  isEncryptionAvailable(): boolean;
  /** Seals one UTF-8 document. */
  encryptString(value: string): Buffer;
  /** Opens what {@link encryptString} sealed, or throws. */
  decryptString(value: Buffer): string;
  /**
   * Checks an existing key now, without creating one or touching the sealed
   * file, and throws the {@link SecretKeyUnavailableError} a later seal or
   * open would. Optional: the keychain adapter has nothing to check until
   * secrets exist, and must not touch the keychain before then.
   */
  probe?(): void;
}

/**
 * A secret key a person has to fix before stored secrets open or save. The
 * message says what is wrong and how to fix it. It may name the key file's
 * path, which is configuration; it never carries key material or a secret.
 */
export class SecretKeyUnavailableError extends Error {
  readonly code = "secret-key-unavailable";
  readonly reason: SecretKeyRefusal;

  constructor(reason: SecretKeyRefusal, message: string) {
    super(message);
    this.name = "SecretKeyUnavailableError";
    this.reason = reason;
  }
}

export function isSecretKeyUnavailable(error: unknown): error is SecretKeyUnavailableError {
  return error instanceof SecretKeyUnavailableError;
}

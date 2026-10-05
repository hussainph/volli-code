/**
 * The secret store, opened eagerly at boot (VC-559), and never a reason not
 * to boot (VC-641; `docs/plans/sealed-credential-store.md` §7).
 *
 * `fileSecretKey` loads its key lazily, on the first save or open, which is
 * right for a desktop profile and wrong for a service: a key file with the
 * wrong mode would only be found by the first Session that needed a secret,
 * hours after the operator walked away. So hostd settles every question about
 * the key at boot, and reports the answer as a credential status
 * (`credential-state.ts` in host-core) rather than refusing to start:
 *
 * | condition                                                | status    |
 * | -------------------------------------------------------- | --------- |
 * | no sealed store                                          | `empty`   |
 * | sealed store opens with its key                          | `ready`   |
 * | key missing, wrong, malformed, unreadable; store sealed  | `locked`  |
 * | by the keychain; sealed store unreadable                 |           |
 * | key readable by group/other, owned by another user, not  | `refused` |
 * | a regular file; relative `VOLLI_SECRET_KEY_FILE`         |           |
 * | the key opened and the store is not a valid store        | `corrupt` |
 *
 * Every non-ready state boots the host with the board and everything else
 * that needs no stored secret; stored secrets are not injected, listed or
 * sealed over. `refused` is the unsafe-key refusal: a key other users could
 * read is never used, which is not the same as a key that is lost. The
 * refusal's own sentence, naming the key path and the fix, goes to the log.
 *
 * Unlock is putting the key back (or fixing its mode) and restarting; reset
 * is `volli-hostd credentials reset` (`credentials.ts`).
 */
import { join } from "node:path";

import type { HostdLogger } from "./log";

import {
  fileSecretKey,
  SECRET_STORE_FILE_NAME,
  secretKeyFilePath,
  SecretStore,
  type CredentialStatus,
  type SecretKeyPort,
} from "@volli/host-core/secrets";

export interface HeadlessSecrets {
  readonly store: SecretStore;
  /** The key file, or `null` when `VOLLI_SECRET_KEY_FILE` named none hostd may use. */
  readonly keyPath: string | null;
  readonly status: CredentialStatus;
  /**
   * The sentence that names what is wrong and how to fix it, for the
   * operator's log: it may name the key path, never a key byte or a secret.
   * `null` when credentials are ready or empty.
   */
  readonly problem: string | null;
}

export function openHeadlessSecrets(
  dataDir: string,
  env: Readonly<Record<string, string | undefined>>,
): HeadlessSecrets {
  let keyPath: string | null;
  let codec: SecretKeyPort;
  try {
    keyPath = secretKeyFilePath(dataDir, env);
    codec = fileSecretKey({ path: keyPath });
  } catch (error) {
    // Only a relative path throws here; it names nothing hostd will open.
    keyPath = null;
    codec = refusing(error as Error);
  }
  const store = new SecretStore(join(dataDir, SECRET_STORE_FILE_NAME), codec);
  const status = store.status();
  return { store, keyPath, status, problem: problemOf(store, status, dataDir) };
}

/** A key port that refuses everything with the configuration error it was built from. */
function refusing(error: Error): SecretKeyPort {
  const refuse = (): never => {
    throw error;
  };
  return {
    isEncryptionAvailable: refuse,
    probe: refuse,
    encryptString: refuse,
    decryptString: refuse,
  };
}

/** What the operator's log says when stored credentials did not open. */
function problemOf(store: SecretStore, status: CredentialStatus, dataDir: string): string | null {
  if (status.state === "ready" || status.state === "empty") return null;
  return (
    store.problem() ??
    `The secret store ${join(dataDir, SECRET_STORE_FILE_NAME)} could not be opened, so saved ` +
      "secrets are unavailable. Run `volli-hostd credentials reset` to set it aside (it is " +
      "kept) and enter the secrets again."
  );
}

/** One line at boot: the status, and the fix when credentials did not open. */
export function logCredentials(secrets: HeadlessSecrets, logger: HostdLogger): void {
  const { status, keyPath } = secrets;
  if (secrets.problem === null) {
    logger.info("credentials", { state: status.state, keyPath });
    return;
  }
  logger.warn("serving without saved credentials", {
    state: status.state,
    reason: status.reason,
    unavailable: status.unavailable,
    fix: secrets.problem,
  });
}

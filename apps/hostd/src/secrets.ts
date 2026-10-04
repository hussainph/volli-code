/**
 * The secret store, opened eagerly at boot (VC-559's review, item 3).
 *
 * `fileSecretKey` loads its key lazily, on the first save or open, which is
 * right for a desktop profile and wrong for a service: a key file with the
 * wrong mode would only be found by the first Session that needed a secret,
 * hours after the operator walked away. So hostd settles every question about
 * the key before it serves anything, and refuses to boot on a bad answer:
 *
 * 1. `VOLLI_SECRET_KEY_FILE` must be absolute (`secretKeyFilePath`).
 * 2. A key file that exists must be usable: mode 0600, owned by this user, a
 *    regular file, one base64 key line (`inspectSecretKeyFile`).
 * 3. A sealed store that exists must open with that key: a missing or
 *    different key is refused rather than re-keyed (`SecretStore.list`).
 *
 * An absent key with no sealed store is fine: the key is created the first
 * time a Project or Always secret is saved. See `docs/secrets.md`.
 */
import { join } from "node:path";

import {
  fileSecretKey,
  inspectSecretKeyFile,
  isSecretKeyUnavailable,
  SECRET_STORE_FILE_NAME,
  secretKeyFilePath,
  SecretStore,
} from "@volli/host-core/secrets";

import { HostdBootError } from "./boot-error";

export interface HeadlessSecrets {
  readonly store: SecretStore;
  readonly keyPath: string;
  /** Whether a key file existed at boot. */
  readonly key: "absent" | "present";
}

export function openHeadlessSecrets(
  dataDir: string,
  env: Readonly<Record<string, string | undefined>>,
): HeadlessSecrets {
  try {
    const keyPath = secretKeyFilePath(dataDir, env);
    const key = inspectSecretKeyFile(keyPath);
    const store = new SecretStore(
      join(dataDir, SECRET_STORE_FILE_NAME),
      fileSecretKey({ path: keyPath }),
    );
    store.list();
    return { store, keyPath, key };
  } catch (error) {
    // The adapter's refusals already name the fix and never a key byte.
    if (isSecretKeyUnavailable(error)) {
      throw new HostdBootError("secret-key", error.message, { refusal: error.reason });
    }
    throw new HostdBootError(
      "secret-store",
      `The secret store ${join(dataDir, SECRET_STORE_FILE_NAME)} could not be opened. ` +
        "Move it aside to start with no saved secrets.",
    );
  }
}

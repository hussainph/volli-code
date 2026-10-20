/**
 * The secret ports harness mode seals with instead of the keychain (VC-703).
 *
 * The same file-backed adapters a headless host runs on (`apps/hostd`), each
 * with a random key created lazily — on the first seal — under the harness
 * instance's own `keys/` directory. Never a keychain call, and never a path
 * outside the instance's scratch tree. See `keychain-guard.ts`.
 */
import { fileCredentialKeyring, fileSecretKey, type SecretKeyPort } from "@volli/host-core/secrets";

import type { HarnessPaths } from "./keychain-guard";

export interface HarnessSecretPorts {
  readonly secretKey: SecretKeyPort;
  readonly keyring: ReturnType<typeof fileCredentialKeyring>;
}

export function harnessSecretPorts(paths: HarnessPaths): HarnessSecretPorts {
  return {
    secretKey: fileSecretKey({ path: paths.secretKeyFile }),
    keyring: fileCredentialKeyring({ path: paths.credentialKeyFile }),
  };
}

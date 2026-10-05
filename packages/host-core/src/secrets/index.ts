/**
 * `@volli/host-core/secrets` — persistent Session secrets and the keys that
 * seal them (VC-481, VC-559). `SecretStore` takes a {@link SecretKeyPort}:
 * desktop passes its keychain adapter, a headless host passes
 * {@link fileSecretKey}. See `docs/secrets.md` ("Headless hosts").
 */
export {
  isSecretKeyUnavailable,
  SecretKeyUnavailableError,
  type SecretKeyPort,
  type SecretKeyRefusal,
} from "../ports/secret-key";
export {
  archiveSealedStore,
  CREDENTIALS_EMPTY,
  CREDENTIALS_READY,
  credentialStatusFor,
  credentialsUnavailable,
  SEALED_CREDENTIAL_KINDS,
  SealedStoreUnreadableError,
  type CredentialKind,
  type CredentialReason,
  type CredentialState,
  type CredentialStatus,
} from "./credential-state";
export {
  fileSecretKey,
  inspectSecretKeyFile,
  SECRET_KEY_FILE_ENV,
  SECRET_KEY_FILE_NAME,
  SECRET_STORE_FILE_NAME,
  secretKeyFilePath,
  type FileSecretKeyOptions,
} from "./file-key";
export { pendingNoticeSecretStart } from "./pending-notice-secret";
export type { SecretWaitPublisher } from "./wait-publisher";
export {
  isSecretName,
  SecretStore,
  type SecretInput,
  type SecretMetadata,
  type SecretScope,
  type SecretStoreReset,
} from "./store";

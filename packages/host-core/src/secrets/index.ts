/**
 * `@volli/host-core/secrets` — persistent Session secrets and the keys that
 * seal them (VC-481, VC-559), and the typed sealed credential module every
 * application credential family moves onto (VC-642): the credential lock,
 * the durable file contract, the key-id format and the typed inventory.
 * `SecretStore` takes a {@link SecretKeyPort}: desktop passes its keychain
 * adapter, a headless host passes {@link fileSecretKey}. See
 * `docs/secrets.md` ("Headless hosts") and
 * `docs/plans/sealed-credential-store.md`.
 */
export {
  isSecretKeyUnavailable,
  SecretKeyUnavailableError,
  type SecretKeyPort,
  type SecretKeyRefusal,
} from "../ports/secret-key";
export {
  CredentialKeyPendingError,
  type CredentialKey,
  type CredentialKeyBackend,
  type CredentialKeyring,
} from "../ports/credential-keyring";
export {
  CREDENTIAL_FAMILIES,
  isCredentialFamily,
  type CredentialFamily,
  type CredentialObject,
  type CredentialSelector,
  type CredentialValue,
} from "./credential-families";
export { credentialKeyId, CredentialKeySet, isCredentialKeyId } from "./credential-key-id";
export {
  CREDENTIAL_LOCK_FILE_NAME,
  CredentialLock,
  CredentialLockBusyError,
  credentialLockFor,
  CredentialLockUnusableError,
  retryWhileBusy,
} from "./credential-lock";
export {
  publishSealedFile,
  readSealedFile,
  SealedFileChangedError,
  SealedFileIndeterminateError,
  type PublishOptions,
  type PublishStep,
} from "./durable-file";
export {
  CREDENTIAL_INVENTORY_FILE_NAME,
  CredentialRevisionConflictError,
  type CredentialRecordRef,
  INVENTORY_SCHEMA,
  SealedInventory,
  type ChangeOptions,
  type CredentialRecord,
  type CredentialRecordMetadata,
  type MirrorEntry,
  type MirrorOutcome,
  type MirrorReceipt,
  type MirrorSnapshot,
  type SealedInventoryOptions,
  type SealedInventoryReset,
} from "./inventory";
export {
  isSealedOpenFailure,
  SealedDocument,
  SealedFileUnverifiedError,
  SealedStoreCorruptError,
  type SealedCodec,
  type SealedDocumentOptions,
  type SealedUpdate,
} from "./sealed-document";
export {
  archiveSealedStore,
  CREDENTIALS_EMPTY,
  CREDENTIALS_READY,
  credentialsBusy,
  credentialsResettable,
  credentialStatusFor,
  credentialsUnavailable,
  SEALED_CREDENTIAL_KINDS,
  SealedStoreNewerError,
  SealedStoreUnreadableError,
  type CredentialKind,
  type CredentialReason,
  type CredentialState,
  type CredentialStatus,
  type SealedStoreArchive,
} from "./credential-state";
export {
  fileCredentialKeyring,
  fileSecretKey,
  inspectSecretKeyFile,
  SECRET_KEY_FILE_ENV,
  SECRET_KEY_FILE_NAME,
  SECRET_STORE_FILE_NAME,
  secretKeyFilePath,
  type FileSecretKeyOptions,
} from "./file-key";
export {
  CREDENTIAL_KEYCHAIN_KEY_FILE_NAME,
  keychainCredentialKeyring,
  type CredentialKeychain,
  type KeychainCredentialKeyringOptions,
} from "./keychain-keyring";
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

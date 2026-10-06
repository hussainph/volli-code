/**
 * `@volli/host-core/secrets`: persistent Session secrets, the sealed credential module and its keys.
 *
 * An explicit list: a name is public because a client, or a client's test,
 * imports it as this cluster's API. Add one here when a client needs it;
 * host-core's own files import the module itself, never this entry. See
 * the cluster map in the package README.
 */
export {
  CREDENTIAL_INVENTORY_FILE_NAME,
  CREDENTIAL_KEYCHAIN_KEY_FILE_NAME,
  type CredentialKeychain,
  type CredentialKind,
  CredentialLock,
  type CredentialStatus,
  credentialsUnavailable,
  fileCredentialKeyring,
  fileSecretKey,
  keychainCredentialKeyring,
  SealedInventory,
  SECRET_KEY_FILE_ENV,
  SECRET_KEY_FILE_NAME,
  SECRET_STORE_FILE_NAME,
  secretKeyFilePath,
  type SecretKeyPort,
  SecretStore,
} from "../secrets";
export { retiresSessionSecrets } from "../secrets/lifetime";
export { SecretService } from "../secrets/service";

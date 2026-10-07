/** Sign-ins on a host (VC-702): the service, its key-provider port, the relay and git's helper. */
export {
  AUTH_CALLBACK_FEATURE,
  HostSignIns,
  MAX_FLOW_UPDATES,
  MAX_FLOWS_PER_CONNECTION,
  type HostSignInsOptions,
} from "./service";
export type {
  GitCredential,
  GitCredentialStore,
  HostSignInKeyProvider,
  ModelCredentialStore,
  StoredModelCredential,
} from "./ports";
export {
  answerGitCredential,
  appendGitConfig,
  fileGitCredentialStore,
  GIT_CREDENTIALS_FILE,
  gitCredentialHelperEnv,
  parseGitCredentialRequest,
  shellWord,
} from "./git-credentials";
export {
  CALLBACK_REPLAY_TIMEOUT_MS,
  deliveryMatches,
  fetchCallbackReplay,
  relayTargetOf,
  type CallbackReplay,
  type RelayTarget,
} from "./relay";

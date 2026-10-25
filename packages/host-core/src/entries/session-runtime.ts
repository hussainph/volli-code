/**
 * `@volli/host-core/session-runtime`: the Pi-backed Session runtime: the runner composition and the recovered services it issues, model access and decisions, background shells.
 *
 * An explicit list: a name is public because a client, or a client's test,
 * imports it as this cluster's API. Add one here when a client needs it;
 * host-core's own files import the module itself, never this entry. See
 * the cluster map in the package README.
 */
export type { HostDecisions } from "../decision/host-decisions";
export { ModelAccessSignInService, type SignInOwner } from "../model-access/sign-in-service";
export {
  answerGitCredential,
  appendGitConfig,
  fileGitCredentialStore,
  GIT_CREDENTIALS_FILE,
  gitCredentialHelperEnv,
  HostSignIns,
  parseGitCredentialRequest,
  shellWord,
  type GitCredentialStore,
  type HostSignInKeyProvider,
  type HostSignInsOptions,
} from "../host-sign-ins";
export { PiSessionOrphanService } from "../pi-session-orphans";
export { removeTicketToolOutput } from "../pi-tool-output";
export { buildSessionEnvReport } from "../session-env";
export type { AutoTitleRequest } from "../session-runtime/auto-title";
export { closeStaleAttachments } from "../session-runtime/boot-recovery";
export { createConnectivityPort } from "../session-runtime/connectivity";
export { createHostNoticeDelivery } from "../session-runtime/durable-host-notice-delivery";
export {
  recoveredRuntimeSessionServices,
  recoveredSessionClientPorts,
  recoveredSessionCommandPorts,
  type RuntimeSessionFacade,
} from "../session-runtime/facade";
export type { HostNoticeDelivery } from "../session-runtime/host-notice-delivery";
export { repackLegacyTranscriptArtifacts } from "../session-runtime";
export {
  type RecoveredSessionServices,
  SessionRuntimeClosingError,
} from "../session-runtime/lifecycle";
export {
  assertDefaultModelAvailable,
  readCompactionPolicy,
  readHiddenModels,
  readModelAccessDefaults,
  readModelPickerView,
  reconcileModelAccessPreferences,
  writeCodeModePolicy,
  writeCompactionPolicy,
  writeHiddenModels,
  writeModelAccessDefault,
  writeModelPickerView,
} from "../session-runtime/model-access-preferences";
export {
  createPiNativeAdapter,
  createPiRuntimeHost,
  PI_ADAPTER_ID,
  type PiAdapterOptions,
  type PiRuntimeContext,
} from "../session-runtime/pi-adapter";
export { createRunnerComposition, type RunnerReady } from "../session-runtime/runner";
export { createSqliteHostNoticeOutbox } from "../session-runtime/sqlite-host-notice-outbox";
export type { StopSessionByIdPorts } from "../session-runtime/supervise-session";
export { createFileTranscriptArtifactStore } from "../session-runtime/transcript-artifacts";
export { createAgentShellPort } from "../shell/agent-port";
export {
  BackgroundShellHost,
  type BackgroundShellHostPorts,
  type BackgroundShellNotice,
  type BackgroundShellOwner,
} from "../shell/background-shell-host";

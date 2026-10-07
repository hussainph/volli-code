/**
 * `@volli/host-core/session-runtime`: the Pi-backed Session runtime: staged assembly, facade, lifecycle, model access and decisions, background shells.
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
export { createRuntimeAssembly, type RuntimeAssemblyOptions } from "../session-runtime/assembly";
export { createAttachmentIdentities } from "../session-runtime/attachment-identity";
export type { AutoTitleRequest } from "../session-runtime/auto-title";
export { createRuntimeAutomations } from "../session-runtime/automations";
export { closeStaleAttachments } from "../session-runtime/boot-recovery";
export { createConnectivityPort } from "../session-runtime/connectivity";
export { createRuntimeContextResolver } from "../session-runtime/context";
export {
  createTicketSessionDelegationStore,
  TicketSessionDelegationStore,
} from "../session-runtime/delegation-store";
export { createHostNoticeDelivery } from "../session-runtime/durable-host-notice-delivery";
export {
  createRuntimeSessionFacade,
  recoveredRuntimeSessionServices,
  recoveredSessionAutomationPorts,
  recoveredSessionClientPorts,
  recoveredSessionCommandPorts,
  type RuntimeSessionFacade,
} from "../session-runtime/facade";
export type { HostNoticeDelivery } from "../session-runtime/host-notice-delivery";
export { repackLegacyTranscriptArtifacts } from "../session-runtime";
export {
  createSessionRuntimeLifecycle,
  readRecoveredSessionServices,
  type RecoveredSessionServices,
  SessionRuntimeClosingError,
  type SessionRuntimeLifecycle,
} from "../session-runtime/lifecycle";
export {
  assertDefaultModelAvailable,
  readCodeModePolicy,
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

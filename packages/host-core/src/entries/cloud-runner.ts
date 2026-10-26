/**
 * `@volli/host-core/cloud-runner`: a runner's side of Volli Cloud
 * registration and sync — linking the machine to its owner, the rotated refresh
 * credential and the runner token, the heartbeat and capability reports.
 *
 * An explicit list: a name is public because a client, or a client's test,
 * imports it as this cluster's API. Add one here when a client needs it;
 * host-core's own files import the module itself, never this entry. See
 * the cluster map in the package README.
 *
 * Production callers: the Mac runner (`apps/desktop/src/main/cloud-runner`,
 * VC-895) composes the link client, token source, backend link, mutation
 * gate, presence and power cycle. Receiving wiring still to land: the runner
 * composition (`apps/runner`, VC-896) and the Mac runner's cloud store
 * (VC-895 N2-2) compose
 * `startRunnerSync` over `createBackendLink(convexBackendConnection(url, convex))`
 * with `createRunnerTokenSource`, `createRunnerPresence`, `createFactDrain`
 * (cursor rows in `sqliteDrainCursorStore`, nudged from the Session
 * engine's append path, adopted at a Session's birth) and
 * `createInboxWorker` (`wake: wakeOverLink(link)`, executors registered per kind, outcomes in
 * `sqliteJobJournalStore`), with a sealed `RunnerLinkStore`, and beside it
 * `startStreamChunks({ link, runtime })` for streamed text;
 * `volli-runner link` calls `linkWithInstallToken` / `linkWithDeviceCode`.
 *
 * Agent verbs in a cloud launch: `createCloudProductStore` composes the
 * HTTP functions client and per-Session Agent-token cache over this same
 * runner token source, link status and drain. Desktop passes its
 * `agentCommands` overlay to the socket; the runner composition passes its
 * Session overlay to the tool door. Local Session targets retain the ordered
 * ledger, while remote reads and commands use Convex. Attachment close/failure
 * forgets the cached Agent grant. `CLOUD_AGENT_ROUTES` is the parity guard.
 */
export {
  createCloudProductStore,
  type CloudProductStore,
  type CloudRunnerSyncConnection,
} from "../cloud-store";
export {
  type BackendConnection,
  type BackendLink,
  type BackendLinkOptions,
  type ConnectBackend,
  createBackendLink,
  LinkResetError,
  type LinkStatus,
} from "../cloud-runner/backend-link";
export {
  convexBackendConnection,
  type ConvexClientLike,
  type ConvexClientModule,
} from "../cloud-runner/convex-connection";
export {
  type AcceptCall,
  type AcceptReply,
  createFactDrain,
  type DrainBlock,
  type DrainCursor,
  type DrainCursorStore,
  type DrainLedger,
  type FactDrain,
  type FactDrainOptions,
  type FactDrainStatus,
} from "../cloud-runner/drain";
export {
  createMutationGate,
  MUTATION_GATE_LIMITS,
  type MutationGate,
  type MutationPriority,
} from "../cloud-runner/flow";
export {
  createInboxWorker,
  type InboxBackend,
  type InboxWake,
  type InboxWorker,
  type InboxWorkerOptions,
  type JobContext,
  type JobExecutor,
  type JobJournalEntry,
  type JobJournalStore,
} from "../cloud-runner/inbox";
export { sqliteDrainCursorStore, sqliteJobJournalStore } from "../cloud-runner/sqlite-stores";
export {
  startStreamChunks,
  type StreamChunks,
  StreamLinkOfflineError,
} from "../cloud-runner/stream-chunker";
export {
  acceptOverLink,
  inboxOverLink,
  type RunnerSync,
  startRunnerSync,
} from "../cloud-runner/sync";
export {
  type DeviceLinkOutcome,
  linkWithDeviceCode,
  linkWithInstallToken,
  type RunnerLink,
  type RunnerLinkStore,
} from "../cloud-runner/link";
export {
  createRunnerLinkClient,
  type RunnerFetch,
  RunnerHttpError,
  type RunnerHttpFailure,
  type RunnerLinkClient,
  type RunnerLinkClientOptions,
} from "../cloud-runner/link-client";
export {
  distroOf,
  gitVersionOf,
  NODE_PLATFORM_PROBE,
  type PlatformProbe,
  probeRunnerCapabilities,
  probeRunnerPlatform,
  readRunnerLoad,
  type RunnerHostCapabilities,
  runnerHostFacts,
} from "../cloud-runner/platform";
export {
  createRunnerPresence,
  isRevokedError,
  type RunnerMutationCaller,
  type RunnerPresence,
  type RunnerPresenceBackend,
  type RunnerPresenceOptions,
  type RunnerPresenceTimers,
  runnerPresenceBackend,
} from "../cloud-runner/presence";
export { createRunnerPowerCycle, type RunnerPowerCycle, watchSleep } from "../cloud-runner/wake";
export {
  createRunnerTokenSource,
  type RunnerLinkLoss,
  type RunnerTokenSource,
  type RunnerTokenSourceOptions,
} from "../cloud-runner/token-source";
export {
  type AgentBackend,
  type AgentCallOptions,
  type AgentBackendOptions,
  createAgentBackend,
  NotYetSyncedError,
} from "../cloud-agent/agent-backend";
export {
  type CloudBoardVerbs,
  type CloudBoardVerbsOptions,
  type CloudPlace,
  type CloudVerb,
  type CloudVerbCall,
  createCloudBoardVerbs,
} from "../cloud-agent/board-verbs";
export {
  CLOUD_FUNCTION_TIMEOUT_MS,
  type CloudFetch,
  CloudFunctionError,
  type CloudFunctionKind,
  type CloudFunctionsClient,
  type CloudFunctionsClientOptions,
  type CloudDelivery,
  CloudOfflineError,
  type CloudOfflineReason,
  createCloudFunctionsClient,
} from "../cloud-agent/functions-client";
export {
  type AgentDoorHandlerKey,
  CLOUD_AGENT_ROUTES,
  type CloudBoardKey,
  type CloudRoute,
} from "../cloud-agent/routes";

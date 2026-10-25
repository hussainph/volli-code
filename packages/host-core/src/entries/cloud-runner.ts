/**
 * `@volli/host-core/cloud-runner`: a runner's side of Volli Cloud
 * registration — linking the machine to its owner, the rotated refresh
 * credential and the runner token, the heartbeat and capability reports.
 *
 * An explicit list: a name is public because a client, or a client's test,
 * imports it as this cluster's API. Add one here when a client needs it;
 * host-core's own files import the module itself, never this entry. See
 * the cluster map in the package README.
 *
 * Receiving wiring (no production caller yet): the runner composition
 * (`apps/runner`, VC-896) and the Mac runner (VC-895) compose
 * `createRunnerTokenSource` and `createRunnerPresence` over the backend
 * link's Convex client (VC-892), with a sealed `RunnerLinkStore`;
 * `volli-runner link` calls `linkWithInstallToken` / `linkWithDeviceCode`.
 */
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
export {
  createRunnerTokenSource,
  type RunnerLinkLoss,
  type RunnerTokenSource,
  type RunnerTokenSourceOptions,
} from "../cloud-runner/token-source";

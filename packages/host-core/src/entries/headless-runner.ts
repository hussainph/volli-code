/**
 * `@volli/host-core/headless-runner`: `volli-runner run`'s composition — a
 * linked box's host-core, cloud product store, Session runtime, agent socket
 * and live connection to Volli Cloud, with no Electron and no window.
 *
 * An explicit list: a name is public because a client, or a client's test,
 * imports it as this cluster's API. Production caller: `apps/runner`'s `run`
 * command (`apps/runner/src/commands/run.ts`).
 */
export {
  HeadlessRunnerBootError,
  type HeadlessRunnerDeployment,
  type HeadlessRunnerOptions,
  type HeadlessRunnerState,
  type HeadlessRunnerStatus,
  type HeadlessRunnerUpdatePorts,
  type RunningHeadlessRunner,
  startHeadlessRunner,
} from "../headless-runner/compose";
export type { HeadlessBackendState, HeadlessBackendStatus } from "../headless-runner/compose";
export type { HeadlessRunnerLogger } from "../headless-runner/ports";

/**
 * `@volli/host-core/automations`: Automations: engine, service, runner and scheduler.
 *
 * An explicit list: a name is public because a client imports it. Add one
 * here when a client needs it; host-core's own files import the module
 * itself, never this entry. See the cluster map in the package README.
 */
export { enabledAutomationIds } from "../automations/enablement";
export { createAutomationEngine } from "../automations/engine";
export type { PendingArmedRunCoordinator } from "../automations/pending-armed-runs";
export type { AutomationRunner } from "../automations/run";
export {
  advanceScheduleCursor,
  readScheduleCursors,
  rebaseScheduleCursor,
} from "../automations/schedule-cursor";
export { createAutomationScheduler } from "../automations/scheduler";
export { type AutomationService, createAutomationService } from "../automations/service";
export { SqliteAutomationLedger } from "../automations/sqlite-ledger";

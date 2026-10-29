/** Automation transport is fixed by the launch, never by the experiments toggle.
 * Local launches keep the preload contract unchanged; cloud windows use their
 * own Convex client. An unavailable cloud source must never fall back to SQLite.
 */
import { launchStore } from "./launch";
import { remoteHostNow } from "./remote-project";
import type { ConvexAutomationSource } from "./cloud-automations/source";

type LocalSource = typeof window.api.automations;
type Methods = Pick<
  LocalSource,
  | "list"
  | "create"
  | "update"
  | "delete"
  | "armings"
  | "columnOrders"
  | "setColumnOrder"
  | "runsForProject"
  | "runsForAutomation"
  | "skipsForProject"
  | "skipsForAutomation"
  | "enablement"
>;
type WithoutReceipt<T> = T extends { ok: true } ? Omit<T, "receipt"> : T;
export type SourceReply<K extends keyof LocalSource> = LocalSource[K] extends (
  ...args: never[]
) => Promise<infer R>
  ? WithoutReceipt<R>
  : never;
export type AutomationSource = {
  [K in keyof Methods]: (...args: Parameters<Methods[K]>) => Promise<SourceReply<K>>;
} & {
  arm(
    input: Parameters<LocalSource["arm"]>[0] & { runnerId?: string },
  ): Promise<SourceReply<"arm">>;
  setEnabled(
    input: Parameters<LocalSource["setEnabled"]>[0] & { runnerId?: string },
  ): Promise<SourceReply<"setEnabled">>;
};
let cloud: ConvexAutomationSource | null = null;
export function installCloudAutomationSource(source: ConvexAutomationSource | null): void {
  cloud = source;
}
export function cloudAutomationSource(): ConvexAutomationSource | null {
  return cloud;
}
export function requireCloudAutomationSource(): ConvexAutomationSource {
  if (cloud === null) throw new Error("Volli Cloud isn’t connected yet.");
  return cloud;
}
export function automationSourceIsCloud(): boolean {
  return launchStore() === "cloud";
}
export function automationsAvailable(projectId?: string | null): boolean {
  return automationSourceIsCloud() || remoteHostNow(projectId) === null;
}
export function automationSource(): AutomationSource {
  return automationSourceIsCloud() ? requireCloudAutomationSource() : window.api.automations;
}

/** Cloud-only evidence beside the local UI projection. Queued/failed Runs do
 * not pretend to have a resolved model or a Session that already exists. */
import { create } from "zustand";
import type { FunctionReturnType } from "convex/server";
import type { CloudApi } from "@renderer/lib/cloud-client";

type Api = CloudApi["automations"];
export type CloudArming = FunctionReturnType<Api["armings"]>[number];
export type CloudSchedule = FunctionReturnType<Api["schedules"]>[number];
export type CloudRun = FunctionReturnType<Api["runsForProject"]>["page"][number];
export type CloudPending = FunctionReturnType<Api["pendingArrivals"]>;
export type AutomationRunner = FunctionReturnType<CloudApi["runners"]["list"]>[number];
interface State {
  armings: Record<string, readonly CloudArming[]>;
  schedules: Record<string, readonly CloudSchedule[]>;
  histories: Record<string, readonly CloudRun[]>;
  pending: Record<string, CloudPending>;
  runners: readonly AutomationRunner[];
}
const empty = (): State => ({
  armings: {},
  schedules: {},
  histories: {},
  pending: {},
  runners: [],
});
export const useCloudAutomationsStore = create<State>(empty);
export function clearCloudAutomations(): void {
  useCloudAutomationsStore.setState(empty());
}

/** runners.list is already owner-filtered. No old builds or revoked runners. */
export function automationRunners(rows: readonly AutomationRunner[]): readonly AutomationRunner[] {
  return rows.filter((row) => {
    const capabilities = row.capabilities as { tools?: unknown } | null;
    return (
      row.status !== "revoked" &&
      Array.isArray(capabilities?.tools) &&
      capabilities.tools.includes("automation.run")
    );
  });
}
export function waitingForRunner(name: string, status: string, since?: number | null): string {
  const offline =
    since == null
      ? " (offline)"
      : ` (offline since ${new Date(since).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })})`;
  return `Waiting for ${name}${status === "asleep" ? " (asleep)" : status === "offline" ? offline : ""}`;
}

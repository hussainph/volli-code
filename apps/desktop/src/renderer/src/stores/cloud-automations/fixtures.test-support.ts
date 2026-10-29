import type { Automation } from "@volli/shared";
import { parseId } from "@volli/shared/cloud";
import type { CloudArming, CloudRun, CloudSchedule, AutomationRunner } from "./state";
export const P = "10000000-0000-4000-8000-000000000001";
export const A = parseId("automation", "10000000-0000-4000-8000-000000000002");
export const R = "10000000-0000-4000-8000-000000000003";
export const U = "10000000-0000-4000-8000-000000000004";
export const T = parseId("ticket", "10000000-0000-4000-8000-000000000005");
export const automation: Automation = {
  id: A,
  projectId: P,
  name: "Review",
  instructions: "Review this",
  runtime: null,
  trigger: { kind: "columns", columns: ["doing"] },
  createdAt: 1,
  updatedAt: 1,
};
export const arming: CloudArming = {
  projectId: P,
  status: "doing",
  automationId: A,
  runnerId: R,
  armedByUserId: U,
  armedAt: 10,
  pausedAt: null,
  pausedReason: null,
  armedByDisplayName: "Ada",
  runnerName: "Ada’s Mac",
  runnerStatus: "online",
};
export const schedule: CloudSchedule = {
  automationId: A,
  runnerId: R,
  armedByUserId: U,
  armedAt: 10,
  pausedAt: null,
  pausedReason: null,
  armedByDisplayName: "Ada",
  runnerName: "Ada’s Mac",
  runnerStatus: "online",
  timezone: "UTC",
  spec: {},
  nextFireAt: 180000,
  lastFiredAt: null,
};
export function runner(patch: Partial<AutomationRunner> = {}): AutomationRunner {
  return {
    id: R,
    name: "Ada’s Mac",
    kind: "mac",
    status: "online",
    statusReason: null,
    statusChangedAt: 1,
    version: "0.3.0",
    platform: { os: "darwin", arch: "arm64", kernel: "24", distro: null, glibc: null },
    capabilities: { tools: ["automation.run"] },
    installMode: "app",
    linkedVia: "desktop",
    linkedAt: 1,
    ...patch,
  };
}
export function run(patch: Partial<CloudRun> = {}): CloudRun {
  return {
    id: "10000000-0000-4000-8000-000000000006",
    automationId: A,
    automationName: "Review",
    projectId: P,
    ticketId: T,
    sessionId: "10000000-0000-4000-8000-000000000007",
    trigger: "manual",
    status: "queued",
    skipReason: null,
    missedCount: 0,
    dueAt: 1,
    model: null,
    attendance: "attended",
    armedByUserId: U,
    runnerId: R,
    createdAt: 1,
    sessionAccess: "starting",
    runner: { id: R, statusChangedAt: null, name: "Ada’s Mac", status: "asleep" },
    ...patch,
  };
}

/** Optimistic definitions/armings use the backend's pure decisions. Convex
 * rolls these query-cache updates back on refusal. Schedule cursors are never
 * guessed: nextFireAt is always the backend's answer. */
import type { OptimisticLocalStore } from "convex/browser";
import { decideAutomationChange, decideArming, parseId } from "@volli/shared/cloud";
import type { CloudApi } from "@renderer/lib/cloud-client";
import type {
  AutomationCreateInput,
  AutomationUpdateInput,
  AutomationArmInput,
} from "../../../../ipc/contract";
import type { AutomationRunner } from "./state";

type Api = CloudApi["automations"];
export function optimisticDefinition(
  store: OptimisticLocalStore,
  api: Api,
  input: {
    projectId: string;
    automationId: string;
    draft: AutomationCreateInput | AutomationUpdateInput;
    change: "create" | "update";
    userId: string;
    now: number;
  },
): void {
  const rows = store.getQuery(api.list, { projectId: input.projectId });
  if (rows === undefined) return;
  const decision = decideAutomationChange({
    change: input.change,
    projectId: parseId("project", input.projectId),
    automationId: parseId("automation", input.automationId),
    existing: rows,
    draft: input.draft,
  });
  if (decision.kind !== "save") return;
  const prior = rows.find((row) => row.id === input.automationId);
  const saved = {
    ...prior,
    ...decision.draft,
    id: parseId("automation", input.automationId),
    projectId: parseId("project", input.projectId),
    createdBy: prior?.createdBy ?? {
      kind: "person" as const,
      userId: parseId("user", input.userId),
    },
    createdAt: prior?.createdAt ?? input.now,
    updatedAt: input.now,
    deletedAt: null,
    triggerSpec: decision.draft.trigger,
  };
  store.setQuery(
    api.list,
    { projectId: input.projectId },
    [...rows.filter((row) => row.id !== input.automationId), saved].toSorted((a, b) =>
      a.name.localeCompare(b.name),
    ),
  );
}
export function optimisticArming(
  store: OptimisticLocalStore,
  api: Api,
  input: {
    intent: AutomationArmInput & { runnerId: string | null };
    userId: string;
    runners: readonly AutomationRunner[];
    now: number;
  },
): void {
  const { intent } = input;
  const rows = store.getQuery(api.armings, { projectId: intent.projectId });
  const definitions = store.getQuery(api.list, { projectId: intent.projectId });
  if (rows === undefined || definitions === undefined) return;
  const runner = input.runners.find((row) => row.id === intent.runnerId);
  const capabilities = runner?.capabilities as { tools?: unknown } | null;
  const decision = decideArming({
    projectId: parseId("project", intent.projectId),
    callerUserId: parseId("user", input.userId),
    canEdit: true,
    status: intent.status,
    disarm: intent.automationId === null,
    automation: definitions.find((row) => row.id === intent.automationId) ?? null,
    runner:
      runner === undefined
        ? null
        : {
            id: parseId("runner", runner.id),
            ownerUserId: parseId("user", input.userId),
            status: runner.status,
            tools: Array.isArray(capabilities?.tools)
              ? capabilities.tools.filter((tool): tool is string => typeof tool === "string")
              : [],
          },
  });
  if (decision.kind === "refused") return;
  const kept = rows.filter((row) => row.status !== intent.status);
  store.setQuery(
    api.armings,
    { projectId: intent.projectId },
    decision.kind === "disarm"
      ? kept
      : [
          ...kept,
          {
            projectId: intent.projectId,
            status: intent.status,
            automationId: decision.automationId,
            armedAt: input.now,
            armedByUserId: decision.armedByUserId,
            runnerId: decision.runnerId,
            pausedAt: null,
            pausedReason: null,
            armedByDisplayName: "You",
            runnerName: runner!.name,
            runnerStatus: runner!.status,
          },
        ],
  );
}

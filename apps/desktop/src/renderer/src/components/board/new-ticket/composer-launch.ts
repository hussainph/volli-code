import type { Automation } from "@volli/shared";
import type { AutomationGroup } from "@renderer/components/automations/ticket-rail-automations-model";

/** A choice, never a command: selecting a mode cannot create or start work. */
export type ComposerLaunch =
  | { kind: "create" }
  | { kind: "kickoff" }
  | { kind: "automation"; projectId: string; automationId: string };

export interface ComposerLaunchAction {
  label: string;
  available: boolean;
  automation: Automation | null;
}

/** Resolve from the current catalogue, not a stale record captured on selection. */
export function composerLaunchAction(
  launch: ComposerLaunch,
  projectId: string,
  offer: { ready: boolean; groups: readonly AutomationGroup[] },
): ComposerLaunchAction {
  if (launch.kind === "create")
    return { label: "Create ticket", available: true, automation: null };
  if (launch.kind === "kickoff")
    return { label: "Create & start", available: true, automation: null };
  const automation =
    offer.ready && launch.projectId === projectId
      ? (offer.groups
          .flatMap((group) => group.automations)
          .find((row) => row.id === launch.automationId) ?? null)
      : null;
  return {
    label: automation === null ? "Create & run" : `Create & run: ${automation.name}`,
    available: automation !== null,
    automation,
  };
}

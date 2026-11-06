import type { ModelAccessModel } from "@volli/shared";
import type { RunnerPickerRow, RunnerPower } from "@volli/shared/cloud";

/** The person's composer projection; presence vocabulary stays open on read. */
export interface ComposerRunner extends Omit<RunnerPickerRow, "id" | "kind" | "status" | "power"> {
  id: string;
  kind: string;
  status: string;
  power?: RunnerPower;
}

export interface ComposerRunners {
  runners: ComposerRunner[];
  defaultRunnerId: string | null;
}

export function runnerSelectable(runner: ComposerRunner): boolean {
  return (
    runner.status !== "revoked" &&
    runner.status !== "removed" &&
    runner.status !== "upgrade_required" &&
    !runner.upgradeRequired
  );
}

/** The backend chooses the always-on default. The client alone knows this Mac. */
export function composerRunnerChoice(
  view: ComposerRunners,
  thisMacId: string | null,
  rememberedId: string | null,
): ComposerRunner | null {
  const available = view.runners.filter(runnerSelectable);
  const remembered = available.find((runner) => runner.id === rememberedId);
  if (remembered) return remembered;
  const preferred = available.find(
    (runner) => runner.id === view.defaultRunnerId && runner.status === "online",
  );
  return (
    preferred ??
    available.find((runner) => runner.id === thisMacId) ??
    available.find((runner) => runner.status === "online") ??
    null
  );
}

export function composerRunnerStatus(runner: ComposerRunner): string {
  if (runner.upgradeRequired || runner.status === "upgrade_required") return "Needs an update";
  if (runner.status === "online") return "Online";
  if (runner.status === "asleep" || runner.status === "offline" || runner.status === "stopped") {
    return `Waiting for ${runner.name}`;
  }
  return runner.status;
}

/** Provider access belongs to the chosen box, not the Mac drawing the catalog. */
export function modelsOnRunner(
  models: readonly ModelAccessModel[],
  runner: ComposerRunner,
): ModelAccessModel[] {
  return models
    .filter((model) => runner.providers.includes(model.providerId))
    .map((model) => Object.assign({}, model, { state: "available" as const }));
}

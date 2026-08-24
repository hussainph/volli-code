import type { VerbDurableWrite, VerbEntry } from "./verb-registry";

export const MUTATION_PLAN_CAVEAT =
  "Preview only: no state changed. A later real call repeats validation and can lose a race.";

/** A resolved target named only by the public identity the Agent CLI already exposes. */
export interface MutationPlanTarget {
  kind: "project" | "ticket" | "session" | "notification" | "integration";
  id: string | null;
  label: string;
}

/** The one preview contract shared by CLI writes and registry-projected tools. */
export interface AgentMutationPlan {
  v: 1;
  kind: "mutation-plan";
  dryRun: true;
  verb: string;
  target: MutationPlanTarget;
  durableWrites: readonly VerbDurableWrite[];
  humanVisibleEffects: readonly string[];
  nonEffects: readonly string[];
  caveat: typeof MUTATION_PLAN_CAVEAT;
}

export interface MutationPlanOverrides {
  durableWrites?: readonly VerbDurableWrite[];
  humanVisibleEffects?: readonly string[];
  nonEffects?: readonly string[];
}

/**
 * Builds a preview from the same structured effect data detailed help and docs
 * use. Resolution and preconditions remain the command handler's job.
 */
export function buildMutationPlan(
  entry: VerbEntry,
  target: MutationPlanTarget,
  overrides: MutationPlanOverrides = {},
): AgentMutationPlan {
  if (entry.effects === undefined) {
    throw new Error(`Verb ${entry.key} has no declared side-effect contract`);
  }
  return {
    v: 1,
    kind: "mutation-plan",
    dryRun: true,
    verb: entry.key,
    target,
    durableWrites: overrides.durableWrites ?? entry.effects.durableWrites,
    humanVisibleEffects: overrides.humanVisibleEffects ?? entry.effects.humanVisible,
    nonEffects: overrides.nonEffects ?? entry.effects.nonEffects,
    caveat: MUTATION_PLAN_CAVEAT,
  };
}

function stringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

/** Wire guard used before the CLI renders a response as a preview. */
export function isAgentMutationPlan(value: unknown): value is AgentMutationPlan {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const plan = value as Record<string, unknown>;
  const target = plan["target"];
  if (typeof target !== "object" || target === null || Array.isArray(target)) return false;
  const typedTarget = target as Record<string, unknown>;
  const writes = plan["durableWrites"];
  return (
    plan["v"] === 1 &&
    plan["kind"] === "mutation-plan" &&
    plan["dryRun"] === true &&
    typeof plan["verb"] === "string" &&
    typeof typedTarget["kind"] === "string" &&
    (typeof typedTarget["id"] === "string" || typedTarget["id"] === null) &&
    typeof typedTarget["label"] === "string" &&
    Array.isArray(writes) &&
    writes.every((write) => {
      if (typeof write !== "object" || write === null || Array.isArray(write)) return false;
      const item = write as Record<string, unknown>;
      return (
        typeof item["resource"] === "string" &&
        typeof item["operation"] === "string" &&
        typeof item["summary"] === "string"
      );
    }) &&
    stringArray(plan["humanVisibleEffects"]) &&
    stringArray(plan["nonEffects"]) &&
    plan["caveat"] === MUTATION_PLAN_CAVEAT
  );
}

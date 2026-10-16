import { AGENT_MODEL_TIERS, REASONING_LEVELS, DECISION_LIMITS } from "@volli/shared";
import {
  BILLING_SOURCES,
  validateBillingCandidates,
  type BillingCandidate,
} from "./auto-select/billing";

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const windowShape = (value: unknown): boolean =>
  value === null ||
  (record(value) &&
    (value["leftPercent"] === null || typeof value["leftPercent"] === "number") &&
    (value["resetsAt"] === null || typeof value["resetsAt"] === "string"));

/** JSON editor boundary. Do not let a half-edited candidate throw during render. */
export function parseBillingCandidates(
  value: unknown,
): { ok: true; candidates: BillingCandidate[] } | { ok: false; error: string } {
  if (!Array.isArray(value) || value.length < 2 || value.length > DECISION_LIMITS.choicesMax) {
    return { ok: false, error: `Enter 2–${DECISION_LIMITS.choicesMax} candidates.` };
  }
  for (const [index, item] of value.entries()) {
    if (
      !record(item) ||
      !record(item["selection"]) ||
      typeof item["selection"]["providerId"] !== "string" ||
      typeof item["selection"]["modelId"] !== "string" ||
      !(REASONING_LEVELS as readonly unknown[]).includes(item["selection"]["reasoningLevel"]) ||
      !Array.isArray(item["tiers"]) ||
      !item["tiers"].every((tier: unknown) =>
        (AGENT_MODEL_TIERS as readonly unknown[]).includes(tier),
      ) ||
      !(BILLING_SOURCES as readonly unknown[]).includes(item["billingSource"]) ||
      !windowShape(item["fiveHour"]) ||
      !windowShape(item["weekly"])
    ) {
      return {
        ok: false,
        error: `Candidate ${index + 1}: expected selection {providerId, modelId, reasoningLevel}, tiers, billingSource, fiveHour and weekly (window objects or null).`,
      };
    }
  }
  const candidates = value as BillingCandidate[];
  const problems = validateBillingCandidates(candidates);
  return problems.length > 0 ? { ok: false, error: problems.join(" ") } : { ok: true, candidates };
}

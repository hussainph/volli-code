import {
  autoSelectCriterion,
  autoSelectRequest,
  checkDecisionRequest,
  DECISION_LIMITS,
  paceOf,
  readAutoSelect,
  type AutoSelectCandidate,
  type AutoSelectPick,
  type DecisionAnswered,
  type DecisionRequest,
  type UsagePace,
} from "@volli/shared";

export const BILLING_SOURCES = ["subscription", "api-key", "gateway", "local"] as const;
export type BillingSource = (typeof BILLING_SOURCES)[number];

/** Null means unknown, never zero remaining or a fresh allowance. */
export interface BillingWindow {
  leftPercent: number | null;
  resetsAt: string | null;
}

export interface BillingScenario {
  billingSource: BillingSource;
  fiveHour: BillingWindow | null;
  weekly: BillingWindow | null;
}

export interface BillingCandidate extends AutoSelectCandidate, BillingScenario {}

export type BillingInput = Parameters<typeof autoSelectRequest>[0];
export type BillingWindowKind = "fiveHour" | "weekly";

export const DEFAULT_BILLING_INSTRUCTIONS =
  "Choose the model and reasoning effort best suited to carry out the request in the state: strong enough to do the work well, minimizing actual marginal cost rather than guessed list price. Subscription capacity is cheap while under pace and scarce near the limit or ahead of pace; consider both five-hour and weekly windows. API-key and metered gateway use spend real dollars. Unknown or expired windows are not evidence of free headroom. Local use has no API token charge but capacity and hardware costs are unknown. Do not sacrifice the ability to complete the task just to save capacity. Candidates on the same subscription account share its windows; changing model or effort does not refill them.";

/** Derive pace with the shipped rules; editable state never stores a pace. */
export function billingWindowPace(
  window: BillingWindow | null,
  kind: BillingWindowKind,
  now: number,
): UsagePace | null {
  if (window === null || window.leftPercent === null || !Number.isFinite(now)) return null;
  return paceOf(
    {
      id: kind,
      kind: kind === "fiveHour" ? "session" : "weekly",
      label: kind === "fiveHour" ? "5h" : "weekly",
      usedPercent: 100 - window.leftPercent,
      ...(window.resetsAt === null ? {} : { resetsAt: window.resetsAt }),
      windowDurationMins: kind === "fiveHour" ? 300 : 7 * 24 * 60,
    },
    now,
  );
}

function windowText(window: BillingWindow | null, kind: BillingWindowKind, now: number): string {
  const label = kind === "fiveHour" ? "5h" : "weekly";
  if (window === null) return `${label}: unknown`;
  const remaining =
    window.leftPercent === null ? "remaining unknown" : `${window.leftPercent}% left`;
  const reset = window.resetsAt === null ? "reset unknown" : `resets ${window.resetsAt}`;
  const expired = window.resetsAt !== null && Date.parse(window.resetsAt) <= now;
  const pace = billingWindowPace(window, kind, now);
  return `${label}: ${remaining}, ${reset}, ${expired ? "expired; headroom unknown" : `pace ${pace ?? "unknown"}`}`;
}

/** The billing part of an option's criterion, independent of the model identity. */
export function billingScenarioCriterion(scenario: BillingScenario, now: number): string {
  switch (scenario.billingSource) {
    case "subscription":
      return `Subscription. ${windowText(scenario.fiveHour, "fiveHour", now)}; ${windowText(scenario.weekly, "weekly", now)}.`;
    case "api-key":
      return "API key: metered real-dollar spend, not subscription capacity; token prices unknown.";
    case "gateway":
      return "Gateway: metered real-dollar spend; gateway prices and any included credit unknown.";
    case "local":
      return "Local: no API token charge; hardware cost and available compute capacity unknown.";
  }
}

export function billingAwareCriterion(candidate: BillingCandidate, now: number): string {
  const billing = billingScenarioCriterion(candidate, now);
  // Keep billing visible even when an editable model name is unusually long.
  const budget = DECISION_LIMITS.criterionMaxChars - billing.length - 1;
  return `${autoSelectCriterion(candidate).slice(0, Math.max(0, budget))} ${billing}`;
}

/** Editor validation; returns messages instead of coercing unknown headroom to zero. */
export function validateBillingCandidates(candidates: readonly BillingCandidate[]): string[] {
  const problems: string[] = [];
  const pairs = new Set<string>();
  for (const [index, candidate] of candidates.entries()) {
    const label = `Candidate ${index + 1}`;
    if (!BILLING_SOURCES.includes(candidate.billingSource))
      problems.push(`${label}: invalid billing source.`);
    if (!candidate.selection.providerId.trim() || !candidate.selection.modelId.trim()) {
      problems.push(`${label}: provider and model are required.`);
    }
    const pair = JSON.stringify([
      candidate.selection.providerId,
      candidate.selection.modelId,
      candidate.selection.reasoningLevel,
    ]);
    if (pairs.has(pair)) problems.push(`${label}: duplicate model and effort.`);
    pairs.add(pair);
    for (const kind of ["fiveHour", "weekly"] as const) {
      const window = candidate[kind];
      if (window === null) continue;
      if (
        window.leftPercent !== null &&
        (!Number.isFinite(window.leftPercent) || window.leftPercent < 0 || window.leftPercent > 100)
      ) {
        problems.push(`${label} ${kind}: remaining must be 0–100 or unknown.`);
      }
      if (window.resetsAt !== null && !Number.isFinite(Date.parse(window.resetsAt))) {
        problems.push(`${label} ${kind}: reset must be a date or unknown.`);
      }
    }
  }
  return problems;
}

/**
 * Lab-only variant. The baseline owns clipping, tier hints and option ordering.
 * Throws for invalid editor values or decision bounds; null means no choice.
 */
export function billingAwareRequest(
  input: BillingInput,
  candidates: readonly BillingCandidate[],
  instructions: string,
  now: number,
): DecisionRequest | null {
  const baseline = autoSelectRequest(input, candidates);
  if (baseline === null) return null;
  if (!Number.isFinite(now)) throw new Error("The scenario clock must be finite.");
  const problems = validateBillingCandidates(candidates);
  if (problems.length > 0) throw new Error(problems.join(" "));
  const criteria = Object.fromEntries(
    candidates.map((candidate, index) => [
      `option_${index + 1}`,
      billingAwareCriterion(candidate, now),
    ]),
  );
  const billing = Object.fromEntries(
    candidates.map((candidate, index) => [
      `option_${index + 1}`,
      {
        selection: { ...candidate.selection },
        tiers: [...candidate.tiers],
        billingSource: candidate.billingSource,
        fiveHour:
          candidate.billingSource === "subscription" && candidate.fiveHour !== null
            ? {
                ...candidate.fiveHour,
                pace: billingWindowPace(candidate.fiveHour, "fiveHour", now),
              }
            : null,
        weekly:
          candidate.billingSource === "subscription" && candidate.weekly !== null
            ? { ...candidate.weekly, pace: billingWindowPace(candidate.weekly, "weekly", now) }
            : null,
      },
    ]),
  );
  const request: DecisionRequest = {
    state: { ...baseline.state, now: new Date(now).toISOString(), billing },
    questions: { model: { type: "choice", instructions, criteria } },
  };
  const checked = checkDecisionRequest(request);
  if (!checked.ok) throw new Error(checked.problem);
  return checked.value;
}

/** Same inclusive confidence threshold, option mapping and fallback as baseline. */
export function readBillingAware(
  answered: DecisionAnswered,
  candidates: readonly BillingCandidate[],
): AutoSelectPick | null {
  return readAutoSelect(answered, candidates);
}

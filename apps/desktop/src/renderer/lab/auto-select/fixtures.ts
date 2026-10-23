import type { AutoSelectCandidate } from "@volli/shared";
import type { BillingCandidate, BillingInput } from "./billing";

/** Model/effort ladders from the provided eval files; no recorded results or account data. */
export const BILLING_LADDERS = {
  "clean-ladder": [
    {
      selection: {
        providerId: "anthropic",
        modelId: "claude-sonnet-4-6",
        reasoningLevel: "medium",
      },
      tiers: ["ticket"],
    },
    {
      selection: {
        providerId: "anthropic",
        modelId: "claude-haiku-4-5",
        reasoningLevel: "low",
      },
      tiers: ["fast"],
    },
    {
      selection: {
        providerId: "anthropic",
        modelId: "claude-opus-4-6",
        reasoningLevel: "high",
      },
      tiers: ["deep"],
    },
    {
      selection: {
        providerId: "anthropic",
        modelId: "claude-opus-4-6",
        reasoningLevel: "max",
      },
      tiers: ["global"],
    },
  ],
  "real-user-ladder": [
    {
      selection: {
        providerId: "openai-codex",
        modelId: "gpt-6.1-sol",
        reasoningLevel: "high",
      },
      tiers: ["ticket"],
    },
    {
      selection: {
        providerId: "zai",
        modelId: "glm-5.3-flash",
        reasoningLevel: "max",
      },
      tiers: ["fast"],
    },
    {
      selection: {
        providerId: "openai-codex",
        modelId: "gpt-6.1-sol",
        reasoningLevel: "xhigh",
      },
      tiers: ["deep"],
    },
    {
      selection: {
        providerId: "anthropic",
        modelId: "claude-opus-5-5",
        reasoningLevel: "high",
      },
      tiers: ["global"],
    },
  ],
} as const satisfies Readonly<Record<string, readonly AutoSelectCandidate[]>>;

export type BillingLadderName = keyof typeof BILLING_LADDERS;
export interface EvalPrompt extends BillingInput {
  id: string;
  complexity: string;
}

/** Only the 14 supplied evaluation prompts, not session/request history. */
export const EVAL_PROMPTS: readonly EvalPrompt[] = [
  {
    id: "greeting",
    complexity: "trivial",
    request: "hi",
  },
  {
    id: "thanks",
    complexity: "trivial",
    request: "thanks, that worked!",
  },
  {
    id: "mechanical",
    complexity: "mechanical",
    request: "rename the variable `foo` to `bar` in utils.ts",
  },
  {
    id: "quick-error",
    complexity: "quick question",
    request:
      "what does this error mean? TypeError: Cannot read properties of undefined (reading 'map')",
  },
  {
    id: "login-form",
    complexity: "everyday coding",
    request: "add a login form with email/password validation and inline error states",
  },
  {
    id: "unit-tests",
    complexity: "everyday coding",
    request: "write unit tests for the date-formatting helpers, including timezones and edge cases",
  },
  {
    id: "refactor",
    complexity: "multi-file",
    request:
      "split this 800-line settings component into smaller modules without changing behavior",
  },
  {
    id: "race-debug",
    complexity: "hard debugging",
    request:
      "intermittent race: a Session can attach before its birth finishes, but only under concurrent load — find and fix it",
  },
  {
    id: "design-harness",
    complexity: "design",
    request:
      "design the auto-model picker evaluation harness: what metrics, what prompts, how to judge pick quality",
  },
  {
    id: "pr-review",
    complexity: "review",
    request:
      "review this PR for correctness, security, and performance; it touches auth, caching, and database migrations",
  },
  {
    id: "board-plan",
    complexity: "planning",
    request:
      "plan work across 5 tickets with dependencies and propose an order with parallel tracks",
  },
  {
    id: "vague",
    complexity: "ambiguous",
    request: "fix it",
  },
  {
    id: "triage-subagent",
    complexity: "bulk triage (subagent)",
    request: "summarize these 200 support messages into 5 categories",
    tierHint: "fast",
  },
  {
    id: "migration-plan",
    complexity: "hard planning (subagent)",
    request: "produce the implementation plan for migrating the agent runtime off pi-agent-core",
    tierHint: "deep",
  },
];

/** Simulated wiring: all billing sources/windows here are editable examples, not probed facts. */
export function createBillingCandidates(
  ladder: BillingLadderName,
  now: number,
): BillingCandidate[] {
  const fiveHourReset = new Date(now + 2.5 * 60 * 60_000).toISOString();
  const weeklyReset = new Date(now + 3.5 * 24 * 60 * 60_000).toISOString();
  return BILLING_LADDERS[ladder].map((candidate) => {
    const subscription = candidate.selection.providerId !== "zai";
    return {
      selection: { ...candidate.selection },
      tiers: [...candidate.tiers],
      billingSource: subscription ? "subscription" : "api-key",
      fiveHour: subscription ? { leftPercent: 85, resetsAt: fiveHourReset } : null,
      weekly: subscription ? { leftPercent: 80, resetsAt: weeklyReset } : null,
    };
  });
}

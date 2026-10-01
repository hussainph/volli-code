/**
 * Automatic model choice (VC-432): picking a model and a reasoning level for a
 * new Session from the person's own configured models, with a decision model.
 *
 * The rules, each stated once here so main, the doors and the header read the
 * same words:
 *
 * - **Only approved candidates.** The choice is over the model-and-effort pairs
 *   the person already configured — the Session's default and every agent tier
 *   — never a model the catalog merely lists. Fewer than two distinct pairs is
 *   no decision at all: nothing is asked and nothing is sent.
 * - **One question.** A single `choice` over the pairs, each described by what
 *   its tiers are for and how much reasoning its effort buys. The input is the
 *   request text and, for a subagent, the tier its parent runs on.
 * - **Unsure falls back.** An answer below {@link AUTO_SELECT_MIN_CONFIDENCE}
 *   is no pick; the caller keeps the configured default. The same goes for
 *   every miss the decision port names.
 * - **Made once, at birth.** What comes out is a model selection plus the
 *   provenance the header shows ({@link ModelAutoPick}); nothing here ever
 *   moves a Session that is already running.
 *
 * Pure: no I/O, and no knowledge of where the decision model runs.
 */

import type { ModelSelection, ReasoningLevel } from "./agent-runtime";
import type { DecisionAnswered, DecisionRequest } from "./decision-model";
import { modelTierRow, type AgentModelTier } from "./model-access-policy";

/**
 * The tiers whose models a decision may choose among. `visual` is left out: it
 * exists for images and a decision reads only text, so it could never be
 * chosen for the reason the tier exists — and resolving it walks the model
 * catalog, which a birth should not wait on.
 */
export const AUTO_SELECT_TIERS = [
  "fast",
  "deep",
  "ticket",
  "global",
] as const satisfies readonly AgentModelTier[];

/**
 * The least confidence a pick may carry and still be acted on. Confidence is
 * how far the answer is from uniform (`(n·peak − 1)/(n − 1)`), so 0.5 asks for
 * a clear favourite over two options (75%) and a clearer one over more.
 */
export const AUTO_SELECT_MIN_CONFIDENCE = 0.5;

/** The request text a decision reads, clipped: the start of a task says what it is. */
export const AUTO_SELECT_MAX_REQUEST_CHARS = 6_000;

/** How many runners-up the header lists beside the pick. */
export const AUTO_SELECT_MAX_ALTERNATIVES = 2;

/** One runner-up the decision considered, and how likely it found it. */
export interface ModelAutoAlternative {
  selection: ModelSelection;
  /** In [0, 1], two decimals. */
  probability: number;
}

/**
 * Why a Session runs on the model it does, when a decision model chose it:
 * the confidence of the pick and the options it passed over, likeliest first.
 * Durable beside the model selection, so the header can say "Auto-picked" and
 * offer the alternatives for as long as the Session exists.
 */
export interface ModelAutoPick {
  /** In [0, 1], two decimals. */
  confidence: number;
  alternatives: readonly ModelAutoAlternative[];
}

/** A model-and-effort pair a decision may pick, with the tiers that name it. */
export interface AutoSelectCandidate {
  selection: ModelSelection;
  /** The agent tiers whose configured model is this pair; empty for a bare default. */
  tiers: readonly AgentModelTier[];
}

function pairKey(selection: ModelSelection): string {
  return JSON.stringify([selection.providerId, selection.modelId, selection.reasoningLevel]);
}

/**
 * The distinct pairs a person has approved: the Session's configured default
 * first, then each agent tier's resolved model in the tiers' own order. A pair
 * several tiers share is one candidate carrying all of their names.
 */
export function autoSelectCandidates(
  configuredDefault: ModelSelection,
  tiers: Readonly<Partial<Record<AgentModelTier, ModelSelection | null>>>,
): readonly AutoSelectCandidate[] {
  const byKey = new Map<string, { selection: ModelSelection; tiers: AgentModelTier[] }>();
  byKey.set(pairKey(configuredDefault), { selection: configuredDefault, tiers: [] });
  for (const tier of AUTO_SELECT_TIERS) {
    const selection = tiers[tier];
    if (selection === null || selection === undefined) continue;
    const key = pairKey(selection);
    const known = byKey.get(key);
    if (known === undefined) byKey.set(key, { selection, tiers: [tier] });
    else known.tiers.push(tier);
  }
  return [...byKey.values()];
}

const EFFORT_BLURB: Record<ReasoningLevel, string> = {
  off: "quick, simple or mechanical work",
  minimal: "quick, simple or mechanical work",
  low: "quick, simple or mechanical work",
  medium: "everyday coding, editing and explaining",
  high: "hard debugging, design and multi-step reasoning",
  xhigh: "hard debugging, design and multi-step reasoning",
  max: "the hardest, most open-ended problems",
};

/** What one pair is good for, in the words the decision model reads. */
export function autoSelectCriterion(candidate: AutoSelectCandidate): string {
  const { selection, tiers } = candidate;
  const kinds = tiers.map((tier) => modelTierRow(tier).hint.replace(/\.$/, "").toLowerCase());
  const head = `${selection.modelId} at ${selection.reasoningLevel} reasoning: good for ${EFFORT_BLURB[selection.reasoningLevel]}`;
  const text = kinds.length === 0 ? `${head}.` : `${head}; set up for ${kinds.join(" and ")}.`;
  return text.slice(0, 500);
}

const OPTION_PREFIX = "option_";

/** The decision's option key for the nth candidate. */
function optionKey(index: number): string {
  return `${OPTION_PREFIX}${index + 1}`;
}

/**
 * The one question a model choice asks, or null when there is nothing to
 * choose between. `tierHint` is the tier a subagent's parent runs on — the
 * kind of work its caller was doing — and rides beside the task text.
 */
export function autoSelectRequest(
  input: { request: string; tierHint?: AgentModelTier | null },
  candidates: readonly AutoSelectCandidate[],
): DecisionRequest | null {
  if (candidates.length < 2) return null;
  const state: Record<string, string> = {
    request: input.request.slice(0, AUTO_SELECT_MAX_REQUEST_CHARS),
  };
  if (input.tierHint !== undefined && input.tierHint !== null) {
    state["tierHint"] = `${input.tierHint}: ${modelTierRow(input.tierHint).hint}`;
  }
  return {
    state,
    questions: {
      model: {
        type: "choice",
        instructions:
          "Choose the model and reasoning effort best suited to carry out the request in the state: strong enough to do the work well, and no more costly than it needs to be.",
        criteria: Object.fromEntries(
          candidates.map((candidate, index) => [optionKey(index), autoSelectCriterion(candidate)]),
        ),
      },
    },
  };
}

/** A decision acted on: the pair chosen and why. */
export interface AutoSelectPick {
  selection: ModelSelection;
  auto: ModelAutoPick;
}

const hundredths = (value: number): number => Math.round(value * 100) / 100;

/**
 * The pick an answer to {@link autoSelectRequest} stands for, or null when it
 * is not one worth acting on: not the question asked, not one of the options,
 * or less confident than {@link AUTO_SELECT_MIN_CONFIDENCE}. Null is the
 * caller's cue to keep the configured default.
 */
export function readAutoSelect(
  answered: DecisionAnswered,
  candidates: readonly AutoSelectCandidate[],
): AutoSelectPick | null {
  const answer = answered.answers["model"];
  if (answer === undefined || answer.type !== "choice") return null;
  if (answer.confidence < AUTO_SELECT_MIN_CONFIDENCE) return null;
  const chosen = candidates.findIndex((_, index) => optionKey(index) === answer.choice);
  if (chosen === -1) return null;
  const alternatives = candidates
    .flatMap((candidate, index) => {
      const probability = answer.probabilities[optionKey(index)] ?? 0;
      return index === chosen || probability <= 0
        ? []
        : [{ selection: candidate.selection, probability: hundredths(probability) }];
    })
    .toSorted((a, b) => b.probability - a.probability)
    .slice(0, AUTO_SELECT_MAX_ALTERNATIVES);
  return {
    selection: candidates[chosen]!.selection,
    auto: { confidence: hundredths(answer.confidence), alternatives },
  };
}

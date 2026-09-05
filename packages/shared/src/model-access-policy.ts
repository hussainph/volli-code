/**
 * The app-wide model policy vocabulary: which purposes a default model serves,
 * how a Session Role resolves one, and which catalog models the user has
 * curated out of every picker.
 *
 * Pure and shared on purpose. Main stores these values and resolves them at
 * Session creation; the renderer's settings and composers read the same words —
 * a purpose or a hidden-model rule that existed in only one process would be
 * two policies wearing one name.
 */

import type { ModelSelection } from "./agent-runtime";

/**
 * The named tiers a default model is configured for (VC-259), in the order
 * Settings lists them. A tier is a KIND OF WORK, not a caller: the same Ticket
 * Session may delegate a quick fix to `fast` and a design question to `deep`.
 *
 * The three that predate tiers keep their names and their rows:
 *
 * - `global` — Board chats, and the base every other tier falls back to.
 * - `ticket` — Ticket Sessions, the structured coding runs.
 * - `utility` — naming chats and summaries; cost-efficient background work.
 *
 * The three advanced tiers sit behind a disclosure and fall back to `ticket`:
 *
 * - `fast` — quick, cheap, bounded side work.
 * - `deep` — hard reasoning, planning, judging.
 * - `visual` — reading images, screenshots, and pages; its fallback only
 *   holds when the model it lands on accepts image input.
 *
 * A fixed set on purpose. User-defined tiers are a non-goal until asked for,
 * and every surface that names a tier — Settings, the `session_start` tool,
 * `volli model list`, an Automation's Runtime — reads this one list.
 */
export const MODEL_TIERS = ["global", "ticket", "utility", "fast", "deep", "visual"] as const;
export type ModelTier = (typeof MODEL_TIERS)[number];

/**
 * The pre-tier name for the same set. `purpose` and `tier` are one word: a
 * caller written against the three-purpose vocabulary keeps compiling, and the
 * type it holds now spans all six rows.
 */
export const MODEL_PURPOSES = MODEL_TIERS;
export type ModelPurpose = ModelTier;

export function isModelTier(value: unknown): value is ModelTier {
  return typeof value === "string" && (MODEL_TIERS as readonly string[]).includes(value);
}

/**
 * The tiers a delegating Session may name in `session_start`, most useful
 * first — the order the tool description lists them in.
 *
 * `utility` is not here. It is the slot for work nobody asked for (naming a
 * chat, a summary), and a Session started under it would be a Session whose
 * bill is filed under background work.
 */
export const AGENT_MODEL_TIERS = ["fast", "deep", "visual", "ticket", "global"] as const;
export type AgentModelTier = (typeof AGENT_MODEL_TIERS)[number];

export function isAgentModelTier(value: unknown): value is AgentModelTier {
  return typeof value === "string" && (AGENT_MODEL_TIERS as readonly string[]).includes(value);
}

/**
 * One row per tier: the label a Settings row wears, and the one-line job the
 * `(i)` beside it carries. Shared so the tool description, `volli model list`
 * and Settings all say the same thing about the same slot.
 *
 * `advanced` rows sit behind the Advanced disclosure in Settings, and are the
 * ones whose fallback is the Ticket default.
 *
 * The `global` label says Board (VC-262): the Session Role word is Board
 * Session, and this row is the one Board chats resolve through.
 */
export interface ModelTierRow {
  tier: ModelTier;
  label: string;
  hint: string;
  advanced: boolean;
}

const TIER_ROW: Record<ModelTier, Omit<ModelTierRow, "tier">> = {
  global: {
    label: "Board chats",
    hint: "Board chats, and the base every other tier falls back to.",
    advanced: false,
  },
  ticket: {
    label: "Ticket Sessions",
    hint: "Ticket Sessions. Unset, they use the Board default.",
    advanced: false,
  },
  utility: {
    label: "Utility",
    hint: "Naming chats and summarizing. Unset, they use the chat's own model.",
    advanced: false,
  },
  fast: { label: "Fast", hint: "Quick, cheap, bounded side work.", advanced: true },
  deep: { label: "Deep", hint: "Hard reasoning, planning, judging.", advanced: true },
  visual: { label: "Visual", hint: "Reading images, screenshots, and pages.", advanced: true },
};

/** The row for one tier; every tier has one by construction. */
export function modelTierRow(tier: ModelTier): ModelTierRow {
  return { tier, ...TIER_ROW[tier] };
}

export const MODEL_TIER_ROWS: readonly ModelTierRow[] = MODEL_TIERS.map(modelTierRow);

/** The configured default per tier. Null means "no explicit choice". */
export type ModelAccessDefaults = Record<ModelTier, ModelSelection | null>;

export const EMPTY_MODEL_ACCESS_DEFAULTS: ModelAccessDefaults = {
  global: null,
  ticket: null,
  utility: null,
  fast: null,
  deep: null,
  visual: null,
};

/**
 * The tier an unset tier resolves through, or null at the root.
 *
 * Stated as data so Settings can print "Ticket default" on an unset Fast row
 * from the same fact the resolver walks, rather than from a second copy of
 * the ladder.
 */
export function modelTierFallback(tier: ModelTier): ModelTier | null {
  switch (tier) {
    case "global":
      return null;
    case "ticket":
    case "utility":
      return "global";
    case "fast":
    case "deep":
    case "visual":
      return "ticket";
  }
}

/** What a tier resolved to, and WHICH rung of the ladder supplied it. */
export interface ResolvedModelTier {
  tier: ModelTier;
  /** `tier` itself when set explicitly; otherwise the rung the walk landed on. */
  resolvedFrom: ModelTier;
  selection: ModelSelection;
}

/**
 * Whether a selection names a model that accepts image input — the one
 * catalog fact the `visual` tier's fallback turns on.
 *
 * A predicate rather than the catalog itself so the resolver stays a pure
 * walk over stored defaults: main builds it from the Model Access snapshot
 * ({@link acceptsImageInputIn}), the renderer from the models it already
 * holds, and neither hands the whole catalog to a function that reads one
 * boolean off one row.
 */
export type AcceptsImageInput = (selection: ModelSelection) => boolean;

/** The predicate over a catalog slice; a model the slice does not hold reads as blind. */
export function acceptsImageInputIn(
  models: readonly { providerId: string; modelId: string; acceptsImageInput: boolean }[],
): AcceptsImageInput {
  return (selection) =>
    models.find(
      (model) => model.providerId === selection.providerId && model.modelId === selection.modelId,
    )?.acceptsImageInput ?? false;
}

/**
 * The model a tier resolves to, walking the fallback ladder, or null when no
 * rung on it is configured.
 *
 * An unset tier falls back BY DEFINITION, not silently: an unset Fast row
 * *means* "use the Ticket default", which is what the Settings row says when
 * it is unset, and `resolvedFrom` carries that rung so every surface can say
 * it. What never happens is a model the user configured nowhere — a fully
 * unset profile resolves null, and the caller refuses rather than substitutes
 * (the DEFAULT_MODEL_REQUIRED invariant).
 *
 * `visual` adds one rule and it is applied to the rung the walk LANDS ON, not
 * used to keep walking: an unset Visual row falls back to the Ticket default
 * only if that model can read images. A Ticket default that cannot resolves
 * null rather than reaching past it for a Board model that can — that would
 * be a model the user chose for nothing here. Without a `sees` predicate the
 * fallback cannot be checked, so it is refused; an explicit Visual choice was
 * checked when it was saved ({@link visualModelProblem}) and is returned as-is.
 */
export function resolveModelTier(
  defaults: ModelAccessDefaults,
  tier: ModelTier,
  sees?: AcceptsImageInput,
): ResolvedModelTier | null {
  let rung: ModelTier | null = tier;
  while (rung !== null) {
    const selection = defaults[rung];
    if (selection !== null) {
      if (tier === "visual" && rung !== "visual" && !(sees?.(selection) ?? false)) return null;
      return { tier, resolvedFrom: rung, selection };
    }
    rung = modelTierFallback(rung);
  }
  return null;
}

/** {@link resolveModelTier} for the callers that only need the selection. */
export function resolveDefaultModel(
  defaults: ModelAccessDefaults,
  tier: ModelTier,
  sees?: AcceptsImageInput,
): ModelSelection | null {
  return resolveModelTier(defaults, tier, sees)?.selection ?? null;
}

/**
 * Why a model cannot be saved as the Visual default, or null when it can.
 *
 * One rule and one line, shared so Settings' refusal and main's write guard
 * are the same sentence. The tier exists to read screenshots and `.jpg`
 * attachments; a model that cannot take image input would make it a slot
 * that fails at the first thing it is for.
 */
export function visualModelProblem(
  models: readonly { providerId: string; modelId: string; acceptsImageInput: boolean }[],
  selection: ModelSelection,
): string | null {
  return acceptsImageInputIn(models)(selection)
    ? null
    : "This model can't read images, so it can't be the Visual default.";
}

/**
 * The refusal every structured Session start states when no default resolves.
 *
 * Lives in shared rather than in main because the renderer has to RECOGNIZE it:
 * a create refused for this reason is a predictable configuration state, not a
 * failure, and the surface that meets it opens Model Access instead of raising
 * an error toast. One wording for both Roles, so a person meeting it twice can
 * tell it is the same missing setting.
 */
export const DEFAULT_MODEL_REQUIRED =
  "Choose a default model in Settings before starting a Session.";

/** Whether a refusal message is the missing-default refusal, whatever wrapped it. */
export function isDefaultModelRequired(message: string): boolean {
  return message.includes(DEFAULT_MODEL_REQUIRED);
}

/**
 * The same refusal when a NAMED tier resolved to nothing.
 *
 * The sentence is the existing one with the tier appended, never a new one:
 * a renderer that recognizes {@link DEFAULT_MODEL_REQUIRED} still opens Model
 * Access, and the caller — an agent that asked for `deep` — learns which row
 * is empty rather than guessing which of six it was.
 */
export function defaultModelRequiredForTier(tier: ModelTier): string {
  return `${DEFAULT_MODEL_REQUIRED} The ${tier} tier resolved to nothing.`;
}

/** One catalog model the user toggled out of composers and pickers. */
export interface HiddenModelRef {
  providerId: string;
  modelId: string;
}

export function isModelHidden(
  hidden: readonly HiddenModelRef[],
  model: { providerId: string; modelId: string },
): boolean {
  return hidden.some(
    (entry) => entry.providerId === model.providerId && entry.modelId === model.modelId,
  );
}

/**
 * The catalog with the user's hidden models removed — the ONLY models any
 * composer or picker may offer.
 *
 * Visibility is a curation of choices, not of facts: a Session already pinned
 * to a hidden model still runs it and still names it, and an explicit
 * invocation-time override (the `session_start` tool's `model` field, or the
 * composer's own picker) names an exact id, so neither consults this.
 */
export function visibleModels<T extends { providerId: string; modelId: string }>(
  models: readonly T[],
  hidden: readonly HiddenModelRef[],
): readonly T[] {
  return hidden.length === 0 ? models : models.filter((model) => !isModelHidden(hidden, model));
}

/** `hidden` with one model's visibility set, never listing the same model twice. */
export function withModelVisibility(
  hidden: readonly HiddenModelRef[],
  model: HiddenModelRef,
  visible: boolean,
): readonly HiddenModelRef[] {
  const without = hidden.filter(
    (entry) => !(entry.providerId === model.providerId && entry.modelId === model.modelId),
  );
  return visible ? without : [...without, { providerId: model.providerId, modelId: model.modelId }];
}

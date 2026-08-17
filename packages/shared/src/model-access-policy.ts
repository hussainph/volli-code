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
 * The three jobs a default model is configured for.
 *
 * - `global` — orchestration: Home/project chats, and the base every other
 *   purpose falls back to when it has no explicit choice of its own.
 * - `ticket` — execution: Ticket Sessions, the structured coding runs.
 * - `utility` — cost-efficient background work.
 */
export const MODEL_PURPOSES = ["global", "ticket", "utility"] as const;
export type ModelPurpose = (typeof MODEL_PURPOSES)[number];

/** The configured default per purpose. Null means "no explicit choice". */
export interface ModelAccessDefaults {
  global: ModelSelection | null;
  ticket: ModelSelection | null;
  utility: ModelSelection | null;
}

export const EMPTY_MODEL_ACCESS_DEFAULTS: ModelAccessDefaults = {
  global: null,
  ticket: null,
  utility: null,
};

/**
 * The default a purpose resolves to, or null when nothing is configured for it.
 *
 * `ticket` and `utility` fall back to `global` BY DEFINITION, not silently: an
 * unset ticket default *means* "use the project default", which is what the
 * settings row says when it is unset. What never happens is a model the user
 * configured nowhere — a fully unset profile resolves null, and the caller
 * refuses rather than substitutes (the DEFAULT_MODEL_REQUIRED invariant).
 */
export function resolveDefaultModel(
  defaults: ModelAccessDefaults,
  purpose: ModelPurpose,
): ModelSelection | null {
  return purpose === "global" ? defaults.global : (defaults[purpose] ?? defaults.global);
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
 * invocation-time override (`volli session start --model`) is an exact id the
 * user typed, so neither consults this.
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

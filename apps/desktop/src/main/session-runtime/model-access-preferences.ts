import type Database from "better-sqlite3";
import {
  DEFAULT_COMPACTION_POLICY,
  isUsableCompactionReserve,
  REASONING_LEVELS,
  type CompactionPolicy,
  type HiddenModelRef,
  type ModelAccessDefaults,
  type ModelAccessSnapshot,
  type ModelCompactionLimit,
  type ModelPurpose,
  type ModelSelection,
} from "@volli/shared";

import { setAppState } from "../db/app-state-repo";
import { prepared } from "../db/prepared";

/**
 * The pre-purpose single default. Read only as a migration source: a profile
 * that configured a default before purposes existed keeps it as the global
 * one, and the first purpose-aware write persists the new shape.
 */
export const MODEL_ACCESS_DEFAULT_APP_STATE_KEY = "volli:model-access-default";
/** One JSON object holding the per-purpose defaults — see {@link ModelAccessDefaults}. */
export const MODEL_ACCESS_DEFAULTS_APP_STATE_KEY = "volli:model-access-defaults";
/** The models the user toggled out of composers and pickers. */
export const MODEL_ACCESS_HIDDEN_MODELS_APP_STATE_KEY = "volli:model-access-hidden-models";
/**
 * The global compaction switch and the per-model reserves, in one blob.
 *
 * One key rather than two, unlike the defaults and the hidden models beside it,
 * because the runtime asks one question — what policy is this Session under
 * right now — and answering it from two rows that could be written apart would
 * be two reads to describe one decision.
 */
export const COMPACTION_POLICY_APP_STATE_KEY = "volli:compaction-policy";

const MAX_IDENTIFIER_LENGTH = 512;

function isIdentifier(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_IDENTIFIER_LENGTH &&
    value.trim() === value
  );
}

function readAppState(db: Database.Database, key: string): unknown {
  const row = prepared<[string], { value: string }>(
    db,
    "SELECT value FROM app_state WHERE key = ?",
  ).get(key);
  if (row === undefined) return undefined;
  try {
    return JSON.parse(row.value) as unknown;
  } catch {
    return undefined;
  }
}

/** The exact safe selection shape out of stored JSON, or null for anything else. */
function sanitizeSelection(value: unknown): ModelSelection | null {
  if (typeof value !== "object" || value === null) return null;
  const candidate = value as Record<string, unknown>;
  const providerId = candidate["providerId"];
  const modelId = candidate["modelId"];
  const reasoningLevel = candidate["reasoningLevel"];
  const validReasoningLevel = REASONING_LEVELS.find((level) => level === reasoningLevel);
  if (!isIdentifier(providerId) || !isIdentifier(modelId) || validReasoningLevel === undefined) {
    return null;
  }
  return { providerId, modelId, reasoningLevel: validReasoningLevel };
}

/** Reads the pre-purpose single default — the migration source and nothing more. */
export function readDefaultModelSelection(db: Database.Database): ModelSelection | null {
  return sanitizeSelection(readAppState(db, MODEL_ACCESS_DEFAULT_APP_STATE_KEY));
}

/**
 * The per-purpose defaults this profile has configured.
 *
 * The purpose-aware key wins once it exists; before it does, a legacy single
 * default reads as the global purpose so nobody's configured model vanishes on
 * update. Each stored purpose is sanitized independently — one malformed entry
 * costs that entry, never the others.
 */
export function readModelAccessDefaults(db: Database.Database): ModelAccessDefaults {
  const stored = readAppState(db, MODEL_ACCESS_DEFAULTS_APP_STATE_KEY);
  if (typeof stored === "object" && stored !== null) {
    const candidate = stored as Record<string, unknown>;
    return {
      global: sanitizeSelection(candidate["global"]),
      ticket: sanitizeSelection(candidate["ticket"]),
      utility: sanitizeSelection(candidate["utility"]),
    };
  }
  return { global: readDefaultModelSelection(db), ticket: null, utility: null };
}

/** Stores one purpose's secret-free model policy; null clears an explicit choice. */
export function writeModelAccessDefault(
  db: Database.Database,
  purpose: ModelPurpose,
  selection: ModelSelection | null,
  now: number,
): ModelAccessDefaults {
  const next: ModelAccessDefaults = {
    ...readModelAccessDefaults(db),
    [purpose]:
      selection === null
        ? null
        : {
            providerId: selection.providerId,
            modelId: selection.modelId,
            reasoningLevel: selection.reasoningLevel,
          },
  };
  setAppState(db, MODEL_ACCESS_DEFAULTS_APP_STATE_KEY, JSON.stringify(next), now);
  return next;
}

/** The models the user toggled out of every composer and picker. */
export function readHiddenModels(db: Database.Database): readonly HiddenModelRef[] {
  const stored = readAppState(db, MODEL_ACCESS_HIDDEN_MODELS_APP_STATE_KEY);
  if (!Array.isArray(stored)) return [];
  return stored.flatMap((entry: unknown): HiddenModelRef[] => {
    if (typeof entry !== "object" || entry === null) return [];
    const candidate = entry as Record<string, unknown>;
    const providerId = candidate["providerId"];
    const modelId = candidate["modelId"];
    return isIdentifier(providerId) && isIdentifier(modelId) ? [{ providerId, modelId }] : [];
  });
}

/** Stores the full curated hidden-model list, identity pairs only. */
export function writeHiddenModels(
  db: Database.Database,
  hidden: readonly HiddenModelRef[],
  now: number,
): void {
  setAppState(
    db,
    MODEL_ACCESS_HIDDEN_MODELS_APP_STATE_KEY,
    JSON.stringify(
      hidden.map((entry) => ({ providerId: entry.providerId, modelId: entry.modelId })),
    ),
    now,
  );
}

/**
 * The compaction policy this profile has configured.
 *
 * Absent or unreadable reads as {@link DEFAULT_COMPACTION_POLICY} — compaction
 * on, nothing limited — because that is what every profile did before this
 * setting existed, and an update is not a reason to stop compacting. Each limit
 * is sanitized independently, so one malformed row costs that model its reserve
 * and never the others theirs.
 *
 * A stored reserve is not checked against the model's window here. It cannot be:
 * this function has no catalog, the window it would check against is the one the
 * catalog reports today, and a row that has gone stale against a shrunken window
 * is a live-resolution question rather than a storage one — the runtime asks it,
 * with the window in hand.
 */
export function readCompactionPolicy(db: Database.Database): CompactionPolicy {
  const stored = readAppState(db, COMPACTION_POLICY_APP_STATE_KEY);
  if (typeof stored !== "object" || stored === null) return DEFAULT_COMPACTION_POLICY;
  const candidate = stored as Record<string, unknown>;
  const autoCompaction = candidate["autoCompaction"];
  const modelLimits = candidate["modelLimits"];
  return {
    autoCompaction:
      typeof autoCompaction === "boolean"
        ? autoCompaction
        : DEFAULT_COMPACTION_POLICY.autoCompaction,
    modelLimits: Array.isArray(modelLimits) ? modelLimits.flatMap(sanitizeCompactionLimit) : [],
  };
}

/** One stored per-model reserve, or nothing at all — never a repaired one. */
function sanitizeCompactionLimit(entry: unknown): ModelCompactionLimit[] {
  if (typeof entry !== "object" || entry === null) return [];
  const candidate = entry as Record<string, unknown>;
  const providerId = candidate["providerId"];
  const modelId = candidate["modelId"];
  const reserveTokens = candidate["reserveTokens"];
  if (!isIdentifier(providerId) || !isIdentifier(modelId)) return [];
  if (typeof reserveTokens !== "number" || !Number.isSafeInteger(reserveTokens)) return [];
  if (reserveTokens <= 0) return [];
  return [{ providerId, modelId, reserveTokens }];
}

/** Stores the whole policy: the switch, and the full curated list of limits. */
export function writeCompactionPolicy(
  db: Database.Database,
  policy: CompactionPolicy,
  now: number,
): CompactionPolicy {
  const next: CompactionPolicy = {
    autoCompaction: policy.autoCompaction,
    modelLimits: policy.modelLimits.map((limit) => ({
      providerId: limit.providerId,
      modelId: limit.modelId,
      reserveTokens: limit.reserveTokens,
    })),
  };
  setAppState(db, COMPACTION_POLICY_APP_STATE_KEY, JSON.stringify(next), now);
  return next;
}

/**
 * A model may only be limited to a reserve it could actually run under.
 *
 * The counterpart of {@link assertDefaultModelAvailable}, and refused at the
 * same boundary for the same reason: a reserve at or above the window puts the
 * threshold at or below zero, which compacts — and pays for a summary — after
 * every single reply, with nothing at the point of use to explain why. A model
 * whose catalog reports no usable window is refused outright rather than stored
 * unchecked: no window means no threshold to measure against, so a limit on it
 * would be a setting that could never do anything.
 *
 * Availability is deliberately not required. Sign-in decides whether a model can
 * answer, not how much room it holds, and a reserve configured for a provider
 * signed out this week is a preference to keep, exactly like a hidden model.
 */
export function assertCompactionLimitsUsable(
  access: ModelAccessSnapshot,
  limits: readonly ModelCompactionLimit[],
): void {
  for (const limit of limits) {
    const model = access.models.find(
      (candidate) =>
        candidate.providerId === limit.providerId && candidate.modelId === limit.modelId,
    );
    if (model?.contextWindow === undefined) {
      throw new Error("This model reports no context window to compact against.");
    }
    if (!isUsableCompactionReserve(limit.reserveTokens, model.contextWindow)) {
      throw new Error("This reserve is larger than the model's context window.");
    }
  }
}

/**
 * Only a model this profile can actually run may become the app default.
 *
 * This value is copied into every new Session's durable model policy at birth
 * and nothing between here and the first prompt re-checks it — so a default
 * that merely *exists* in the catalog is a first message that dies at the
 * provider, once per Session, with a raw API error and no obvious cause.
 * Signed-out is a state to recover from before saving, not a choice to honour.
 */
export function assertDefaultModelAvailable(
  access: ModelAccessSnapshot,
  selection: ModelSelection,
): void {
  const model = access.models.find(
    (candidate) =>
      candidate.providerId === selection.providerId && candidate.modelId === selection.modelId,
  );
  if (model === undefined || model.state !== "available") {
    throw new Error(
      model?.state === "authentication-required"
        ? "Sign in to this provider before making it the default model."
        : "This model is not currently available.",
    );
  }
  if (!model.reasoningLevels.includes(selection.reasoningLevel)) {
    throw new Error("This reasoning level is not supported by the selected model.");
  }
}

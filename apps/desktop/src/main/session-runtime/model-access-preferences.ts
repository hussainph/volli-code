import type Database from "better-sqlite3";
import {
  REASONING_LEVELS,
  type HiddenModelRef,
  type ModelAccessDefaults,
  type ModelAccessSnapshot,
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

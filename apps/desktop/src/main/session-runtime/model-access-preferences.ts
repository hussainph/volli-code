import type Database from "better-sqlite3";
import {
  DEFAULT_COMPACTION_POLICY,
  REASONING_LEVELS,
  type CompactionPolicy,
  type HiddenModelRef,
  type ModelAccessDefaults,
  type ModelAccessSnapshot,
  type ModelPurpose,
  type ModelSelection,
} from "@volli/shared";

import { supersededModelId } from "@volli/agent-runtime";

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
 * The global compaction switch, in one blob.
 *
 * The blob once carried per-model reserves beside the switch; they were
 * retired (VC-155), and a stored `modelLimits` array from that era is simply
 * ignored on read — the switch it sits beside is still honoured.
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
 * Repairs preferences after a complete upstream list replaced a provider's old
 * catalog.
 *
 * Only successfully refreshed providers participate. A provider whose feed
 * failed retains its last usable list and every preference naming it.
 *
 * For a successful provider there are two outcomes, and the difference matters
 * to whoever set the preference. A model that was *renamed* is followed: the
 * catalogue's own supersession policy says where the id went, so a default
 * keeps pointing at the model the person chose. A model that is simply gone is
 * retired: its default is cleared and its visibility entry dropped, so stored
 * state cannot name rows no picker can show again.
 */
export function reconcileModelAccessPreferences(
  db: Database.Database,
  access: ModelAccessSnapshot,
  now: number,
): void {
  const refreshed = new Set(access.refresh?.refreshedProviderIds ?? []);
  if (refreshed.size === 0) return;
  const present = new Set(
    access.models.map((model) => `${model.providerId}\u0000${model.modelId}`),
  );
  const has = (providerId: string, modelId: string): boolean =>
    present.has(`${providerId}\u0000${modelId}`);

  /** The id this entry should name now: itself, its successor, or nothing. */
  const settle = <T extends { providerId: string; modelId: string }>(entry: T): T | null => {
    if (!refreshed.has(entry.providerId) || has(entry.providerId, entry.modelId)) return entry;
    const successor = supersededModelId(entry.providerId, entry.modelId);
    if (successor !== undefined && has(entry.providerId, successor)) {
      return { ...entry, modelId: successor };
    }
    return null;
  };

  const defaults = readModelAccessDefaults(db);
  const repaired: ModelAccessDefaults = {
    global: defaults.global === null ? null : settle(defaults.global),
    ticket: defaults.ticket === null ? null : settle(defaults.ticket),
    utility: defaults.utility === null ? null : settle(defaults.utility),
  };
  if (JSON.stringify(repaired) !== JSON.stringify(defaults)) {
    setAppState(db, MODEL_ACCESS_DEFAULTS_APP_STATE_KEY, JSON.stringify(repaired), now);
  }

  const hidden = readHiddenModels(db);
  const seen = new Set<string>();
  const kept: HiddenModelRef[] = [];
  for (const entry of hidden) {
    const settled = settle(entry);
    if (settled === null) continue;
    // Someone may have hidden a model under both its old and its new name;
    // following the rename must not leave the same row hidden twice.
    const key = `${settled.providerId}\u0000${settled.modelId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    kept.push(settled);
  }
  if (JSON.stringify(kept) !== JSON.stringify(hidden)) writeHiddenModels(db, kept, now);
}

/**
 * The compaction policy this profile has configured.
 *
 * Absent or unreadable reads as {@link DEFAULT_COMPACTION_POLICY} — compaction
 * on — because that is what every profile did before this setting existed, and
 * an update is not a reason to stop compacting. A blob written by the era that
 * stored per-model reserves still reads: the switch is taken and the retired
 * `modelLimits` beside it are ignored.
 */
export function readCompactionPolicy(db: Database.Database): CompactionPolicy {
  const stored = readAppState(db, COMPACTION_POLICY_APP_STATE_KEY);
  if (typeof stored !== "object" || stored === null) return DEFAULT_COMPACTION_POLICY;
  const candidate = stored as Record<string, unknown>;
  const autoCompaction = candidate["autoCompaction"];
  return {
    autoCompaction:
      typeof autoCompaction === "boolean"
        ? autoCompaction
        : DEFAULT_COMPACTION_POLICY.autoCompaction,
  };
}

/** Stores the whole policy: the one global switch. */
export function writeCompactionPolicy(
  db: Database.Database,
  policy: CompactionPolicy,
  now: number,
): CompactionPolicy {
  const next: CompactionPolicy = { autoCompaction: policy.autoCompaction };
  setAppState(db, COMPACTION_POLICY_APP_STATE_KEY, JSON.stringify(next), now);
  return next;
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

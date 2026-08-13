import type Database from "better-sqlite3";
import { REASONING_LEVELS, type ModelAccessSnapshot, type ModelSelection } from "@volli/shared";

import { setAppState } from "../db/app-state-repo";
import { prepared } from "../db/prepared";

export const MODEL_ACCESS_DEFAULT_APP_STATE_KEY = "volli:model-access-default";

const MAX_IDENTIFIER_LENGTH = 512;

function isIdentifier(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_IDENTIFIER_LENGTH &&
    value.trim() === value
  );
}

/** Reads the app-wide model policy used by one-click Ticket Session creation. */
export function readDefaultModelSelection(db: Database.Database): ModelSelection | null {
  const row = prepared<[string], { value: string }>(
    db,
    "SELECT value FROM app_state WHERE key = ?",
  ).get(MODEL_ACCESS_DEFAULT_APP_STATE_KEY);
  if (row === undefined) return null;

  try {
    const value: unknown = JSON.parse(row.value);
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
  } catch {
    return null;
  }
}

/** Stores only Volli's secret-free model identity and reasoning policy. */
export function writeDefaultModelSelection(
  db: Database.Database,
  selection: ModelSelection,
  now: number,
): void {
  setAppState(
    db,
    MODEL_ACCESS_DEFAULT_APP_STATE_KEY,
    JSON.stringify({
      providerId: selection.providerId,
      modelId: selection.modelId,
      reasoningLevel: selection.reasoningLevel,
    }),
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

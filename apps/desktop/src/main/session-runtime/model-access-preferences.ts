import type Database from "better-sqlite3";
import type { ModelAccessSnapshot, ModelSelection, ReasoningLevel } from "@volli/shared";

import { setAppState } from "../db/app-state-repo";
import { prepared } from "../db/prepared";

export const MODEL_ACCESS_DEFAULT_APP_STATE_KEY = "volli:model-access-default";

const REASONING_LEVELS = new Set<ReasoningLevel>([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);
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
    if (
      !isIdentifier(providerId) ||
      !isIdentifier(modelId) ||
      typeof reasoningLevel !== "string" ||
      !REASONING_LEVELS.has(reasoningLevel as ReasoningLevel)
    ) {
      return null;
    }
    return { providerId, modelId, reasoningLevel: reasoningLevel as ReasoningLevel };
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

/** Refuses silent repair while allowing an explicit choice that still needs sign-in. */
export function assertDefaultModelAvailable(
  access: ModelAccessSnapshot,
  selection: ModelSelection,
): void {
  const model = access.models.find(
    (candidate) =>
      candidate.providerId === selection.providerId && candidate.modelId === selection.modelId,
  );
  if (model === undefined || model.state === "unavailable") {
    throw new Error("This model is not currently available.");
  }
  if (!model.reasoningLevels.includes(selection.reasoningLevel)) {
    throw new Error("This reasoning level is not supported by the selected model.");
  }
}

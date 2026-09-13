/** Durable editor drafts, isolated by project and saved-record id. New-record
 * drafts occupy their project's default slot. appStateStorage supplies the same
 * synchronous cache / debounced SQLite / unload flush as the ticket composer. */
import {
  AUTOMATION_SCHEDULE_PRESETS,
  isValidAutomationRuntime,
  isTicketStatus,
  SCHEDULE_WEEKDAYS,
  type AutomationSchedule,
  type AutomationSchedulePreset,
  type ScheduleWeekday,
  type TicketStatus,
  type ValidAutomationRuntime,
} from "@volli/shared";

import { appStateStorage, type SyncStateStorage } from "@renderer/lib/app-state-storage";

/** The single app_state row that owns every project's editor draft. */
const DRAFT_KEY = "volli:automation-editor-draft";
const DRAFT_VERSION = 1;

export type AutomationOwnershipDraft = "project" | "global";
export type AutomationTriggerChoice = "none" | "columns" | "schedule";

/**
 * The editor's restorable field state, mirroring the
 * panel's `useState` fields. The schedule is stored whole (preset, fields and
 * zone together) because the panel edits it as one record.
 */
export interface AutomationEditorDraft {
  name: string;
  instructions: string;
  ownership: AutomationOwnershipDraft;
  triggerChoice: AutomationTriggerChoice;
  columns: readonly TicketStatus[];
  schedule: AutomationSchedule;
  runtime: ValidAutomationRuntime;
}

function isOwnership(value: unknown): value is AutomationOwnershipDraft {
  return value === "project" || value === "global";
}

function isTriggerChoice(value: unknown): value is AutomationTriggerChoice {
  return value === "none" || value === "columns" || value === "schedule";
}

function isSchedule(value: unknown): value is AutomationSchedule {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  if (!AUTOMATION_SCHEDULE_PRESETS.includes(candidate["preset"] as AutomationSchedulePreset)) {
    return false;
  }
  if (typeof candidate["minute"] !== "number") return false;
  if (candidate["preset"] !== "hourly" && typeof candidate["hour"] !== "number") return false;
  if (
    candidate["preset"] === "weekly" &&
    !SCHEDULE_WEEKDAYS.includes(candidate["weekday"] as ScheduleWeekday)
  ) {
    return false;
  }
  return typeof candidate["timeZone"] === "string";
}

/** Field-level shape validation for a decoded draft candidate. */
function isEditorDraft(value: unknown): value is AutomationEditorDraft {
  if (typeof value !== "object" || value === null) return false;
  const draft = value as Record<string, unknown>;
  return (
    typeof draft["name"] === "string" &&
    typeof draft["instructions"] === "string" &&
    isOwnership(draft["ownership"]) &&
    isTriggerChoice(draft["triggerChoice"]) &&
    Array.isArray(draft["columns"]) &&
    draft["columns"].every((column) => isTicketStatus(column)) &&
    isSchedule(draft["schedule"]) &&
    // `null` is the inherit answer; anything else must be a runtime the
    // shared rule would still accept on read-back. A slot with NO runtime
    // field at all is not a shape this version wrote — reject it too.
    draft["runtime"] !== undefined &&
    isValidAutomationRuntime(draft["runtime"] as AutomationEditorDraft["runtime"])
  );
}

/** Whether the draft still matches a new editor's meaningful defaults. */
export function isEmptyEditorDraft(draft: AutomationEditorDraft): boolean {
  return (
    draft.name.trim() === "" &&
    draft.instructions.trim() === "" &&
    draft.ownership === "project" &&
    draft.triggerChoice === "none" &&
    draft.runtime === null
  );
}

function readDrafts(storage: SyncStateStorage): Record<string, AutomationEditorDraft> {
  const raw = storage.getItem(DRAFT_KEY);
  if (raw === null) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (typeof parsed !== "object" || parsed === null) return {};
  const envelope = parsed as Record<string, unknown>;
  if (envelope["version"] !== DRAFT_VERSION) return {};
  const drafts = envelope["drafts"];
  if (typeof drafts !== "object" || drafts === null) return {};
  const kept: Record<string, AutomationEditorDraft> = Object.create(null);
  for (const [projectId, candidate] of Object.entries(drafts)) {
    if (isEditorDraft(candidate)) kept[projectId] = candidate;
  }
  return kept;
}

/** New and saved-record slots cannot collide, even across projects. */
function slotKey(projectId: string, automationId: string | null): string {
  return automationId === null ? projectId : JSON.stringify([projectId, automationId]);
}

/** Empty new drafts are absent; emptied edits remain recoverable until discard. */
export function loadEditorDraft(
  projectId: string,
  storage: SyncStateStorage = appStateStorage,
  automationId: string | null = null,
): AutomationEditorDraft | null {
  const drafts = readDrafts(storage);
  const key = slotKey(projectId, automationId);
  const draft = Object.hasOwn(drafts, key) ? drafts[key]! : null;
  return draft !== null && automationId === null && isEmptyEditorDraft(draft) ? null : draft;
}

/** Persist one draft. Erasing a new draft clears it; a saved record's empty
 * edit is still unsaved work and must survive a navigation too. */
export function saveEditorDraft(
  projectId: string,
  draft: AutomationEditorDraft,
  storage: SyncStateStorage = appStateStorage,
  automationId: string | null = null,
): void {
  const drafts = readDrafts(storage);
  const key = slotKey(projectId, automationId);
  if (automationId === null && isEmptyEditorDraft(draft)) {
    if (drafts[key] === undefined) return;
    delete drafts[key];
  } else {
    drafts[key] = draft;
  }
  if (Object.keys(drafts).length === 0) {
    storage.removeItem(DRAFT_KEY);
    return;
  }
  storage.setItem(DRAFT_KEY, JSON.stringify({ version: DRAFT_VERSION, drafts }));
}

/** Consume or explicitly discard one slot, leaving every other draft intact. */
export function clearEditorDraft(
  projectId: string,
  storage: SyncStateStorage = appStateStorage,
  automationId: string | null = null,
): void {
  const drafts = readDrafts(storage);
  const key = slotKey(projectId, automationId);
  if (drafts[key] === undefined) return;
  delete drafts[key];
  if (Object.keys(drafts).length === 0) {
    storage.removeItem(DRAFT_KEY);
    return;
  }
  storage.setItem(DRAFT_KEY, JSON.stringify({ version: DRAFT_VERSION, drafts }));
}

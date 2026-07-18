/**
 * The composer's draft cache — Linear-style implicit save of in-progress work,
 * so an accidental Escape / overlay click / app quit never destroys what was
 * typed. The full field state is written through {@link appStateStorage} (the
 * SQLite-backed `app_state` kv layer: synchronous cache reads, debounced
 * write-through, `beforeunload` flush) on every change; any close keeps it, the
 * next open restores it, and a successful create clears it.
 *
 * A draft only exists when there's CONTENT to protect (title, body, or labels)
 * — chip-only fiddling (status/priority/worktree/project) is not worth
 * restoring and would just surprise on the next open, so {@link saveDraft}
 * treats it as "no draft". Loading is defensive: any malformed or
 * wrong-version envelope reads as "no draft" rather than throwing (the value
 * crossed a persistence boundary; trust nothing).
 */
import {
  isTicketPriority,
  isTicketStatus,
  type TicketPriority,
  type TicketStatus,
} from "@volli/shared";

import { appStateStorage, type SyncStateStorage } from "@renderer/lib/app-state-storage";

/** The composer's restorable field state, mirroring its useState fields. */
export interface ComposerDraft {
  /** Target project id — revalidated against live projects on restore (the caller's job). */
  projectId: string;
  status: TicketStatus;
  priority: TicketPriority;
  title: string;
  body: string;
  labels: string[];
  usesWorktree: boolean;
}

const DRAFT_KEY = "volli:new-ticket-draft";
const DRAFT_VERSION = 1;

/** Whether the draft carries no content worth protecting (see module doc). */
export function isEmptyDraft(draft: ComposerDraft): boolean {
  return draft.title.trim() === "" && draft.body.trim() === "" && draft.labels.length === 0;
}

/**
 * Persist `draft`, or clear the slot when it's {@link isEmptyDraft} — so
 * erasing your fields IS discarding the draft, and a blank composer never
 * leaves a stale envelope behind.
 */
export function saveDraft(draft: ComposerDraft, storage: SyncStateStorage = appStateStorage): void {
  if (isEmptyDraft(draft)) {
    storage.removeItem(DRAFT_KEY);
    return;
  }
  storage.setItem(DRAFT_KEY, JSON.stringify({ version: DRAFT_VERSION, draft }));
}

/** Drop the stored draft (a successful create consumed it). */
export function clearDraft(storage: SyncStateStorage = appStateStorage): void {
  storage.removeItem(DRAFT_KEY);
}

/** Field-level shape validation for a decoded draft candidate. */
function isComposerDraft(value: unknown): value is ComposerDraft {
  if (typeof value !== "object" || value === null) return false;
  const draft = value as Record<string, unknown>;
  return (
    typeof draft["projectId"] === "string" &&
    isTicketStatus(draft["status"]) &&
    isTicketPriority(draft["priority"]) &&
    typeof draft["title"] === "string" &&
    typeof draft["body"] === "string" &&
    Array.isArray(draft["labels"]) &&
    draft["labels"].every((label) => typeof label === "string") &&
    typeof draft["usesWorktree"] === "boolean"
  );
}

/**
 * The stored draft, or null when none exists / it fails validation. Content-
 * empty drafts also read as null (they can only exist via legacy or hand-edited
 * rows; restoring one would be indistinguishable from a fresh composer anyway).
 */
export function loadDraft(storage: SyncStateStorage = appStateStorage): ComposerDraft | null {
  const raw = storage.getItem(DRAFT_KEY);
  if (raw === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const envelope = parsed as Record<string, unknown>;
  if (envelope["version"] !== DRAFT_VERSION || !isComposerDraft(envelope["draft"])) return null;
  return isEmptyDraft(envelope["draft"]) ? null : envelope["draft"];
}

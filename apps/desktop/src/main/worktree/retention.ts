/**
 * Retention primitives (CONCEPT #16, issue #76) — the pure computations and the
 * one mutating composition the merge-watch and its IPC surface build on. This
 * file holds NO polling and NO timers (those live in `watch.ts`); it is the
 * dependency-light core:
 *
 *  - the global Done-TTL setting, stored in `app_state` (the existing kv the
 *    ui/workspace persist stores already use);
 *  - `doneEntryTimestamp`, the event-log read that dates a ticket's LATEST entry
 *    into the Done column — the anchor the TTL counts from;
 *  - `computeArchiveReadiness`, the pure verdict (merge vs TTL vs neither) with
 *    the Keep-pin and dismissal exemptions folded in — the one place the
 *    Vibe-Kanban bug (a TTL sweep that ignores its own pin) is forbidden;
 *  - `archiveAndClean`, the human-disposes composition: it reuses `remove`
 *    (dirty ALWAYS refuses via the shared refusal contract) and the existing
 *    archive path, adding no new git call site (decision #42).
 */
import type Database from "better-sqlite3";
import type { TicketEventActor, TicketEventPayload, TicketStatus } from "@volli/shared";

import { getAllAppState, setAppState } from "../db/app-state-repo";
import { prepared } from "../db/prepared";
import { getTicketRow } from "../db/tickets-repo";
import { archiveTicketCommand } from "../ticket-commands";
import { remove } from "./remove";
import { err, ok, type WorktreeDeps, type WorktreeResult } from "./types";

/** The `app_state` key the retention settings JSON lives under. */
export const RETENTION_SETTINGS_KEY = "volli:retention";
/** Done-TTL default: 14 days from the ticket's Done entry (settled 2026-07-21). */
export const DEFAULT_RETENTION_TTL_DAYS = 14;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** The retention settings blob persisted under {@link RETENTION_SETTINGS_KEY}. */
interface RetentionSettings {
  ttlDays: number;
}

/**
 * The Done-TTL in days. Reads the `app_state` blob, falling back to
 * {@link DEFAULT_RETENTION_TTL_DAYS} when unset or unparseable (a corrupt
 * setting must never silently disable retention or invent a wild TTL).
 */
export function getRetentionTtlDays(db: Database.Database): number {
  const raw = getAllAppState(db)[RETENTION_SETTINGS_KEY];
  if (raw === undefined) return DEFAULT_RETENTION_TTL_DAYS;
  try {
    const parsed = JSON.parse(raw) as Partial<RetentionSettings>;
    const days = parsed.ttlDays;
    return typeof days === "number" && Number.isFinite(days) && days >= 1
      ? Math.floor(days)
      : DEFAULT_RETENTION_TTL_DAYS;
  } catch {
    return DEFAULT_RETENTION_TTL_DAYS;
  }
}

/**
 * Persists the Done-TTL (clamped to a minimum of 1 day — a zero/negative TTL
 * would archive a ticket the instant it entered Done). Returns the stored value.
 */
export function setRetentionTtlDays(db: Database.Database, days: number, now: number): number {
  const clamped = Number.isFinite(days) && days >= 1 ? Math.floor(days) : 1;
  const blob: RetentionSettings = { ttlDays: clamped };
  setAppState(db, RETENTION_SETTINGS_KEY, JSON.stringify(blob), now);
  return clamped;
}

/** The TTL in milliseconds, for the readiness clock arithmetic. */
export function retentionTtlMs(db: Database.Database): number {
  return getRetentionTtlDays(db) * MS_PER_DAY;
}

/**
 * The timestamp (epoch ms) of the ticket's most recent entry INTO the Done
 * column — a `status_changed { to: "done" }` event, or a `created { status:
 * "done" }` for a ticket born in Done. `null` when the log records neither (the
 * TTL then has no anchor and never fires). Scans newest-first so a ticket that
 * bounced out of and back into Done counts from the LATEST entry.
 */
export function doneEntryTimestamp(db: Database.Database, ticketId: string): number | null {
  const rows = prepared<[string], { payload: string; created_at: number }>(
    db,
    `SELECT payload, created_at FROM ticket_events
       WHERE ticket_id = ? AND kind IN ('status_changed', 'created')
       ORDER BY created_at DESC, rowid DESC`,
  ).all(ticketId);
  for (const row of rows) {
    let payload: TicketEventPayload;
    try {
      payload = JSON.parse(row.payload) as TicketEventPayload;
    } catch {
      continue;
    }
    if (payload.kind === "status_changed" && payload.to === "done") return row.created_at;
    if (payload.kind === "created" && payload.status === "done") return row.created_at;
  }
  return null;
}

/** Why a ticket is archive-ready — drives the prompt copy. */
export type RetentionReason = "pr-merged" | "ttl-expired";

/** The inputs the readiness verdict is a pure function of. */
export interface ArchiveReadinessInput {
  status: TicketStatus;
  /** The durable Keep pin — exempts BOTH paths. */
  keep: boolean;
  /** In-memory, launch-scoped dismissal of the prompt (suppresses, doesn't exempt). */
  dismissed: boolean;
  /** The watched PR's state, or `null` when the ticket has no PR. */
  prState: "open" | "merged" | "closed" | null;
  /** Epoch ms the ticket entered Done, or `null` when unknown. */
  doneEntryAt: number | null;
  now: number;
  ttlMs: number;
}

/** The readiness verdict: whether to prompt, and the underlying reason. */
export interface ArchiveReadiness {
  archiveReady: boolean;
  reason: RetentionReason | null;
}

/**
 * The pure retention verdict. Precedence:
 *  1. Keep pin — a HARD exemption from both paths (`reason: null`). This is the
 *     Vibe-Kanban anti-pattern encoded as a guarantee: their TTL sweep ignores
 *     its own pin; ours must not, so the pin short-circuits before any path.
 *  2. Merge path — a MERGED PR is archive-ready in any column.
 *  3. TTL path — a Done ticket with NO open PR (an open PR waits for its merge,
 *     never a TTL) whose Done entry is at least `ttlMs` old.
 * `archiveReady` is the reason being met AND not dismissed; `reason` still
 * reports the met condition when dismissed, so the surface can explain itself.
 */
export function computeArchiveReadiness(input: ArchiveReadinessInput): ArchiveReadiness {
  if (input.keep) return { archiveReady: false, reason: null };

  let reason: RetentionReason | null = null;
  if (input.prState === "merged") {
    reason = "pr-merged";
  } else if (
    input.status === "done" &&
    input.prState !== "open" &&
    input.doneEntryAt !== null &&
    input.now - input.doneEntryAt >= input.ttlMs
  ) {
    reason = "ttl-expired";
  }
  return { archiveReady: reason !== null && !input.dismissed, reason };
}

// The archive here is a human-disposed affordance (the UI's "Archive & clean"),
// so its `archived` event is attributed to the user — matching volli:ticket-archive.
const USER_ACTOR: TicketEventActor = { kind: "user" };

/**
 * Archive-and-clean (issue #76): the ONE composition that removes a retained
 * worktree. Order matters — the worktree is removed FIRST (through `remove`,
 * so a DIRTY tree refuses via {@link
 * import("@volli/shared").WORKTREE_DIRTY_REFUSAL_PREFIX} and the whole action
 * aborts, leaving the card on the board to resolve), and only once the checkout
 * is safely gone is the ticket archived (reversible; branch, `pr_url`, and the
 * event log all survive — #16). Never auto-invoked; the retention watch only
 * ever PROMPTS, the human disposes.
 */
export async function archiveAndClean(
  deps: WorktreeDeps,
  ticketId: string,
): Promise<WorktreeResult<void>> {
  const ticket = getTicketRow(deps.db, ticketId);
  if (!ticket) return err("Unknown ticket");

  // Dirty ALWAYS refuses (force: false); a stale-clean confirmation is re-checked
  // inside `remove` right before deletion. A missing/absent worktree is a no-op
  // there, so a PR-less TTL ticket that never had one still archives cleanly.
  const removed = await remove(deps, ticketId, { force: false });
  if (!removed.ok) return removed;

  archiveTicketCommand(deps.db, ticketId, { now: Date.now(), actor: USER_ACTOR });
  return ok(undefined);
}

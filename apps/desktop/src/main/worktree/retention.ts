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
 *  - `computeArchiveReadiness` (re-exported from `@volli/shared` — it's pure
 *    and dependency-free, so it lives there), the verdict (merge vs TTL vs
 *    neither) with the Keep-pin and dismissal exemptions folded in — the one
 *    place the Vibe-Kanban bug (a TTL sweep that ignores its own pin) is
 *    forbidden;
 *  - `archiveAndClean`, the human-disposes composition: it reuses `remove`
 *    (dirty ALWAYS refuses via the shared refusal contract) and the existing
 *    archive path, adding no new git call site (decision #42).
 */
import { existsSync } from "node:fs";
import type Database from "better-sqlite3";
import {
  computeWorktreeReclaim,
  type TicketEventActor,
  type TicketEventPayload,
  type TicketStatus,
} from "@volli/shared";

import { getAllAppState, setAppState } from "../db/app-state-repo";
import { recordTicketEvent } from "../db/events-repo";
import { prepared } from "../db/prepared";
import { getTicketRow } from "../db/tickets-repo";
import { archiveTicketCommand } from "../ticket-commands";
import type { AgentSiteReleaseReport } from "./agent-sites";
import { remove, type WorktreeRemoveOptions } from "./remove";
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
  // `.iterate()` (not `.all()`) so a ticket with a long event log stops at the
  // FIRST matching row instead of materializing and JSON-parsing every
  // status_changed/created event it ever had — this runs once per ticket per
  // `volli:retention-state` call (K3), so the per-row cost compounds.
  const rows = prepared<[string], { payload: string; created_at: number }>(
    db,
    `SELECT payload, created_at FROM ticket_events
       WHERE ticket_id = ? AND kind IN ('status_changed', 'created')
       ORDER BY created_at DESC, rowid DESC`,
  ).iterate(ticketId);
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

/**
 * The archive-readiness verdict is pure and dependency-free, so it lives in
 * `@volli/shared` (K2) alongside the repo's other pure domain logic; this
 * re-export keeps every existing importer (the merge-watch, its IPC surface,
 * this module's own `archiveAndClean`) working unchanged.
 */
export {
  computeArchiveReadiness,
  type ArchiveReadiness,
  type ArchiveReadinessInput,
} from "@volli/shared";
// `RetentionReason` moved to `@volli/shared` alongside it; nothing in this file
// uses the type directly (it only appears inside `ArchiveReadiness`, re-exported
// above), so no import is needed here.

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
  opts: Pick<WorktreeRemoveOptions, "releaseAgentSites"> = {},
): Promise<WorktreeResult<void>> {
  const ticket = getTicketRow(deps.db, ticketId);
  if (!ticket) return err("Unknown ticket");

  // Dirty ALWAYS refuses (force: false); a stale-clean confirmation is re-checked
  // inside `remove` right before deletion. A missing/absent worktree is a no-op
  // there, so a PR-less TTL ticket that never had one still archives cleanly.
  // `remove` also ends the bindings rooted in the checkout — the same act on
  // this path as on the manual one, because it is the same delete.
  const removed = await remove(deps, ticketId, { ...opts, force: false });
  if (!removed.ok) return removed;

  archiveTicketCommand(deps.db, ticketId, { now: Date.now(), actor: USER_ACTOR });
  return ok(undefined);
}

// ---- reclaim (VC-113) ------------------------------------------------------

/** System-driven, no session: the reclaim is attributed to automation. */
const AUTOMATION_ACTOR: TicketEventActor = { kind: "automation" };

/** The seams {@link reclaimIfStale} needs beyond the worktree bundle. */
export interface ReclaimDeps {
  worktree: WorktreeDeps;
  now: () => number;
  /** Ends the bindings rooted in the checkout, exactly as the manual remove does. */
  releaseAgentSites?: (directory: string) => Promise<AgentSiteReleaseReport>;
  /** Where work is genuinely in flight; a busy directory is never reclaimed. */
  busyWorktreeSites?: (target: string) => Promise<readonly { directory: string }[]>;
}

/** Why a reclaim did or didn't happen — the caller logs/notifies off this. */
export type ReclaimOutcome =
  | { kind: "reclaimed"; branch: string | null; daysInDone: number }
  | { kind: "skipped"; reason: string };

const SKIP = (reason: string): ReclaimOutcome => ({ kind: "skipped", reason });

/**
 * The DURATION gate on automatic worktree removal (VC-113).
 *
 * The bug this answers is not that Volli reclaimed disk; it is WHEN. A branch
 * becomes "clean" the instant it is pushed — which is the instant a PR opens —
 * so cleanliness alone made a checkout disposable at the exact moment its
 * review started, and the review is precisely when a person comes back to it to
 * make the small fix the PR earned. Time is the honest signal instead: a ticket
 * that has sat in Done for the whole retention window, with nothing uncommitted
 * in it and no PR still open, is finished in the way that matters.
 *
 * What it takes is the DIRECTORY and nothing else. The ticket stays on the
 * board, the branch stays in git with every commit on it, `pr_url` stays
 * stamped, and `worktree-recreate` puts the checkout back on that branch on
 * demand. That is why this may run unattended where an archive may not: it is a
 * cache eviction, and every part of it is undoable.
 *
 * Every gate below is a refusal, in the order that costs least to answer, and
 * the removal itself goes through `remove(force: false)` — so the dirty
 * predicate is re-run immediately before deletion and ANY uncommitted work,
 * mid-flight rebase, lock, or unreadable git aborts the whole thing.
 */
export async function reclaimIfStale(
  deps: ReclaimDeps,
  ticketId: string,
  prState: "open" | "merged" | "closed" | null,
): Promise<ReclaimOutcome> {
  const db = deps.worktree.db;
  const ticket = getTicketRow(db, ticketId);
  if (!ticket) return SKIP("unknown ticket");
  if (ticket.worktree_path === null) return SKIP("no worktree");
  // Already gone from disk: leave the stamp alone. Clearing it here would race
  // the recreate path and cost the ticket the only pointer it has left.
  if (!existsSync(ticket.worktree_path)) return SKIP("worktree already missing");
  if (ticket.retention_keep !== 0) return SKIP("kept");

  const doneEntryAt = doneEntryTimestamp(db, ticketId);
  const ttlMs = retentionTtlMs(db);
  const now = deps.now();
  // The pure verdict (@volli/shared): dwell alone, never a merge — see
  // `computeWorktreeReclaim` for why those are different questions.
  const verdict = computeWorktreeReclaim({
    status: ticket.status as TicketStatus,
    keep: false, // the Keep pin is checked above, before any of this costs a read
    prUrl: ticket.pr_url,
    prState,
    doneEntryAt,
    now,
    ttlMs,
  });
  if (!verdict.reclaim) return SKIP("not stale enough");

  const busy = (await deps.busyWorktreeSites?.(ticket.worktree_path)) ?? [];
  if (busy.length > 0) return SKIP("work in flight");

  const removed = await remove(deps.worktree, ticketId, {
    force: false,
    releaseAgentSites: deps.releaseAgentSites,
  });
  if (!removed.ok) return SKIP(removed.error);

  const daysInDone =
    doneEntryAt === null ? 0 : Math.floor((now - doneEntryAt) / (24 * 60 * 60 * 1000));
  recordTicketEvent(
    db,
    ticketId,
    { kind: "worktree_reclaimed", branch: ticket.branch, daysInDone },
    now,
    AUTOMATION_ACTOR,
  );
  return { kind: "reclaimed", branch: ticket.branch, daysInDone };
}

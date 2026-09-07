/**
 * The durable cleanup history (VC-284).
 *
 * The audit's fourth finding: the orphan report lived in one process-local
 * promise, so every removal the app made was forgotten the moment it quit — a
 * run interrupted halfway left nothing behind saying which directories were
 * already gone, and the Storage list labelled every removed row "Removed at
 * launch" whoever had asked for it. A destructive act with no record is
 * indistinguishable from work going missing.
 *
 * So a run is written BEFORE its first change and updated after every item.
 * Storage in `app_state` rather than a new table, for the same reason the
 * retention setting lives there: this is a small, bounded, app-wide blob (ten
 * runs), and a schema migration buys nothing a JSON row does not.
 *
 * Everything here is defensive on read. A corrupt blob answers "no history"
 * instead of throwing into a launch path — the history is evidence about the
 * past, and losing it must never cost the app its start.
 */
import type Database from "better-sqlite3";

import type { OrphanCleanupItem, OrphanCleanupRun } from "../../ipc/contract";
import { getAppState, setAppState } from "../db/app-state-repo";

/** The `app_state` key the cleanup history lives under. */
export const CLEANUP_RUNS_KEY = "volli:worktree-cleanup-runs";

/**
 * How many runs are kept, newest first. Enough that a person can still find the
 * launch where a directory disappeared; bounded so one `app_state` row can
 * never grow without limit.
 */
export const MAX_CLEANUP_RUNS = 10;

const ITEM_STATUSES = new Set(["pending", "completed", "skipped", "failed"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A stored item, or `null` when the blob has been tampered with or predates a field. */
function parseItem(value: unknown): OrphanCleanupItem | null {
  if (!isRecord(value)) return null;
  const { kind, path, projectId, branch, status, detail, finishedAt } = value;
  if (kind !== "worktree" && kind !== "metadata") return null;
  if (typeof path !== "string") return null;
  if (typeof status !== "string" || !ITEM_STATUSES.has(status)) return null;
  return {
    kind,
    path,
    projectId: typeof projectId === "string" ? projectId : null,
    branch: typeof branch === "string" ? branch : null,
    status: status as OrphanCleanupItem["status"],
    detail: typeof detail === "string" ? detail : null,
    finishedAt: typeof finishedAt === "number" ? finishedAt : null,
  };
}

function parseRun(value: unknown): OrphanCleanupRun | null {
  if (!isRecord(value)) return null;
  const { id, source, startedAt, finishedAt, interruptedAt, preservation, items } = value;
  if (typeof id !== "string" || typeof startedAt !== "number") return null;
  if (source !== "settings" && source !== "startup") return null;
  if (!Array.isArray(items)) return null;
  const parsedItems = items
    .map(parseItem)
    .filter((item): item is OrphanCleanupItem => item !== null);
  return {
    id,
    source,
    startedAt,
    finishedAt: typeof finishedAt === "number" ? finishedAt : null,
    interruptedAt: typeof interruptedAt === "number" ? interruptedAt : null,
    preservation: Array.isArray(preservation)
      ? preservation.filter((rule): rule is string => typeof rule === "string")
      : [],
    items: parsedItems,
  };
}

/** Every recorded cleanup run, newest first. A missing or unreadable blob is no history. */
export function readCleanupRuns(db: Database.Database): OrphanCleanupRun[] {
  const raw = getAppState(db, CLEANUP_RUNS_KEY);
  if (raw === undefined) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!isRecord(parsed) || !Array.isArray(parsed["runs"])) return [];
  return parsed["runs"].map(parseRun).filter((run): run is OrphanCleanupRun => run !== null);
}

function writeCleanupRuns(db: Database.Database, runs: OrphanCleanupRun[], now: number): void {
  setAppState(db, CLEANUP_RUNS_KEY, JSON.stringify({ runs: runs.slice(0, MAX_CLEANUP_RUNS) }), now);
}

/**
 * Upserts one run by id and puts it at the head of the history. Called once per
 * item during a cleanup, which is what makes an interrupted run legible: the
 * last write to land is the truth about how far it got.
 */
export function saveCleanupRun(db: Database.Database, run: OrphanCleanupRun, now: number): void {
  const rest = readCleanupRuns(db).filter((entry) => entry.id !== run.id);
  writeCleanupRuns(db, [run, ...rest], now);
}

/**
 * Marks every still-open run as interrupted, and answers with the ones this
 * call stamped. Run once per launch: a run with no `finishedAt` is one the app
 * did not live long enough to close, and the stamp is what lets Storage say so
 * without rewriting a single item — completed items stay completed, and the
 * items the run never reached stay `pending`, which is exactly the set a person
 * may scan again.
 */
export function reconcileInterruptedCleanupRuns(
  db: Database.Database,
  now: number,
): OrphanCleanupRun[] {
  const next = readCleanupRuns(db);
  const stamped: OrphanCleanupRun[] = [];
  for (const run of next) {
    if (run.finishedAt !== null || run.interruptedAt !== null) continue;
    // In place: `readCleanupRuns` already parsed a fresh object graph out of
    // the stored JSON, so there is nothing here anyone else is holding.
    run.interruptedAt = now;
    stamped.push(run);
  }
  if (stamped.length > 0) writeCleanupRuns(db, next, now);
  return stamped;
}

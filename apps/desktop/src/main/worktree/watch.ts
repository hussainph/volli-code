/**
 * The retention merge-watch (CONCEPT #16, issue #76): the background poll that
 * watches each worktree ticket's PR and computes its transient retention state.
 * Structured as the codebase's other sweeps are — a PURE, injected poll STEP
 * ({@link pollRetention}) plus a thin start/stop interval DRIVER
 * ({@link RetentionWatcher}) following `park.ts`'s pattern, with env-var timing
 * overrides. The step performs the poll's side effects (stamp a discovered
 * `pr_url`, record `pr_opened`/`pr_merged`, fire the single merge notification)
 * through injected seams — a real DB, an injected {@link RunNet}, an injected
 * clock, and injected `notify`/`onChange` callbacks — so the whole thing is
 * unit-tested with the scripted fakes, never real network or timers.
 *
 * Everything the watch surfaces except the Keep pin is TRANSIENT (decision #42):
 * the module holds the last PR observation per ticket; readiness, keep, and
 * dismissal are (re)computed on read against the live DB and clock, so toggling
 * Keep or dismissing takes effect immediately, without waiting for a poll. A
 * background READ failure is silent (a read is not a mutation — no toasts).
 */
import { existsSync } from "node:fs";
import type Database from "better-sqlite3";
import type { TicketEventActor, TicketStatus } from "@volli/shared";
import type { PrCheck, TicketRetentionState } from "../../ipc/contract";

import { recordTicketEvent } from "../db/events-repo";
import { getProjectById } from "../db/projects-repo";
import { prepared } from "../db/prepared";
import { listRetentionCandidates, updateTicketFields, type TicketRow } from "../db/tickets-repo";
import { ghDiscoverPr, ghPrStatus, type RunNet } from "./net";
import {
  computeArchiveReadiness,
  doneEntryTimestamp,
  reclaimIfStale,
  retentionTtlMs,
  type ReclaimDeps,
} from "./retention";

export type { TicketRetentionState } from "../../ipc/contract";

/** System-level automation (no session): stamps and merge events are attributed here. */
const AUTOMATION_ACTOR: TicketEventActor = { kind: "automation" };

// --- config -----------------------------------------------------------------

/** Poll cadence: 60s (settled 2026-07-21). */
export const RETENTION_POLL_INTERVAL_MS = 60_000;
/** Exponential-backoff ceiling: ~15 min. */
export const RETENTION_MAX_BACKOFF_MS = 15 * 60_000;

/** The watch's tunables — derived once from the environment. */
export interface RetentionWatchConfig {
  intervalMs: number;
  maxBackoffMs: number;
}

/** Parses a positive-int env string, falling back on absent/invalid/non-positive values. */
function positiveIntFromEnv(value: string | undefined, fallback: number): number {
  if (value === undefined || !/^\d+$/.test(value)) return fallback;
  const parsed = Number.parseInt(value, 10);
  return parsed > 0 ? parsed : fallback;
}

/**
 * Builds the watch config from the environment. `VOLLI_RETENTION_INTERVAL_MS` /
 * `VOLLI_RETENTION_MAX_BACKOFF_MS` override the timings (positive-int strings
 * only) so the e2e smokes can poll fast. Pure.
 */
export function retentionConfigFromEnv(env: NodeJS.ProcessEnv): RetentionWatchConfig {
  return {
    intervalMs: positiveIntFromEnv(env["VOLLI_RETENTION_INTERVAL_MS"], RETENTION_POLL_INTERVAL_MS),
    maxBackoffMs: positiveIntFromEnv(
      env["VOLLI_RETENTION_MAX_BACKOFF_MS"],
      RETENTION_MAX_BACKOFF_MS,
    ),
  };
}

/**
 * The delay before the next poll given `failures` consecutive failed cycles:
 * the base interval when healthy, else `interval * 2^failures` capped at
 * `maxBackoffMs` (the T3 backoff pattern — a `gh`-not-installed / offline run
 * must not hammer the CLI every 60s). Pure.
 */
export function nextBackoffDelay(failures: number, config: RetentionWatchConfig): number {
  if (failures <= 0) return config.intervalMs;
  const scaled = config.intervalMs * 2 ** failures;
  return Math.min(scaled, config.maxBackoffMs);
}

// --- store ------------------------------------------------------------------

/** The last PR observation for a ticket (everything readiness is computed from). */
interface RetentionObservation {
  prUrl: string | null;
  prState: "open" | "merged" | "closed" | null;
  hasConflicts: boolean;
  /** The PR's whole check rollup as of this poll (VC-182); empty when it has none. */
  checks: PrCheck[];
}

/**
 * The watch's module-resident transient state. `observations` holds the last
 * poll's PR read per ticket; `notifiedMerged` dedups the one-shot merge event +
 * notification; `dismissed` is the launch-scoped prompt suppression. All rebuilt
 * from scratch on launch — nothing here is persisted.
 */
export interface RetentionStore {
  observations: Map<string, RetentionObservation>;
  notifiedMerged: Set<string>;
  dismissed: Set<string>;
}

export function createRetentionStore(): RetentionStore {
  return { observations: new Map(), notifiedMerged: new Set(), dismissed: new Set() };
}

// --- poll deps + step -------------------------------------------------------

/** The poll step's injected seams — DB, network, clock, and notify/broadcast callbacks. */
export interface RetentionPollDeps {
  db: Database.Database;
  net: RunNet;
  /** Injected clock (never `Date.now()` inline) — the TTL and readiness read it. */
  now: () => number;
  /** Fires the single native "PR merged" notification. */
  notify: (title: string, body: string) => void;
  /** Broadcast seam (wired to `broadcastDataChanged`) — called once when any observation changed. */
  onChange?: () => void;
  /**
   * The duration-gated worktree reclaim (VC-113). Absent — in tests, and in any
   * degraded boot that could not build the worktree seams — means the poll stays
   * the pure read it has always been: nothing is deleted, the prompts still
   * appear, and the only thing lost is the automatic disk reclaim.
   */
  reclaim?: ReclaimDeps;
}

/** The poll cycle's outcome — the driver reads it to update backoff and broadcast. */
export interface PollResult {
  /** At least one observation was created or changed (the driver broadcasts). */
  changed: boolean;
  /** How many `gh` reads were attempted this cycle. */
  attempted: number;
  /** How many of those failed (a wholly-failed cycle drives backoff). */
  failed: number;
}

/** Whether a `pr_merged` event already exists for the ticket (durable dedup across restarts). */
function hasPrMergedEvent(db: Database.Database, ticketId: string): boolean {
  const row = prepared<[string], { n: number }>(
    db,
    "SELECT COUNT(*) as n FROM ticket_events WHERE ticket_id = ? AND kind = 'pr_merged'",
  ).get(ticketId);
  return (row?.n ?? 0) > 0;
}

/**
 * True when two observations differ (drives the single broadcast per cycle).
 *
 * The rollup is compared on NAME AND STATE, not on identity or on the failing
 * subset alone: a suite going green one job at a time changes no name and no
 * count, and comparing only counts would leave the rail showing "3 running"
 * until something unrelated happened to broadcast (VC-182). `url` is
 * deliberately not compared — a re-run mints a fresh `detailsUrl` for an
 * otherwise identical row, and a broadcast per poll is what the whole
 * change-detection here exists to avoid.
 */
function observationChanged(a: RetentionObservation | undefined, b: RetentionObservation): boolean {
  if (!a) return true;
  return (
    a.prUrl !== b.prUrl ||
    a.prState !== b.prState ||
    a.hasConflicts !== b.hasConflicts ||
    a.checks.length !== b.checks.length ||
    a.checks.some(
      (check, i) => check.name !== b.checks[i]?.name || check.state !== b.checks[i]?.state,
    )
  );
}

/**
 * Resolves the cwd a `gh` call runs in for a ticket: its worktree if it still
 * exists on disk, else the project checkout (the worktree may have been removed
 * on archive while the branch + `pr_url` are retained and still worth watching).
 */
function ghCwd(deps: RetentionPollDeps, ticket: TicketRow): string | null {
  if (ticket.worktree_path && existsSync(ticket.worktree_path)) return ticket.worktree_path;
  const project = getProjectById(deps.db, ticket.project_id);
  return project?.path ?? null;
}

/**
 * One poll cycle (issue #76). For every non-archived worktree/branch ticket:
 *  1. DISCOVER — a ticket with a branch but no `pr_url` runs `gh pr list`; a
 *     found PR stamps `pr_url` + records `pr_opened` (automation).
 *  2. STATUS — a ticket with a `pr_url` runs `gh pr view`; the parsed state,
 *     conflict flag, and failing checks become its observation.
 *  3. MERGE — the FIRST observation of `merged` records `pr_merged` (automation)
 *     and fires ONE native notification (deduped in-memory AND against the
 *     event log, so a restart never re-notifies).
 * A `gh` failure is counted (for backoff) and logged silently — the ticket
 * keeps its previous observation. Never throws.
 */
export async function pollRetention(
  deps: RetentionPollDeps,
  store: RetentionStore,
): Promise<PollResult> {
  const result: PollResult = { changed: false, attempted: 0, failed: 0 };

  for (const ticket of listRetentionCandidates(deps.db)) {
    // Per-ticket isolation: a throw here (SQLITE_BUSY, an FK failure on a
    // ticket deleted mid-cycle, ...) must not abort the whole candidate loop —
    // log it and move on so every OTHER ticket's discovery/status/merge still
    // runs this cycle, and `deps.onChange` still fires for whatever changed.
    try {
      const cwd = ghCwd(deps, ticket);
      if (cwd === null) continue;

      let prUrl = ticket.pr_url;
      // A PR the discovery saw but could not durably stamp (VC-113): the
      // reclaim below must read this ticket as having an UNKNOWN PR this cycle,
      // because "no PR" is exactly the verdict a failed write would fake — and
      // acting on it is a deletion, not a stale read.
      let prUnresolved = false;

      // (1) DISCOVER — adopt an agent-opened PR for a branch with no stored url.
      if (prUrl === null && ticket.branch) {
        result.attempted += 1;
        const discovered = await ghDiscoverPr(deps.net, {
          worktreePath: cwd,
          branch: ticket.branch,
        });
        if (!discovered.ok) {
          result.failed += 1;
          console.error(
            `[retention] discover failed for ${ticket.id}:`,
            discovered.failure.message,
          );
          continue;
        }
        if (discovered.value.url !== null) {
          // A durable write, isolated in its own try/catch below — a failure
          // there leaves `prUrl` null so DISCOVER simply retries next poll,
          // rather than treating a stamp we couldn't persist as adopted.
          if (stampDiscoveredPr(deps, ticket, discovered.value.url)) {
            prUrl = discovered.value.url;
            result.changed = true;
          } else {
            prUnresolved = true;
          }
        }
      }

      // No PR to watch — clear any stale observation so the state answer is
      // honest. The reclaim still runs: a Done ticket that never had a PR is
      // finished by dwell alone, and skipping it here is how the tidiest
      // tickets would have been the ones that kept their checkouts forever.
      // It does NOT run when a PR was seen this cycle but not stamped: an open
      // PR is half the reclaim question, and we have no answer for it yet.
      if (prUrl === null) {
        if (store.observations.delete(ticket.id)) result.changed = true;
        if (!prUnresolved && (await maybeReclaim(deps, ticket, null))) result.changed = true;
        continue;
      }

      // (2) STATUS — read the PR's live state.
      result.attempted += 1;
      const status = await ghPrStatus(deps.net, { worktreePath: cwd, prUrl });
      if (!status.ok) {
        result.failed += 1;
        console.error(`[retention] status failed for ${ticket.id}:`, status.failure.message);
        continue;
      }

      const observation: RetentionObservation = {
        prUrl,
        prState: status.value.state,
        hasConflicts: status.value.hasConflicts,
        checks: status.value.checks,
      };
      if (observationChanged(store.observations.get(ticket.id), observation)) result.changed = true;
      store.observations.set(ticket.id, observation);

      // (3) MERGE — the one-shot merged event + notification. `notifiedMerged`
      // is added only AFTER the event + notification succeed (or are found to
      // already exist) — never before — so a throw here (e.g. SQLITE_BUSY)
      // lands in this ticket's catch below and the ticket retries next poll
      // instead of being suppressed until an app restart.
      if (status.value.state === "merged" && !store.notifiedMerged.has(ticket.id)) {
        if (!hasPrMergedEvent(deps.db, ticket.id)) {
          recordTicketEvent(
            deps.db,
            ticket.id,
            { kind: "pr_merged", url: prUrl },
            deps.now(),
            AUTOMATION_ACTOR,
          );
          deps.notify("Pull request merged", ticket.title);
          result.changed = true;
        }
        store.notifiedMerged.add(ticket.id);
      }

      // (4) RECLAIM — the duration gate (VC-113). Runs LAST, after the PR state
      // this cycle observed is known, because "is a PR still open on it?" is
      // half the question of whether a Done ticket is finished.
      if (await maybeReclaim(deps, ticket, observation.prState)) result.changed = true;
    } catch (error) {
      console.error(`[retention] poll failed for ${ticket.id}:`, error);
    }
  }

  if (result.changed) deps.onChange?.();
  return result;
}

/**
 * The duration-gated reclaim for one ticket (VC-113), and the notification that
 * accounts for it. Every refusal is SILENT — a background pass that toasts on
 * every cycle is a background pass nobody keeps enabled — but an actual deletion
 * never is: a directory that vanishes without a word is the failure this whole
 * ticket is about. The notification says what was kept, because that is the part
 * that makes it survivable.
 *
 * Returns whether anything changed, so the caller broadcasts.
 */
async function maybeReclaim(
  deps: RetentionPollDeps,
  ticket: TicketRow,
  prState: "open" | "merged" | "closed" | null,
): Promise<boolean> {
  if (!deps.reclaim) return false;
  const outcome = await reclaimIfStale(deps.reclaim, ticket.id, prState);
  if (outcome.kind !== "reclaimed") return false;
  deps.notify(
    "Worktree removed",
    outcome.branch === null
      ? `${ticket.title}: Volli removed the folder after ${outcome.daysInDone} days in Done.`
      : `${ticket.title}: Volli removed the folder after ${outcome.daysInDone} days in Done. Branch ${outcome.branch} is kept, so you can recreate it.`,
  );
  return true;
}

/**
 * Stamps a newly-discovered PR url and records the `pr_opened` event
 * (automation). This is a durable mutation, not a background read, so it gets
 * its own try/catch (isolated from the rest of the per-ticket cycle above)
 * and surfaces a failure the same way the merge one-shot does — the native
 * notification is the only user-visible surface a background poll has (repo
 * CLAUDE.md: never silently swallow a failed mutation). The write is
 * transactional, so a failure leaves `pr_url` untouched in the DB; returning
 * `false` tells the caller not to adopt the url this cycle either, which
 * means DISCOVER naturally retries the stamp on the next poll — no separate
 * retry bookkeeping needed.
 */
function stampDiscoveredPr(deps: RetentionPollDeps, ticket: TicketRow, url: string): boolean {
  try {
    const now = deps.now();
    const write = deps.db.transaction(() => {
      updateTicketFields(deps.db, ticket.id, { prUrl: url }, now);
      recordTicketEvent(deps.db, ticket.id, { kind: "pr_opened", url }, now, AUTOMATION_ACTOR);
    });
    write();
    return true;
  } catch (error) {
    console.error(`[retention] failed to stamp discovered PR for ${ticket.id}:`, error);
    deps.notify(
      "Couldn't save discovered PR",
      `${ticket.title}: found PR ${url} but couldn't record it. Will retry.`,
    );
    return false;
  }
}

// --- composed state (read) --------------------------------------------------

const EMPTY_OBSERVATION: RetentionObservation = {
  prUrl: null,
  prState: null,
  hasConflicts: false,
  checks: [],
};

/**
 * The composed retention state for one ticket, recomputed live: the last PR
 * observation (or an empty one, seeded with the stored `pr_url`) plus the
 * current Keep pin, dismissal, and Done-TTL verdict. `null` when the ticket is
 * unknown. Recomputing readiness here (rather than caching it) means a Keep
 * toggle or dismissal is reflected instantly, between polls.
 */
export function getRetentionState(
  deps: RetentionPollDeps,
  store: RetentionStore,
  ticketId: string,
): TicketRetentionState | null {
  const ticket = prepared<[string], TicketRow>(deps.db, "SELECT * FROM tickets WHERE id = ?").get(
    ticketId,
  );
  if (!ticket) return null;

  const observation = store.observations.get(ticketId) ?? {
    ...EMPTY_OBSERVATION,
    prUrl: ticket.pr_url,
  };
  const keep = ticket.retention_keep !== 0;
  const dismissed = store.dismissed.has(ticketId);
  const readiness = computeArchiveReadiness({
    status: ticket.status as TicketStatus,
    keep,
    dismissed,
    prUrl: observation.prUrl,
    prState: observation.prState,
    doneEntryAt: doneEntryTimestamp(deps.db, ticketId),
    now: deps.now(),
    ttlMs: retentionTtlMs(deps.db),
  });

  return {
    ticketId,
    prUrl: observation.prUrl,
    prState: observation.prState,
    hasConflicts: observation.hasConflicts,
    checks: observation.checks,
    archiveReady: readiness.archiveReady,
    reason: readiness.reason,
    keep,
    dismissed,
  };
}

// --- driver -----------------------------------------------------------------

/**
 * The start/stop interval driver over {@link pollRetention} (the `park.ts`
 * pattern, but self-rescheduling with `setTimeout` so the delay can back off on
 * failure). Owns the transient {@link RetentionStore}; exposes `triggerNow`
 * (the on-focus/manual poll), the composed `getState`, and `dismiss`.
 */
export class RetentionWatcher {
  private readonly store = createRetentionStore();
  private timer: NodeJS.Timeout | null = null;
  private failures = 0;
  private running = false;
  private started = false;

  constructor(
    private readonly deps: RetentionPollDeps,
    private readonly config: RetentionWatchConfig,
  ) {}

  /** Starts the recurring poll (idempotent). The first poll runs after one interval. */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.schedule(this.config.intervalMs);
  }

  /** Stops the recurring poll. */
  stop(): void {
    this.started = false;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /** Runs a poll immediately (on window focus / manual trigger), then reschedules. */
  triggerNow(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    void this.runOnce();
  }

  /** The composed retention state for a ticket (or `null` when unknown). */
  getState(ticketId: string): TicketRetentionState | null {
    return getRetentionState(this.deps, this.store, ticketId);
  }

  /** Suppresses a ticket's Archive prompt for this launch (re-offered next launch). */
  dismiss(ticketId: string): void {
    this.store.dismissed.add(ticketId);
  }

  private schedule(delay: number): void {
    if (!this.started) return;
    // Clear any timer already pending before overwriting the field — without
    // this, a stop()-during-in-flight-poll followed by start() lets the
    // in-flight run's `finally` schedule a SECOND self-perpetuating chain
    // that stop() can no longer reach (it only clears the last-written id).
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.runOnce(), delay);
    // Never keep the process alive for a poll at quit (park.ts precedent).
    this.timer.unref();
  }

  private async runOnce(): Promise<void> {
    // A trigger that lands mid-poll is dropped; the in-flight run reschedules.
    if (this.running) return;
    this.running = true;
    try {
      const result = await pollRetention(this.deps, this.store);
      this.failures =
        result.attempted > 0 && result.failed === result.attempted ? this.failures + 1 : 0;
    } catch (error) {
      // Defensive: pollRetention already swallows per-ticket read failures, but a
      // catastrophic failure must never leave an unhandled rejection.
      console.error("[retention] poll cycle failed:", error);
      this.failures += 1;
    } finally {
      this.running = false;
      this.schedule(nextBackoffDelay(this.failures, this.config));
    }
  }
}

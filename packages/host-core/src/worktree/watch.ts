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
 *
 * ── CADENCE (VC-686) ──────────────────────────────────────────────────────
 * A host that stays on all day (the menu-bar Mac, a Linux runner) must not pay
 * for a board nobody is touching. So a cycle no longer reads every ticket: each
 * ticket carries its own read schedule. A read that saw something change, or a
 * PR whose checks are still running, is due again after the base interval; a
 * read that saw nothing new, or failed, doubles that ticket's delay, up to the
 * quiet ceiling. A ticket whose row changed (moved, re-pointed, a PR stamped)
 * is due at once, and a committed change to a ticket wakes the driver and reads
 * that ticket, so the board drives the reads rather than the clock. A person
 * looking (window focus, a manual poll) refreshes anything older than the base
 * interval. The trim backfill keeps its own per-ticket memo, so a
 * finished worktree is walked again only when its ticket changes or the memo
 * lapses, not every cycle.
 */
import { existsSync, readFileSync } from "node:fs";
import { join, resolve as resolvePath } from "node:path";
import type Database from "better-sqlite3";
import type { TicketEventActor, TicketStatus } from "@volli/shared";
import type { PrCheck, TicketRetentionState } from "@volli/shared";

import { projectFreeze } from "../cloud-move/freeze";
import { recordTicketEvent } from "../db/events-repo";
import { getProjectById } from "../db/projects-repo";
import { prepared } from "../db/prepared";
import {
  getTicketRow,
  listRetentionCandidates,
  listTrimCandidates,
  updateTicketFields,
  type TicketRow,
} from "../db/tickets-repo";
import type { NotificationRequest } from "@volli/shared";
import { ghDiscoverPr, ghPrStatus, type RunNet } from "./net";
import {
  computeArchiveReadiness,
  doneEntryTimestamp,
  reclaimIfStale,
  retentionTtlMs,
  trimFinishedWorktree,
  type ReclaimPorts,
  type TrimFinishPorts,
} from "./retention";
import { getTrimSettings } from "./trim-settings";
import { hostLogger } from "../log/root";

const log = hostLogger("worktree-watch");

export type { TicketRetentionState } from "@volli/shared";

/** System-level automation (no session): stamps and merge events are attributed here. */
const AUTOMATION_ACTOR: TicketEventActor = { kind: "automation" };

// --- config -----------------------------------------------------------------

/** Poll cadence: 60s (settled 2026-07-21). */
export const RETENTION_POLL_INTERVAL_MS = 60_000;
/** Exponential-backoff ceiling: ~15 min. */
export const RETENTION_MAX_BACKOFF_MS = 15 * 60_000;
/**
 * The ceiling a quiet ticket's read delay doubles toward (VC-686): how stale a
 * PR nobody touched may get before an unattended host looks again. A person
 * looking refreshes it sooner (see {@link RetentionPollOptions.present}).
 */
const RETENTION_QUIET_MAX_MS = 15 * 60_000;
/**
 * How long the trim backfill trusts a finished worktree it trimmed, or found
 * nothing to trim in, before walking it again with an unchanged ticket
 * (VC-686). The Done move trims on its own (`ticket-move.ts`); this pass only
 * catches what that missed, so it has no reason to walk the same clean
 * checkout every minute.
 */
const RETENTION_TRIM_RECHECK_MS = 6 * 60 * 60_000;
/** How long a burst of ticket changes is folded before the watch reads (VC-686). */
const RETENTION_CHANGE_DEBOUNCE_MS = 2_000;
/** How often the driver writes its load summary to the host log (VC-686). */
const LOAD_SUMMARY_INTERVAL_MS = 60 * 60_000;
/**
 * How long a Done ticket with no `pr_url` keeps looking for one (VC-836). A PR
 * is normally open (and stamped) long before its ticket reaches Done, so this
 * only has to outlast an agent that opened it late or a stretch offline; past
 * it, the ticket is read as having no PR without a `gh pr list` every cycle.
 */
const DONE_DISCOVERY_GRACE_MS = 7 * 24 * 60 * 60_000;

/** The watch's tunables — derived once from the environment. */
export interface RetentionWatchConfig {
  /** The base cycle, and the read delay of a ticket that is still moving. */
  intervalMs: number;
  maxBackoffMs: number;
  /** The ceiling a quiet (or failing) ticket's read delay doubles toward. */
  quietMaxMs: number;
  /** How long the trim backfill trusts a worktree it trimmed or found clean. */
  trimRecheckMs: number;
  /** How long a burst of ticket changes is folded into one cycle. */
  changeDebounceMs: number;
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
 * only) so the e2e smokes can poll fast; the cadence ceilings are fixed. Pure.
 */
export function retentionConfigFromEnv(env: NodeJS.ProcessEnv): RetentionWatchConfig {
  return {
    intervalMs: positiveIntFromEnv(env["VOLLI_RETENTION_INTERVAL_MS"], RETENTION_POLL_INTERVAL_MS),
    maxBackoffMs: positiveIntFromEnv(
      env["VOLLI_RETENTION_MAX_BACKOFF_MS"],
      RETENTION_MAX_BACKOFF_MS,
    ),
    quietMaxMs: RETENTION_QUIET_MAX_MS,
    trimRecheckMs: RETENTION_TRIM_RECHECK_MS,
    changeDebounceMs: RETENTION_CHANGE_DEBOUNCE_MS,
  };
}

/**
 * The delay before the next poll given `failures` consecutive failed cycles:
 * the base interval when healthy, else `interval * 2^failures` capped at
 * `maxBackoffMs` (the T3 backoff pattern — a `gh`-not-installed / offline run
 * must not hammer the CLI every 60s). Pure.
 */
export function nextBackoffDelay(
  failures: number,
  config: Pick<RetentionWatchConfig, "intervalMs" | "maxBackoffMs">,
): number {
  if (failures <= 0) return config.intervalMs;
  const scaled = config.intervalMs * 2 ** failures;
  return Math.min(scaled, config.maxBackoffMs);
}

/**
 * The driver's delay before the next cycle (VC-686): the failure backoff when
 * whole cycles are failing, else until the earliest ticket read falls due —
 * never sooner than the base interval and never later than the quiet ceiling
 * (the reclaim and trim answers ride the same cycle). Pure.
 */
function nextCycleDelay(
  failures: number,
  nextDueInMs: number | null,
  config: RetentionWatchConfig,
): number {
  if (failures > 0) return nextBackoffDelay(failures, config);
  const ceiling = Math.max(config.intervalMs, config.quietMaxMs);
  if (nextDueInMs === null) return ceiling;
  return Math.min(Math.max(nextDueInMs, config.intervalMs), ceiling);
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
 * One ticket's read schedule (VC-686): the row it was read against, when, and
 * when it is due again.
 */
interface ReadSchedule {
  /** {@link ticketFingerprint} of the row the last read answered. */
  fingerprint: string;
  readAt: number;
  delayMs: number;
  dueAt: number;
}

/** The trim backfill's memo for one ticket (VC-686). */
interface TrimMemo {
  /** The ticket row, Keep pin, merge flag and trim settings the last check answered. */
  key: string;
  recheckAt: number;
}

/**
 * The watch's module-resident transient state. `observations` holds the last
 * poll's PR read per ticket; `notifiedMerged` dedups the one-shot merge event +
 * notification; `dismissed` is the launch-scoped prompt suppression; `reads`
 * and `trims` are the per-ticket cadence (VC-686). All rebuilt from scratch on
 * launch — nothing here is persisted.
 */
export interface RetentionStore {
  observations: Map<string, RetentionObservation>;
  notifiedMerged: Set<string>;
  dismissed: Set<string>;
  reads: Map<string, ReadSchedule>;
  trims: Map<string, TrimMemo>;
}

export function createRetentionStore(): RetentionStore {
  return {
    observations: new Map(),
    notifiedMerged: new Set(),
    dismissed: new Set(),
    reads: new Map(),
    trims: new Map(),
  };
}

/** The timings one cycle reads and schedules by (VC-686). */
type RetentionCadence = Pick<RetentionWatchConfig, "intervalMs" | "quietMaxMs" | "trimRecheckMs">;

const DEFAULT_CADENCE: RetentionCadence = {
  intervalMs: RETENTION_POLL_INTERVAL_MS,
  quietMaxMs: RETENTION_QUIET_MAX_MS,
  trimRecheckMs: RETENTION_TRIM_RECHECK_MS,
};

/** One cycle's options. */
export interface RetentionPollOptions {
  /** Defaults to the shipped timings. */
  cadence?: RetentionCadence;
  /**
   * A person is looking (window focus, a manual poll): every ticket whose last
   * read is older than the base interval is read now, whatever its backoff.
   */
  present?: boolean;
  /** Tickets a committed change named since the last cycle: read now, whatever their backoff. */
  woken?: ReadonlySet<string>;
}

/**
 * The ticket fields a retention read depends on (VC-686): a moved, archived,
 * re-pointed or freshly stamped ticket reads as changed and is due at once. An
 * edit to anything else (title, body, labels) is not a reason to call `gh`.
 */
function ticketFingerprint(ticket: TicketRow): string {
  return [
    ticket.status,
    ticket.branch ?? "",
    ticket.pr_url ?? "",
    ticket.worktree_path ?? "",
    ticket.archived_at ?? "",
  ].join("\u0000");
}

/** Whether a ticket's PR read is due this cycle (VC-686). */
function readDue(
  store: RetentionStore,
  ticketId: string,
  fingerprint: string,
  now: number,
  options: Required<RetentionPollOptions>,
): boolean {
  if (options.woken.has(ticketId)) return true;
  const entry = store.reads.get(ticketId);
  if (entry === undefined || entry.fingerprint !== fingerprint) return true;
  // A clock stepped backwards must not stall a read by the size of the step.
  if (now >= entry.dueAt || now < entry.readAt) return true;
  return options.present && now - entry.readAt >= options.cadence.intervalMs;
}

/**
 * Schedules a ticket's next read (VC-686). After a read that saw a change, a
 * first read, a read of a changed row, or a PR still moving, it is due again
 * after the base interval. After a quiet read, or a failed one, its delay
 * doubles up to the ceiling: a ticket whose `gh` read keeps failing (a deleted
 * PR, a repository it can no longer reach) backs off on its own instead of
 * holding the driver to a one-minute wake.
 */
function scheduleRead(
  store: RetentionStore,
  ticketId: string,
  fingerprint: string,
  now: number,
  cadence: RetentionCadence,
  active: boolean,
): void {
  const previous = store.reads.get(ticketId);
  const delayMs =
    active || previous === undefined || previous.fingerprint !== fingerprint
      ? cadence.intervalMs
      : Math.min(previous.delayMs * 2, Math.max(cadence.intervalMs, cadence.quietMaxMs));
  store.reads.set(ticketId, { fingerprint, readAt: now, delayMs, dueAt: now + delayMs });
}

/** An open PR whose checks have not all settled is still moving (VC-686). */
function stillMoving(observation: RetentionObservation): boolean {
  return (
    observation.prState === "open" && observation.checks.some((check) => check.state === "pending")
  );
}

// --- poll deps + step -------------------------------------------------------

/** The poll step's injected seams — DB, network, clock, and notify/broadcast callbacks. */
export interface RetentionPollPorts {
  db: Database.Database;
  net: RunNet;
  /** Injected clock (never `Date.now()` inline) — the TTL and readiness read it. */
  now: () => number;
  /**
   * The one delivery path (VC-295). This watch posts three different alerts
   * under three different policies — a merged PR (`finished`), a reclaimed
   * worktree (`swept`), and a durable write that did not land (operational,
   * never muteable) — so it names a producer per alert rather than a title and
   * a body, and the preference is decided in one place for all three.
   */
  notify: (request: NotificationRequest) => void;
  /** Broadcast seam (wired to `broadcastDataChanged`) — called once when any observation changed. */
  onChange?: () => void;
  /**
   * The duration-gated worktree reclaim (VC-113). Absent — in tests, and in any
   * degraded boot that could not build the worktree seams — means the poll stays
   * the pure read it has always been: nothing is deleted, the prompts still
   * appear, and the only thing lost is the automatic disk reclaim.
   */
  reclaim?: ReclaimPorts;
  /**
   * The trim-on-finish pass (VC-340). Absent — in tests, and in a degraded boot
   * that could not build the worktree seams — leaves the poll exactly as it was:
   * no worktree gives up its ignored content, and nothing else changes.
   */
  trim?: TrimFinishPorts;
}

/** The poll cycle's outcome — the driver reads it to update backoff and broadcast. */
export interface PollResult {
  /** At least one observation was created or changed (the driver broadcasts). */
  changed: boolean;
  /** How many `gh` reads were attempted this cycle (one process each). */
  attempted: number;
  /** How many of those failed (a wholly-failed cycle drives backoff). */
  failed: number;
  /**
   * How many finished tickets the trim backfill asked this cycle. One that gets
   * past the cheap refusals (missing folder, Keep, trim off) costs git
   * processes and a tree walk.
   */
  trimChecks: number;
  /** Milliseconds until the earliest scheduled read falls due; `null` when none is scheduled. */
  nextDueInMs: number | null;
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
 * Whether a `pr_merged` event records THIS url merging (VC-836) — the durable
 * fact that lets a fresh launch skip a PR an earlier one already saw merge. An
 * event for a different url (the ticket's pr_url was re-pointed at a new PR)
 * says nothing about the current one, so it does not count.
 */
function hasPrMergedEventFor(db: Database.Database, ticketId: string, url: string): boolean {
  const rows = prepared<[string], { payload: string }>(
    db,
    "SELECT payload FROM ticket_events WHERE ticket_id = ? AND kind = 'pr_merged'",
  ).all(ticketId);
  return rows.some((row) => {
    try {
      return (JSON.parse(row.payload) as { url?: unknown }).url === url;
    } catch {
      return false;
    }
  });
}

/**
 * The terminal observation for a ticket's current PR, when one is already known
 * (VC-836): merged and closed PRs do not change, so re-reading them every cycle
 * only spends the user's GitHub API budget. Known from this launch's last
 * observation of the same url — a merge only once its one-shot event landed,
 * so a failed write still retries through a fresh read — or, after a restart,
 * from the durable `pr_merged` event for that url. A new `pr_url` is never
 * terminal until it is read. `null` means the PR must be polled.
 */
function knownTerminalObservation(
  deps: RetentionPollPorts,
  store: RetentionStore,
  ticketId: string,
  prUrl: string,
): RetentionObservation | null {
  const last = store.observations.get(ticketId);
  if (last !== undefined && last.prUrl === prUrl) {
    if (last.prState === "closed") return last;
    if (last.prState === "merged" && store.notifiedMerged.has(ticketId)) return last;
  }
  if (hasPrMergedEventFor(deps.db, ticketId, prUrl)) {
    return { prUrl, prState: "merged", hasConflicts: false, checks: [] };
  }
  return null;
}

/**
 * Whether a ticket with no `pr_url` should still run discovery (VC-836): any
 * ticket outside Done does, and a Done ticket does for
 * {@link DONE_DISCOVERY_GRACE_MS} after it entered Done. A Done ticket whose
 * entry the log cannot date has been there longer than anything the log
 * remembers, so it is past the grace too.
 */
function shouldDiscover(deps: RetentionPollPorts, ticket: TicketRow): boolean {
  if (ticket.status !== "done") return true;
  const doneEntryAt = doneEntryTimestamp(deps.db, ticket.id);
  return doneEntryAt !== null && deps.now() - doneEntryAt < DONE_DISCOVERY_GRACE_MS;
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
 * Whether `dir` is a git checkout `gh` can run in: a `.git` directory, or a
 * `.git` file whose `gitdir:` target still exists. An empty leftover directory
 * or a linked worktree whose admin dir was pruned fails every `gh` call with
 * "not a git repository" (VC-836).
 */
function hasUsableGit(dir: string): boolean {
  // One read, no stat first: reading a directory fails with EISDIR, which is
  // the ordinary-checkout answer, and anything else that fails is unusable.
  let gitfile: string;
  try {
    gitfile = readFileSync(join(dir, ".git"), "utf8");
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EISDIR";
  }
  const target = /^gitdir:\s*(.+?)\s*$/m.exec(gitfile)?.[1];
  return target !== undefined && existsSync(resolvePath(dir, target));
}

/**
 * Resolves the cwd a `gh` call runs in for a ticket: its worktree if it is still
 * a usable checkout, else the project checkout (the worktree may have been
 * removed on archive while the branch + `pr_url` are retained and still worth
 * watching, or left behind as a directory git no longer recognises).
 */
function ghCwd(deps: RetentionPollPorts, ticket: TicketRow): string | null {
  if (ticket.worktree_path && hasUsableGit(ticket.worktree_path)) return ticket.worktree_path;
  const project = getProjectById(deps.db, ticket.project_id);
  return project?.path ?? null;
}

/**
 * One poll cycle (issue #76). For every non-archived worktree/branch ticket:
 *  1. DISCOVER — a ticket with a branch but no `pr_url` runs `gh pr list`; a
 *     found PR stamps `pr_url` + records `pr_opened` (automation). A Done
 *     ticket stops looking after {@link DONE_DISCOVERY_GRACE_MS} (VC-836).
 *  2. STATUS — a ticket with a `pr_url` runs `gh pr view`; the parsed state,
 *     conflict flag, and failing checks become its observation. A PR already
 *     known merged or closed is not read again (VC-836): its known state feeds
 *     the reclaim and trim below with no `gh` call.
 *  3. MERGE — the FIRST observation of `merged` records `pr_merged` (automation)
 *     and fires ONE native notification (deduped in-memory AND against the
 *     event log, so a restart never re-notifies).
 * A `gh` failure is counted (for backoff) and logged silently — the ticket
 * keeps its previous observation. Never throws.
 */
export async function pollRetention(
  deps: RetentionPollPorts,
  store: RetentionStore,
  options: RetentionPollOptions = {},
): Promise<PollResult> {
  const result: PollResult = {
    changed: false,
    attempted: 0,
    failed: 0,
    trimChecks: 0,
    nextDueInMs: null,
  };
  const cycle: Required<RetentionPollOptions> = {
    cadence: options.cadence ?? DEFAULT_CADENCE,
    present: options.present ?? false,
    woken: options.woken ?? new Set(),
  };
  const now = deps.now();
  /** Tickets this cycle knows merged — finished, whatever column they are in. */
  const mergedThisCycle = new Set<string>();
  /** Every candidate this cycle saw; a schedule for anything else is dropped. */
  const seen = new Set<string>();

  for (const ticket of listRetentionCandidates(deps.db)) {
    seen.add(ticket.id);
    // A project moving to Volli Cloud takes no write, a pull request's
    // included (VC-993): its tickets are polled again once it is unfrozen.
    if (projectFreeze(deps.db, ticket.project_id) !== null) continue;
    // Per-ticket isolation: a throw here (SQLITE_BUSY, an FK failure on a
    // ticket deleted mid-cycle, ...) must not abort the whole candidate loop —
    // log it and move on so every OTHER ticket's discovery/status/merge still
    // runs this cycle, and `deps.onChange` still fires for whatever changed.
    try {
      const cwd = ghCwd(deps, ticket);
      if (cwd === null) {
        store.reads.delete(ticket.id);
        continue;
      }

      let fingerprint = ticketFingerprint(ticket);
      const due = readDue(store, ticket.id, fingerprint, now, cycle);
      let prUrl = ticket.pr_url;
      // A PR the discovery saw but could not durably stamp (VC-113): the
      // reclaim below must read this ticket as having an UNKNOWN PR this cycle,
      // because "no PR" is exactly the verdict a failed write would fake — and
      // acting on it is a deletion, not a stale read.
      let prUnresolved = false;

      // (1) DISCOVER — adopt an agent-opened PR for a branch with no stored url.
      const branch = prUrl === null ? ticket.branch : null;
      const discoverable = branch !== null && branch !== "" && shouldDiscover(deps, ticket);
      // Nothing left to discover (no branch, past the Done grace, or a PR
      // already stored): no schedule, so the driver never wakes for it.
      if (prUrl === null && !discoverable) store.reads.delete(ticket.id);
      // Not due (VC-686): the last read found no PR for this unchanged row. That
      // answer is good enough to show, but not to delete by: the reclaim below
      // waits for the cycle whose discovery is fresh.
      const staleDiscovery = discoverable && !due;
      if (discoverable && due) {
        result.attempted += 1;
        const discovered = await ghDiscoverPr(deps.net, {
          worktreePath: cwd,
          branch,
        });
        if (!discovered.ok) {
          result.failed += 1;
          log.error("pull request discovery failed", {
            ticketId: ticket.id,
            error: discovered.failure.message,
          });
          scheduleRead(store, ticket.id, fingerprint, now, cycle.cadence, false);
          continue;
        }
        if (discovered.value.url !== null) {
          // A durable write, isolated in its own try/catch below — a failure
          // there leaves `prUrl` null so DISCOVER simply retries next poll,
          // rather than treating a stamp we couldn't persist as adopted.
          if (stampDiscoveredPr(deps, ticket, discovered.value.url)) {
            prUrl = discovered.value.url;
            result.changed = true;
            // The stamp rewrote the row; schedule against what is stored now,
            // or the next cycle reads this ticket again as "changed".
            const stamped = getTicketRow(deps.db, ticket.id);
            if (stamped !== undefined) fingerprint = ticketFingerprint(stamped);
          } else {
            // Read again next interval, whatever the backoff said: the stamp
            // is what DISCOVER retries, and until it lands nothing is reclaimed.
            prUnresolved = true;
            scheduleRead(store, ticket.id, fingerprint, now, cycle.cadence, true);
          }
        } else {
          scheduleRead(store, ticket.id, fingerprint, now, cycle.cadence, false);
        }
      }

      // No PR to watch — clear any stale observation so the state answer is
      // honest. The reclaim still runs: a Done ticket that never had a PR is
      // finished by dwell alone, and skipping it here is how the tidiest
      // tickets would have been the ones that kept their checkouts forever.
      // It does NOT run when a PR was seen this cycle but not stamped: an open
      // PR is half the reclaim question, and we have no answer for it yet. Nor
      // when this cycle skipped a discovery that is still owed (VC-686): "no
      // PR" from an earlier cycle is not an answer a deletion may rest on.
      if (prUrl === null) {
        if (store.observations.delete(ticket.id)) result.changed = true;
        if (!prUnresolved && !staleDiscovery && (await maybeReclaim(deps, ticket, null))) {
          result.changed = true;
        }
        continue;
      }

      // A merged or closed PR does not change: answer from what is already
      // known instead of a fresh read (VC-836). The reclaim and the trim still
      // run, fed by that known state, so a ticket merged in an earlier launch
      // keeps its schedule without spending a `gh` call.
      const terminal = knownTerminalObservation(deps, store, ticket.id, prUrl);
      if (terminal !== null) {
        store.reads.delete(ticket.id);
        if (observationChanged(store.observations.get(ticket.id), terminal)) result.changed = true;
        store.observations.set(ticket.id, terminal);
        if (terminal.prState === "merged") {
          // Known merged means the one-shot event exists, which is exactly
          // what the dedup below would have found.
          store.notifiedMerged.add(ticket.id);
          mergedThisCycle.add(ticket.id);
        }
        if (await maybeReclaim(deps, ticket, terminal.prState)) result.changed = true;
        continue;
      }

      // Not due (VC-686): the last read of this same PR stands, and the
      // reclaim runs on it exactly as it does for a terminal PR above. A ticket
      // backing off from a failed read has no last read and waits its turn. A
      // merge whose one-shot write failed is never left waiting: it is read
      // again so the write is retried.
      const last = store.observations.get(ticket.id);
      const mergeOwed = last?.prState === "merged" && !store.notifiedMerged.has(ticket.id);
      if (!due && !mergeOwed) {
        if (last !== undefined && last.prUrl === prUrl) {
          if (await maybeReclaim(deps, ticket, last.prState)) result.changed = true;
        }
        continue;
      }

      // (2) STATUS — read the PR's live state.
      result.attempted += 1;
      const status = await ghPrStatus(deps.net, { worktreePath: cwd, prUrl });
      if (!status.ok) {
        result.failed += 1;
        log.error("pull request status failed", {
          ticketId: ticket.id,
          error: status.failure.message,
        });
        scheduleRead(store, ticket.id, fingerprint, now, cycle.cadence, false);
        continue;
      }

      const observation: RetentionObservation = {
        prUrl,
        prState: status.value.state,
        hasConflicts: status.value.hasConflicts,
        checks: status.value.checks,
      };
      const moved = observationChanged(last, observation);
      if (moved) result.changed = true;
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
          deps.notify({
            producer: "pull-request-merged",
            title: "Pull request merged",
            body: ticket.title,
            // The completion `finished` actually governs, and a click opens
            // the ticket it merged for.
            target: { kind: "ticket", projectId: ticket.project_id, ticketId: ticket.id },
          });
          result.changed = true;
        }
        store.notifiedMerged.add(ticket.id);
      }

      // Scheduled only now (VC-686): a merge write that threw above leaves the
      // merge owed, so the next cycle reads it again and retries the write. A
      // merged or closed PR is terminal from here on and holds no schedule.
      if (observation.prState === "open") {
        scheduleRead(
          store,
          ticket.id,
          fingerprint,
          now,
          cycle.cadence,
          moved || stillMoving(observation),
        );
      } else {
        store.reads.delete(ticket.id);
      }

      // A merge is a finish wherever the card happens to sit, so the trim pass
      // below is told about it — `listTrimCandidates` only knows Done/archived.
      if (observation.prState === "merged") mergedThisCycle.add(ticket.id);

      // (4) RECLAIM — the duration gate (VC-113). Runs LAST, after the PR state
      // this cycle observed is known, because "is a PR still open on it?" is
      // half the question of whether a Done ticket is finished.
      if (await maybeReclaim(deps, ticket, observation.prState)) result.changed = true;
    } catch (error) {
      log.error("retention poll failed", { ticketId: ticket.id, error });
    }
  }

  // (5) TRIM — the footprint gate (VC-340), over Done/archived tickets plus
  // anything this cycle saw merged. Runs after the reclaim so a directory that
  // was just removed is not walked on the way out.
  const trim = await runTrimPass(deps, store, mergedThisCycle, now, cycle.cadence);
  if (trim.changed) result.changed = true;
  result.trimChecks = trim.checks;

  // A ticket that left the candidate set takes its schedule with it, so an
  // always-on host's memory does not grow with every ticket it ever watched.
  let nextDueAt: number | null = null;
  for (const [ticketId, entry] of store.reads) {
    if (!seen.has(ticketId)) store.reads.delete(ticketId);
    else if (nextDueAt === null || entry.dueAt < nextDueAt) nextDueAt = entry.dueAt;
  }
  result.nextDueInMs = nextDueAt === null ? null : Math.max(0, nextDueAt - now);

  if (result.changed) deps.onChange?.();
  return result;
}

/**
 * The trim-on-finish pass (VC-340): every finished ticket's worktree gives up
 * what git ignores. Deliberately quiet — no notification, unlike the reclaim.
 * The reclaim speaks because a FOLDER vanished and the user needs to know it can
 * come back; a trim removes only what a package manager rebuilds, and a native
 * alert for every Done move would be noise nobody can act on. It is still
 * accounted for: each trim writes a `worktree_trimmed` event, so the ticket's own
 * History says what went and how much, and the pass broadcasts so surfaces
 * re-read.
 *
 * Refusals are silent by the same rule that makes background reads silent, and
 * per-ticket failures are isolated: one unreadable worktree must not stop the
 * rest of the pass.
 */
async function runTrimPass(
  deps: RetentionPollPorts,
  store: RetentionStore,
  mergedThisCycle: ReadonlySet<string>,
  now: number,
  cadence: RetentionCadence,
): Promise<{ changed: boolean; checks: number }> {
  const trim = deps.trim;
  if (trim === undefined) return { changed: false, checks: 0 };
  const rows = new Map<string, TicketRow | undefined>(
    listTrimCandidates(deps.db).map((ticket) => [ticket.id, ticket]),
  );
  for (const ticketId of mergedThisCycle) {
    if (!rows.has(ticketId)) rows.set(ticketId, getTicketRow(deps.db, ticketId));
  }
  for (const ticketId of store.trims.keys()) {
    if (!rows.has(ticketId)) store.trims.delete(ticketId);
  }
  // Settings belong in the memo's key: a person who changes what a trim keeps,
  // or turns it back on, has asked a new question of every worktree.
  const settings = JSON.stringify(getTrimSettings(deps.db));
  let changed = false;
  let checks = 0;
  for (const [ticketId, row] of rows) {
    try {
      const prMerged = mergedThisCycle.has(ticketId);
      // The memo (VC-686): an unchanged ticket this pass already answered is
      // not asked again until its recheck. A changed row is a new question.
      const key =
        row === undefined
          ? null
          : [ticketFingerprint(row), row.retention_keep, prMerged, settings].join("\u0000");
      const memo = store.trims.get(ticketId);
      if (key !== null && memo !== undefined && memo.key === key && now < memo.recheckAt) {
        continue;
      }
      checks += 1;
      const outcome = await trimFinishedWorktree(trim, ticketId, { prMerged });
      // Trimmed, or nothing left to trim, holds for hours; a refusal (busy,
      // tracked changes, a failed git, a missing folder) is asked again once
      // the quiet ceiling passes, so it costs one check per ceiling rather
      // than one per cycle.
      if (key !== null) {
        const clean = outcome.kind === "trimmed" || outcome.nothingLeft === true;
        store.trims.set(ticketId, {
          key,
          recheckAt: now + (clean ? cadence.trimRecheckMs : cadence.quietMaxMs),
        });
      }
      if (outcome.kind !== "trimmed") continue;
      changed = true;
      log.info("ignored paths trimmed", {
        ticketId,
        removed: outcome.report.removed.length,
        bytes: outcome.report.totalBytes,
        kept: outcome.report.kept.length,
        worktreePath: outcome.report.worktreePath,
      });
    } catch (error) {
      log.error("trim failed", { ticketId, error });
    }
  }
  return { changed, checks };
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
  deps: RetentionPollPorts,
  ticket: TicketRow,
  prState: "open" | "merged" | "closed" | null,
): Promise<boolean> {
  if (!deps.reclaim) return false;
  const outcome = await reclaimIfStale(deps.reclaim, ticket.id, prState);
  if (outcome.kind !== "reclaimed") return false;
  deps.notify({
    producer: "worktree-reclaimed",
    title: "Worktree removed",
    body:
      outcome.branch === null
        ? `${ticket.title}: Volli removed the folder after ${outcome.daysInDone} days in Done.`
        : `${ticket.title}: Volli removed the folder after ${outcome.daysInDone} days in Done. Branch ${outcome.branch} is kept, so you can recreate it.`,
    // The folder is gone; the ticket it belonged to is what a person can still
    // act on (its branch is kept, and the ticket is where recreating starts).
    target: { kind: "ticket", projectId: ticket.project_id, ticketId: ticket.id },
  });
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
function stampDiscoveredPr(deps: RetentionPollPorts, ticket: TicketRow, url: string): boolean {
  try {
    const now = deps.now();
    const write = deps.db.transaction(() => {
      updateTicketFields(deps.db, ticket.id, { prUrl: url }, now);
      recordTicketEvent(deps.db, ticket.id, { kind: "pr_opened", url }, now, AUTOMATION_ACTOR);
    });
    write();
    return true;
  } catch (error) {
    log.error("failed to stamp discovered pull request", { ticketId: ticket.id, error });
    // Operational, and deliberately outside the switches: this is a durable
    // write that failed in a background pass with no other user-visible
    // surface (CLAUDE.md's never-swallow rule). A "worktree maintenance"
    // preference that could hide a failed write would be a mute button on the
    // one thing the pass cannot recover by itself.
    //
    // It still opens the ticket it is about. Operational means no preference is
    // consulted, not that the person is left to find the card themselves — and
    // this target is one the failure genuinely has rather than an invented one.
    deps.notify({
      producer: "worktree-record-failed",
      title: "Couldn't save discovered PR",
      body: `${ticket.title}: found PR ${url} but couldn't record it. Will retry.`,
      target: { kind: "ticket", projectId: ticket.project_id, ticketId: ticket.id },
    });
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
  deps: RetentionPollPorts,
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
 * Subscribes to committed ticket changes that can move a retention answer
 * (VC-686), naming the ticket each one touched. Returns the unsubscribe.
 */
export type RetentionChangeSource = (listener: (ticketId: string) => void) => () => void;

/** What the driver has spent since its last load summary (VC-686). */
interface LoadWindow {
  startedAt: number;
  cycles: number;
  ghReads: number;
  ghFailures: number;
  trimChecks: number;
  cycleMs: number;
}

/**
 * The start/stop driver over {@link pollRetention} (the `park.ts` pattern, but
 * self-rescheduling with `setTimeout` so the delay can follow the per-ticket
 * schedule and back off on failure). Owns the transient
 * {@link RetentionStore}; exposes `triggerNow` (the on-focus/manual poll), the
 * composed `getState`, and `dismiss`.
 *
 * Event-driven where it can be (VC-686): with a {@link RetentionChangeSource},
 * a committed ticket change wakes it after a short debounce and the changed
 * ticket is read whatever its backoff, and between
 * changes it sleeps until the earliest ticket read falls due, up to the quiet
 * ceiling. Each cycle's spawns and scan time are counted, and an hourly summary
 * goes to the host log, so an always-on host's background cost is measurable
 * where it runs.
 *
 * `stop()` only disarms the timers; a poll already in flight keeps running and
 * still writes (a `pr_opened` stamp, a `pr_merged` event, a reclaim). A host
 * that is about to close the database stops the watch and then awaits
 * {@link RetentionWatcher.settled} (VC-627).
 */
export class RetentionWatcher {
  private readonly store = createRetentionStore();
  private timer: NodeJS.Timeout | null = null;
  private changeTimer: NodeJS.Timeout | null = null;
  private unsubscribe: (() => void) | null = null;
  /** Tickets a change named since the last cycle began. */
  private readonly woken = new Set<string>();
  /** A ticket changed while a poll was in flight: read again once it lands. */
  private changedMidPoll = false;
  private failures = 0;
  /** The poll in flight, if any. Never rejects; `null` between polls. */
  private inFlight: Promise<void> | null = null;
  private started = false;
  private load: LoadWindow | null = null;

  constructor(
    private readonly deps: RetentionPollPorts,
    private readonly config: RetentionWatchConfig,
    private readonly changes?: RetentionChangeSource,
  ) {}

  /** Starts the recurring poll (idempotent). The first poll runs after one interval. */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.unsubscribe = this.changes?.((ticketId) => this.ticketChanged(ticketId)) ?? null;
    this.schedule(this.config.intervalMs);
  }

  /** Stops the recurring poll. A poll already in flight runs on: see {@link settled}. */
  stop(): void {
    this.started = false;
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.changedMidPoll = false;
    this.woken.clear();
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.changeTimer !== null) {
      clearTimeout(this.changeTimer);
      this.changeTimer = null;
    }
  }

  /**
   * Runs a poll immediately (on window focus / manual trigger), then
   * reschedules. A person is looking, so every ticket read longer than the
   * base interval ago is read again, whatever its backoff.
   */
  triggerNow(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    void this.runOnce(true);
  }

  /**
   * Resolves once no poll is in flight — including one a trigger started while
   * this waited. Never rejects and adds no delay of its own. It does not stop
   * the watch: after {@link stop}, nothing reschedules, so this is the last
   * write the watch makes.
   */
  async settled(): Promise<void> {
    while (this.inFlight !== null) await this.inFlight;
  }

  /** The composed retention state for a ticket (or `null` when unknown). */
  getState(ticketId: string): TicketRetentionState | null {
    return getRetentionState(this.deps, this.store, ticketId);
  }

  /** Suppresses a ticket's Archive prompt for this launch (re-offered next launch). */
  dismiss(ticketId: string): void {
    this.store.dismissed.add(ticketId);
  }

  /**
   * A committed ticket change: read soon, folding a burst into one cycle. The
   * cycle reads the tickets that changed (and anything else already due), so
   * a busy board costs reads in proportion to what moved.
   */
  private ticketChanged(ticketId: string): void {
    if (!this.started) return;
    this.woken.add(ticketId);
    if (this.inFlight !== null) {
      this.changedMidPoll = true;
      return;
    }
    if (this.changeTimer !== null) return;
    this.changeTimer = setTimeout(() => {
      this.changeTimer = null;
      if (!this.started) return;
      if (this.timer !== null) {
        clearTimeout(this.timer);
        this.timer = null;
      }
      void this.runOnce(false);
    }, this.config.changeDebounceMs);
    this.changeTimer.unref();
  }

  private schedule(delay: number): void {
    if (!this.started) return;
    // Clear any timer already pending before overwriting the field — without
    // this, a stop()-during-in-flight-poll followed by start() lets the
    // in-flight run's `finally` schedule a SECOND self-perpetuating chain
    // that stop() can no longer reach (it only clears the last-written id).
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.runOnce(false), delay);
    // Never keep the process alive for a poll at quit (park.ts precedent).
    this.timer.unref();
  }

  private async runOnce(present: boolean): Promise<void> {
    // A trigger that lands mid-poll is dropped; the in-flight run reschedules.
    if (this.inFlight !== null) return;
    let finished!: () => void;
    this.inFlight = new Promise<void>((resolve) => {
      finished = resolve;
    });
    let nextDueInMs: number | null = null;
    const startedAt = performance.now();
    const woken = new Set(this.woken);
    this.woken.clear();
    try {
      const result = await pollRetention(this.deps, this.store, {
        cadence: this.config,
        present,
        woken,
      });
      this.failures =
        result.attempted > 0 && result.failed === result.attempted ? this.failures + 1 : 0;
      nextDueInMs = result.nextDueInMs;
      this.account(result, performance.now() - startedAt);
    } catch (error) {
      // Defensive: pollRetention already swallows per-ticket read failures, but a
      // catastrophic failure must never leave an unhandled rejection.
      log.error("retention poll cycle failed", { error });
      this.failures += 1;
    } finally {
      this.inFlight = null;
      // Waiters resume on a later microtask, after the reschedule below.
      finished();
      if (this.changedMidPoll) {
        this.changedMidPoll = false;
        this.schedule(this.config.changeDebounceMs);
      } else {
        this.schedule(nextCycleDelay(this.failures, nextDueInMs, this.config));
      }
    }
  }

  /**
   * Counts one cycle's cost and writes the hourly summary when it is due.
   * `cycleMs` is wall time, including the `gh` and git processes it waited on.
   */
  private account(result: PollResult, cycleMs: number): void {
    const now = this.deps.now();
    const load = (this.load ??= {
      startedAt: now,
      cycles: 0,
      ghReads: 0,
      ghFailures: 0,
      trimChecks: 0,
      cycleMs: 0,
    });
    load.cycles += 1;
    load.ghReads += result.attempted;
    load.ghFailures += result.failed;
    load.trimChecks += result.trimChecks;
    load.cycleMs += cycleMs;
    if (log.enabled("debug")) {
      log.debug("retention cycle", {
        ghReads: result.attempted,
        ghFailures: result.failed,
        trimChecks: result.trimChecks,
        cycleMs: Math.round(cycleMs),
        nextDueInMs: result.nextDueInMs,
      });
    }
    if (now - load.startedAt < LOAD_SUMMARY_INTERVAL_MS) return;
    log.info("retention load", {
      windowMs: now - load.startedAt,
      cycles: load.cycles,
      ghReads: load.ghReads,
      ghFailures: load.ghFailures,
      trimChecks: load.trimChecks,
      cycleMs: Math.round(load.cycleMs),
    });
    this.load = null;
  }
}

/**
 * Orphaned PROCESSES: whose a running process is, and which of them no live
 * Session owns any more (VC-341).
 *
 * Volli already sweeps orphaned worktree DIRECTORIES and orphaned Pi sidecar
 * FILES. Neither notices that a `next dev` started for a Ticket three weeks ago
 * is still holding 2.9 GB after the Session that started it ended, because
 * nothing on the machine remembered that the process belonged to that Session
 * at all. This module is the domain half of the answer, and it is deliberately
 * pure: two evidence sources arrive as plain records, and what comes out is a
 * list of candidates a person is shown.
 *
 * TWO SOURCES, ONE VOCABULARY, DELIBERATELY UNEQUAL.
 *
 *  - The SPAWN LEDGER is authoritative. Volli wrote a row when it started the
 *    child, so `(sessionId, ticketId, pid, pgid, startedAt, cwd)` is a fact
 *    about ownership rather than an inference from a command line. Grepping
 *    argv for `node` or `vp dev` finds JavaScript and misses a Gradle daemon, a
 *    `cargo watch`, a `uvicorn --reload` or a Jupyter kernel; the ledger does
 *    not care what the binary is.
 *  - The CWD SWEEP is the safety net. A daemon that double-forks or calls
 *    `setsid` leaves the process group Volli started and so escapes both the
 *    group kill and its ledger row's usefulness — but it keeps its working
 *    directory, and a working directory under `~/.volli/worktrees/<project>/`
 *    still names a Ticket. Attribution is by path, and the resulting claim is
 *    weaker: this says where a process is standing, not who started it.
 *
 * PID RECYCLING IS THE HAZARD THIS MODULE EXISTS TO REFUSE. A ledger row is a
 * pid plus the wall clock at spawn, and pids are reused. Between the row being
 * written and a sweep running, that number may have become an unrelated
 * process — the user's editor, a build, `launchd` itself. So a ledger row is
 * only ever matched against an OBSERVED process whose start time agrees with
 * the recorded one ({@link ledgerEntryMatches}); a row whose pid now belongs to
 * something that started at a different time is simply not a candidate, and a
 * caller re-runs the same check immediately before it signals.
 *
 * NOT EVERYTHING RUNNING IN A WORKTREE IS VOLLI'S. A person's own shell,
 * `cd`'d into a ticket's checkout from a terminal tab, has a controlling TTY
 * and no ledger row. That is somebody sitting at a keyboard, not a leak, so it
 * is reported with {@link OrphanProcessStance} `not-volli` and carries no Reap:
 * killing a shell out from under the person who opened it would be exactly the
 * kind of silent, confident destruction this feature is supposed to replace.
 *
 * AND WORKTREES ARE REUSED. A dev server started by a Session that has since
 * ended, in a checkout a NEW live Session now holds, is genuinely an orphan —
 * its owner is gone — and hiding it would recreate the bug this exists to fix.
 * But the new Session may be depending on it: a held port, a running watch, a
 * warm cache. So it is `held`: listed with the holder named, offered a Reap on
 * its own row where a person can weigh it, and never taken by "Reap all" or by
 * the background policy, whatever its age and whatever the machine's memory is
 * doing.
 *
 * SURFACING IS NOT REAPING. Nothing here kills anything or decides on its own
 * that something should die. {@link selectAutoReapable} is the one policy
 * function, and it is written to say no: it requires the setting to be on, the
 * candidate to be reapable, the candidate to be older than the person's own
 * threshold, and the machine to actually be under memory pressure.
 */

/** Which evidence produced a candidate. `ledger` is ownership; `cwd` is location. */
export type OrphanProcessSource = "ledger" | "cwd";

/**
 * What may be done about a candidate.
 *
 * `reapable` is a process Volli is prepared to signal on a person's word.
 * `held` is Volli's own process in a worktree somebody else is now working in:
 * killable, but only one row at a time and only by hand.
 * `not-volli` is listed for the same reason a doctor reports a measurement it
 * has no remedy for — it explains what is holding the worktree — and offers no
 * action.
 */
export type OrphanProcessStance = "reapable" | "held" | "not-volli";

/**
 * What Volli starts on a Session's behalf, by door.
 *
 * Three doors, because three doors own a spawn. There is deliberately no
 * `browser` kind: a Browser Tab is a `WebContentsView` inside this process
 * (`browser/tab-host.ts`), so there is no child pid to record and a value
 * nothing can ever write would be dead vocabulary frozen into a CHECK
 * constraint.
 */
export type SpawnLedgerKind = "execute" | "shell" | "terminal";

/** Whether a value is a spawn kind this build knows. */
export function isSpawnLedgerKind(value: unknown): value is SpawnLedgerKind {
  return value === "execute" || value === "shell" || value === "terminal";
}

/** One process as the machine reports it right now. */
export interface ProcessFact {
  pid: number;
  ppid: number;
  /** The process group, which is what a kill signals. */
  pgid: number;
  /** Epoch ms the kernel says this process started. Second-resolution on macOS. */
  startedAt: number;
  rssBytes: number;
  /** The controlling terminal (`s001`), or null for a process with none. */
  tty: string | null;
  command: string;
  /** Working directory, when the cwd sweep observed one for this pid. */
  cwd: string | null;
}

/** What Volli recorded when it spawned a child on a Session's behalf. */
export interface SpawnLedgerSpawn {
  sessionId: string;
  ticketId: string | null;
  projectId: string | null;
  kind: SpawnLedgerKind;
  pid: number;
  /** The group the child leads, when it was spawned detached; null when it leads none. */
  pgid: number | null;
  /** Volli's own clock at the moment of the spawn. */
  startedAt: number;
  cwd: string;
  command: string;
}

/** A ledger row that has not been marked exited. */
export interface SpawnLedgerEntry extends SpawnLedgerSpawn {
  /** The row's durable id, which a reap names rather than re-deriving. */
  id: string;
}

/**
 * The narrow door a spawn site writes through.
 *
 * A port rather than a class so the two packages that spawn — the agent
 * runtime's `execute` and the desktop's shell and PTY hosts — depend on the
 * vocabulary instead of on SQLite, and so a test can hand in an array.
 * `recordSpawn` answers with the row's id, or `null` when the ledger declined
 * (no database this launch): a spawn is never blocked by its bookkeeping.
 */
export interface SpawnLedgerPort {
  recordSpawn(spawn: SpawnLedgerSpawn): string | null;
  markExited(id: string, exitedAt?: number): void;
}

/** A live Session and the checkout it is attached to. */
export interface WorktreeHolder {
  path: string;
  sessionId: string;
}

/** A ticket's checkout, as the classification needs to know it. */
export interface WorktreeRef {
  path: string;
  ticketId: string;
  ticketDisplayId: string;
  projectId: string;
}

/** One process a person is shown, with everything they need to judge it. */
export interface OrphanProcessCandidate {
  /** Stable within one scan: source, pid and observed start time. */
  itemId: string;
  source: OrphanProcessSource;
  stance: OrphanProcessStance;
  pid: number;
  /** The group a reap would signal; null when only the pid is known. */
  pgid: number | null;
  /** The kernel's start time, which is also the identity a reap re-checks. */
  startedAt: number;
  ageMs: number;
  rssBytes: number;
  /** Informational text. Never parsed, never matched against — it is evidence for a person. */
  command: string;
  cwd: string | null;
  tty: string | null;
  sessionId: string | null;
  ticketId: string | null;
  ticketDisplayId: string | null;
  worktreePath: string | null;
  /** One line saying why this is listed, in the voice of what was observed. */
  reason: string;
}

export interface OrphanProcessScanInput {
  now: number;
  /** Every process the inventory saw, with cwds merged in where the sweep found them. */
  processes: readonly ProcessFact[];
  /** Ledger rows with no exit recorded. */
  ledger: readonly SpawnLedgerEntry[];
  /** Ticket checkouts, for attributing a cwd to a Ticket. */
  worktrees: readonly WorktreeRef[];
  /** Sessions holding a live executor right now. */
  liveSessionIds: readonly string[];
  /**
   * Worktrees a live Session is attached to, and which Session holds each.
   *
   * Two different answers come out of this one fact: the cwd sweep says nothing
   * at all about a checkout somebody is working in (it cannot tell that
   * Session's own process from a leak), while the ledger — which knows whose a
   * process is — downgrades its candidate to `held` and names the holder.
   */
  liveWorktrees: readonly WorktreeHolder[];
  /** Working directories of open terminal tabs; a person is looking at these. */
  openTerminalCwds: readonly string[];
  /** Volli's own process and anything it must never signal. */
  protectedPids: readonly number[];
  /** How far a ledger row's clock may sit from the kernel's. Defaults to {@link START_TIME_TOLERANCE_MS}. */
  startToleranceMs?: number;
}

/**
 * How far apart Volli's clock at spawn and the kernel's start time may be and
 * still describe the same process.
 *
 * The two are written within microseconds of each other, so the whole budget is
 * reporting granularity: `ps` reports `lstart` to the second, and a spawn that
 * straddles a second boundary is off by up to one. Five seconds is generous for
 * that and still refuses a recycled pid, because a pid recycled onto a busy
 * machine reappears minutes or hours later, not inside the same five seconds as
 * the row that named it.
 */
export const START_TIME_TOLERANCE_MS = 5_000;

/** Whether `path` is `root` or lives inside it, as a path — no filesystem is touched. */
export function isUnderPath(root: string, path: string): boolean {
  if (root.length === 0) return false;
  const normalizedRoot = root.endsWith("/") ? root.slice(0, -1) : root;
  return path === normalizedRoot || path.startsWith(`${normalizedRoot}/`);
}

/** The deepest worktree `path` sits inside, or null when it sits in none. */
export function worktreeForPath(
  path: string | null,
  worktrees: readonly WorktreeRef[],
): WorktreeRef | null {
  if (path === null) return null;
  let deepest: WorktreeRef | null = null;
  for (const worktree of worktrees) {
    if (!isUnderPath(worktree.path, path)) continue;
    if (deepest === null || worktree.path.length > deepest.path.length) deepest = worktree;
  }
  return deepest;
}

/**
 * Whether an observed process is the one a ledger row named.
 *
 * The pid alone never answers this. `startedAt` is what makes the row an
 * identity rather than a number, and the comparison is the last thing standing
 * between a sweep and signalling a stranger.
 */
export function ledgerEntryMatches(
  entry: Pick<SpawnLedgerSpawn, "pid" | "startedAt">,
  fact: Pick<ProcessFact, "pid" | "startedAt">,
  toleranceMs: number = START_TIME_TOLERANCE_MS,
): boolean {
  if (entry.pid !== fact.pid) return false;
  return Math.abs(entry.startedAt - fact.startedAt) <= toleranceMs;
}

function ageOf(now: number, startedAt: number): number {
  return Math.max(0, now - startedAt);
}

/** `3d 4h`, `4h 12m`, `12m`, `40s` — an age a person reads at a glance. */
export function formatProcessAge(ageMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(ageMs / 1000));
  const days = Math.floor(totalSeconds / 86_400);
  const hours = Math.floor((totalSeconds % 86_400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m`;
  return `${totalSeconds}s`;
}

/**
 * Every candidate, oldest first.
 *
 * The ledger pass runs first and claims its pids, so a process Volli knows it
 * started is never demoted to the weaker cwd evidence. The cwd pass then covers
 * what escaped: the double-forkers, and anything a crashed launch never wrote a
 * row for.
 */
export function classifyOrphanProcesses(
  input: OrphanProcessScanInput,
): readonly OrphanProcessCandidate[] {
  const tolerance = input.startToleranceMs ?? START_TIME_TOLERANCE_MS;
  const byPid = new Map<number, ProcessFact>();
  for (const fact of input.processes) byPid.set(fact.pid, fact);
  const protectedPids = new Set(input.protectedPids);
  const liveSessions = new Set(input.liveSessionIds);
  const claimed = new Set<number>();
  const candidates: OrphanProcessCandidate[] = [];

  for (const entry of input.ledger) {
    const fact = byPid.get(entry.pid);
    // A row with no live process behind it, or one whose pid has been recycled
    // onto a stranger, is not a candidate — it is a row to forget.
    if (fact === undefined || !ledgerEntryMatches(entry, fact, tolerance)) continue;
    if (protectedPids.has(fact.pid)) continue;
    claimed.add(fact.pid);
    if (liveSessions.has(entry.sessionId)) continue;
    const worktree = worktreeForPath(entry.cwd, input.worktrees);
    // Worktree reuse: the owner is gone, but somebody is standing in the
    // checkout now and may be depending on what is running in it.
    const holder =
      worktree === null
        ? undefined
        : input.liveWorktrees.find((live) => isUnderPath(live.path, worktree.path));
    candidates.push({
      itemId: `ledger:${fact.pid}:${fact.startedAt}`,
      source: "ledger",
      stance: holder === undefined ? "reapable" : "held",
      pid: fact.pid,
      pgid: entry.pgid ?? fact.pgid,
      startedAt: fact.startedAt,
      ageMs: ageOf(input.now, fact.startedAt),
      rssBytes: fact.rssBytes,
      command: entry.command,
      cwd: fact.cwd ?? entry.cwd,
      tty: fact.tty,
      sessionId: entry.sessionId,
      ticketId: entry.ticketId ?? worktree?.ticketId ?? null,
      ticketDisplayId: worktree?.ticketDisplayId ?? null,
      worktreePath: worktree?.path ?? null,
      reason:
        holder === undefined
          ? `Volli started this for a Session that has ended (${entry.kind}).`
          : `Owner Session ended; worktree now held by ${holder.sessionId}.`,
    });
  }

  for (const fact of input.processes) {
    if (claimed.has(fact.pid) || protectedPids.has(fact.pid)) continue;
    const cwd = fact.cwd;
    const worktree = cwd === null ? null : worktreeForPath(cwd, input.worktrees);
    if (worktree === null || cwd === null) continue;
    if (input.liveWorktrees.some((live) => isUnderPath(live.path, cwd))) continue;
    if (input.openTerminalCwds.some((path) => isUnderPath(worktree.path, path))) continue;
    // A controlling terminal and no ledger row is a person's own shell. It is
    // reported, because it explains what is holding the checkout, and it is
    // never offered a kill.
    const own = fact.tty !== null;
    candidates.push({
      itemId: `cwd:${fact.pid}:${fact.startedAt}`,
      source: "cwd",
      stance: own ? "not-volli" : "reapable",
      pid: fact.pid,
      pgid: fact.pgid,
      startedAt: fact.startedAt,
      ageMs: ageOf(input.now, fact.startedAt),
      rssBytes: fact.rssBytes,
      command: fact.command,
      cwd,
      tty: fact.tty,
      sessionId: null,
      ticketId: worktree.ticketId,
      ticketDisplayId: worktree.ticketDisplayId,
      worktreePath: worktree.path,
      reason: own
        ? "Not Volli's — a terminal of your own is standing in this worktree."
        : "Running in a worktree whose Session has ended, with no ledger row.",
    });
  }

  return candidates.toSorted((left, right) => left.startedAt - right.startedAt);
}

/** How the machine's memory is doing, as the two macOS readings report it. */
export interface MemoryPressureReading {
  underPressure: boolean;
  /** What was measured, for the notification and the panel — never a verdict alone. */
  detail: string;
}

/** The opt-in background policy, exactly as a person set it. */
export interface AutoReapPolicy {
  enabled: boolean;
  /** How old a candidate must be before the policy will touch it. */
  minimumAgeHours: number;
}

/** The policy's default: off, and a full day of age before anything is considered. */
export const DEFAULT_AUTO_REAP_POLICY: AutoReapPolicy = { enabled: false, minimumAgeHours: 24 };

/**
 * Which candidates the background policy may take, and why it took none.
 *
 * Every gate is a conjunction and every one of them can veto: the setting, the
 * stance, the age, and real memory pressure. A candidate that only satisfies
 * three of the four keeps running and stays on the panel, where a person can
 * decide about it themselves.
 *
 * `reapable` and nothing else. A `held` process — Volli's own, in a checkout a
 * live Session has taken over — is excluded here regardless of age and
 * regardless of how short of memory the machine is: whoever is working in that
 * worktree may be depending on it, and no threshold makes an unattended kill
 * the right answer to that.
 */
export function selectAutoReapable(
  candidates: readonly OrphanProcessCandidate[],
  policy: AutoReapPolicy,
  pressure: MemoryPressureReading,
): { reap: readonly OrphanProcessCandidate[]; declined: string | null } {
  if (!policy.enabled) return { reap: [], declined: "Automatic reaping is off." };
  if (!pressure.underPressure) {
    return { reap: [], declined: `The machine is not under memory pressure (${pressure.detail}).` };
  }
  const minimumAgeMs = Math.max(0, policy.minimumAgeHours) * 3_600_000;
  const reap = candidates.filter(
    (candidate) => candidate.stance === "reapable" && candidate.ageMs >= minimumAgeMs,
  );
  if (reap.length === 0) {
    return {
      reap: [],
      declined: `Nothing has been running longer than ${policy.minimumAgeHours}h.`,
    };
  }
  return { reap, declined: null };
}

/** The notification's line: what was killed, named rather than counted alone. */
export function describeReapedProcesses(candidates: readonly OrphanProcessCandidate[]): string {
  const named = candidates
    .map((candidate) => `${candidate.ticketDisplayId ?? "no ticket"} · ${candidate.command}`)
    .slice(0, 3);
  const rest = candidates.length - named.length;
  return rest > 0 ? `${named.join(", ")} and ${rest} more` : named.join(", ");
}

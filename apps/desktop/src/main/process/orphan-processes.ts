/**
 * The orphan process sweep (VC-341): what is running that no live Session owns,
 * and the one door that may kill it.
 *
 * SURFACE, DON'T SILENTLY KILL. Every path here ends in a list a person reads.
 * A scan mints a revision and the exact proposal that was shown under it; a
 * reap may only name items from that revision, exactly as the worktree cleanup
 * and Pi sidecar sweeps work, so no caller — present or future — can ask this
 * app to signal a pid that no completed scan proposed. The panel shows age, RSS
 * and the command as INFORMATIONAL TEXT: nothing here matches on a command
 * line, because the day it did is the day a `cargo watch` or a Gradle daemon
 * stopped being found.
 *
 * IDENTITY IS RE-PROVEN IMMEDIATELY BEFORE THE SIGNAL. A candidate is a pid and
 * the start time observed with it. Between the scan and the click a pid can die
 * and be recycled onto something else entirely, so {@link OrphanProcessService.reap}
 * re-reads the process table and refuses any candidate whose start time no
 * longer agrees. This is the difference between a sweep and an accident.
 *
 * WHAT IS SIGNALLED. A candidate that leads its own process group is signalled
 * as a GROUP (`kill(-pgid)`), which is how `background-shell-host.ts` ends a
 * shell and the only way to reach the children a dev server forked. A candidate
 * that is NOT its group's leader is signalled alone: its group is somebody
 * else's — a login shell's, most likely — and taking it would kill processes no
 * scan ever proposed. SIGTERM first, SIGKILL after the grace, because the
 * daemons this exists for (Gradle, some file watchers) re-exec on TERM.
 *
 * AUTOMATIC REAPING IS OPT-IN AND DOUBLY GATED. Off by default; when on, it
 * takes only candidates older than the person's own threshold, only while the
 * machine is genuinely under memory pressure, and it always says what it
 * killed.
 */
import { randomUUID } from "node:crypto";

import {
  classifyOrphanProcesses,
  DEFAULT_AUTO_REAP_POLICY,
  describeReapedProcesses,
  ledgerEntryMatches,
  selectAutoReapable,
  type AutoReapPolicy,
  type MemoryPressureReading,
  type OrphanProcessCandidate,
  type ProcessFact,
  type SpawnLedgerEntry,
  type WorktreeHolder,
  type WorktreeRef,
} from "@volli/shared";

import type {
  OrphanProcessInventory,
  OrphanProcessReapInput,
  OrphanProcessReapReport,
} from "../../ipc/contract";
import { readProcessInventory } from "./inventory";
import { readMemoryPressure } from "./memory-pressure";

/** How long SIGTERM gets before SIGKILL — `background-shell-host.ts`'s grace. */
export const REAP_KILL_GRACE_MS = 5_000;
/** How stale a scan may be and still answer `volli doctor`'s count. */
export const DOCTOR_SCAN_MAX_AGE_MS = 60_000;

/** The ledger, as this sweep needs it: what is open, and the power to close a row. */
export interface SweepSpawnLedger {
  listOpen(): SpawnLedgerEntry[];
  markExited(id: string, exitedAt?: number): void;
  prune(): number;
}

export interface OrphanProcessDeps {
  ledger: SweepSpawnLedger;
  /** Every Ticket checkout on this machine, for attributing a cwd to a Ticket. */
  worktrees(): readonly WorktreeRef[];
  /** Sessions holding a live executor. */
  liveSessionIds(): readonly string[];
  /** Worktrees a live Session is attached to, and which Session holds each. */
  liveWorktrees(): readonly WorktreeHolder[];
  /** Working directories of open terminal tabs. */
  openTerminalCwds(): readonly string[];
  /** The process table with working directories; the real one by default. */
  inventory?: () => Promise<ProcessFact[]>;
  memoryPressure?: () => Promise<MemoryPressureReading>;
  /** The opt-in background policy, read at the moment it is needed. */
  policy?: () => AutoReapPolicy;
  /** Where an automatic reap says what it killed. */
  notify?: (title: string, message: string) => void;
  now?: () => number;
  nextId?: () => string;
  /** The signal seam; the real `process.kill` by default. */
  signal?: (target: number, signal: NodeJS.Signals | 0) => void;
  /**
   * Pids no sweep may ever propose or signal — Volli's own process and its
   * parent by default. Read at both windows (the scan and, again, immediately
   * before the signal), so a pid that becomes protected between them is still
   * refused.
   */
  protectedPids?: () => readonly number[];
  killGraceMs?: number;
}

interface ScanState {
  inventory: OrphanProcessInventory;
  candidates: Map<string, OrphanProcessCandidate>;
}

/**
 * One signal, and what the kernel said about it.
 *
 * The outcome is kept rather than discarded because the three answers are
 * genuinely different: delivered, `ESRCH` (nothing there — which for a kill is
 * success and for a probe is "it is gone"), and anything else, of which `EPERM`
 * is the one that matters. A process this app may not signal used to be
 * reported as reaped, closing its ledger row while it kept running.
 */
type SignalOutcome = "delivered" | "gone" | "refused";

function deliver(
  signal: (target: number, sig: NodeJS.Signals | 0) => void,
  target: number,
  sig: NodeJS.Signals | 0,
): SignalOutcome {
  try {
    signal(target, sig);
    return "delivered";
  } catch (error) {
    return (error as NodeJS.ErrnoException | null)?.code === "ESRCH" ? "gone" : "refused";
  }
}

export class OrphanProcessService {
  readonly #deps: OrphanProcessDeps;
  readonly #now: () => number;
  readonly #nextId: () => string;
  readonly #inventory: () => Promise<ProcessFact[]>;
  readonly #memoryPressure: () => Promise<MemoryPressureReading>;
  readonly #policy: () => AutoReapPolicy;
  readonly #signal: (target: number, sig: NodeJS.Signals | 0) => void;
  readonly #killGraceMs: number;
  readonly #protectedPids: () => readonly number[];
  #current: ScanState | null = null;

  constructor(deps: OrphanProcessDeps) {
    this.#deps = deps;
    this.#now = deps.now ?? Date.now;
    this.#nextId = deps.nextId ?? randomUUID;
    this.#inventory = deps.inventory ?? (() => readProcessInventory());
    this.#memoryPressure = deps.memoryPressure ?? (() => readMemoryPressure());
    this.#policy = deps.policy ?? (() => DEFAULT_AUTO_REAP_POLICY);
    this.#signal = deps.signal ?? ((target, sig) => process.kill(target, sig === 0 ? 0 : sig));
    this.#killGraceMs = deps.killGraceMs ?? REAP_KILL_GRACE_MS;
    this.#protectedPids = deps.protectedPids ?? (() => [process.pid, process.ppid]);
  }

  /**
   * The read-only inventory. Nothing in this call signals anything.
   *
   * It does two pieces of housekeeping the reader alone can do: a ledger row
   * whose process is no longer in the table is closed — the exit this app never
   * saw, dated at the moment it noticed — and retention runs, so the ledger
   * stays small without a timer of its own.
   */
  async scan(): Promise<OrphanProcessInventory> {
    // A requested rescan retires the old proposal even if the walk fails: a
    // failed refresh must never leave an older revision actionable.
    this.#current = null;
    const processes = await this.#inventory();
    const ledger = this.#deps.ledger.listOpen();
    const now = this.#now();
    const candidates = classifyOrphanProcesses({
      now,
      processes,
      ledger,
      worktrees: this.#deps.worktrees(),
      liveSessionIds: this.#deps.liveSessionIds(),
      liveWorktrees: this.#deps.liveWorktrees(),
      openTerminalCwds: this.#deps.openTerminalCwds(),
      protectedPids: this.#protectedPids(),
    });
    this.#closeVanishedRows(ledger, processes, now);
    this.#deps.ledger.prune();

    const inventory: OrphanProcessInventory = {
      revision: this.#nextId(),
      scannedAt: now,
      candidates: [...candidates],
      reapableCount: candidates.filter((candidate) => candidate.stance === "reapable").length,
    };
    this.#current = {
      inventory,
      candidates: new Map(candidates.map((candidate) => [candidate.itemId, candidate])),
    };
    return inventory;
  }

  /** The latest scan, or a fresh one when there is none or it has gone stale. */
  async freshInventory(maxAgeMs = DOCTOR_SCAN_MAX_AGE_MS): Promise<OrphanProcessInventory> {
    const current = this.#current;
    if (current !== null && this.#now() - current.inventory.scannedAt <= maxAgeMs) {
      return current.inventory;
    }
    return this.scan();
  }

  /**
   * The destructive half, over items the reviewed scan proposed.
   *
   * Every candidate is re-checked against a freshly read process table before
   * a signal is sent: the stance it was listed under, that a process with that
   * pid is still there, and that the process there is still the one that was
   * listed. A candidate that fails any of those is KEPT with the reason, which
   * is the honest report — "the thing you asked me to kill is not what is
   * running under that number any more" is not an error, it is an answer.
   */
  async reap(input: OrphanProcessReapInput): Promise<OrphanProcessReapReport> {
    const scan = this.#current;
    if (scan === null || scan.inventory.revision !== input.scanRevision) {
      throw new Error("This process list is out of date. Scan again before reaping.");
    }
    const selected = [...new Set(input.itemIds)].map((itemId) => {
      const candidate = scan.candidates.get(itemId);
      if (candidate === undefined) {
        throw new Error("This reap named a process that was not in the reviewed scan.");
      }
      return candidate;
    });

    const processes = await this.#inventory();
    const byPid = new Map(processes.map((fact) => [fact.pid, fact] as const));
    const guarded = new Set(this.#protectedPids());
    // Read fresh rather than remembered from the scan: the row a reap closes
    // must be one that is still open NOW, and a cwd-swept candidate has no row
    // at all.
    const openRows = this.#deps.ledger.listOpen();
    const kept: OrphanProcessReapReport["kept"] = [];
    const signalling: OrphanProcessCandidate[] = [];

    for (const candidate of selected) {
      const refusal = this.#refuseReap(candidate, byPid, guarded);
      if (refusal === null) signalling.push(candidate);
      else kept.push({ candidate, reason: refusal });
    }

    // Concurrently, because each termination spends the grace period WAITING.
    // Ten rows serially is ten graces — the better part of a minute with the
    // renderer's invoke parked on it — and the waits have nothing to do with
    // each other.
    const outcomes = await Promise.all(
      signalling.map(async (candidate) => ({ candidate, ended: await this.#terminate(candidate) })),
    );
    const reaped: OrphanProcessCandidate[] = [];
    for (const { candidate, ended } of outcomes) {
      if (ended === null) {
        // Still running after the whole SIGTERM → SIGKILL sequence, or a signal
        // this app was not allowed to send. Either way the ledger row stays
        // open, because the process it names is still there.
        kept.push({ candidate, reason: this.#survivedReason(candidate) });
        continue;
      }
      const row = openRows.find((entry) =>
        ledgerEntryMatches(entry, { pid: candidate.pid, startedAt: candidate.startedAt }),
      );
      if (row !== undefined) this.#deps.ledger.markExited(row.id, this.#now());
      reaped.push(candidate);
    }

    // A reap changes the proposal even when one item is kept: requiring a fresh
    // scan stops a second click acting on a partly-consumed list.
    this.#current = null;
    return { reaped, kept, reapedCount: reaped.length };
  }

  /**
   * The opt-in background policy. Answers what it did, and says nothing to a
   * person unless it actually killed something.
   */
  async autoReap(): Promise<{
    reaped: readonly OrphanProcessCandidate[];
    declined: string | null;
  }> {
    const policy = this.#policy();
    // The cheapest refusal first: a machine with the setting off must not pay
    // for a process table walk to learn that.
    if (!policy.enabled) return { reaped: [], declined: "Automatic reaping is off." };
    const inventory = await this.scan();
    const pressure = await this.#memoryPressure();
    const selection = selectAutoReapable(inventory.candidates, policy, pressure);
    if (selection.reap.length === 0) return { reaped: [], declined: selection.declined };
    const report = await this.reap({
      scanRevision: inventory.revision,
      itemIds: selection.reap.map((candidate) => candidate.itemId),
    });
    if (report.reaped.length > 0) {
      this.#deps.notify?.(
        `Reaped ${report.reaped.length} orphaned ${report.reaped.length === 1 ? "process" : "processes"}`,
        `${describeReapedProcesses(report.reaped)} — ${pressure.detail}.`,
      );
    }
    return { reaped: report.reaped, declined: null };
  }

  /** Why this candidate may not be signalled right now, or null when it may. */
  #refuseReap(
    candidate: OrphanProcessCandidate,
    byPid: Map<number, ProcessFact>,
    guarded: Set<number>,
  ): string | null {
    // `held` is signalled on a person's explicit per-row word; only `not-volli`
    // is refused outright.
    if (candidate.stance === "not-volli") {
      return "Not Volli's to kill — it has a terminal of its own.";
    }
    if (guarded.has(candidate.pid)) return "This is Volli's own process.";
    const fact = byPid.get(candidate.pid);
    if (fact === undefined) return "It had already exited.";
    if (!ledgerEntryMatches({ pid: candidate.pid, startedAt: candidate.startedAt }, fact)) {
      return "That pid now belongs to a different process, so nothing was signalled.";
    }
    return null;
  }

  /**
   * SIGTERM, then SIGKILL after the grace, to the group when the candidate
   * leads one. Answers the outcome: `"ended"` when the process is gone,
   * `"refused"` when a signal could not be delivered, `null` when it is simply
   * still there.
   */
  async #terminate(candidate: OrphanProcessCandidate): Promise<"ended" | null> {
    // A candidate that leads its group takes the group with it; one that does
    // not is signalled alone, because its group belongs to somebody else.
    const leadsGroup = candidate.pgid !== null && candidate.pgid === candidate.pid;
    const target = leadsGroup ? -candidate.pid : candidate.pid;
    if (deliver(this.#signal, target, "SIGTERM") === "refused") return null;
    await new Promise<void>((resolve) => setTimeout(resolve, this.#killGraceMs));
    // Signal 0 asks "is it still there" without touching it. `gone` means the
    // TERM was enough, which is the ordinary case and costs no KILL. (A process
    // that died but has not been reaped by its parent still answers here; the
    // extra KILL that buys is harmless and cheaper than guessing.)
    if (deliver(this.#signal, candidate.pid, 0) === "gone") return "ended";
    if (deliver(this.#signal, target, "SIGKILL") === "refused") return null;
    return deliver(this.#signal, candidate.pid, 0) === "gone" ? "ended" : null;
  }

  /** What to tell a person about a process that outlived its own SIGKILL. */
  #survivedReason(candidate: OrphanProcessCandidate): string {
    return deliver(this.#signal, candidate.pid, 0) === "refused"
      ? "This machine would not let Volli signal it (try it from a terminal)."
      : "It was still running after SIGTERM and SIGKILL.";
  }

  /** Closes the rows whose processes are no longer in the table. */
  #closeVanishedRows(
    ledger: readonly SpawnLedgerEntry[],
    processes: readonly ProcessFact[],
    now: number,
  ): void {
    const byPid = new Map(processes.map((fact) => [fact.pid, fact] as const));
    for (const entry of ledger) {
      const fact = byPid.get(entry.pid);
      if (fact !== undefined && ledgerEntryMatches(entry, fact)) continue;
      this.#deps.ledger.markExited(entry.id, now);
    }
  }
}

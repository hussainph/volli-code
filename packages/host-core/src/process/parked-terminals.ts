/**
 * Terminals a previous launch left frozen (VC-833), and the one signal that
 * releases them.
 *
 * The warm-park tier SIGSTOPs a hidden, idle terminal's whole tree. An orderly
 * teardown CONTs it before the kill. A host that dies without one — a crash,
 * `kill -9`, a force quit — closes the PTY master instead: the kernel's hangup
 * SIGHUP reaches the shell, but a stopped process does not act on it, and the
 * shell's jobs are not orphaned while the shell lives. So the whole tree stays
 * stopped indefinitely, holding its memory, its open files and any lock (a
 * parked `git commit` holds `.git/index.lock`).
 *
 * The park controller marks the spawn-ledger row before the first SIGSTOP and
 * clears it on every wake, so a row still marked at the next launch names a
 * tree that may still be frozen. This module SIGCONTs that tree's group, which
 * delivers the pending SIGHUP: exactly what an unparked terminal already got
 * from the same crash. It sends nothing else — it never kills, and it never
 * touches a row it cannot prove is still the process the ledger recorded.
 *
 * IDENTITY IS RE-PROVEN FIRST, as the orphan reap does: a pid alone names
 * nothing after a crash, because the pid may since have been recycled onto a
 * stranger. A row is acted on only when a live process has its pid AND a start
 * time that agrees with the row.
 */
import { ledgerEntryMatches, type ProcessFact, type SpawnLedgerEntry } from "@volli/shared";

import { hostLogger } from "../log/root";
import { parsePsTable, PS_ARGS, runInventoryTool } from "./inventory";

const log = hostLogger("parked-terminals");

/** The ledger, as this recovery needs it. */
export interface ParkedTerminalLedger {
  /** Open terminal rows a launch before `parkedBefore` left marked parked. */
  listParkedTerminals(parkedBefore: number): SpawnLedgerEntry[];
  markParked(id: string, parkedAt: number | null): void;
}

export interface ParkedTerminalRecoveryPorts {
  ledger: ParkedTerminalLedger;
  /** When this launch began: a park this launch made is never treated as stranded. */
  launchedAt: number;
  /** The process table, or `null` when it could not be read. The real `ps` by default. */
  processes?: () => Promise<ProcessFact[] | null>;
  /** The signal seam; the real `process.kill` by default. */
  signal?: (target: number, signal: "SIGCONT") => void;
}

/** What the recovery did, for its log line and its tests. */
export interface ParkedTerminalRecovery {
  /** Rows whose tree was sent SIGCONT. */
  resumed: string[];
  /** Rows whose process is gone, or whose pid now belongs to something else: nothing was sent. */
  stale: string[];
  /** Rows the signal could not reach for any reason but "gone"; their mark stays for the next launch. */
  refused: string[];
}

/** The process table through the inventory's own bounded `ps`, or `null` when `ps` failed. */
async function readProcessTable(): Promise<ProcessFact[] | null> {
  const out = await runInventoryTool("ps", PS_ARGS);
  return out === null ? null : parsePsTable(out);
}

/**
 * SIGCONTs every terminal tree a previous launch left parked. Answers what it
 * did; never throws.
 *
 * The cheapest refusal comes first: with no marked row — every launch after an
 * orderly quit — the process table is never read.
 */
export async function resumeParkedTerminals(
  ports: ParkedTerminalRecoveryPorts,
): Promise<ParkedTerminalRecovery> {
  const report: ParkedTerminalRecovery = { resumed: [], stale: [], refused: [] };
  const rows = ports.ledger.listParkedTerminals(ports.launchedAt);
  if (rows.length === 0) return report;
  let processes: ProcessFact[] | null;
  try {
    processes = await (ports.processes ?? readProcessTable)();
  } catch {
    processes = null;
  }
  // No evidence, no action, and no mark cleared: the next launch tries again.
  if (processes === null) {
    log.warn("could not read the process table; parked terminals left for the next launch", {
      rows: rows.length,
    });
    return report;
  }
  const signal = ports.signal ?? ((target, sig) => process.kill(target, sig));
  const byPid = new Map(processes.map((fact) => [fact.pid, fact] as const));
  for (const row of rows) {
    const fact = byPid.get(row.pid);
    if (fact === undefined || !ledgerEntryMatches(row, fact)) {
      // Gone, or recycled onto a stranger: there is no frozen tree of ours
      // under this pid, and there never will be again.
      report.stale.push(row.id);
      ports.ledger.markParked(row.id, null);
      continue;
    }
    // The shell leads its own group (node-pty `setsid`s it), and the group is
    // what was frozen with it. A process that no longer leads its group is
    // continued alone: that group is somebody else's.
    const target = fact.pgid === fact.pid ? -fact.pid : fact.pid;
    try {
      signal(target, "SIGCONT");
      report.resumed.push(row.id);
      ports.ledger.markParked(row.id, null);
    } catch (error) {
      if ((error as NodeJS.ErrnoException | null)?.code === "ESRCH") {
        report.stale.push(row.id);
        ports.ledger.markParked(row.id, null);
      } else {
        report.refused.push(row.id);
      }
    }
  }
  if (report.resumed.length > 0 || report.refused.length > 0) {
    log.info("resumed terminals a previous launch left parked", {
      resumed: report.resumed.length,
      refused: report.refused.length,
    });
  }
  return report;
}

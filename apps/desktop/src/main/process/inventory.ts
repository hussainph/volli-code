/**
 * What is actually running, as two POSIX tools report it (VC-341).
 *
 * `ps` answers "which processes exist, since when, how big, and on whose
 * terminal". `lsof -d cwd` answers the question nothing else can: where each
 * process is STANDING. That second answer is the whole safety net — a daemon
 * that double-forks or calls `setsid` leaves the process group Volli started
 * and stops resembling anything Volli spawned, but it keeps its working
 * directory, and a working directory under a Ticket's worktree still names the
 * Ticket.
 *
 * NO NATIVE DEPENDENCY. `proc_pidinfo` would answer the cwd question without a
 * subprocess, and adding a native module to ask it would cost this app an ABI
 * to rebuild on every Electron bump, in exchange for milliseconds on a scan a
 * person presses a button for. `lsof` ships with macOS and is already how the
 * park controller inspects processes.
 *
 * THE PARSERS ARE PURE AND THE RUNNER IS A SEAM, deliberately: parsing `ps`
 * output is where a sweep silently mis-attributes a process, and it must be
 * testable against fixture text on any machine rather than only against
 * whatever happens to be running on the developer's. Both parsers are written
 * to DROP a line they cannot read rather than to guess at it — a malformed row
 * that became a candidate would be a kill aimed at a number nobody measured.
 *
 * Everything here is macOS-shaped, which is what this app ships on. `lstart`'s
 * format and `rss` in kibibytes are BSD `ps` conventions; a Linux `ps` prints
 * both differently, and the parser answers with nothing rather than with a
 * misread number.
 */
import { execFile } from "node:child_process";

import type { ProcessFact } from "@volli/shared";

/** How long either tool gets before the inventory gives up on it. */
export const INVENTORY_TIMEOUT_MS = 15_000;
/** Enough for a machine with thousands of processes; a bound rather than a budget. */
const INVENTORY_MAX_BUFFER = 8 * 1024 * 1024;

/** Runs one read-only tool and answers with its stdout, or `null` when it could not run. */
export type InventoryRunner = (file: string, args: readonly string[]) => Promise<string | null>;

/** The default runner: the tool itself, bounded in time and output. */
export const runInventoryTool: InventoryRunner = (file, args) =>
  new Promise((resolve) => {
    execFile(
      file,
      [...args],
      { timeout: INVENTORY_TIMEOUT_MS, maxBuffer: INVENTORY_MAX_BUFFER, encoding: "utf8" },
      // stderr is dropped on purpose: `lsof` reports every process it may not
      // inspect there, and a permission it never had is not a finding.
      (error, stdout) => resolve(error !== null && stdout.length === 0 ? null : stdout),
    );
  });

/** The `ps` request, kept beside its parser so the two cannot drift. */
export const PS_ARGS = ["-Ao", "pid=,ppid=,pgid=,rss=,tty=,lstart=,command="] as const;

/** The `lsof` request: every process's working directory, one field pair each. */
export const LSOF_ARGS = ["-d", "cwd", "-F", "pn", "-w"] as const;

/**
 * One `ps` row into a fact, or `null` when it cannot be read as one.
 *
 * The shape is fixed by {@link PS_ARGS}: five leading columns, then `lstart`'s
 * five words (`Tue Jul 21 01:41:03 2026`), then the command — which is the only
 * field allowed to contain spaces, and so is everything that is left.
 */
export function parsePsLine(line: string): ProcessFact | null {
  const words = line.trim().split(/\s+/);
  if (words.length < 11) return null;
  const [pid, ppid, pgid, rssKib, tty, ...rest] = words;
  const numbers = [pid, ppid, pgid, rssKib].map((word) => Number(word));
  if (numbers.some((value) => !Number.isInteger(value) || value < 0)) return null;
  const startedAt = Date.parse(rest.slice(0, 5).join(" "));
  if (!Number.isFinite(startedAt)) return null;
  const command = rest.slice(5).join(" ");
  if (command.length === 0) return null;
  return {
    pid: numbers[0]!,
    ppid: numbers[1]!,
    pgid: numbers[2]!,
    // `ps` reports RSS in kibibytes; the panel and every threshold speak bytes.
    rssBytes: numbers[3]! * 1024,
    // `??` is BSD `ps` for "no controlling terminal", which is the difference
    // between a daemon and a person's shell.
    tty: tty === "??" || tty === "?" || tty === "-" ? null : tty!,
    startedAt,
    command,
    cwd: null,
  };
}

/** Every readable row of a `ps` table. */
export function parsePsTable(stdout: string): ProcessFact[] {
  return stdout
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .flatMap((line) => {
      const fact = parsePsLine(line);
      return fact === null ? [] : [fact];
    });
}

/**
 * `lsof -F` output into pid → working directory.
 *
 * The format is one field per line, each prefixed by its letter, with `p`
 * opening a process's set. Unknown letters (`f`, which `-d` prints whether or
 * not it was asked for) are skipped rather than treated as an error: `-F`'s
 * contract is that a reader takes the fields it knows.
 */
export function parseLsofCwd(stdout: string): Map<number, string> {
  const cwds = new Map<number, string>();
  let pid: number | null = null;
  for (const line of stdout.split("\n")) {
    const letter = line[0];
    const value = line.slice(1);
    if (letter === "p") {
      const parsed = Number(value);
      pid = Number.isInteger(parsed) && parsed > 0 ? parsed : null;
    } else if (letter === "n" && pid !== null && value.startsWith("/")) {
      // First name wins: a process has one cwd, and a second `n` under the same
      // `p` would be a file this selection was never supposed to include.
      if (!cwds.has(pid)) cwds.set(pid, value);
    }
  }
  return cwds;
}

/**
 * The machine's process table with working directories merged in.
 *
 * A pid `lsof` could not report keeps `cwd: null` — a process this app may not
 * inspect is a measurement gap, not a process standing at the root — and the
 * cwd sweep simply says nothing about it. When `ps` itself cannot run, the
 * answer is an empty inventory: with no evidence, nothing is a candidate.
 */
export async function readProcessInventory(
  run: InventoryRunner = runInventoryTool,
): Promise<ProcessFact[]> {
  const [psOut, lsofOut] = await Promise.all([run("ps", PS_ARGS), run("lsof", LSOF_ARGS)]);
  if (psOut === null) return [];
  const cwds = lsofOut === null ? new Map<number, string>() : parseLsofCwd(lsofOut);
  const facts = parsePsTable(psOut);
  for (const fact of facts) fact.cwd = cwds.get(fact.pid) ?? null;
  return facts;
}

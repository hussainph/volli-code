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

/**
 * Runs one read-only tool and answers with its stdout, or `null` when it could
 * not run. `ps` must report C-locale UTC start times; other tools inherit the
 * caller's environment. {@link parseLsofCwd} decodes lsof names across locales.
 */
export type InventoryRunner = (file: string, args: readonly string[]) => Promise<string | null>;

/** The default runner: the tool itself, bounded in time and output. */
export const runInventoryTool: InventoryRunner = (file, args) =>
  new Promise((resolve) => {
    execFile(
      file,
      [...args],
      {
        timeout: INVENTORY_TIMEOUT_MS,
        maxBuffer: INVENTORY_MAX_BUFFER,
        encoding: "utf8",
        // Pin only ps; lsof inherits the caller's locale and its names are decoded.
        ...(file === "ps" ? { env: { ...process.env, LC_ALL: "C", TZ: "UTC" } } : {}),
      },
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
 * five words (`Tue Jul 21 01:41:03 2026`, in C locale and UTC as requested by
 * the runner), then the command — which is the only field allowed to contain
 * spaces, and so is everything that is left.
 */
export function parsePsLine(line: string): ProcessFact | null {
  const words = line.trim().split(/\s+/);
  if (words.length < 11) return null;
  const [pid, ppid, pgid, rssKib, tty, ...rest] = words;
  const numbers = [pid, ppid, pgid, rssKib].map((word) => Number(word));
  if (numbers.some((value) => !Number.isInteger(value) || value < 0)) return null;
  const startedAt = Date.parse(`${rest.slice(0, 5).join(" ")} UTC`);
  if (!Number.isFinite(startedAt)) return null;
  // Whatever is left after the date is the command, and there is always
  // something left: a line with fewer than eleven words was refused above.
  const command = rest.slice(5).join(" ");
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

const LSOF_C_ESCAPES: Readonly<Record<string, number>> = {
  "\\": 0x5c,
  b: 0x08,
  f: 0x0c,
  r: 0x0d,
  n: 0x0a,
  t: 0x09,
};

/**
 * Apple's lsof `safestrprt` / `safepup` quote backslashes as `\\`, C whitespace
 * as `\[bfrnt]`, and non-printable bytes as `\xNN`. Decode bytes BEFORE UTF-8,
 * not each escape as a character: C/missing locales escape every non-ASCII byte.
 *
 * Caret notation (`^@`…`^_` / `^?`) is ambiguous: literal carets are NOT quoted.
 * Conservatively drop those spellings instead of choosing either cwd identity.
 * A UTF-8 LC_CTYPE would not fix this ambiguity (or non-printable Unicode), and
 * is overridden by an inherited LC_ALL. Keep lsof's inherited environment intact.
 * Contract: https://github.com/apple-oss-distributions/lsof/blob/main/lsof/misc.c
 */
function decodeLsofName(value: string): string | null {
  // Raw controls, lone surrogates, and replacements are not readable lsof output.
  if (/[\p{Cc}\p{Cs}\uFFFD]|\^[@-_?]/u.test(value)) return null;
  const chunks: Buffer[] = [];
  let offset = 0;
  for (const match of value.matchAll(/\\(x[0-9a-f]{2}|[\\bfrnt])|\\/g)) {
    chunks.push(Buffer.from(value.slice(offset, match.index)));
    const escaped = match[1];
    if (escaped === undefined) return null;
    const byte = escaped.startsWith("x")
      ? Number.parseInt(escaped.slice(1), 16)
      : LSOF_C_ESCAPES[escaped]!;
    chunks.push(Buffer.from([byte]));
    offset = match.index + match[0].length;
  }
  chunks.push(Buffer.from(value.slice(offset)));
  try {
    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
    // A NUL cannot be part of a POSIX pathname, even if written as an escape.
    return decoded.includes("\0") ? null : decoded;
  } catch {
    // Invalid UTF-8 must not become U+FFFD and accidentally name another cwd.
    return null;
  }
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
  const seen = new Set<number>();
  let pid: number | null = null;
  for (const line of stdout.split("\n")) {
    const letter = line[0];
    const value = line.slice(1);
    if (letter === "p") {
      const parsed = Number(value);
      pid = Number.isInteger(parsed) && parsed > 0 ? parsed : null;
    } else if (letter === "n" && pid !== null) {
      // First name wins, even if unreadable: a second `n` would be a file
      // this selection was never supposed to include, not a fallback cwd.
      if (!seen.has(pid)) {
        seen.add(pid);
        const cwd = value.startsWith("/") ? decodeLsofName(value) : null;
        if (cwd !== null) cwds.set(pid, cwd);
      }
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

/**
 * `volli doctor` — the client half, whose whole job is to observe rather than
 * to report configuration.
 *
 * This process runs inside the environment under test, which is the only place
 * several of the questions have a truthful answer. Main can say which wrappers
 * it wrote; only a process living in the session can say what the shell would
 * actually run. The defect this command exists for was invisible precisely
 * because every component reported its own configuration correctly, so the
 * split is load-bearing: nothing here asks main what the environment looks
 * like, and nothing in main substitutes an assumption for what is measured
 * here.
 */
import { constants } from "node:fs";
import { access, readdir, realpath, stat } from "node:fs/promises";
import { dirname } from "node:path";

import {
  harnessAdapters,
  isBareHarnessCommand,
  resolveOnPath,
  SESSION_ENV_TOOLS,
  VOLLI_BIN_DIR_ENV,
} from "@volli/shared";
import type { DoctorCheck, SessionEnvRepair } from "@volli/shared";

export interface DoctorEnvironment {
  env: Record<string, string | undefined>;
  /** Whether a path is executable — the same question a shell asks of PATH. */
  isExecutable(path: string): Promise<boolean>;
  /** What a directory holds, or `[]` when it cannot be read — an unreadable dir names nothing. */
  entriesIn(path: string): Promise<string[]>;
  /** A path with its symlinks followed, or `null` when it cannot be resolved. */
  realPathOf(path: string): Promise<string | null>;
}

/**
 * Whether a path is executable the way a shell judges it: a REGULAR FILE
 * with execute permission. `access(X_OK)` alone passes for a directory, and
 * a directory named after a tool on some PATH entry must not be reported as
 * the tool. `stat` follows symlinks, so a link to an executable still counts.
 */
export async function executableAt(path: string): Promise<boolean> {
  try {
    if (!(await stat(path)).isFile()) return false;
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export async function entriesInDirectory(path: string): Promise<string[]> {
  try {
    return await readdir(path);
  } catch {
    return [];
  }
}

export async function realPathOfFile(path: string): Promise<string | null> {
  try {
    return await realpath(path);
  } catch {
    return null;
  }
}

export function processEnvironment(): DoctorEnvironment {
  return {
    env: process.env,
    isExecutable: executableAt,
    entriesIn: entriesInDirectory,
    realPathOf: realPathOfFile,
  };
}

/**
 * The first executable named `command` on `pathEntries` — what this shell
 * would pick, resolved without invoking one. Defined once in `@volli/shared`
 * (`resolveOnPath`) so doctor's resolution and `volli identify`'s env block
 * share one notion of "found"; re-exported under its doctor name for the
 * callers and tests that already use it. Volli's own bin dir is deliberately
 * NOT skipped here, unlike everywhere else: finding our wrapper first is the
 * answer we are looking for, not an obstacle to seeing past.
 */
export { resolveOnPath as resolveHere };

/**
 * Volli's own bin dir, as a process living outside main can find it. The shell
 * chain exports it and that is the authoritative answer; failing that it is the
 * directory the `volli` shim really lives in, since the global link is a
 * symlink into that same dir. Both routes are needed — a non-zsh session gets
 * no chain, and a `doctor` run from a plain terminal gets no session at all.
 */
async function volliBinDir(
  volliPath: string | null,
  environment: DoctorEnvironment,
): Promise<string | null> {
  const exported = environment.env[VOLLI_BIN_DIR_ENV];
  if (exported !== undefined && exported.length > 0) return exported;
  if (volliPath === null) return null;
  const shimPath = await environment.realPathOf(volliPath);
  return shimPath === null ? null : dirname(shimPath);
}

/**
 * Every command name worth resolving. The built-in adapters are only part of
 * the set the checks iterate: a REGISTERED harness has a wrapper too, and its
 * command name appears nowhere in this process's code — so resolving only the
 * built-ins left every registered harness reported as resolving to nothing,
 * which is the one lie a resolution diagnostic may not tell.
 *
 * The wrappers themselves are therefore the census. They are read out of the
 * directory the generator writes them into, under the same
 * `isBareHarnessCommand` filter it writes them under, so the set measured here
 * and the set the checks iterate cannot drift apart.
 */
async function commandsToResolve(
  binDir: string | null,
  environment: DoctorEnvironment,
): Promise<string[]> {
  const wrapperNames =
    binDir === null ? [] : (await environment.entriesIn(binDir)).filter(isBareHarnessCommand);
  return [...new Set([...harnessAdapters.map((adapter) => adapter.command), ...wrapperNames])];
}

/**
 * `path` as the filesystem actually resolves it, for a value that is about to
 * be compared byte-for-byte against main's own idea of the same file
 * (`volliCheck`, `packages/shared/src/doctor.ts`): a symlink followed (the
 * user-space `~/.local/bin/volli` link main installs points AT the shim rather
 * than BEING it, so an unresolved comparison reads a correct install as
 * "another install owns the link"), and on macOS `/tmp` normalized to
 * `/private/tmp` the same way. `null` stays `null` — nothing to resolve — and
 * a path `realpath` cannot follow is reported exactly as found, since a stale
 * entry unresolvable here is still worth comparing as-is rather than losing
 * silently.
 */
async function canonicalPath(
  path: string | null,
  environment: DoctorEnvironment,
): Promise<string | null> {
  if (path === null) return null;
  return (await environment.realPathOf(path)) ?? path;
}

/**
 * What this process can see, packaged for the socket. The session id rides in
 * the request context main already builds, so it is deliberately absent here.
 */
export async function observeEnvironment(
  environment: DoctorEnvironment = processEnvironment(),
): Promise<Record<string, unknown>> {
  const pathEntries = (environment.env["PATH"] ?? "").split(":").filter(Boolean);
  const volliPath = await resolveOnPath(pathEntries, "volli", environment);
  const binDir = await volliBinDir(volliPath, environment);
  const resolved: Record<string, string | null> = {};
  for (const command of await commandsToResolve(binDir, environment)) {
    resolved[command] = await resolveOnPath(pathEntries, command, environment);
  }
  // The session tools are measured on every run, with or without harnesses:
  // a machine with no agent installed still needs `git` audited. Measuring is
  // not requiring — which of these absences is a fault is decided per project
  // (`requiredSessionEnvTools`, sent beside this observation).
  // They share the `resolved` map with harness commands — a harness that would
  // take a system tool's name is refused, so the keys never collide.
  for (const tool of SESSION_ENV_TOOLS) {
    resolved[tool] = await resolveOnPath(pathEntries, tool, environment);
  }
  return {
    pathEntries,
    zdotDir: environment.env["ZDOTDIR"] ?? null,
    resolved,
    volliPath: await canonicalPath(volliPath, environment),
  };
}

const MARK: Record<DoctorCheck["status"], string> = { ok: "✓", warn: "!", fail: "✗" };

/** One check as a human reads it: a mark, the claim, and what was actually seen. */
export function renderDoctorCheck(check: DoctorCheck): string {
  const lines = [`${MARK[check.status]} ${check.title}`, `    ${check.detail}`];
  if (check.remedy !== undefined) lines.push(`    → ${check.remedy}`);
  return lines.join("\n");
}

function repairedDirectories(entries: readonly string[]): string {
  return entries.length === 0 ? "-" : entries.join(" ");
}

/**
 * The repair is main's fact; the checks remain the calling Session's fact.
 * Putting both in one report makes the boundary explicit instead of calling a
 * stale running Session healthy after main repaired the environment new
 * Sessions will inherit.
 */
export function renderSessionPathRepair(repair: SessionEnvRepair): string {
  return [
    "Session PATH repair",
    `    env.path  ${repair.path}`,
    `    env.provenance  ${repair.provenance}`,
    `    env.added  ${repairedDirectories(repair.added)}`,
    `    env.interactiveProvenance  ${repair.interactiveProvenance}`,
    `    env.interactiveAdded  ${repairedDirectories(repair.interactiveAdded)}`,
    "    Sessions started after this repair use this PATH. This running Session keeps the environment it started with.",
  ].join("\n");
}

export function renderDoctorReport(
  checks: readonly DoctorCheck[],
  summary: string,
  repair?: SessionEnvRepair,
): string {
  const repaired = repair === undefined ? "" : `${renderSessionPathRepair(repair)}\n\n`;
  return `${repaired}${checks.map(renderDoctorCheck).join("\n")}\n\n${summary}\n`;
}

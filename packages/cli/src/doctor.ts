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
import { access, readdir, realpath } from "node:fs/promises";
import { dirname, join } from "node:path";

import { harnessAdapters, isBareHarnessCommand, VOLLI_BIN_DIR_ENV } from "@volli/shared";
import type { DoctorCheck } from "@volli/shared";

export interface DoctorEnvironment {
  env: Record<string, string | undefined>;
  /** Whether a path is executable — the same question a shell asks of PATH. */
  isExecutable(path: string): Promise<boolean>;
  /** What a directory holds, or `[]` when it cannot be read — an unreadable dir names nothing. */
  entriesIn(path: string): Promise<string[]>;
  /** A path with its symlinks followed, or `null` when it cannot be resolved. */
  realPathOf(path: string): Promise<string | null>;
}

export async function executableAt(path: string): Promise<boolean> {
  try {
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
 * The first executable named `command` on `pathEntries` — what this shell would
 * pick, resolved without invoking one. Volli's own bin dir is NOT skipped here,
 * unlike everywhere else: finding our wrapper first is the answer we are
 * looking for, not an obstacle to seeing past.
 */
export async function resolveHere(
  pathEntries: readonly string[],
  command: string,
  environment: DoctorEnvironment,
): Promise<string | null> {
  for (const directory of pathEntries) {
    const candidate = join(directory, command);
    if (await environment.isExecutable(candidate)) return candidate;
  }
  return null;
}

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
 * What this process can see, packaged for the socket. The session id rides in
 * the request context main already builds, so it is deliberately absent here.
 */
export async function observeEnvironment(
  environment: DoctorEnvironment = processEnvironment(),
): Promise<Record<string, unknown>> {
  const pathEntries = (environment.env["PATH"] ?? "").split(":").filter(Boolean);
  const volliPath = await resolveHere(pathEntries, "volli", environment);
  const binDir = await volliBinDir(volliPath, environment);
  const resolved: Record<string, string | null> = {};
  for (const command of await commandsToResolve(binDir, environment)) {
    resolved[command] = await resolveHere(pathEntries, command, environment);
  }
  return {
    pathEntries,
    zdotDir: environment.env["ZDOTDIR"] ?? null,
    resolved,
    volliPath,
  };
}

const MARK: Record<DoctorCheck["status"], string> = { ok: "✓", warn: "!", fail: "✗" };

/** One check as a human reads it: a mark, the claim, and what was actually seen. */
export function renderDoctorCheck(check: DoctorCheck): string {
  const lines = [`${MARK[check.status]} ${check.title}`, `    ${check.detail}`];
  if (check.remedy !== undefined) lines.push(`    → ${check.remedy}`);
  return lines.join("\n");
}

export function renderDoctorReport(checks: readonly DoctorCheck[], summary: string): string {
  return `${checks.map(renderDoctorCheck).join("\n")}\n\n${summary}\n`;
}

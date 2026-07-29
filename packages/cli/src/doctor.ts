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
import { access } from "node:fs/promises";
import { join } from "node:path";

import { harnessAdapters } from "@volli/shared";
import type { DoctorCheck } from "@volli/shared";

export interface DoctorEnvironment {
  env: Record<string, string | undefined>;
  /** Whether a path is executable — the same question a shell asks of PATH. */
  isExecutable(path: string): Promise<boolean>;
}

export async function executableAt(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function processEnvironment(): DoctorEnvironment {
  return { env: process.env, isExecutable: executableAt };
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

/** Every command name worth resolving: the built-in harnesses, plus `volli`. */
function commandsToResolve(): string[] {
  return [...new Set(harnessAdapters.map((adapter) => adapter.command))];
}

/**
 * What this process can see, packaged for the socket. The session id rides in
 * the request context main already builds, so it is deliberately absent here.
 */
export async function observeEnvironment(
  environment: DoctorEnvironment = processEnvironment(),
): Promise<Record<string, unknown>> {
  const pathEntries = (environment.env["PATH"] ?? "").split(":").filter(Boolean);
  const resolved: Record<string, string | null> = {};
  for (const command of commandsToResolve()) {
    resolved[command] = await resolveHere(pathEntries, command, environment);
  }
  return {
    pathEntries,
    zdotDir: environment.env["ZDOTDIR"] ?? null,
    resolved,
    volliPath: await resolveHere(pathEntries, "volli", environment),
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

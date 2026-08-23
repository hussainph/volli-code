/**
 * The in-app half of `volli doctor` (VC-52): Settings → CLI runs the REAL
 * probe — a login shell resolving `volli` off its own PATH and running
 * `volli doctor --json` — rather than main synthesizing an observation about an
 * environment it does not live in. That split is doctor's whole design
 * (`packages/shared/src/doctor.ts`): main knows what it wrote, and only a
 * process inside the environment under test can say what a shell would run.
 * Spawning the user's login shell IS that environment — the exact one the
 * acceptance question "does `volli` work in a plain terminal?" is about — so a
 * broken link, a missing PATH entry, or a foreign shim all surface here as the
 * findings they are instead of being reconstructed.
 *
 * The spawn hygiene mirrors `login-shell-path.ts` and for the same measured reasons:
 * stdin is /dev/null (an rc that prompts must not hang the pane), the shell
 * runs detached and the TIMEOUT kills the process group (a profile that leaves
 * a foreground child holding the pipe would otherwise never complete), and the
 * marker makes the answer findable inside an interactive shell's chatter.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

import { errorMessage } from "@volli/shared";
import type { DoctorCheck, DoctorStatus } from "@volli/shared";

import type { CliDoctorResult } from "../ipc/contract";

/** Generous next to one command, tight next to a click: doctor itself is a socket round-trip. */
const DOCTOR_TIMEOUT_MS = 15_000;
const MAX_OUTPUT_BYTES = 1 << 20;
const DOCTOR_MARKER = "__VOLLI_DOCTOR__";
/**
 * stderr is dropped on purpose: a missing `volli` prints "command not found"
 * there, and the absence of marked output already reports that, in a sentence
 * that names the remedy instead of echoing shell noise into the pane.
 */
const DOCTOR_COMMAND = `printf ${DOCTOR_MARKER}; volli doctor --json 2>/dev/null`;

export interface CliDoctorDeps {
  /** The user's login shell binary (`resolveShell`). */
  shellFile: string;
  /**
   * The project root to run the probe in, or `null` for none in scope.
   *
   * `volli doctor` decides which tool absences are faults from its own cwd
   * (VC-157), so the probe has to STAND in the project the pane is describing.
   * Left to inherit, it would take main's cwd — `/` under launchd — and report
   * every tool as required by nothing, including a `git` that is genuinely
   * missing. Only in dev, where main's cwd happens to be the checkout, would
   * that look correct.
   */
  cwd?: string | null;
  /** Test seam over the spawn; resolves whatever the shell printed. */
  runShell?(file: string, args: readonly string[], cwd: string | null): Promise<string>;
}

async function runLoginShell(
  file: string,
  args: readonly string[],
  cwd: string | null,
): Promise<string> {
  const child = spawn(file, [...args], {
    detached: true,
    stdio: ["ignore", "pipe", "ignore"],
    // A cwd that has gone (a project folder deleted while Settings is open)
    // makes spawn throw ENOENT, which would report a missing folder as a
    // broken login shell. Falling back to inherited is the honest degrade:
    // the probe still answers, and only the project-scoped half is unknown.
    ...(cwd !== null && existsSync(cwd) ? { cwd } : {}),
  });
  let output = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    if (output.length < MAX_OUTPUT_BYTES) output += chunk;
  });
  const timer = setTimeout(() => {
    try {
      if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
    } catch {
      // Already gone, which is the outcome the kill was after.
    }
  }, DOCTOR_TIMEOUT_MS);
  try {
    await new Promise<void>((resolve, reject) => {
      child.once("error", reject);
      // `close`, not `exit`: the pipe outliving the shell is the hazard.
      child.once("close", () => resolve());
    });
  } finally {
    clearTimeout(timer);
  }
  return output;
}

function isDoctorStatus(value: unknown): value is DoctorStatus {
  return value === "ok" || value === "warn" || value === "fail";
}

function isDoctorCheck(value: unknown): value is DoctorCheck {
  if (typeof value !== "object" || value === null) return false;
  const check = value as Record<string, unknown>;
  return (
    typeof check["id"] === "string" &&
    typeof check["title"] === "string" &&
    isDoctorStatus(check["status"]) &&
    typeof check["detail"] === "string" &&
    (check["remedy"] === undefined || typeof check["remedy"] === "string")
  );
}

/** The `{ checks, summary }` the CLI printed, or `null` when the output holds no such report. */
export function parseDoctorOutput(
  stdout: string,
): { checks: DoctorCheck[]; summary: string } | null {
  const marked = stdout.lastIndexOf(DOCTOR_MARKER);
  if (marked === -1) return null;
  const payload = stdout.slice(marked + DOCTOR_MARKER.length).trim();
  if (payload.length === 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const { checks, summary } = parsed as { checks?: unknown; summary?: unknown };
  if (!Array.isArray(checks) || !checks.every(isDoctorCheck) || typeof summary !== "string") {
    return null;
  }
  return { checks, summary };
}

export async function probeCliDoctor(deps: CliDoctorDeps): Promise<CliDoctorResult> {
  const runShell = deps.runShell ?? runLoginShell;
  let stdout: string;
  try {
    stdout = await runShell(deps.shellFile, ["-l", "-i", "-c", DOCTOR_COMMAND], deps.cwd ?? null);
  } catch (error) {
    return { ok: false, error: `The login shell could not be run: ${errorMessage(error)}` };
  }
  const report = parseDoctorOutput(stdout);
  if (report === null) {
    return {
      ok: false,
      // The probe failing IS a diagnosis: a login shell that cannot produce a
      // doctor report could not have run `volli` for an agent either.
      error:
        "`volli` did not answer from a login shell — the link or PATH entry is missing, or the app socket is down.",
    };
  }
  return { ok: true, ...report };
}

/**
 * What `install`, `start`, `enroll` and `status --json` share (VC-700): the
 * system they touch, as ports, so every rule is tested on any OS against a
 * temporary directory and a fake `systemctl`; the record `install` leaves for
 * `start`; and the one-line JSON answer each prints (`@volli/host-install/
 * contract`).
 */
import { existsSync, readFileSync } from "node:fs";

import type { HostdFailure, HostdFailureCode, InstallMode } from "@volli/host-install/contract";

import type { InstallLayout } from "./layout";
import { LAUNCHD_LABEL, SERVICE_UNIT } from "./layout";
import { atomicWrite } from "./write-file";

export interface CommandResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Runs a system tool by name: `systemctl`, `useradd`, `usermod`, `loginctl`, `id`, `journalctl`. */
export type RunTool = (tool: string, args: readonly string[]) => CommandResult;

/** A refusal or failure with its typed code: the command prints it and exits non-zero. */
export class ManagementError extends Error {
  constructor(
    readonly code: HostdFailureCode,
    message: string,
    readonly detail: readonly string[] = [],
    readonly exitCode = 1,
  ) {
    super(message);
  }
}

export function failureJson(error: ManagementError): HostdFailure {
  return {
    v: 1,
    ok: false,
    code: error.code,
    message: error.message,
    ...(error.detail.length === 0 ? {} : { detail: error.detail }),
  };
}

/** Prints one answer and returns its exit code; anything else thrown is a bug and propagates. */
export async function answer(out: (text: string) => void, work: () => unknown): Promise<number> {
  try {
    out(`${JSON.stringify(await work())}\n`);
    return 0;
  } catch (error) {
    if (!(error instanceof ManagementError)) throw error;
    out(`${JSON.stringify(failureJson(error))}\n`);
    return error.exitCode;
  }
}

/** Runs a tool that must succeed; a failure is `command-failed`, naming it and its stderr. */
export function must(run: RunTool, tool: string, args: readonly string[]): CommandResult {
  const result = run(tool, args);
  if (result.code !== 0) {
    throw new ManagementError(
      "command-failed",
      `${tool} ${args.join(" ")} failed (exit ${result.code}).`,
      result.stderr.trim().split("\n").filter(Boolean).slice(-10),
    );
  }
  return result;
}

/** `systemctl`'s arguments for this mode: `--user` for a user unit. */
export function systemctlArgs(mode: InstallMode, ...args: string[]): string[] {
  return mode === "user" ? ["--user", ...args] : args;
}

export interface UnitState {
  readonly name: string;
  readonly active: string;
  readonly enabled: string;
}

/** The service unit's ActiveState and UnitFileState; `unknown` when systemd will not say. */
export function unitState(run: RunTool, mode: InstallMode): UnitState {
  const result = run(
    "systemctl",
    systemctlArgs(mode, "show", SERVICE_UNIT, "-p", "ActiveState", "-p", "UnitFileState"),
  );
  const field = (name: string): string =>
    result.code === 0
      ? new RegExp(`^${name}=(.*)$`, "mu").exec(result.stdout)?.[1]?.trim() || "unknown"
      : "unknown";
  return { name: SERVICE_UNIT, active: field("ActiveState"), enabled: field("UnitFileState") };
}

/**
 * A Mac's agent as launchd sees it in the per-user domain: `active` while it
 * runs, `inactive` when it is not loaded or between runs; `enabled` while
 * its plist is in ~/Library/LaunchAgents.
 */
export function agentState(run: RunTool, layout: InstallLayout, uid: number): UnitState {
  const printed = run("launchctl", ["print", `user/${uid}/${LAUNCHD_LABEL}`]);
  const state = /^\s*state = (.+)$/mu.exec(printed.stdout)?.[1]?.trim();
  return {
    name: LAUNCHD_LABEL,
    active: printed.code === 0 && state === "running" ? "active" : "inactive",
    enabled: existsSync(layout.agentPlist!) ? "enabled" : "not-found",
  };
}

/** Whether `login`'s user units outlive their sessions; `null` when logind will not say. */
export function lingerOf(run: RunTool, login: string): boolean | null {
  const result = run("loginctl", ["show-user", login, "-p", "Linger", "--value"]);
  if (result.code !== 0) return null;
  const value = result.stdout.trim();
  return value === "yes" ? true : value === "no" ? false : null;
}

/** What `install` configured, for `start` to converge to and `status` to report. */
export interface ManagedRecord {
  readonly v: 1;
  readonly mode: InstallMode;
  readonly version: string;
  /** The release directory `current` names (`<version>-<revision>`); absent before it was recorded. */
  readonly release?: string;
  /** The release `start` last brought up: a revision change restarts even at one version. */
  readonly started?: string;
  readonly port: number;
  readonly installedAt: string;
}

export function readManaged(layout: InstallLayout): ManagedRecord | null {
  try {
    const parsed = JSON.parse(readFileSync(layout.managedFile, "utf8")) as Partial<ManagedRecord>;
    return parsed.v === 1 &&
      parsed.mode === layout.mode &&
      typeof parsed.version === "string" &&
      typeof parsed.port === "number"
      ? (parsed as ManagedRecord)
      : null;
  } catch {
    return null;
  }
}

export function writeManaged(layout: InstallLayout, record: ManagedRecord): void {
  atomicWrite(layout.managedFile, `${JSON.stringify(record, null, 2)}\n`, 0o644);
}

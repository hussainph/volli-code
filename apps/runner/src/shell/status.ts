/**
 * A headless daemon's health surface: `<dataDir>/<prefix>-status.json`, and
 * the `<program> status` check that reads it.
 *
 * The running daemon rewrites the file (atomically, mode 0600) at every state
 * change. It holds no secret. The fields every daemon writes are
 * {@link ShellStatus}; each daemon adds its own (hostd its capabilities and
 * database, the runner its link state).
 *
 * A file alone could be stale after a crash, so `status` believes it only
 * when its pid is alive AND its socket accepts a connection. Exit codes:
 *
 * | code | meaning                                                          |
 * | ---- | ---------------------------------------------------------------- |
 * | 0    | serving                                                          |
 * | 1    | up, but refusing to serve                                        |
 * | 3    | not serving: stopped, starting, stopping, crashed or unreachable |
 *
 * Which recorded states count as serving and refusing is each daemon's to
 * say (`checkStatus`'s `verdictOf`).
 */
import { randomBytes } from "node:crypto";
import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { join } from "node:path";

import type { ShellIdentity } from "./identity";

/** What every daemon's status file holds, whatever else it adds. */
export interface ShellStatus<State extends string = string> {
  readonly v: 1;
  readonly state: State;
  readonly pid: number;
  readonly version: string;
  readonly startedAt: string;
  readonly updatedAt: string;
  readonly dataDir: string;
  readonly socketPath: string;
}

/** `<prefix>-status.json`: durable, the file a running install already writes. */
export function statusFileName(identity: ShellIdentity): string {
  return `${identity.filePrefix}-status.json`;
}

export function statusFilePath(identity: ShellIdentity, dataDir: string): string {
  return join(dataDir, statusFileName(identity));
}

/** Replaces the status file whole: a reader never sees half of one. */
export function writeStatus(identity: ShellIdentity, dataDir: string, status: ShellStatus): void {
  const path = statusFilePath(identity, dataDir);
  const temporary = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(status, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

/** The recorded status, `null` when there is none, `"unreadable"` when it is not one. */
export function readStatus<S extends ShellStatus>(
  identity: ShellIdentity,
  dataDir: string,
): S | null | "unreadable" {
  let text: string;
  try {
    text = readFileSync(statusFilePath(identity, dataDir), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    return "unreadable";
  }
  try {
    const parsed = JSON.parse(text) as Partial<S> | null;
    return parsed?.v === 1 &&
      typeof parsed.pid === "number" &&
      typeof parsed.socketPath === "string"
      ? (parsed as S)
      : "unreadable";
  } catch {
    return "unreadable";
  }
}

/** Whether something accepts connections on `socketPath` right now. */
export function socketAccepts(socketPath: string, timeoutMs = 500): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection(socketPath);
    let settled = false;
    const finish = (answer: boolean): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(answer);
    };
    socket.setTimeout(timeoutMs, () => finish(false));
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

/** Whether `pid` names a live process. EPERM is a live process we may not signal. */
export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export type StatusVerdict = "serving" | "refusing" | "not-serving";

export interface StatusReport<S extends ShellStatus = ShellStatus> {
  readonly verdict: StatusVerdict;
  /** Why `not-serving`, in a few words; absent otherwise. */
  readonly detail?: string;
  readonly status: S | null;
}

export interface StatusProbes<S extends ShellStatus = ShellStatus> {
  read(dataDir: string): S | null | "unreadable";
  alive(pid: number): boolean;
  accepts(socketPath: string): Promise<boolean>;
}

/** The probes `status` runs against a real box. */
export function liveProbes<S extends ShellStatus>(identity: ShellIdentity): StatusProbes<S> {
  return {
    read: (dataDir) => readStatus<S>(identity, dataDir),
    alive: processAlive,
    accepts: (socketPath) => socketAccepts(socketPath),
  };
}

/**
 * What a live daemon in `state` is doing: `serving`, `refusing`, or `null`
 * for a state that is neither (starting, stopping), which reads as not
 * serving with the state as its detail.
 */
export type VerdictOf<State extends string> = (state: State) => "serving" | "refusing" | null;

export async function checkStatus<S extends ShellStatus>(
  dataDir: string,
  probes: StatusProbes<S>,
  verdictOf: VerdictOf<S["state"]>,
): Promise<StatusReport<S>> {
  const status = probes.read(dataDir);
  if (status === null) return { verdict: "not-serving", detail: "no status file", status: null };
  if (status === "unreadable") {
    return { verdict: "not-serving", detail: "status file unreadable", status: null };
  }
  if (status.state === "stopped") return { verdict: "not-serving", detail: "stopped", status };
  if (!probes.alive(status.pid)) {
    return { verdict: "not-serving", detail: `process ${status.pid} is gone`, status };
  }
  if (!(await probes.accepts(status.socketPath))) {
    return { verdict: "not-serving", detail: "socket does not accept connections", status };
  }
  const verdict = verdictOf(status.state);
  if (verdict !== null) return { verdict, status };
  return { verdict: "not-serving", detail: status.state, status };
}

export function statusExitCode(verdict: StatusVerdict): number {
  return verdict === "serving" ? 0 : verdict === "refusing" ? 1 : 3;
}

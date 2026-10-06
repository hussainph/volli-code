/**
 * hostd's health surface: `<dataDir>/hostd-status.json`, and the
 * `volli-hostd status` check that reads it.
 *
 * The running host rewrites the file (atomically, mode 0600) at every state
 * change. It holds no secret: paths, a pid, versions, the capabilities this
 * host serves, the credential status (VC-641: `ready`, `empty`, `locked`,
 * `refused` or `corrupt`, with a typed reason and never a key path) and,
 * when the database would not open, the typed reason (`databaseFailure`,
 * VC-602) with the sentence every verb answers with.
 *
 * A file alone could be stale after a crash, so `status` believes it only
 * when its pid is alive AND its socket accepts a connection. Exit codes:
 *
 * | code | meaning                                                         |
 * | ---- | --------------------------------------------------------------- |
 * | 0    | serving, whatever the credential status                         |
 * | 1    | up, but refusing to serve: the database failed to open          |
 * | 3    | not serving: stopped, starting, stopping, crashed or unreachable |
 *
 * This is the M1 surface. The host protocol (VC-564) carries the same facts
 * to remote clients.
 */
import { randomBytes } from "node:crypto";
import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { join } from "node:path";

import type { DbOpenFailure } from "@volli/host-core";
import type { CredentialStatus } from "@volli/host-core/secrets";

export const STATUS_FILE_NAME = "hostd-status.json";

export type HostdState = "starting" | "serving" | "refusing" | "stopping" | "stopped";

export type Capability = "available" | "unavailable";

/**
 * What this host can do. `board` is the agent socket's planning verbs over a
 * healthy database. The rest arrive with later tickets: Sessions with the
 * runtime composition, terminals with the host protocol's streams (VC-568),
 * the browser with standalone Chromium (VC-619).
 */
export interface HostdCapabilities {
  readonly board: Capability;
  readonly sessions: Capability;
  readonly terminals: Capability;
  readonly browser: Capability;
  readonly automations: Capability;
}

export type HostdDatabaseStatus =
  | { readonly ok: true; readonly path: string }
  | {
      readonly ok: false;
      readonly path: string;
      /** The sentence every verb answers with. */
      readonly error: string;
      /** Typed, for routing (VC-602): `newer-version`, `native-module` or `other`. */
      readonly failure: DbOpenFailure | null;
    };

export interface HostdStatus {
  readonly v: 1;
  readonly state: HostdState;
  readonly pid: number;
  readonly version: string;
  readonly startedAt: string;
  readonly updatedAt: string;
  readonly dataDir: string;
  readonly socketPath: string;
  readonly database: HostdDatabaseStatus | null;
  readonly capabilities: HostdCapabilities;
  /**
   * Whether saved credentials opened (VC-641); `null` until boot has looked.
   * Not `ready` or `empty` means stored secrets are unavailable and the host
   * serves everything else; the fix is in the log. Absent in a file written
   * by an older hostd.
   */
  readonly credentials?: CredentialStatus | null;
  /**
   * The host protocol's WebSocket listener (VC-663): where it listens, or
   * `null` when nothing does (the `cloud` flag off, or no `--listen`). Absent
   * in a file written by an older hostd.
   */
  readonly hostProtocol?: HostdHostProtocolStatus | null;
}

/** Where the host protocol listens: loopback only until VC-575. */
export interface HostdHostProtocolStatus {
  readonly url: string;
  readonly host: string;
  readonly port: number;
}

export function statusFilePath(dataDir: string): string {
  return join(dataDir, STATUS_FILE_NAME);
}

/** Replaces the status file whole: a reader never sees half of one. */
export function writeStatus(dataDir: string, status: HostdStatus): void {
  const path = statusFilePath(dataDir);
  const temporary = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(status, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

/** The recorded status, `null` when there is none, `"unreadable"` when it is not one. */
export function readStatus(dataDir: string): HostdStatus | null | "unreadable" {
  let text: string;
  try {
    text = readFileSync(statusFilePath(dataDir), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    return "unreadable";
  }
  try {
    const parsed = JSON.parse(text) as Partial<HostdStatus> | null;
    return parsed?.v === 1 &&
      typeof parsed.pid === "number" &&
      typeof parsed.socketPath === "string"
      ? (parsed as HostdStatus)
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

export interface StatusReport {
  readonly verdict: StatusVerdict;
  /** Why `not-serving`, in a few words; absent otherwise. */
  readonly detail?: string;
  readonly status: HostdStatus | null;
}

export interface StatusProbes {
  read(dataDir: string): HostdStatus | null | "unreadable";
  alive(pid: number): boolean;
  accepts(socketPath: string): Promise<boolean>;
}

export const LIVE_PROBES: StatusProbes = {
  read: readStatus,
  alive: processAlive,
  accepts: (socketPath) => socketAccepts(socketPath),
};

export async function checkStatus(dataDir: string, probes: StatusProbes): Promise<StatusReport> {
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
  if (status.state === "serving") return { verdict: "serving", status };
  if (status.state === "refusing") return { verdict: "refusing", status };
  return { verdict: "not-serving", detail: status.state, status };
}

export function statusExitCode(verdict: StatusVerdict): number {
  return verdict === "serving" ? 0 : verdict === "refusing" ? 1 : 3;
}

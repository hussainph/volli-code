/**
 * `volli-hostd start --system | --user` (VC-700): make what runs match what
 * `install` recorded, and wait until it serves.
 *
 * Idempotent: when the recorded version already serves on the recorded port,
 * it does nothing (`restarted: false`). Otherwise it stops and starts the
 * units (the runbook's upgrade order: both stopped, both started), then
 * watches the status file until hostd serves that version with its listener
 * up, or says why it will not:
 *
 * - `refusing`: up, but the database would not open (a newer Volli's, say);
 *   the sentence hostd answers with comes back as the message.
 * - `start-failed`: the unit failed; the journal's last lines come back as
 *   detail (hostd's log carries no secret, `log.ts`).
 * - `start-timeout`: neither, within `--timeout`.
 *
 * A user unit stops at logout unless the account lingers. `start --user`
 * asks logind for lingering itself (many distributions let a user turn on
 * their own); when that is refused it answers `linger-required`, naming the
 * one command that needs sudo, and starts nothing.
 */
import type { HostdStartResult, InstallMode } from "@volli/host-install/contract";

import type { InstallLayout } from "./layout";
import { SERVICE_UNIT, SOCKET_UNIT } from "./layout";
import {
  lingerOf,
  ManagementError,
  must,
  readManaged,
  systemctlArgs,
  unitState,
  type RunTool,
} from "./management";
import { ROOT_UID } from "./install";
import { checkStatus, type StatusProbes } from "./status";

export interface StartCommand {
  readonly kind: "start";
  readonly mode: InstallMode;
  readonly timeoutMs: number;
}

export interface StartPorts {
  readonly uid: () => number;
  /** The login a user unit belongs to. */
  readonly login: () => string;
  readonly layout: InstallLayout;
  readonly run: RunTool;
  readonly probes: StatusProbes;
  readonly sleep: (ms: number) => Promise<void>;
  readonly now: () => number;
}

export const DEFAULT_START_TIMEOUT_MS = 60_000;
const POLL_MS = 500;

export async function runStart(
  command: StartCommand,
  ports: StartPorts,
): Promise<HostdStartResult> {
  const { layout, run } = ports;
  const { mode } = command;
  if (mode === "system" && ports.uid() !== ROOT_UID) {
    throw new ManagementError("not-root", "start --system runs as root (sudo).", [], 77);
  }
  if (mode === "user" && ports.uid() === ROOT_UID) {
    throw new ManagementError("is-root", "start --user runs as you, not root.");
  }
  const managed = readManaged(layout);
  if (managed === null) {
    throw new ManagementError(
      "not-installed",
      `Nothing is installed here: run install --${mode} first.`,
    );
  }

  let linger: boolean | null = null;
  if (mode === "user") {
    const login = ports.login();
    linger = lingerOf(run, login);
    if (linger !== true) {
      run("loginctl", ["enable-linger", login]);
      linger = lingerOf(run, login);
    }
    if (linger !== true) {
      throw new ManagementError(
        "linger-required",
        `${login}'s host would stop when you log out. Run: sudo loginctl enable-linger ${login}`,
      );
    }
  }

  const matches = async () => {
    const report = await checkStatus(layout.dataDir, ports.probes);
    const status = report.status;
    const ok =
      report.verdict === "serving" &&
      status?.version === managed.version &&
      status.hostProtocol?.port === managed.port;
    return { report, ok };
  };

  let { report, ok } = await matches();
  const restarted = !ok;
  if (!ok) {
    const units = mode === "system" ? [SERVICE_UNIT, SOCKET_UNIT] : [SERVICE_UNIT];
    must(run, "systemctl", systemctlArgs(mode, "stop", ...units));
    must(run, "systemctl", systemctlArgs(mode, "start", ...units.toReversed()));
    const deadline = ports.now() + command.timeoutMs;
    for (;;) {
      ({ report, ok } = await matches());
      if (ok) break;
      if (report.verdict === "refusing" && report.status?.version === managed.version) {
        const database = report.status.database;
        throw new ManagementError(
          "refusing",
          database !== null && !database.ok
            ? database.error
            : "volli-hostd is up but refusing to serve.",
        );
      }
      if (unitState(run, mode).active === "failed") {
        throw new ManagementError(
          "start-failed",
          "volli-hostd did not start.",
          journalTail(run, mode),
        );
      }
      if (ports.now() >= deadline) {
        throw new ManagementError(
          "start-timeout",
          `volli-hostd did not serve within ${Math.round(command.timeoutMs / 1000)} s.`,
          [report.detail ?? report.verdict, ...journalTail(run, mode)],
        );
      }
      await ports.sleep(POLL_MS);
    }
  }
  // `ok` means serving, this version, the listener on the recorded port.
  const status = report.status!;
  const listener = status.hostProtocol!;
  return {
    v: 1,
    ok: true,
    mode,
    version: managed.version,
    restarted,
    hostId: status.hostId ?? null,
    listen: { host: listener.host, port: listener.port },
    linger,
  };
}

/** The unit's last journal lines, for the log under Details. */
function journalTail(run: RunTool, mode: InstallMode): string[] {
  const result = run("journalctl", [
    ...(mode === "user" ? ["--user"] : []),
    "-u",
    SERVICE_UNIT,
    "-n",
    "20",
    "-o",
    "cat",
    "--no-pager",
  ]);
  return result.code === 0 ? result.stdout.split("\n").filter(Boolean) : [];
}

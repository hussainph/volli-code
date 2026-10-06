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
 *
 * **On a Mac** the host is the person's launchd agent (`install --user`),
 * a `Background` session agent, and starting it is `launchctl bootstrap
 * user/<uid>`: the per-user domain an SSH login reaches, which outlives that
 * login and the person's GUI logout alike. The plist's session type keeps a
 * GUI login from loading a second copy into `gui/<uid>`. A restart boots it
 * out first (and out of `gui/<uid>`, where a hand-loaded template may sit),
 * so there is only ever one, and re-reads its plist. A failure comes back
 * with the last lines of `~/Library/Logs/volli-hostd.log`. After the Mac
 * restarts, the agent loads again at the person's next login.
 */
import type { HostdStartResult, InstallMode } from "@volli/host-install/contract";

import { readFileSync } from "node:fs";

import type { InstallLayout } from "./layout";
import { LAUNCHD_LABEL, SERVICE_UNIT, SOCKET_UNIT } from "./layout";
import {
  lingerOf,
  ManagementError,
  must,
  readManaged,
  systemctlArgs,
  unitState,
  writeManaged,
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
  const launchd = layout.manager === "launchd";
  if (mode === "system" && launchd) {
    throw new ManagementError(
      "system-unsupported",
      "A Mac runs volli-hostd as your launchd agent: start --user.",
    );
  }
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
  // Where a Mac's agent runs: the per-user domain an SSH login reaches.
  const domain: LaunchdDomain | null = launchd ? "user" : null;
  if (mode === "user" && !launchd) {
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
  // One version can be rebuilt (another revision): what runs is the release
  // `start` last brought up, so a new one restarts even at the same version.
  const releaseStarted = managed.release === undefined || managed.started === managed.release;

  let { report, ok } = await matches();
  const restarted = !ok || !releaseStarted;
  if (restarted) {
    if (domain !== null) {
      // One agent only: out of both domains (either may say it was not there), then in.
      for (const each of ["gui", "user"] as const) {
        run("launchctl", ["bootout", launchdTarget(each, ports.uid())]);
      }
      // A person's `launchctl disable` would refuse the bootstrap.
      run("launchctl", ["enable", launchdTarget(domain, ports.uid())]);
      const bootstrapped = run("launchctl", [
        "bootstrap",
        `${domain}/${ports.uid()}`,
        layout.agentPlist!,
      ]);
      if (bootstrapped.code !== 0) {
        throw new ManagementError("start-failed", "volli-hostd did not start.", [
          ...lines(bootstrapped.stderr),
          ...logTail(layout),
        ]);
      }
    } else {
      const units = mode === "system" ? [SERVICE_UNIT, SOCKET_UNIT] : [SERVICE_UNIT];
      must(run, "systemctl", systemctlArgs(mode, "stop", ...units));
      const started = run("systemctl", systemctlArgs(mode, "start", ...units.toReversed()));
      if (started.code !== 0) {
        // The common start failure: the job failed at once. The journal says why.
        throw new ManagementError(
          "start-failed",
          "volli-hostd did not start.",
          journalTail(run, mode),
        );
      }
    }
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
      if (
        domain !== null
          ? agentFailed(run, domain, ports.uid())
          : unitState(run, mode).active === "failed"
      ) {
        throw new ManagementError(
          "start-failed",
          "volli-hostd did not start.",
          domain !== null ? logTail(layout) : journalTail(run, mode),
        );
      }
      if (ports.now() >= deadline) {
        throw new ManagementError(
          "start-timeout",
          `volli-hostd did not serve within ${Math.round(command.timeoutMs / 1000)} s.`,
          [
            report.detail ?? report.verdict,
            ...(domain !== null ? logTail(layout) : journalTail(run, mode)),
          ],
        );
      }
      await ports.sleep(POLL_MS);
    }
  }
  if (!releaseStarted) writeManaged(layout, { ...managed, started: managed.release });
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

type LaunchdDomain = "gui" | "user";

/** The agent's service target in a domain: `gui/501/com.volli.hostd`. */
function launchdTarget(domain: LaunchdDomain, uid: number): string {
  return `${domain}/${uid}/${LAUNCHD_LABEL}`;
}

/** Whether launchd says the agent exited non-zero and is not running again. */
function agentFailed(run: RunTool, domain: LaunchdDomain, uid: number): boolean {
  const printed = run("launchctl", ["print", launchdTarget(domain, uid)]);
  if (printed.code !== 0) return false;
  const state = /^\s*state = (.+)$/mu.exec(printed.stdout)?.[1]?.trim();
  const exit = /^\s*last exit code = (\d+)/mu.exec(printed.stdout)?.[1];
  return state !== "running" && exit !== undefined && exit !== "0";
}

function lines(text: string): string[] {
  return text.trim().split("\n").filter(Boolean).slice(-10);
}

/** The agent's last log lines (`StandardErrorPath`), for the log under Details. */
function logTail(layout: InstallLayout): string[] {
  let text: string;
  try {
    text = readFileSync(layout.logFile!, "utf8");
  } catch {
    return [];
  }
  return text.split("\n").filter(Boolean).slice(-20);
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

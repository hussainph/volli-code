/**
 * What `volli-runner`'s status file says, and how `volli-runner status`
 * reads it.
 *
 * The file is the shell's (`status.ts`): `<dataDir>/runner-status.json`,
 * rewritten whole at every change by the running daemon, believed only when
 * its pid is alive and its socket accepts. Beyond the shell's fields the
 * runner records its link, its backend connection and its update, each
 * `null` until the part of the runner that owns it has something to say.
 * None of it is a secret: never the credential, a token or a key path.
 *
 * Verdicts and exit codes:
 *
 * | state                                    | verdict       | exit |
 * | ---------------------------------------- | ------------- | ---- |
 * | `online`                                 | `serving`     | 0    |
 * | `connecting`, `offline`, `revoked`,      | `refusing`    | 1    |
 * | `draining`, `updating`                   |               |      |
 * | `unlinked`, `starting`, `stopping`,      | `not-serving` | 3    |
 * | `stopped`; no file; a dead process       |               |      |
 *
 * An unlinked runner serves nothing but `status`, so it is not serving: it
 * runs no Session until it is linked.
 */
import type { CredentialStatus } from "@volli/host-core/secrets";
import type { RunnerId } from "@volli/shared/cloud";

import { RUNNER } from "./identity";
import {
  checkStatus,
  liveProbes,
  type ShellStatus,
  type StatusProbes,
  type StatusReport,
  type VerdictOf,
} from "./status";

export const RUNNER_STATES = [
  "starting",
  "unlinked",
  "connecting",
  "online",
  "offline",
  "revoked",
  "draining",
  "updating",
  "stopping",
  "stopped",
] as const;
export type RunnerState = (typeof RUNNER_STATES)[number];

/** The link a running runner holds: who it is, and where. Never its credential. */
export interface RunnerLinkSummary {
  readonly runnerId: RunnerId;
  readonly name: string;
  /** The Convex deployment URL it links to. */
  readonly server: string;
}

/** The backend connection, as the runner last saw it. */
export interface RunnerBackendStatus {
  readonly state: "connecting" | "online" | "offline" | "revoked";
  /** When it entered `state`, ISO 8601. */
  readonly since: string;
  readonly lastHeartbeatAt: string | null;
  /** A short reason for `offline` or `revoked`, for an operator. */
  readonly detail: string | null;
}

/** The update the backend asked for, and how far this runner got with it. */
export interface RunnerUpdateStatus {
  readonly targetVersion: string | null;
  readonly minVersion: string | null;
  readonly phase: "idle" | "staging" | "staged" | "activating" | "failed";
  readonly detail: string | null;
}

export interface RunnerStatus extends ShellStatus<RunnerState> {
  readonly link: RunnerLinkSummary | null;
  readonly backend: RunnerBackendStatus | null;
  readonly update: RunnerUpdateStatus | null;
  /** Whether saved Session secrets opened (VC-641); `null` until boot has looked. */
  readonly credentials: CredentialStatus | null;
}

export const runnerVerdict: VerdictOf<RunnerState> = (state) => {
  if (state === "online") return "serving";
  if (
    state === "connecting" ||
    state === "offline" ||
    state === "revoked" ||
    state === "draining" ||
    state === "updating"
  ) {
    return "refusing";
  }
  return null;
};

/** The probes `volli-runner status` runs against this box. */
export const RUNNER_LIVE_PROBES: StatusProbes<RunnerStatus> = liveProbes<RunnerStatus>(RUNNER);

export function checkRunnerStatus(
  dataDir: string,
  probes: StatusProbes<RunnerStatus> = RUNNER_LIVE_PROBES,
): Promise<StatusReport<RunnerStatus>> {
  return checkStatus(dataDir, probes, runnerVerdict);
}

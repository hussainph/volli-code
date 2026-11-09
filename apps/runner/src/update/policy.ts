/**
 * Whether this runner should update, and how urgently (n3 §9.1–9.2). Pure.
 *
 * Volli's heartbeat reply names a target (the runner's pin, else its
 * channel's release) and the floor (`minVersion`, the oldest runner the
 * backend still accepts). In order:
 *
 * 1. A runner nothing supervises (a foreground `run`) never updates itself:
 *    nothing would restart it; its status's `update` says `unsupervised`.
 * 2. `volli-runner update --now [--to <v>]` asks for an update now.
 * 3. Below the floor, it updates to the target even with auto-update off:
 *    opting out never strands a runner Volli no longer accepts.
 * 4. A pin is Settings' **Update now**: explicit intent, even with auto-update off.
 * 5. Auto-update on: the target, when it is newer.
 *
 * Never a downgrade, and never a release that already failed its health check
 * here. An urgent update (1–4) waits at most {@link URGENT_DRAIN_MS} for
 * running turns; a target update waits up to {@link TARGET_DRAIN_MS} for an
 * idle moment and then tries again later.
 */
import { compareVersions } from "@volli/shared";
import type { RunnerHeartbeatReply } from "@volli/shared/cloud";

import type { NowRequest } from "./files";

export type UpdateTarget = Pick<
  RunnerHeartbeatReply,
  "targetVersion" | "minVersion" | "autoUpdate"
>;

/** A target update waits up to 6 h for no turn in flight, then gives up until later. */
export const TARGET_DRAIN_MS = 6 * 60 * 60 * 1000;
/** A floor, pinned or `--now` update waits up to 30 min, then activates anyway. */
export const URGENT_DRAIN_MS = 30 * 60 * 1000;
/** Idle means no turn in flight for this long. */
export const IDLE_WINDOW_MS = 60 * 1000;
/** After a failed stage or an abandoned drain, the same release is retried no sooner. */
export const RETRY_AFTER_MS = 60 * 60 * 1000;

export type UpdateReason = "now" | "floor" | "pin" | "target";

export type UpdateDecision =
  | { readonly kind: "none"; readonly why: string }
  | {
      readonly kind: "update";
      readonly version: string;
      readonly reason: UpdateReason;
      readonly urgent: boolean;
    };

export interface PolicyInputs {
  readonly running: string;
  readonly target: UpdateTarget | null;
  readonly now: NowRequest | null;
  readonly supervised: boolean;
  readonly bad: readonly string[];
}

const newer = (version: string | null, than: string): version is string =>
  version !== null && compareVersions(version, than) > 0;

export function decideUpdate(inputs: PolicyInputs): UpdateDecision {
  if (!inputs.supervised) return { kind: "none", why: "unsupervised" };
  const pick = (version: string, reason: UpdateReason): UpdateDecision =>
    inputs.bad.includes(version) && inputs.now?.version !== version
      ? { kind: "none", why: `release ${version} failed here before` }
      : { kind: "update", version, reason, urgent: reason !== "target" };
  const { running, target } = inputs;
  if (inputs.now !== null) {
    const version = inputs.now.version ?? target?.targetVersion ?? null;
    if (newer(version, running)) return pick(version, "now");
  }
  if (target === null) return { kind: "none", why: "no target yet" };
  const { targetVersion, minVersion, autoUpdate } = target;
  if (!newer(targetVersion, running)) return { kind: "none", why: "up to date" };
  if (minVersion !== null && compareVersions(running, minVersion) < 0) {
    return pick(targetVersion, "floor");
  }
  if (autoUpdate.pinnedVersion !== null && autoUpdate.pinnedVersion === targetVersion) {
    return pick(targetVersion, "pin");
  }
  if (autoUpdate.enabled) return pick(targetVersion, "target");
  return { kind: "none", why: "auto-update is off" };
}

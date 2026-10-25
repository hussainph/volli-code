/**
 * "This Mac" as a runner (VC-895): what the handler map's desktop-only
 * `runners.*` entries call.
 *
 * Desktop main implements it with its Mac runner
 * (`apps/desktop/src/main/cloud-runner/`): the registration with the
 * person's sign-in, the sealed runner credential, the heartbeat and the
 * sleep/wake reports. Every other host (hostd) supplies none, and each entry
 * answers `OperationUnavailableError`. A port that cannot act now (the
 * `cloud` flag is off) throws `OperationUnavailableError` itself.
 * Structural, so host-core imports nothing of the desktop's.
 *
 * **Secrets.** A snapshot names the runner and its state, never its
 * credential or a token.
 */
import type { ThisMacRunnerSnapshot } from "@volli/shared";

type Answer<Value> = Value | Promise<Value>;

export interface RunnerAccountPort {
  /** Where this Mac's runner stands now. */
  thisMac(): Answer<ThisMacRunnerSnapshot>;
  /** Calls `listener` with the snapshot now, then on every change, until the answer is called. */
  subscribeThisMac(listener: (snapshot: ThisMacRunnerSnapshot) => void): Answer<() => void>;
  /** Registers this Mac again after it was removed, or retries a failed registration. */
  addThisMac(): Answer<void>;
  /** Removes this Mac from the person's runners; it stays removed until {@link addThisMac}. */
  removeThisMac(): Answer<void>;
}

/**
 * Sign-ins on a remote host, from this desktop (VC-702 PR 2): what the
 * handler map's `hostSignIns.*` desktop-only entries call.
 *
 * Desktop main implements it over each remote host's link (VC-700's
 * registry): it calls the host's `sign-ins` operations, reads this Mac's own
 * Pi credential for "Send from this Mac", and relays a browser sign-in's
 * redirect. Every other host supplies none, and each entry answers
 * `OperationUnavailableError`. Structural, so host-core imports nothing of
 * the desktop's.
 *
 * **Secrets go one way.** A key or token travels in (`setApiKey`,
 * `setGitCredential`, `answer`) and onto the host link; nothing here answers
 * one. "Send from this Mac" reads this Mac's key in main and answers only the
 * host's status or why nothing was sent.
 *
 * Every method may answer synchronously or with a promise.
 */
import type {
  HostSetGitCredentialInput,
  HostSignInRunEvent,
  HostSignInSendResult,
  HostSignInStatus,
} from "@volli/shared";

type Answer<Value> = Value | Promise<Value>;

export interface RemoteSignInsPort {
  /** The host's sign-ins: availability only. */
  status(hostId: string): Answer<HostSignInStatus>;
  /** The providers this Mac holds an API key for: availability only. */
  macKeys(): Answer<readonly string[]>;
  /** After the person's confirm: this Mac's key for one provider, onto the host link. */
  sendFromThisMac(hostId: string, providerId: string): Answer<HostSignInSendResult>;
  setApiKey(hostId: string, providerId: string, key: string): Answer<HostSignInStatus>;
  setGitCredential(hostId: string, input: HostSetGitCredentialInput): Answer<HostSignInStatus>;
  /**
   * Signs the host in to a provider, and calls `listener` with everything the
   * sign-in says until it ends. The answer ends the stream and cancels the
   * sign-in if it is still running. `runId` is the window's name for this
   * run: an `answer` or `cancel` naming another reaches nothing.
   */
  run(
    hostId: string,
    providerId: string,
    listener: (event: HostSignInRunEvent) => void | Promise<void>,
    runId?: string,
  ): Answer<() => void>;
  /** Answers the step the running sign-in waits on (the pasted redirect included). */
  answer(
    hostId: string,
    providerId: string,
    promptId: string,
    value: string,
    runId?: string,
  ): Answer<void>;
  /** Cancels the running sign-in, if it is still the one `runId` names. */
  cancel(hostId: string, providerId: string, runId?: string): Answer<void>;
}

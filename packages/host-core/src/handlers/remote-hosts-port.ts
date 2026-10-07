/**
 * The remote hosts port (VC-700 PR 2): what the handler map's `hosts.*` and
 * `hostAdd.*` desktop-only entries call.
 *
 * Desktop main holds the registry of hosts it added over SSH, their tunnels
 * and the add flows (`@volli/host-install`'s `createRemoteHosts`); it hands
 * the map an object of this shape (`HostHandlerOptions.remoteHosts`). Every
 * other host (hostd) supplies none, and each of those entries answers
 * `OperationUnavailableError` ("Remote hosts are unavailable on this host").
 * Structural, so host-core never imports `@volli/host-install` or Electron.
 *
 * **Unavailability.** A method that cannot act now (the `cloud` flag is off,
 * or v1 does not do it yet: `updateHost` and `signIn` answer with the shared
 * `REMOTE_HOST_UPDATE_UNAVAILABLE` / `REMOTE_HOST_SIGN_IN_UNAVAILABLE` text)
 * throws `OperationUnavailableError` from `@volli/shared`, or any error
 * carrying its brand (`isOperationUnavailable`). Every door then says so in
 * its own words: the routers `NOT_IMPLEMENTED` / `operation-unavailable`, its
 * message intact. Any other error (an unknown host or flow) travels as the
 * port threw it; its message, sanitized, is what the window shows.
 *
 * **Secrets.** Nothing here carries one out: every value is plain JSON, no
 * device key, no credential. The sudo password goes in through
 * {@link RemoteHostsPort.sudoPassword} only and is never echoed: not in a
 * snapshot, an event, a log line, or an error's message (the map scrubs a
 * message that carries it anyway, but the port must not rely on that).
 *
 * Every method may answer synchronously or with a promise.
 */
import type {
  AddHostAnswer,
  AddHostEvent,
  AddHostFacts,
  AddHostStartInput,
  AddHostStepId,
  CreateRemoteProjectInput,
  CreateRemoteProjectResult,
  RemoteHostDevices,
  RemoteHostProjects,
  RemoteHostsSnapshot,
} from "@volli/shared";

/** When an update runs: at once, or when the host's Sessions are idle. */
export type RemoteHostUpdateWhen = "now" | "when-idle";

/** Ends a subscription; called once, and harmless after the source ended. */
export type RemoteHostsUnsubscribe = () => void;

type Answer<Value> = Value | Promise<Value>;

/** Desktop main's remote hosts registry and add flows, as the handler map reads them. */
export interface RemoteHostsPort {
  /** Every remote host, and which serves each remote project. */
  snapshot(): Answer<RemoteHostsSnapshot>;
  /**
   * Calls `listener` with the current snapshot first, then with the whole
   * snapshot again on every change, until the answer is called.
   */
  subscribe(
    listener: (snapshot: RemoteHostsSnapshot) => void | Promise<void>,
  ): Answer<RemoteHostsUnsubscribe>;
  /** Tries the host's link again now. */
  retry(hostId: string): Answer<void>;
  /** Updates the host's Volli (v1 refuses: unavailable). */
  updateHost(hostId: string, when: RemoteHostUpdateWhen): Answer<void>;
  /** Cancels an update scheduled for when the host is idle. */
  cancelScheduledUpdate(hostId: string): Answer<void>;
  /** Signs the host in to a model provider again (v1 refuses: unavailable). */
  signIn(hostId: string, providerId: string): Answer<void>;
  /** Closes the host's link and drops it from this desktop. */
  forget(hostId: string): Answer<void>;
  /** This Mac's label for the host (the host's own name is untouched). */
  rename(hostId: string, name: string): Answer<void>;
  /** The devices the host has enrolled, read from it over SSH now, never cached. */
  devices(hostId: string): Answer<RemoteHostDevices>;
  /** Starts an add flow; answers its id. */
  startAdd(input: AddHostStartInput): Answer<{ flowId: string }>;
  /**
   * Calls `listener` with the flow's current view first, then with every
   * change to it and each log line, until the answer is called.
   */
  subscribeAdd(
    flowId: string,
    listener: (event: AddHostEvent) => void | Promise<void>,
  ): Answer<RemoteHostsUnsubscribe>;
  /** Answers the question the flow stopped on: `questionId` must be that one's, and the answer fit it. */
  answerAdd(flowId: string, questionId: string, answer: AddHostAnswer): Answer<void>;
  /**
   * Hands the flow the sudo password its question `questionId` asked for.
   * Write-only: never echoed or logged.
   */
  sudoPassword(flowId: string, questionId: string, password: string): Answer<void>;
  /** Retries a failed flow, from `from` or from the step its failure names. */
  retryAdd(flowId: string, from?: AddHostStepId): Answer<void>;
  /** Cancels the flow. */
  cancelAdd(flowId: string): Answer<void>;
  /** What the flow has found about its host so far: read beside its view. */
  addFacts(flowId: string): Answer<AddHostFacts>;
  /* ── A host's projects (VC-710) ── */
  /** The projects the host has, read over SSH now, never cached; and whether this Mac can add one. */
  projects(hostId: string): Answer<RemoteHostProjects>;
  /** The host's own `volli project add` over SSH; a refusal answers, in one line. */
  createProject(input: CreateRemoteProjectInput): Answer<CreateRemoteProjectResult>;
  /** Opens one of the host's projects on this Mac: remembered, and linked. */
  openWorkspace(hostId: string, workspaceId: string): Answer<void>;
  /** Closes it on this Mac; the project on the host is untouched. */
  closeWorkspace(hostId: string, workspaceId: string): Answer<void>;
}

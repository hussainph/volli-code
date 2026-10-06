/**
 * Remote hosts this desktop added over SSH (VC-700 PR 2): the wire between
 * desktop main, which holds the registry, the tunnels and the add flows
 * (`@volli/host-install`'s `createRemoteHosts`), and the renderer, which
 * shows them through VC-576's host-connection store.
 *
 * Plain JSON, both directions, through the desktop-only tier (`hosts.*`,
 * `hostAdd.*` in `DESKTOP_ENTRIES`). Never a secret: no device key, no sudo
 * password (that one goes in, write-only, and is never echoed), no
 * credential.
 *
 * **One mapping, the renderer's.** A host's link travels as the facts VC-576's
 * `hostLinkView` reads (a client host link's state, VC-670, less its
 * welcome), plus the version facts the registry knows, so the UI words a
 * link exactly one way whichever source it came from.
 */

/** Why a host was added in user mode: agents run as the person's own account. */
export type RemoteHostMode = "system" | "user";

/** A host's error as a link reports it: `@volli/host-protocol`'s `HostError`, its JSON fields. */
export interface RemoteHostLinkError {
  readonly code: string;
  readonly reason: string;
  readonly message: string;
}

/**
 * A host's link, as VC-670's `HostLinkState` says it, minus the welcome a
 * `ready` link carries (the registry keeps what it needs of it). While no
 * Workspace on the host is open, the SSH tunnel answers for the link:
 * starting is `connecting`, up is `ready`, retrying is `unreachable`, closed
 * is `closed`.
 */
export type RemoteHostLinkState =
  | { readonly status: "connecting"; readonly attempt: number }
  | { readonly status: "ready" }
  | {
      readonly status: "unreachable";
      readonly attempt: number;
      readonly error: RemoteHostLinkError;
      readonly closeCode: number | null;
      /** Epoch ms of the next automatic attempt. */
      readonly retryAt: number;
    }
  | {
      readonly status: "refused";
      readonly error: RemoteHostLinkError;
      readonly closeCode: number | null;
    }
  | { readonly status: "fenced"; readonly error: RemoteHostLinkError }
  | { readonly status: "closed" };

/** The link and what `hostLinkView`'s context needs beside it. */
export interface RemoteHostLink {
  readonly state: RemoteHostLinkState;
  /** Whether the link has been `ready` since this launch opened it. */
  readonly everReady: boolean;
  /** Epoch ms it last left `ready`, or `null`. */
  readonly droppedAt: number | null;
}

/** One remote host, as the registry knows it. */
export interface RemoteHost {
  /** The host's own id (hostd's `hostId`, UUIDv4), pinned at enrollment. Never `this-mac`. */
  readonly id: string;
  /** What the person calls it: the target they typed, or the label they gave. */
  readonly name: string;
  /** The SSH target: `you@box`, or a `~/.ssh/config` alias. */
  readonly target: string;
  readonly transport: "ssh-tunnel";
  readonly os: "linux" | "macos" | null;
  readonly mode: RemoteHostMode;
  /** User mode: agents on this host run as the person's own account (the desktop says so). */
  readonly agentsShareAccount: boolean;
  /** hostd's version at its last answer; `null` when unknown. */
  readonly version: string | null;
  /** A compatible update this app carries (the host is older), else `null`. */
  readonly availableUpdate: string | null;
  /** The host runs a Volli newer than this app. */
  readonly hostIsNewer: boolean;
  /** This Mac's device id on the host (its enrollment). */
  readonly deviceId: string;
  readonly addedAt: string;
  readonly link: RemoteHostLink;
  /** Sessions running there now, `null` while nothing reports it. */
  readonly liveSessions: number | null;
}

/** Every remote host, and which serves each project this desktop knows to live remotely. */
export interface RemoteHostsSnapshot {
  readonly v: 1;
  readonly hosts: readonly RemoteHost[];
  /** Project id → remote host id. Empty until a remote project is opened (VC-700 PR 3). */
  readonly projects: Readonly<Record<string, string>>;
}

/* ── Adding a host ──────────────────────────────────────────────────────── */

/** The add flow's steps, in order (`@volli/host-install`'s `STEP_ORDER`). */
export type AddHostStepId = "connect" | "probe" | "deliver" | "install" | "start" | "enroll" | "link";

export type AddHostStepStatus = "pending" | "running" | "done" | "skipped" | "failed";

/**
 * A question the flow stopped on, as `@volli/host-install` asks it (`kind`,
 * `step` and its own fields: a host key's fingerprints, an older hostd's
 * version…). A sudo password question names the command, never a password.
 */
export interface AddHostQuestion {
  readonly kind: string;
  readonly step: AddHostStepId;
  readonly [field: string]: RemoteHostJson;
}

/** A JSON value: what a question's own fields are. */
export type RemoteHostJson =
  | string
  | number
  | boolean
  | null
  | readonly RemoteHostJson[]
  | { readonly [key: string]: RemoteHostJson };

/** A failure the flow stopped on: its typed code, the line to show, and the one recovery. */
export interface AddHostFailure {
  readonly code: string;
  readonly step: AddHostStepId;
  /** One sentence for the person. */
  readonly line: string;
  readonly recovery:
    | { readonly action: "retry"; readonly label: string; readonly from: AddHostStepId }
    | { readonly action: "back"; readonly label: string };
  /** Supporting text (ssh's own words, a journal tail) for the log under Details. */
  readonly detail: string | null;
}

/** One add flow, as the checklist shows it. */
export interface AddHostView {
  readonly flowId: string;
  readonly target: string;
  readonly name: string;
  readonly status: "running" | "question" | "failed" | "done" | "cancelled";
  readonly steps: readonly { readonly id: AddHostStepId; readonly status: AddHostStepStatus }[];
  readonly question: AddHostQuestion | null;
  readonly failure: AddHostFailure | null;
  /** The host it added, once `done`. */
  readonly hostId: string | null;
}

/** One line of the flow's log (the log under Details): never a secret. */
export interface AddHostLogLine {
  readonly at: string;
  readonly level: "debug" | "info" | "warn" | "error";
  readonly message: string;
  readonly fields: Readonly<Record<string, string | number | boolean | null>>;
}

/** What `hostAdd.subscribe` streams: the view on every change, and each log line. */
export type AddHostEvent =
  | { readonly kind: "view"; readonly view: AddHostView }
  | { readonly kind: "log"; readonly flowId: string; readonly line: AddHostLogLine };

/** A person's answer to the question a flow stopped on. A sudo password has its own command. */
export type AddHostAnswer =
  | { readonly kind: "accept-host-key" }
  | { readonly kind: "update" }
  | { readonly kind: "adopt" }
  | { readonly kind: "open" }
  | { readonly kind: "user-install" }
  | { readonly kind: "repair" };

export interface AddHostStartInput {
  /** `you@box`, `you@box:2222`, or a `~/.ssh/config` alias. */
  readonly target: string;
  /** What to call it; the target when absent. */
  readonly name?: string;
}

/** The text a refusal of an action v1 does not do yet carries. */
export const REMOTE_HOST_UPDATE_UNAVAILABLE =
  "Updating a host from this Mac comes in a later build: re-run Add a host to install this version.";
export const REMOTE_HOST_SIGN_IN_UNAVAILABLE =
  "Signing in on a host from this Mac comes in a later build.";

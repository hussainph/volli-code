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
  /** Sessions running there now, `null` while nothing reports it. */
  readonly liveSessions: number | null;
  /** The OS as the host names itself ("Ubuntu 24.04.1 LTS", "macOS 15.1"), from its check; `null` when not known. */
  readonly system: string | null;
  /** Its architecture as people read it ("x86-64", "arm64"); `null` when not known. */
  readonly arch: string | null;
  /**
   * The host key fingerprints (`SHA256:…`) the person compared and trusted
   * when adding it; empty when its key was already known to their ssh.
   */
  readonly hostKeys: readonly string[];
}

/**
 * One remote project: the host that serves it, and that project's own
 * Workspace connection (VC-670: one link, and one authority fence, per
 * Workspace; the tunnel's state until its link exists). VC-576's store words
 * it per project and aggregates a host's link from its projects'.
 */
export interface RemoteProjectLink {
  readonly hostId: string;
  readonly link: RemoteHostLinkState;
}

/** Every remote host, and each remote project with its own link. */
export interface RemoteHostsSnapshot {
  readonly v: 1;
  /** A host has no link of its own: its projects each have one. */
  readonly hosts: readonly RemoteHost[];
  /** Project id → its host and its link. Empty until a remote project is opened (VC-700 PR 3). */
  readonly projects: Readonly<Record<string, RemoteProjectLink>>;
  /**
   * Why this Mac's hosts cannot change now, in one line, or `null`: its hosts
   * file is from a newer Volli, or cannot be read. The file is left exactly
   * as it is, and adding, forgetting or opening a project on a host refuses.
   */
  readonly readOnly: string | null;
}

/* ── Adding a host ──────────────────────────────────────────────────────── */

/** The add flow's steps, in order (`@volli/host-install`'s `STEP_ORDER`). */
export type AddHostStepId =
  | "connect"
  | "probe"
  | "deliver"
  | "install"
  | "start"
  | "enroll"
  | "link";

export type AddHostStepStatus = "pending" | "running" | "done" | "skipped" | "failed";

/**
 * A question the flow stopped on, as `@volli/host-install` asks it (`kind`,
 * `step` and its own fields: a host key's fingerprints, an older hostd's
 * version…). A sudo password question names the command, never a password.
 */
export interface AddHostQuestion {
  /** This question's id in its flow: an answer names it, so a stale answer is refused. */
  readonly id: string;
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
  /**
   * When the host comes up on its own, once the check knows: a Mac's is
   * "Starts when you log in to <name>" (a launchd agent, not at boot); null
   * says nothing (a Linux host starts at boot).
   */
  readonly startup: string | null;
  /** What the flow has found so far: the checklist's completed rows read these, never made up. */
  readonly facts: AddHostFacts;
}

/** What an add has learned about the host, each `null` until a step has said it. */
export interface AddHostFacts {
  /** The login it connected as. */
  readonly user: string | null;
  /** `linux` or `macos`, from the check: the host's icon. */
  readonly os: "linux" | "macos" | null;
  /** The OS as the host names itself: "Ubuntu 24.04.1 LTS", "macOS 15.1". */
  readonly system: string | null;
  /** "x86-64", "arm64". */
  readonly arch: string | null;
  readonly memoryBytes: number | null;
  /** The Volli host it installed, kept or found running. */
  readonly version: string | null;
  /** Whether it keeps running when the person logs out (a system unit, or lingering); `null` on a Mac, which says `startup`. */
  readonly keepsRunning: boolean | null;
  /** This Mac was already paired with it. */
  readonly alreadyPaired: boolean;
}

/** One line of the flow's log (the log under Details): never a secret. */
export interface AddHostLogLine {
  readonly at: string;
  readonly level: "debug" | "info" | "warn" | "error";
  readonly message: string;
  readonly fields: Readonly<Record<string, string | number | boolean | null>>;
}

/**
 * What `hostAdd.subscribe` streams: first one `replay` (the view now and the
 * newest of the log, bounded in bytes), then the view on every change and
 * each new log line.
 */
export type AddHostEvent =
  | {
      readonly kind: "replay";
      readonly view: AddHostView;
      /** The newest log lines, oldest first. */
      readonly log: readonly AddHostLogLine[];
      /** How many earlier lines were left out ("N earlier lines omitted"). */
      readonly omitted: number;
    }
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

/** Every link to one host this Mac opens at most: other Macs and reconnects keep the rest of hostd's 32. */
export const REMOTE_HOST_LINK_CAP = 24;

/** The reason a project past {@link REMOTE_HOST_LINK_CAP} reads, refused by this Mac (never by the host). */
export const REMOTE_HOST_TOO_MANY_PROJECTS = "too-many-projects";

/* ── Managing a host (VC-700 PR 3) ───────────────────────────────────── */

/** The longest label a host may be given (as `hostAdd.start`'s `name`). */
export const REMOTE_HOST_NAME_MAX = 120;

/** `hosts.rename`: this Mac's label for a host. The host's own name never changes. */
export interface RenameRemoteHostInput {
  readonly hostId: string;
  /** Trimmed; 1 to {@link REMOTE_HOST_NAME_MAX} characters, no control characters. */
  readonly name: string;
}

/** One device enrolled with a host (`volli-hostd devices list`): never a key. */
export interface RemoteHostDevice {
  readonly deviceId: string;
  /** What it called itself when it enrolled ("Hussain's MacBook Pro"). */
  readonly name: string;
  /** The enrolled key's fingerprint. */
  readonly fingerprint: string;
  /** ISO 8601. */
  readonly enrolledAt: string;
  /** How it enrolled (`ssh`). */
  readonly via: string;
  /** ISO 8601 once revoked, else `null`. */
  readonly revokedAt: string | null;
  /** This Mac's own enrollment (its `deviceId` is the registry's). */
  readonly thisMac: boolean;
}

/**
 * The most devices `hosts.devices` answers, and the longest text any of a
 * device's fields may be: bounds, not policy. A host's answer past either is
 * not believed (the engine says the host did not list its devices).
 */
export const REMOTE_HOST_DEVICES_MAX = 1000;
export const REMOTE_HOST_DEVICE_TEXT_MAX = 256;

/** `hosts.devices`: the devices a host has enrolled, read over SSH when asked. */
export interface RemoteHostDevices {
  readonly hostId: string;
  readonly devices: readonly RemoteHostDevice[];
}

/** The text a refusal of an action v1 does not do yet carries. */
export const REMOTE_HOST_UPDATE_UNAVAILABLE =
  "Updating a host from this Mac comes in a later build: re-run Add a host to install this version.";
export const REMOTE_HOST_SIGN_IN_UNAVAILABLE =
  "Signing in on a host from this Mac comes in a later build.";

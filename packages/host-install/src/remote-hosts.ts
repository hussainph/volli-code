/**
 * The remote hosts this desktop added over SSH (VC-700 PR 2): the registry,
 * each host's device key (through a port), its SSH tunnel and one VC-670
 * client link per open Workspace, and the "Add a host" flows on the step
 * machine. Desktop main runs it; host-core reaches it through a port. No
 * Electron.
 *
 * **Never a secret out.** A host's device key (P-256 PKCS#8) lives in the
 * caller's key store only: `flow:<flowId>` while a flow adds the host, then
 * `host:<hostId>:<deviceId>` once it is added (and removed when the flow is
 * cancelled or the host forgotten). A sudo password lives in its flow's
 * `ProvisionSecrets` only, and only until the flow next stops. Neither enters
 * the registry, a snapshot, a view or a log line; a credential is minted per
 * handshake and handed straight to the link.
 *
 * **One host, one link.** Each host's `RemoteHostLink` is its Workspace
 * links' most informative state or, while none is open, its tunnel's
 * (`remote-hosts-link.ts`), in the shape VC-576's `hostLinkView` reads. At
 * most {@link REMOTE_HOST_LINK_CAP} Workspace links per host: a project past
 * it reads "Too many projects open", never offline or open.
 *
 * **Flows are single-flight.** Every call on one flow (an answer, a sudo
 * password, a retry) waits for the one before it. Cancelling takes effect at
 * once: the flow's SSH commands and tunnel end, a step in flight finds its
 * result discarded, and nothing after it runs.
 *
 * **One finalization per host.** Adding a host ends in a lease on its id:
 * the device key is written under its own name beside any older one, then
 * the registry, the runtime and the snapshot change together with no await
 * between them. Every await before that checks the flow is still wanted (not
 * cancelled, not quit), so a flow can never register a host, keep a key or
 * start a tunnel after either. A failure before the registry is written
 * leaves the flow's key and tunnel, so a retry finishes it; once written, the
 * add is done and a cancel is too late (Forget undoes it).
 *
 * **Durable, or it says so.** A registry write that fails fails the change
 * that needed it, which keeps what it had. A hosts file from a newer Volli,
 * or one that cannot be read, is never overwritten: every change refuses
 * with {@link RemoteHostsSnapshot.readOnly}'s line.
 *
 * **Quit owns everything.** `close()` cancels every flow, waits (within a
 * grace) for whatever is in flight to finish or find itself cancelled, then
 * stops every host; once it returns nothing here creates a resource again.
 */
import { hostOffersSignIns, isUuidV4, type HostFeature } from "@volli/host-protocol";
import type {
  HostLink,
  HostLinkLogEvent,
  HostLinkOptions,
  HostLinkState,
  HostLinkWakeCause,
} from "@volli/host-protocol/client-link";
import {
  OperationUnavailableError,
  REMOTE_HOST_LINK_CAP,
  REMOTE_HOST_DEVICE_TEXT_MAX,
  REMOTE_HOST_DEVICES_MAX,
  REMOTE_HOST_NAME_MAX,
  REMOTE_HOST_SIGN_IN_UNAVAILABLE,
  REMOTE_HOST_TOO_MANY_PROJECTS,
  REMOTE_HOST_NAME_MAX as PROJECT_NAME_MAX,
  REMOTE_HOST_PROJECT_TEXT_MAX,
  REMOTE_HOST_UPDATE_UNAVAILABLE,
  type AddHostAnswer,
  type AddHostEvent,
  type AddHostFacts,
  type AddHostLogLine,
  type AddHostQuestion,
  type AddHostStartInput,
  type AddHostStepId,
  type AddHostView,
  type CreateRemoteProjectInput,
  type CreateRemoteProjectResult,
  type RemoteHost,
  type RemoteHostDevice,
  type RemoteHostDevices,
  type RemoteHostLink,
  type RemoteHostLinkState,
  type RemoteHostProjects,
  type RemoteProjectFailure,
  type RemoteProjectLink,
  type RemoteHostsSnapshot,
} from "@volli/shared";

import { isHostdFailure, readHostdJson, type InstallMode, type ListenAddress } from "./contract";
import type { StepId } from "./failures";
import { componentLogger, type InstallLogger, type LogFields } from "./logger";
import {
  advance,
  answer,
  initialProvisionState,
  retry as retryFrom,
  type HostProvider,
  type ProvisionSecrets,
} from "./provision";
import {
  ADD_HOST_LOG_LIMIT,
  failureJson,
  flowFacts,
  logLine,
  logTail,
  questionJson,
  stepStatuses,
  stoppedAt,
} from "./remote-hosts-flow";
import { generateDeviceKey, mintDeviceCredential } from "./remote-hosts-device-key";
import { nextRemoteHostLink, remoteHostLinkState, versionFacts } from "./remote-hosts-link";
import {
  cliError,
  createFailure,
  createProjectScript,
  gitUrlProblem,
  lastJsonObject,
  operatorTokenCommand,
  projectsListScript,
  readProject,
  readProjectList,
  repositoryName,
  scriptFacts,
  SYSTEM_PROJECTS_DIR,
} from "./remote-hosts-projects";
import {
  deviceKeyName,
  flowKeyName,
  readRegistry,
  type RegistryFile,
  type RegistryHost,
} from "./remote-hosts-registry";
import {
  modeOf,
  sshProvider,
  type SshProviderPorts,
  type SshProvisionState,
  type SshStepResults,
} from "./ssh-provider";
import { classifySshFailure, shellQuote, type SshExecResult, type SshTransport } from "./ssh";
import { describeStartup } from "./probe";
import { parseSshTarget, type SshTarget } from "./target";
import type { SshTunnel, TunnelState } from "./tunnel";

export const REMOTE_HOSTS_DISABLED = "Remote hosts are not available in this build.";

/** The lines a read-only registry reads. */
export const REGISTRY_NEWER = "This Mac’s hosts file is from a newer Volli.";
export const REGISTRY_UNREADABLE = "This Mac’s hosts file can’t be read.";
export const REGISTRY_UNWRITABLE = "Couldn’t save this Mac’s hosts file.";

/**
 * The feature is off, or v1 does not do this yet: the caller says
 * "unavailable". It carries `@volli/shared`'s operation-unavailable brand, so
 * every door answers it as such (`NOT_IMPLEMENTED` / `operation-unavailable`).
 */
export class RemoteHostsUnavailableError extends OperationUnavailableError {
  constructor(message: string = REMOTE_HOSTS_DISABLED) {
    super(message);
    this.name = "RemoteHostsUnavailableError";
  }
}

export type RemoteHostsErrorCode =
  | "unknown-host"
  | "unknown-flow"
  | "bad-target"
  | "bad-workspace"
  /** The flow is not stopped where this call answers: done, cancelled, or not asking that. */
  | "flow-not-waiting"
  /** The hosts file is from a newer Volli, or unreadable: nothing changes it. */
  | "registry-read-only"
  /** The hosts file would not save: the change did not happen. */
  | "registry-unwritable"
  /** A host's label is empty, longer than `REMOTE_HOST_NAME_MAX`, or has a control character. */
  | "bad-name"
  /** SSH could not reach the host (or ran nothing there): nothing was asked of it. */
  | "host-unreachable"
  /** The host was reached, but its hostd answered no device list this Mac believes, or refused. */
  | "devices-unavailable"
  /** The host was reached, but answered no project list this Mac believes (VC-710). */
  | "projects-unavailable";

export class RemoteHostsError extends Error {
  readonly code: RemoteHostsErrorCode;

  constructor(code: RemoteHostsErrorCode, message: string) {
    super(message);
    this.name = "RemoteHostsError";
    this.code = code;
  }
}

/** Where the registry lives: plain JSON, no secrets. */
export interface RemoteHostsStore {
  /**
   * The file's JSON, or `null` when there is none yet. Throws when there is
   * one it cannot read (not JSON, no permission): the engine then leaves it
   * alone and refuses every change.
   */
  load(): unknown;
  /** Replaces the file whole; throws when it could not. */
  save(file: RegistryFile): void;
}

/** Each host's device private key (P-256 PKCS#8 PEM), held by the caller's sealed store. */
export interface DeviceKeyStore {
  get(name: string): Promise<string | null>;
  put(name: string, pkcs8Pem: string): Promise<void>;
  remove(name: string): Promise<void>;
}

export interface RemoteHostsTunnelOptions {
  readonly target: SshTarget;
  readonly resolveRemote: () => Promise<ListenAddress>;
  readonly logger: InstallLogger;
}

/** Why the tunnels and links should try again now: the Mac woke, or the network came back. */
export type RemoteHostsWakeCause = HostLinkWakeCause;

/** How long and how many finished flows stay answerable before they are let go. */
export interface FlowRetention {
  readonly ttlMs: number;
  readonly max: number;
}

export const DEFAULT_FLOW_RETENTION: FlowRetention = { ttlMs: 10 * 60_000, max: 20 };

/** How long quit waits for work in flight before it lets it find itself cancelled. */
export const DEFAULT_QUIT_GRACE_MS = 5_000;

export interface RemoteHostsPorts {
  readonly store: RemoteHostsStore;
  readonly deviceKeys: DeviceKeyStore;
  /** Production: `systemSsh`. One per flow, closed when it ends. */
  readonly ssh: (target: SshTarget) => SshTransport;
  /** Production: `discoverHostKeys` / `acceptHostKeys` for the target. */
  readonly hostKeys: (target: SshTarget) => SshProviderPorts["hostKeys"];
  /** Production: `resolveArtifact` for this app's version and pin. */
  readonly artifact: SshProviderPorts["artifact"];
  readonly supportedTargets: readonly string[];
  readonly appVersion: string;
  /** What the host calls this Mac. */
  readonly deviceName: string;
  /** Production: `createSshTunnel`. */
  readonly tunnel: (options: RemoteHostsTunnelOptions) => SshTunnel;
  /** Production: `createHostLink`. */
  readonly link: (options: HostLinkOptions) => HostLink;
  /** The features each Workspace link asks for; none by default. */
  readonly linkFeatures?: readonly HostFeature[];
  /**
   * The Mac woke or came back online: every tunnel and link tries now, not
   * after its backoff or a dead-peer timeout. Answers the unsubscribe.
   */
  readonly wake?: (listener: (cause: RemoteHostsWakeCause) => void) => () => void;
  readonly flowRetention?: FlowRetention;
  readonly quitGraceMs?: number;
  readonly now: () => number;
  readonly newId: () => string;
  readonly logger: InstallLogger;
  /** The `cloud` flag. Off: every call refuses with {@link RemoteHostsUnavailableError}. */
  readonly enabled: () => boolean;
}

export interface RemoteHosts {
  snapshot(): RemoteHostsSnapshot;
  /**
   * The host's own link, off the wire: its Workspaces' links aggregated, or
   * its tunnel's while it serves none. For the app's log and the add flow;
   * the UI words each project's link and aggregates them itself (VC-576).
   */
  hostLink(hostId: string): RemoteHostLink;
  /** Called on every change with a new snapshot, not with the current one. */
  subscribe(listener: (snapshot: RemoteHostsSnapshot) => void): () => void;
  /** Reconnect now: the tunnel, and every Workspace link. */
  retry(hostId: string): void;
  /** v1 refuses: {@link REMOTE_HOST_UPDATE_UNAVAILABLE}. */
  updateHost(hostId: string, when: "now" | "when-idle"): void;
  /** v1 refuses: {@link REMOTE_HOST_UPDATE_UNAVAILABLE}. */
  cancelScheduledUpdate(hostId: string): void;
  /** v1 refuses: {@link REMOTE_HOST_SIGN_IN_UNAVAILABLE}. */
  signIn(hostId: string, providerId: string): void;
  /**
   * A Workspace link of the host that is `ready` and was granted `sign-ins`
   * (VC-702), for desktop main's sign-in calls; null while it has none. The
   * caller never closes it: the engine owns every link.
   */
  signInLink(hostId: string): HostLink | null;
  /**
   * The link of a remote Workspace this Mac opened, while it is `ready`
   * (VC-711), for desktop main's Workspace link relay; null while it has none
   * ready, or no host here serves the Workspace. The same shape as
   * {@link RemoteHosts.signInLink}: the caller never closes it (the engine
   * owns every link) and learns it went through `subscribeState`.
   */
  workspaceLink(workspaceId: string): HostLink | null;
  /**
   * Closes its tunnel and links, drops it and its device key. The box is
   * untouched. When the registry would not save, refuses and keeps it all.
   */
  forget(hostId: string): Promise<void>;
  /**
   * This Mac's label for the host, trimmed: persisted and published. The
   * host's own name is untouched (nothing runs on the box). The same name
   * again changes nothing.
   */
  rename(hostId: string, name: string): void;
  /**
   * The devices the host has enrolled, read now over SSH (`volli-hostd
   * devices list`, no sudo), never cached; this Mac's own marked.
   */
  devices(hostId: string): Promise<RemoteHostDevices>;
  /** Opens a Workspace on the host: remembered, and linked whenever the tunnel is up. */
  openWorkspace(hostId: string, workspaceId: string): void;
  /* ── A host's projects (VC-710) ── */
  /**
   * The projects the host has, read now over SSH as its login (`volli project
   * list`, no sudo), never cached; and whether this Mac can add one there.
   */
  projects(hostId: string): Promise<RemoteHostProjects>;
  /**
   * Makes a folder on the host a project, through its own `volli project
   * add` over SSH; with a git URL, cloned first. Answers the project, or the
   * one line (and command) that says why not. Opening it is
   * {@link RemoteHosts.openWorkspace}'s.
   */
  createProject(input: CreateRemoteProjectInput): Promise<CreateRemoteProjectResult>;
  /**
   * Forgets a Workspace on this Mac: its link closes and it leaves the
   * registry. The project on the host is untouched. One not open is a no-op.
   */
  closeWorkspace(hostId: string, workspaceId: string): void;
  /**
   * Starts adding a host; follow it with {@link RemoteHosts.subscribeAdd}.
   * A target with a flow still under way answers that flow, so a retried
   * start never makes a second.
   */
  startAdd(input: AddHostStartInput): Promise<{ readonly flowId: string }>;
  /** One replay (the view, the newest of the log), then every change. */
  subscribeAdd(flowId: string, listener: (event: AddHostEvent) => void): () => void;
  /** Answers the question `questionId`, which must be the one the flow waits on now. */
  answerAdd(flowId: string, questionId: string, reply: AddHostAnswer): Promise<void>;
  /** Kept in the flow's memory only, for sudo's stdin, until the flow next stops. */
  sudoPassword(flowId: string, questionId: string, password: string): Promise<void>;
  retryAdd(flowId: string, from?: AddHostStepId): Promise<void>;
  /**
   * Cancels a flow. Allowed with `cloud` off too, for a flow already under
   * way: turning the flag off must still let the window stop it.
   */
  cancelAdd(flowId: string): Promise<void>;
  /**
   * What the flow has found about its host so far (`hostAdd.facts`), read
   * beside each view; a finished flow's until it is let go.
   */
  addFacts(flowId: string): AddHostFacts;
  /** Stops everything: at quit. Every call shares the first. */
  close(): Promise<void>;
}

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** C0, DEL and C1: never in a host's label. */
const CONTROL_CHARACTER = /\p{Cc}/u;

/**
 * Where hostd's binary is for each install mode, as the probe looks for it
 * (`probe.ts`'s `CANDIDATES`): a managed system install, else the M1
 * runbook's hand-made one; a user install (a Mac's too) under
 * `$XDG_DATA_HOME` or `~/.local/share`.
 */
const MANAGED_SYSTEM_BINARY = "/opt/volli-hostd/current/bin/volli-hostd";
const FLAT_SYSTEM_BINARY = "/opt/volli-hostd/bin/volli-hostd";
const USER_BINARY = '"${XDG_DATA_HOME:-$HOME/.local/share}/volli-hostd/current/bin/volli-hostd"';

/**
 * `volli-hostd devices list` for a host's install mode: plain POSIX sh, run
 * as the login (anyone may list; no sudo), its stdin `/dev/null`.
 */
export function devicesListScript(mode: InstallMode): string {
  const find =
    mode === "system"
      ? [
          `b=${shellQuote(MANAGED_SYSTEM_BINARY)}`,
          `[ -x "$b" ] || b=${shellQuote(FLAT_SYSTEM_BINARY)}`,
        ]
      : [`b=${USER_BINARY}`];
  return [...find, `exec "$b" devices list --${mode} </dev/null`].join("\n");
}

const isDeviceText = (value: unknown): value is string =>
  typeof value === "string" && value.length <= REMOTE_HOST_DEVICE_TEXT_MAX;

/** hostd's device list, each device exactly as the wire carries it, or `null` when not believed. */
function readDeviceList(
  said: Record<string, unknown>,
  thisDevice: string,
): RemoteHostDevice[] | null {
  const { devices } = said;
  if (said.ok !== true || !Array.isArray(devices) || devices.length > REMOTE_HOST_DEVICES_MAX) {
    return null;
  }
  const read: RemoteHostDevice[] = [];
  for (const value of devices as unknown[]) {
    if (typeof value !== "object" || value === null) return null;
    const { deviceId, name, fingerprint, enrolledAt, via, revokedAt } = value as Record<
      string,
      unknown
    >;
    if (
      !isDeviceText(deviceId) ||
      !isDeviceText(name) ||
      !isDeviceText(fingerprint) ||
      !isDeviceText(enrolledAt) ||
      !isDeviceText(via) ||
      !(revokedAt === null || isDeviceText(revokedAt))
    ) {
      return null;
    }
    read.push({
      deviceId,
      name,
      fingerprint,
      enrolledAt,
      via,
      revokedAt,
      thisMac: deviceId === thisDevice,
    });
  }
  return read;
}

/** A create refused before anything ran on the host. */
const refusedHere = (
  code: RemoteProjectFailure["code"],
  message: string,
): CreateRemoteProjectResult => ({ ok: false, failure: { code, message, command: null } });

/** How long a host's project list may take, and a create (a clone included). */
const PROJECTS_TIMEOUT_MS = 30_000;
const CREATE_PROJECT_TIMEOUT_MS = 10 * 60_000;

/** Backoff for a tunnel's first open, which the tunnel leaves to its owner to retry. */
const OPEN_BACKOFF_MIN_MS = 1_000;
const OPEN_BACKOFF_MAX_MS = 30_000;

/** A flow's work that found it cancelled, or the engine closed: not a failure. */
class Abandoned extends Error {}

/** The flow's own key is gone from the store: nothing a retry of the link can bring back. */
class KeyMissing extends Error {
  constructor() {
    super("This Mac's new device key went missing.");
  }
}

interface HeldLink {
  readonly link: HostLink;
  readonly url: string;
  readonly unsubscribe: () => void;
}

interface HostRuntime {
  readonly id: string;
  readonly tunnel: SshTunnel;
  readonly remote: { listen: ListenAddress };
  readonly links: Map<string, HeldLink>;
  readonly unsubscribeTunnel: () => void;
  /** The tunnel's failures since it was last up. */
  attempt: number;
  retryAt: number;
  link: RemoteHostLink;
  /** Each open Workspace's own link: its VC-670 link's, or the tunnel's until it has one. */
  readonly projectLinks: Map<string, RemoteHostLink>;
  timer: ReturnType<typeof setTimeout> | undefined;
  closed: boolean;
}

interface Flow {
  readonly id: string;
  readonly target: SshTarget;
  readonly targetText: string;
  readonly name: string;
  readonly ssh: SshTransport;
  readonly secrets: ProvisionSecrets;
  readonly logger: InstallLogger;
  readonly log: AddHostLogLine[];
  /** Lines the log let go of, past {@link ADD_HOST_LOG_LIMIT}. */
  dropped: number;
  readonly listeners: Set<(event: AddHostEvent) => void>;
  state: SshProvisionState;
  /** The results the view shows: the state's, plus each step finished in this run. */
  results: SshStepResults;
  status: AddHostView["status"];
  active: StepId | null;
  hostId: string | null;
  tunnel: SshTunnel | null;
  remote: { listen: ListenAddress } | null;
  /** A device key written under its host's name that the registry does not name yet. */
  promoted: string | null;
  /** How many questions it has asked: each one's id. */
  questions: number;
  /** The host key fingerprints the person compared and trusted in this flow, if it asked. */
  trustedKeys: readonly string[] | null;
  queue: Promise<void>;
  view: AddHostView;
  sshClosed: Promise<void> | null;
  discarded: Promise<void> | null;
  disposeTimer: ReturnType<typeof setTimeout> | undefined;
  endedAt: number | null;
}

/** A link's state from the host's tunnel and these Workspace links (all of them, or one). */
function derive(runtime: HostRuntime, links: readonly HeldLink[]) {
  return remoteHostLinkState({
    tunnel: runtime.tunnel.state,
    attempt: runtime.attempt,
    retryAt: runtime.retryAt,
    links: links.map((held): HostLinkState => held.link.getState()),
  });
}

/** What a project past the cap reads: refused by this Mac, in words that say so. */
function tooManyProjects(name: string): RemoteHostLinkState {
  return {
    status: "refused",
    error: {
      code: "TOO_MANY_REQUESTS",
      reason: REMOTE_HOST_TOO_MANY_PROJECTS,
      message: `Too many projects open on ${name}`,
    },
    closeCode: null,
  };
}

/** `job` after every call on the flow before it: one at a time, whatever each one did. */
function enqueue(flow: Flow, job: () => Promise<void>): Promise<void> {
  const run = flow.queue.then(job);
  flow.queue = run.catch(() => {});
  return run;
}

/** Whether `reply` is an answer the question offers. */
export function answerFits(question: AddHostQuestion, reply: AddHostAnswer): boolean {
  switch (question.kind) {
    case "host-key":
      return reply.kind === "accept-host-key";
    case "existing-hostd":
      return reply.kind === "update" || (reply.kind === "adopt" && question["adoptable"] === true);
    case "already-paired":
      return reply.kind === "open";
    case "sudo-password":
      return reply.kind === "user-install" && question["reason"] === "install";
    case "identity-changed":
      return reply.kind === "repair";
    default:
      return false;
  }
}

/** The Workspaces that get a link: the first {@link REMOTE_HOST_LINK_CAP} remembered. */
function linked(entry: RegistryHost): readonly string[] {
  return entry.workspaceIds.slice(0, REMOTE_HOST_LINK_CAP);
}

/** Why the flow's current question is not `questionId`, or `null` when it is and `fit` holds. */
function asking(
  flow: Flow,
  questionId: string,
  fit: (question: AddHostQuestion) => boolean,
): string | null {
  const { question } = flow.view;
  if (flow.status !== "question" || question === null) return `is ${flow.status}, not asking`;
  if (question.id !== questionId) return `asks ${question.id} now, not ${questionId}`;
  return fit(question) ? null : `does not take that answer to ${question.kind}`;
}

/** Waits for every promise to settle, or for `ms`, whichever is first. */
async function settleWithin(promises: readonly Promise<unknown>[], ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), ms);
  });
  const settled = Promise.allSettled(promises).then(() => true as const);
  try {
    return await Promise.race([settled, late]);
  } finally {
    clearTimeout(timer);
  }
}

export function createRemoteHosts(ports: RemoteHostsPorts): RemoteHosts {
  const { logger } = ports;
  const retention = ports.flowRetention ?? DEFAULT_FLOW_RETENTION;
  const entries = new Map<string, RegistryHost>();
  const runtimes = new Map<string, HostRuntime>();
  const flows = new Map<string, Flow>();
  const listeners = new Set<(snapshot: RemoteHostsSnapshot) => void>();
  /** Each host's finalization and forget, one at a time. */
  const leases = new Map<string, Promise<void>>();
  /** Starts and forgets in flight: quit waits for them. */
  const pending = new Set<Promise<unknown>>();
  let current: RemoteHostsSnapshot = { v: 1, hosts: [], projects: {}, readOnly: null };
  /** Why the registry must not be written, or `null`. */
  let readOnly: string | null = null;
  let started = false;
  let closed = false;
  let closing: Promise<void> | null = null;
  /**
   * Every tunnel it made, closed or not: quit SIGKILLs whatever ssh any of
   * them still owns (a replaced host's, a cancelled link step's).
   */
  const tunnelsMade = new Set<SshTunnel>();
  /** Each project script's SSH connection while it runs (VC-710): quit SIGKILLs what is left. */
  const projectSsh = new Set<SshTransport>();
  /** Epoch ms by which quit is done, once it has begun. */
  let quitDeadline: number | null = null;
  let unsubscribeWake: (() => void) | undefined;

  const iso = (): string => new Date(ports.now()).toISOString();

  function makeTunnel(options: RemoteHostsTunnelOptions): SshTunnel {
    const tunnel = ports.tunnel(options);
    tunnelsMade.add(tunnel);
    return tunnel;
  }

  function track<T>(work: Promise<T>): Promise<T> {
    pending.add(work);
    const done = (): void => {
      pending.delete(work);
    };
    work.then(done, done);
    return work;
  }

  /** `job` once every earlier lease on the host is over. */
  function withLease<T>(hostId: string, job: () => Promise<T>): Promise<T> {
    const run = (leases.get(hostId) ?? Promise.resolve()).then(job);
    const tail = run.then(
      () => {},
      () => {},
    );
    leases.set(hostId, tail);
    void tail.then(() => {
      if (leases.get(hostId) === tail) leases.delete(hostId);
    });
    return run;
  }

  /* ── The registry and the snapshot ───────────────────────────────────── */

  /** Writes `hosts` as the registry, or throws having changed nothing. */
  function save(hosts: Iterable<RegistryHost>): void {
    try {
      ports.store.save({ v: 1, hosts: [...hosts] });
    } catch (error) {
      logger.error("remote host registry not saved", { error: messageOf(error) });
      throw new RemoteHostsError("registry-unwritable", REGISTRY_UNWRITABLE);
    }
  }

  function writable(): void {
    if (readOnly !== null) throw new RemoteHostsError("registry-read-only", readOnly);
  }

  function hostJson(entry: RegistryHost): RemoteHost {
    return {
      id: entry.id,
      name: entry.name,
      target: entry.target,
      transport: "ssh-tunnel",
      os: entry.os,
      mode: entry.mode,
      agentsShareAccount: entry.mode === "user",
      version: entry.version,
      ...versionFacts(entry.version, ports.appVersion),
      deviceId: entry.deviceId,
      addedAt: entry.addedAt,
      liveSessions: null,
      system: entry.system,
      arch: entry.arch,
      hostKeys: entry.hostKeys,
    };
  }

  function publish(): void {
    const projects: Record<string, RemoteProjectLink> = {};
    for (const entry of entries.values()) {
      const runtime = runtimes.get(entry.id)!;
      for (const workspaceId of entry.workspaceIds) {
        projects[workspaceId] = {
          hostId: entry.id,
          link: runtime.projectLinks.get(workspaceId)!.state,
        };
      }
    }
    current = { v: 1, hosts: [...entries.values()].map(hostJson), projects, readOnly };
    for (const listener of listeners) {
      try {
        listener(current);
      } catch (error) {
        logger.warn("remote hosts listener threw", { error: messageOf(error) });
      }
    }
  }

  function load(): void {
    let raw: unknown;
    try {
      raw = ports.store.load();
    } catch (error) {
      readOnly = REGISTRY_UNREADABLE;
      logger.error("remote host registry unreadable; leaving it as it is", {
        error: messageOf(error),
      });
      return;
    }
    if (raw === null) return;
    const read = readRegistry(raw);
    if (read.kind === "newer") {
      readOnly = REGISTRY_NEWER;
      logger.error("remote host registry is from a newer Volli; leaving it as it is", {
        version: read.version,
      });
      return;
    }
    if (read.kind === "unreadable") {
      readOnly = REGISTRY_UNREADABLE;
      logger.error("remote host registry unreadable; leaving it as it is", {
        problem: read.problem,
      });
      return;
    }
    if (read.problems.length > 0) {
      logger.warn("remote host registry had entries it could not use; dropped them", {
        problems: read.problems.join("; "),
      });
    }
    for (const host of read.file.hosts) entries.set(host.id, host);
  }

  function ensureStarted(): void {
    if (started) return;
    started = true;
    load();
    for (const entry of entries.values()) startHost(entry);
    unsubscribeWake = ports.wake?.((cause) => wakeAll(cause));
    publish();
  }

  function guard(): void {
    if (closed || !ports.enabled()) throw new RemoteHostsUnavailableError();
    ensureStarted();
  }

  function hostOf(hostId: string): RegistryHost {
    const entry = entries.get(hostId);
    if (entry === undefined) {
      throw new RemoteHostsError("unknown-host", `No remote host ${hostId} on this Mac.`);
    }
    return entry;
  }

  /* ── Bringing a host up ──────────────────────────────────────────────── */

  /** Moves the host's link, and each of its Workspaces' links, on to what they say now. */
  function follow(runtime: HostRuntime, previous: RemoteHostLink | null): void {
    const now = ports.now();
    const entry = entries.get(runtime.id)!;
    runtime.link = nextRemoteHostLink(previous, derive(runtime, [...runtime.links.values()]), now);
    entry.workspaceIds.forEach((workspaceId, index) => {
      const held = runtime.links.get(workspaceId);
      const state =
        index < REMOTE_HOST_LINK_CAP
          ? derive(runtime, held === undefined ? [] : [held])
          : tooManyProjects(entry.name);
      runtime.projectLinks.set(
        workspaceId,
        nextRemoteHostLink(runtime.projectLinks.get(workspaceId) ?? null, state, now),
      );
    });
  }

  function recompute(runtime: HostRuntime): void {
    follow(runtime, runtime.link);
    publish();
  }

  /** A fresh `vdc1` for one handshake, signed with the host's device key. */
  async function credentialFor(hostId: string, workspaceId: string): Promise<string> {
    const entry = entries.get(hostId);
    if (entry === undefined) throw new Error("This host was forgotten.");
    const privateKeyPem = await ports.deviceKeys.get(deviceKeyName(hostId, entry.deviceId));
    if (privateKeyPem === null) throw new Error(`This Mac has no device key for ${entry.name}.`);
    return mintDeviceCredential({
      privateKeyPem,
      hostId,
      deviceId: entry.deviceId,
      workspaceId,
      now: ports.now(),
    });
  }

  /** The host's version as its link last said: kept in memory, and on disk when it can be. */
  function noteVersion(runtime: HostRuntime, version: string): void {
    const entry = entries.get(runtime.id)!;
    if (entry.version === version) return;
    const next = { ...entry, version };
    entries.set(runtime.id, next);
    try {
      save(entries.values());
    } catch {
      // Logged by save; the version is a cache, read again at the next handshake.
    }
  }

  /** One Workspace link's events, in the app's log beside the tunnel's (VC-699). */
  function linkLogger(hostId: string, workspaceId: string): (event: HostLinkLogEvent) => void {
    return (event) => {
      const loud =
        event.kind === "state" &&
        (event.to === "unreachable" || event.to === "refused" || event.to === "fenced");
      const level = loud ? "warn" : event.kind === "state" ? "info" : "debug";
      logger[level](`host link ${event.kind}`, { ...event, hostId, workspaceId });
    };
  }

  function openLink(runtime: HostRuntime, workspaceId: string, url: string): void {
    const held = runtime.links.get(workspaceId);
    if (held !== undefined) {
      if (held.url === url) {
        // The tunnel came back on the same port: try now rather than after backoff.
        held.link.wake("network-online");
        return;
      }
      held.unsubscribe();
      held.link.close();
      runtime.links.delete(workspaceId);
    }
    const link = ports.link({
      url,
      workspaceId,
      client: { kind: "desktop", version: ports.appVersion },
      features: ports.linkFeatures ?? [],
      credential: () => credentialFor(runtime.id, workspaceId),
      log: linkLogger(runtime.id, workspaceId),
    });
    const unsubscribe = link.subscribeState((state) => {
      if (state.status === "ready") noteVersion(runtime, state.welcome.host.version);
      recompute(runtime);
    });
    runtime.links.set(workspaceId, { link, url, unsubscribe });
  }

  function onTunnel(runtime: HostRuntime, state: TunnelState): void {
    if (state.status === "up") {
      runtime.attempt = 0;
      clearTimeout(runtime.timer);
      runtime.timer = undefined;
      for (const workspaceId of linked(entries.get(runtime.id)!)) {
        openLink(runtime, workspaceId, state.url);
      }
    } else if (state.status === "down") {
      runtime.attempt += 1;
      runtime.retryAt = ports.now() + state.retryInMs;
    }
    recompute(runtime);
  }

  /** The first open; a tunnel retries by itself only once it has been up. */
  function openTunnel(runtime: HostRuntime): void {
    runtime.timer = undefined;
    runtime.tunnel.start().catch(() => {
      if (runtime.closed) return;
      const delay = Math.min(
        OPEN_BACKOFF_MAX_MS,
        OPEN_BACKOFF_MIN_MS * 2 ** Math.max(0, runtime.attempt - 1),
      );
      runtime.retryAt = ports.now() + delay;
      recompute(runtime);
      runtime.timer = setTimeout(() => openTunnel(runtime), delay);
    });
  }

  /** The Mac woke, or the network came back: every tunnel and link tries now. */
  function wakeAll(cause: RemoteHostsWakeCause): void {
    if (closed) return;
    logger.info("remote hosts woken", { cause, hosts: runtimes.size });
    for (const runtime of runtimes.values()) {
      if (runtime.timer !== undefined) {
        // Never up yet, and waiting out a backoff: open it now.
        clearTimeout(runtime.timer);
        openTunnel(runtime);
      } else {
        runtime.tunnel.wake();
      }
      for (const held of runtime.links.values()) held.link.wake(cause);
    }
  }

  function startHost(
    entry: RegistryHost,
    tunnel?: SshTunnel,
    remote?: { listen: ListenAddress },
  ): void {
    const holder = remote ?? { listen: entry.listen };
    holder.listen = entry.listen;
    const hostTunnel =
      tunnel ??
      makeTunnel({
        target: parseSshTarget(entry.target) as SshTarget,
        resolveRemote: () => Promise.resolve(holder.listen),
        logger: componentLogger(logger, { host: entry.name, hostId: entry.id }),
      });
    const runtime: HostRuntime = {
      id: entry.id,
      tunnel: hostTunnel,
      remote: holder,
      links: new Map(),
      unsubscribeTunnel: hostTunnel.onState((state) => onTunnel(runtime, state)),
      attempt: 0,
      retryAt: ports.now(),
      link: { state: { status: "connecting", attempt: 0 }, everReady: false, droppedAt: null },
      projectLinks: new Map(),
      timer: undefined,
      closed: false,
    };
    follow(runtime, null);
    runtimes.set(entry.id, runtime);
    const state = runtime.tunnel.state;
    if (state.status === "up") onTunnel(runtime, state);
    else openTunnel(runtime);
  }

  function stopHost(hostId: string): void {
    const runtime = runtimes.get(hostId);
    if (runtime === undefined) return;
    runtime.closed = true;
    clearTimeout(runtime.timer);
    runtime.unsubscribeTunnel();
    for (const held of runtime.links.values()) {
      held.unsubscribe();
      held.link.close();
    }
    runtime.tunnel.close();
    runtimes.delete(hostId);
  }

  /** Removes a key, logging rather than failing: what is left is a stray key, never a lost one. */
  async function removeKey(name: string): Promise<void> {
    try {
      await ports.deviceKeys.remove(name);
    } catch (error) {
      logger.warn("a device key was not removed", { key: name, error: messageOf(error) });
    }
  }

  /** Forgets a host: the registry first, so a write that fails keeps it all. */
  function dropHost(hostId: string): Promise<void> {
    return withLease(hostId, async () => {
      const entry = hostOf(hostId);
      save([...entries.values()].filter((other) => other.id !== hostId));
      entries.delete(hostId);
      stopHost(hostId);
      publish();
      await removeKey(deviceKeyName(hostId, entry.deviceId));
    });
  }

  /* ── Managing a host ─────────────────────────────────────────────────── */

  /** Runs `devices list` on the host over its own short-lived SSH connection, always closed. */
  async function listDevices(entry: RegistryHost): Promise<RemoteHostDevices> {
    const log = componentLogger(logger, { host: entry.name, hostId: entry.id });
    const ssh = ports.ssh(parseSshTarget(entry.target) as SshTarget);
    let result: SshExecResult;
    try {
      result = await ssh.exec(devicesListScript(entry.mode), {
        label: "devices",
        timeoutMs: 30_000,
      });
    } catch (error) {
      log.warn("listing devices: ssh failed", { error: messageOf(error) });
      throw new RemoteHostsError("host-unreachable", `Couldn't reach ${entry.name}.`);
    } finally {
      try {
        await ssh.close();
      } catch (error) {
        log.warn("listing devices: ssh did not close cleanly", { error: messageOf(error) });
      }
    }
    const failure = classifySshFailure(result);
    if (failure !== null) {
      log.warn("listing devices: host unreachable", {
        failure: failure.kind,
        detail: failure.detail,
      });
      throw new RemoteHostsError("host-unreachable", `Couldn't reach ${entry.name}.`);
    }
    const said = readHostdJson(result.stdout);
    const devices = said === null ? null : readDeviceList(said, entry.deviceId);
    if (devices === null) {
      log.warn("listing devices: no device list believed", {
        code: result.code,
        ...(said !== null && isHostdFailure(said)
          ? { hostd: said.code, message: said.message }
          : { stderr: result.stderr.trim().split("\n").slice(-3).join(" ") }),
      });
      throw new RemoteHostsError("devices-unavailable", `${entry.name} didn't list its devices.`);
    }
    log.info("listed devices", { devices: devices.length });
    return { hostId: entry.id, devices };
  }

  /* ── A host's projects over SSH (VC-710) ─────────────────────────────── */

  /**
   * Runs one project script on the host over its own short-lived SSH
   * connection, always closed. `null`: SSH could not reach it (logged).
   */
  async function runProjectScript(
    entry: RegistryHost,
    script: string,
    label: "projects" | "create-project",
    timeoutMs: number,
    /** The login's sudo password, for the script's stdin only: never logged or kept. */
    sudoPassword: string | null = null,
  ): Promise<SshExecResult | null> {
    const log = componentLogger(logger, { host: entry.name, hostId: entry.id });
    const ssh = ports.ssh(parseSshTarget(entry.target) as SshTarget);
    projectSsh.add(ssh);
    let result: SshExecResult;
    try {
      result = await ssh.exec(script, {
        label,
        timeoutMs,
        ...(sudoPassword === null ? {} : { stdin: `${sudoPassword}\n` }),
      });
    } catch (error) {
      log.warn(`${label}: ssh failed`, { error: messageOf(error) });
      return null;
    } finally {
      projectSsh.delete(ssh);
      try {
        await ssh.close();
      } catch (error) {
        log.warn(`${label}: ssh did not close cleanly`, { error: messageOf(error) });
      }
    }
    const failure = classifySshFailure(result);
    if (failure !== null) {
      log.warn(`${label}: host unreachable`, { failure: failure.kind, detail: failure.detail });
      return null;
    }
    return result;
  }

  async function listProjects(entry: RegistryHost): Promise<RemoteHostProjects> {
    const log = componentLogger(logger, { host: entry.name, hostId: entry.id });
    const result = await runProjectScript(
      entry,
      projectsListScript(entry.mode),
      "projects",
      PROJECTS_TIMEOUT_MS,
    );
    if (result === null) {
      throw new RemoteHostsError("host-unreachable", `Couldn't reach ${entry.name}.`);
    }
    const facts = scriptFacts(result.stdout);
    const projects = readProjectList(lastJsonObject(result.stdout));
    if (projects === "outdated") {
      log.warn("listing projects: the host's volli lists no ids");
      throw new RemoteHostsError(
        "projects-unavailable",
        `${entry.name}'s Volli is too old to list its projects here: add it again to update it.`,
      );
    }
    if (projects === null) {
      const error = cliError(result.stderr);
      log.warn("listing projects: no project list believed", {
        code: result.code,
        ...(error === null
          ? { stderr: result.stderr.trim().split("\n").slice(-3).join(" ") }
          : { cli: error.code, reason: error.reason }),
      });
      throw new RemoteHostsError(
        "projects-unavailable",
        error?.code === "APP_UNREACHABLE"
          ? `Volli isn't answering on ${entry.name}.`
          : `${entry.name} didn't list its projects.`,
      );
    }
    log.info("listed projects", { projects: projects.length, operator: facts.token });
    return {
      hostId: entry.id,
      projects,
      adds:
        entry.mode === "user"
          ? { kind: "user-install" }
          : facts.token
            ? { kind: "ready" }
            : {
                kind: "needs-operator",
                command: operatorTokenCommand(facts.login ?? "<your login>"),
              },
    };
  }

  async function addProject(
    entry: RegistryHost,
    input: CreateRemoteProjectInput,
  ): Promise<CreateRemoteProjectResult> {
    const log = componentLogger(logger, { host: entry.name, hostId: entry.id });
    if (entry.mode === "user") {
      return refusedHere(
        "user-install",
        `${entry.name} runs Volli as your login, so this Mac can't add projects to it.`,
      );
    }
    const gitUrl = input.gitUrl?.trim() || null;
    if (gitUrl !== null && gitUrlProblem(gitUrl) !== null) {
      return refusedHere("bad-url", "That isn't a git URL this Mac can clone: use https or ssh.");
    }
    const named = input.path?.trim() || null;
    const cloneName = gitUrl === null ? null : repositoryName(gitUrl);
    const path = named ?? (cloneName === null ? null : `${SYSTEM_PROJECTS_DIR}/${cloneName}`);
    if (path === null) {
      return gitUrl === null
        ? refusedHere("refused", `Name a folder on ${entry.name}.`)
        : refusedHere("bad-url", "Name the folder to clone it into: the URL names none.");
    }
    if (
      !(path.startsWith("/") || path.startsWith("~/")) ||
      path.length > REMOTE_HOST_PROJECT_TEXT_MAX ||
      CONTROL_CHARACTER.test(path)
    ) {
      return refusedHere(
        "refused",
        `A folder on ${entry.name} is a full path, like /srv/volli/app.`,
      );
    }
    // Only a clone runs as hostd's account; a password for anything else is dropped here.
    const sudoPassword = gitUrl !== null && input.sudoPassword ? input.sudoPassword : null;
    const name = input.name?.trim() || null;
    if (name !== null && (name.length > PROJECT_NAME_MAX || CONTROL_CHARACTER.test(name))) {
      return refusedHere(
        "refused",
        `A project's name is 1 to ${PROJECT_NAME_MAX} characters, with no control characters.`,
      );
    }
    log.info("adding a project", { clone: gitUrl !== null });
    const result = await runProjectScript(
      entry,
      createProjectScript({
        mode: entry.mode,
        path,
        name,
        gitUrl,
        sudoPassword: sudoPassword !== null,
      }),
      "create-project",
      CREATE_PROJECT_TIMEOUT_MS,
      sudoPassword,
    );
    if (result === null) {
      return refusedHere("host-unreachable", `Couldn't reach ${entry.name}.`);
    }
    const facts = scriptFacts(result.stdout);
    const said = lastJsonObject(result.stdout);
    const project =
      facts.fail === null && typeof said?.["project"] === "object"
        ? readProject({ tickets: 0, ...(said["project"] as Record<string, unknown>) })
        : null;
    if (project !== null) {
      const created = said?.["created"] === true;
      log.info(created ? "added a project" : "the folder was already a project", {
        workspaceId: project.id,
      });
      return { ok: true, created, project };
    }
    const failure = createFailure(entry.name, facts, cliError(result.stderr), result.stderr, {
      path,
      gitUrl,
    });
    // Never the password: not in a failure's words, nor in the log below.
    log.warn("adding a project failed", { failure: failure.code, code: result.code });
    return { ok: false, failure };
  }

  /* ── Adding a host ───────────────────────────────────────────────────── */

  function flowOf(flowId: string): Flow {
    const flow = flows.get(flowId);
    if (flow === undefined) throw new RemoteHostsError("unknown-flow", `No add flow ${flowId}.`);
    return flow;
  }

  /** Still wanted: not cancelled, and not quit. */
  const alive = (flow: Flow): boolean => !closed && flow.status !== "cancelled";

  function check(flow: Flow): void {
    if (!alive(flow)) throw new Abandoned();
  }

  /** The flow under way for the same box (destination and port), if any. */
  function activeFlowFor(target: SshTarget): Flow | undefined {
    return [...flows.values()].find(
      (flow) =>
        flow.status !== "done" &&
        flow.status !== "cancelled" &&
        flow.target.destination === target.destination &&
        flow.target.port === target.port,
    );
  }

  function emit(flow: Flow, event: AddHostEvent): void {
    for (const listener of flow.listeners) {
      try {
        listener(event);
      } catch (error) {
        logger.warn("add-host listener threw", { flowId: flow.id, error: messageOf(error) });
      }
    }
  }

  function emitView(flow: Flow): void {
    const { state, status } = flow;
    const waiting = status === "question" || status === "failed";
    const { probe } = flow.results;
    flow.view = {
      flowId: flow.id,
      target: flow.targetText,
      name: flow.name,
      status,
      steps: stepStatuses(
        flow.results,
        waiting ? stoppedAt(state) : null,
        status === "running" ? flow.active : null,
      ),
      question: status === "question" ? questionJson(state, `q${flow.questions}`) : null,
      failure: status === "failed" ? failureJson(state, flow.name) : null,
      hostId: flow.hostId,
      startup: probe === undefined ? null : describeStartup(probe, flow.name),
    };
    emit(flow, { kind: "view", view: flow.view });
  }

  /** The flow's logger: every line to the app's log, and to the flow's own until it is done. */
  function flowLogger(flow: () => Flow): InstallLogger {
    const at =
      (level: AddHostLogLine["level"]) =>
      (message: string, fields: LogFields = {}): void => {
        const self = flow();
        logger[level](message, { ...fields, flowId: self.id });
        if (self.status === "done") return;
        const line = logLine(iso(), level, message, fields);
        self.log.push(line);
        if (self.log.length > ADD_HOST_LOG_LIMIT) {
          self.log.shift();
          self.dropped += 1;
        }
        emit(self, { kind: "log", flowId: self.id, line });
      };
    return { debug: at("debug"), info: at("info"), warn: at("warn"), error: at("error") };
  }

  /** The link step's tunnel: this flow's, handed to the host once it is added. */
  async function openFlowTunnel(
    flow: Flow,
    listen: ListenAddress,
  ): Promise<{ readonly url: string } | { readonly error: string }> {
    flow.tunnel?.close();
    flow.tunnel = null;
    const remote = { listen };
    const tunnel = makeTunnel({
      target: flow.target,
      resolveRemote: () => Promise.resolve(remote.listen),
      logger: componentLogger(flow.logger, { host: flow.name }),
    });
    flow.tunnel = tunnel;
    flow.remote = remote;
    try {
      const url = await tunnel.start();
      // A cancel closes the flow's tunnel itself; one that lands after quit is closed here.
      if (!alive(flow)) tunnel.close();
      return { url };
    } catch (error) {
      tunnel.close();
      if (flow.tunnel === tunnel) flow.tunnel = null;
      return { error: messageOf(error) };
    }
  }

  /** The SSH provider, watched: each step shows as it runs and ends, and a cancel stops the rest. */
  function flowProvider(flow: Flow): HostProvider<SshStepResults> {
    const inner = sshProvider({
      ssh: flow.ssh,
      hostKeys: ports.hostKeys(flow.target),
      artifact: ports.artifact,
      openTunnel: (listen) => openFlowTunnel(flow, listen),
    });
    return {
      id: inner.id,
      async run(step, context) {
        flow.active = step;
        flow.results = context.state.results;
        emitView(flow);
        const outcome = await inner.run(step, context);
        if (!alive(flow)) {
          // Discarded, and nothing after it runs.
          return {
            kind: "failed",
            failure: { code: "unexpected-state", step, detail: "The add was cancelled." },
          };
        }
        if (!("kind" in outcome)) {
          flow.results = { ...context.state.results, [step]: outcome.result };
        }
        return outcome;
      },
    };
  }

  /**
   * The host is added, under its lease: its key under its own name beside
   * any older one, then (no await between) the registry, the runtime and the
   * snapshot. Throws {@link Abandoned} when the flow stopped being wanted at
   * any await before that, having written nothing it leaves behind.
   */
  async function finishAdd(flow: Flow, state: SshProvisionState): Promise<void> {
    const enroll = state.results.enroll!;
    const hostId = enroll.hostId;
    await withLease(hostId, async () => {
      check(flow);
      const privateKeyPem = await ports.deviceKeys.get(flowKeyName(flow.id));
      check(flow);
      if (privateKeyPem === null) throw new KeyMissing();
      const keyName = deviceKeyName(hostId, enroll.deviceId);
      flow.promoted = keyName;
      await ports.deviceKeys.put(keyName, privateKeyPem);
      if (!alive(flow)) {
        // Cancelled or quit while it was written: the discard may have run first.
        flow.promoted = null;
        await removeKey(keyName);
        throw new Abandoned();
      }
      // From here to the handoff nothing awaits.
      const pinned = state.request.pinnedHostId;
      // The person agreed the host's identity changed: the old one goes.
      const replaced = pinned !== null && pinned !== hostId ? (entries.get(pinned) ?? null) : null;
      const kept = entries.get(hostId);
      const facts = flowFacts(state.results, state.decisions);
      const remote = flow.remote!;
      const entry: RegistryHost = {
        id: hostId,
        name: flow.name,
        target: flow.targetText,
        os: state.results.probe!.kernel === "Darwin" ? "macos" : "linux",
        mode: modeOf(state)!,
        version: enroll.version,
        deviceId: enroll.deviceId,
        addedAt: kept?.addedAt ?? iso(),
        listen: remote.listen,
        workspaceIds: kept?.workspaceIds ?? [],
        system: facts.system,
        arch: facts.arch,
        // The keys the person trusted in this add, or what an earlier add kept.
        hostKeys: flow.trustedKeys ?? kept?.hostKeys ?? [],
      };
      const next = new Map(entries);
      if (replaced !== null) next.delete(replaced.id);
      next.set(hostId, entry);
      save(next.values());
      // Saved: the add is done. Everything after this only tidies.
      if (replaced !== null) {
        entries.delete(replaced.id);
        stopHost(replaced.id);
      }
      entries.set(hostId, entry);
      stopHost(hostId);
      const tunnel = flow.tunnel!;
      flow.tunnel = null;
      flow.promoted = null;
      flow.hostId = hostId;
      startHost(entry, tunnel, remote);
      publish();
      flow.status = "done";
      flow.secrets.sudoPassword = null;
      flow.active = null;
      emitView(flow);
      ended(flow);
      const stale = [
        flowKeyName(flow.id),
        ...(replaced === null ? [] : [deviceKeyName(replaced.id, replaced.deviceId)]),
        ...(kept === undefined || kept.deviceId === enroll.deviceId
          ? []
          : [deviceKeyName(hostId, kept.deviceId)]),
      ];
      for (const name of stale) await removeKey(name);
    });
    // Outside the lease: the next flow for this host need not wait on this one's SSH.
    await closeSsh(flow);
  }

  /** Runs the flow until it is added, fails, or asks; one at a time per flow. */
  async function runFlow(flow: Flow): Promise<void> {
    // Only ever called on a flow that is wanted: a new one, or one resumed from a stop.
    flow.status = "running";
    flow.results = flow.state.results;
    emitView(flow);
    const state = await advance(flow.state, flowProvider(flow), {
      logger: flow.logger,
      secrets: flow.secrets,
    });
    // Cancelled while it ran: the result is discarded.
    if (!alive(flow)) return;
    flow.state = state;
    flow.results = state.results;
    flow.active = null;
    if (state.status === "done") {
      try {
        await finishAdd(flow, state);
        return;
      } catch (error) {
        if (!alive(flow)) return;
        const missing = error instanceof KeyMissing;
        const { link: _, ...results } = state.results;
        flow.state = {
          ...state,
          results,
          status: "stopped",
          stop: {
            kind: "failed",
            failure: missing
              ? { code: "unexpected-state", step: "link", detail: messageOf(error) }
              : { code: "save-failed", step: "link", detail: messageOf(error) },
          },
        };
        flow.results = results;
        flow.status = "failed";
        flow.logger.error("adding the host failed at the end", { error: messageOf(error) });
      }
    } else if (state.stop!.kind === "question") {
      flow.questions += 1;
      flow.status = "question";
    } else {
      flow.status = "failed";
    }
    // Every stop forgets the password: an answer that needs it again asks again.
    flow.secrets.sudoPassword = null;
    emitView(flow);
  }

  /** Ends the flow's SSH connection and every command on it, once. */
  function closeSsh(flow: Flow): Promise<void> {
    // At quit, ending the connection gets only what is left of quit's grace.
    const options = quitDeadline === null ? undefined : { deadline: quitDeadline };
    flow.sshClosed ??= flow.ssh.close(options).catch((error: unknown) => {
      logger.warn("an add flow's ssh connection did not close cleanly", {
        flowId: flow.id,
        error: messageOf(error),
      });
    });
    return flow.sshClosed;
  }

  /**
   * Cancels a flow at once: its password forgotten, its tunnel closed and its
   * SSH commands ended (a step waiting on either finishes now).
   */
  function cancel(flow: Flow): void {
    flow.status = "cancelled";
    flow.secrets.sudoPassword = null;
    flow.tunnel?.close();
    flow.tunnel = null;
    void closeSsh(flow);
    emitView(flow);
    ended(flow);
  }

  /** Releases the rest of what a cancelled flow holds: its connection and its unused keys. Once. */
  function discard(flow: Flow): Promise<void> {
    flow.discarded ??= (async () => {
      await closeSsh(flow);
      const keys = [flowKeyName(flow.id), ...(flow.promoted === null ? [] : [flow.promoted])];
      flow.promoted = null;
      const failures: unknown[] = [];
      for (const name of keys) {
        try {
          await ports.deviceKeys.remove(name);
        } catch (error) {
          failures.push(error);
        }
      }
      if (failures.length > 0) throw failures[0];
    })();
    return flow.discarded;
  }

  /* ── Letting finished flows go ───────────────────────────────────────── */

  /** A done or cancelled flow stays answerable for a while, then goes. */
  function ended(flow: Flow): void {
    flow.endedAt = ports.now();
    flow.disposeTimer = setTimeout(() => dispose(flow), retention.ttlMs);
    flow.disposeTimer.unref?.();
    const finished = [...flows.values()]
      .filter((other) => other.endedAt !== null)
      .toSorted((a, b) => a.endedAt! - b.endedAt!);
    for (const old of finished.slice(0, Math.max(0, finished.length - retention.max))) {
      dispose(old);
    }
  }

  function dispose(flow: Flow): void {
    clearTimeout(flow.disposeTimer);
    flow.secrets.sudoPassword = null;
    flow.listeners.clear();
    flow.log.length = 0;
    flows.delete(flow.id);
  }

  /** Continues a flow stopped on a question or a failure, after `change`. */
  async function resume(
    flowId: string,
    allowed: (flow: Flow) => string | null,
    change: (flow: Flow) => void,
  ): Promise<void> {
    guard();
    const flow = flowOf(flowId);
    await enqueue(flow, async () => {
      const refusal = allowed(flow);
      if (refusal !== null) {
        throw new RemoteHostsError("flow-not-waiting", `Add flow ${flowId} ${refusal}.`);
      }
      change(flow);
      await runFlow(flow);
    });
  }

  async function begin(
    flowId: string,
    target: SshTarget,
    targetText: string,
    name: string,
  ): Promise<{ readonly flowId: string }> {
    const key = generateDeviceKey(ports.deviceName);
    await ports.deviceKeys.put(flowKeyName(flowId), key.privateKeyPem);
    const raced = closed ? undefined : activeFlowFor(target);
    if (closed || raced !== undefined) {
      await removeKey(flowKeyName(flowId));
      if (raced === undefined) throw new RemoteHostsUnavailableError();
      return { flowId: raced.id };
    }
    const pinned = [...entries.values()].find((entry) => {
      const known = parseSshTarget(entry.target) as SshTarget;
      return known.destination === target.destination && known.port === target.port;
    });
    const state = initialProvisionState<SshStepResults>({
      host: name,
      appVersion: ports.appVersion,
      device: key.identity,
      pinnedHostId: pinned?.id ?? null,
      supportedTargets: ports.supportedTargets,
    });
    const flow: Flow = {
      id: flowId,
      target,
      targetText,
      name,
      ssh: ports.ssh(target),
      secrets: { sudoPassword: null },
      logger: flowLogger(() => flow),
      log: [],
      dropped: 0,
      listeners: new Set(),
      state,
      results: state.results,
      status: "running",
      active: null,
      hostId: null,
      tunnel: null,
      remote: null,
      promoted: null,
      questions: 0,
      trustedKeys: null,
      queue: Promise.resolve(),
      view: undefined as unknown as AddHostView,
      sshClosed: null,
      discarded: null,
      disposeTimer: undefined,
      endedAt: null,
    };
    flows.set(flowId, flow);
    emitView(flow);
    void enqueue(flow, () => runFlow(flow));
    return { flowId };
  }

  if (ports.enabled()) ensureStarted();

  return {
    snapshot() {
      guard();
      return current;
    },
    hostLink(hostId) {
      guard();
      hostOf(hostId);
      return runtimes.get(hostId)!.link;
    },
    subscribe(listener) {
      guard();
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    retry(hostId) {
      guard();
      hostOf(hostId);
      const runtime = runtimes.get(hostId)!;
      runtime.tunnel.wake();
      for (const held of runtime.links.values()) held.link.reconnect();
    },
    updateHost() {
      guard();
      throw new RemoteHostsUnavailableError(REMOTE_HOST_UPDATE_UNAVAILABLE);
    },
    cancelScheduledUpdate() {
      guard();
      throw new RemoteHostsUnavailableError(REMOTE_HOST_UPDATE_UNAVAILABLE);
    },
    signIn() {
      guard();
      throw new RemoteHostsUnavailableError(REMOTE_HOST_SIGN_IN_UNAVAILABLE);
    },
    signInLink(hostId) {
      guard();
      hostOf(hostId);
      for (const held of runtimes.get(hostId)!.links.values()) {
        const state = held.link.getState();
        if (state.status === "ready" && hostOffersSignIns(state.welcome)) return held.link;
      }
      return null;
    },
    workspaceLink(workspaceId) {
      guard();
      for (const runtime of runtimes.values()) {
        const link = runtime.links.get(workspaceId)?.link;
        if (link?.getState().status === "ready") return link;
      }
      return null;
    },
    async forget(hostId) {
      guard();
      writable();
      hostOf(hostId);
      return track(dropHost(hostId));
    },
    rename(hostId, name) {
      guard();
      writable();
      const entry = hostOf(hostId);
      const label = name.trim();
      if (label === "" || label.length > REMOTE_HOST_NAME_MAX || CONTROL_CHARACTER.test(label)) {
        throw new RemoteHostsError(
          "bad-name",
          `A host's name is 1 to ${REMOTE_HOST_NAME_MAX} characters, with no control characters.`,
        );
      }
      if (label === entry.name) return;
      const next = { ...entry, name: label };
      save([...entries.values()].map((other) => (other.id === hostId ? next : other)));
      entries.set(hostId, next);
      publish();
      componentLogger(logger, { hostId }).info("remote host renamed");
    },
    async devices(hostId) {
      guard();
      return listDevices(hostOf(hostId));
    },
    openWorkspace(hostId, workspaceId) {
      guard();
      writable();
      const entry = hostOf(hostId);
      if (!isUuidV4(workspaceId)) {
        throw new RemoteHostsError("bad-workspace", `${workspaceId} is not a Workspace id.`);
      }
      if (entry.workspaceIds.includes(workspaceId)) return;
      const next = { ...entry, workspaceIds: [...entry.workspaceIds, workspaceId] };
      save([...entries.values()].map((other) => (other.id === hostId ? next : other)));
      entries.set(hostId, next);
      const runtime = runtimes.get(hostId)!;
      const tunnel = runtime.tunnel.state;
      if (tunnel.status === "up" && next.workspaceIds.length <= REMOTE_HOST_LINK_CAP) {
        openLink(runtime, workspaceId, tunnel.url);
      }
      recompute(runtime);
    },
    async projects(hostId) {
      guard();
      return track(listProjects(hostOf(hostId)));
    },
    async createProject(input) {
      guard();
      return track(addProject(hostOf(input.hostId), input));
    },
    closeWorkspace(hostId, workspaceId) {
      guard();
      writable();
      const entry = hostOf(hostId);
      if (!entry.workspaceIds.includes(workspaceId)) return;
      const next = {
        ...entry,
        workspaceIds: entry.workspaceIds.filter((other) => other !== workspaceId),
      };
      save([...entries.values()].map((other) => (other.id === hostId ? next : other)));
      entries.set(hostId, next);
      const runtime = runtimes.get(hostId)!;
      const held = runtime.links.get(workspaceId);
      if (held !== undefined) {
        held.unsubscribe();
        held.link.close();
        runtime.links.delete(workspaceId);
      }
      runtime.projectLinks.delete(workspaceId);
      // One past the cap moves under it: linked now, if the tunnel is up.
      const tunnel = runtime.tunnel.state;
      if (tunnel.status === "up") {
        for (const linkedId of linked(next)) {
          if (!runtime.links.has(linkedId)) openLink(runtime, linkedId, tunnel.url);
        }
      }
      recompute(runtime);
      componentLogger(logger, { hostId }).info("closed a workspace", { workspaceId });
    },
    async startAdd(input) {
      guard();
      writable();
      const targetText = input.target.trim();
      const target = parseSshTarget(targetText);
      if (typeof target === "string") throw new RemoteHostsError("bad-target", target);
      const under = activeFlowFor(target);
      if (under !== undefined) return { flowId: under.id };
      const name = input.name?.trim() || targetText;
      return track(begin(ports.newId(), target, targetText, name));
    },
    subscribeAdd(flowId, listener) {
      guard();
      const flow = flowOf(flowId);
      const tail = logTail(flow.log);
      listener({
        kind: "replay",
        view: flow.view,
        log: tail.lines,
        omitted: flow.dropped + tail.omitted,
      });
      flow.listeners.add(listener);
      return () => {
        flow.listeners.delete(listener);
      };
    },
    answerAdd(flowId, questionId, reply) {
      return resume(
        flowId,
        (flow) => asking(flow, questionId, (question) => answerFits(question, reply)),
        (flow) => {
          const stop = flow.state.stop;
          if (stop?.kind === "question" && stop.question.kind === "host-key") {
            // Kept with the host once it is added: what the person compared.
            flow.trustedKeys = stop.question.offer.fingerprints.map((key) => key.fingerprint);
          }
          flow.state = answer(flow.state, reply);
        },
      );
    },
    sudoPassword(flowId, questionId, password) {
      return resume(
        flowId,
        (flow) => asking(flow, questionId, (question) => question.kind === "sudo-password"),
        (flow) => {
          flow.secrets.sudoPassword = password;
          // Clears the question only: the password itself never enters the state.
          flow.state = answer(flow.state, { kind: "sudo-password", password: "" });
        },
      );
    },
    retryAdd(flowId, from) {
      return resume(
        flowId,
        (flow) =>
          flow.status === "failed" || flow.status === "question"
            ? null
            : `is ${flow.status}, not waiting`,
        (flow) => {
          flow.state = retryFrom(flow.state, from);
        },
      );
    },
    addFacts(flowId) {
      guard();
      const flow = flowOf(flowId);
      return flowFacts(flow.results, flow.state.decisions);
    },
    async cancelAdd(flowId) {
      // The one call that stays open with `cloud` off: a flow already under
      // way when the flag turned off is still stopped (the window cancels it
      // as its sheet unmounts). It starts nothing, and needs no started engine.
      if (closed) throw new RemoteHostsUnavailableError();
      const flow = flowOf(flowId);
      // Done: the host is in the registry, too late to cancel (Forget undoes it).
      if (flow.status === "done" || flow.status === "cancelled") return;
      cancel(flow);
      // At once: the step in flight finds its result discarded.
      await discard(flow);
    },
    close() {
      closing ??= (async () => {
        closed = true;
        // One deadline for all of quit: what is left of it bounds every wait below.
        const grace = ports.quitGraceMs ?? DEFAULT_QUIT_GRACE_MS;
        const deadline = Date.now() + grace;
        quitDeadline = deadline;
        const left = (): number => Math.max(0, deadline - Date.now());
        unsubscribeWake?.();
        // Nothing registers a host from here on: every finalization checks first.
        for (const hostId of runtimes.keys()) stopHost(hostId);
        const open = [...flows.values()].filter(
          (flow) => flow.status !== "done" && flow.status !== "cancelled",
        );
        for (const flow of open) cancel(flow);
        // Whatever is in flight finishes, or finds itself cancelled at its next await.
        const settled = await settleWithin(
          [...pending, ...leases.values(), ...[...flows.values()].map((flow) => flow.queue)],
          left(),
        );
        listeners.clear();
        // Each cancelled flow's SSH and unused keys, in what is left.
        const cleanups = open.map((flow) => {
          const cleanup = { flowId: flow.id, done: false, work: discard(flow) };
          cleanup.work.then(
            () => {
              cleanup.done = true;
            },
            (error: unknown) => {
              cleanup.done = true;
              logger.warn("an add flow did not close cleanly", {
                flowId: flow.id,
                error: messageOf(error),
              });
            },
          );
          return cleanup;
        });
        const cleaned = await settleWithin(
          cleanups.map((cleanup) => cleanup.work),
          left(),
        );
        if (!settled || !cleaned) {
          // A key removal still running is abandoned: when it lands, nothing reads it.
          logger.warn("remote hosts quit at its deadline; ending what is left", {
            graceMs: grace,
            abandoned: cleanups
              .filter((cleanup) => !cleanup.done)
              .map((cleanup) => cleanup.flowId)
              .join(", "),
          });
        }
        // Every ssh process still owned is SIGKILLed now, and briefly awaited.
        await Promise.allSettled([
          ...[...flows.values()].map((flow) => flow.ssh.kill?.()),
          ...[...projectSsh].map((ssh) => ssh.kill?.()),
          ...[...tunnelsMade].map((tunnel) => tunnel.kill?.()),
        ]);
        for (const flow of flows.values()) dispose(flow);
      })();
      return closing;
    },
  };
}

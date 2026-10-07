/**
 * The remote hosts this desktop added over SSH (VC-700 PR 2): the registry,
 * each host's device key (through a port), its SSH tunnel and one VC-670
 * client link per open Workspace, and the "Add a host" flows on the step
 * machine. Desktop main runs it; host-core reaches it through a port. No
 * Electron.
 *
 * **Never a secret out.** A host's device key (P-256 PKCS#8) lives in the
 * caller's key store only: `flow:<flowId>` while a flow adds the host, then
 * `host:<hostId>` once it is added (and removed when the flow is cancelled or
 * the host forgotten). A sudo password lives in its flow's `ProvisionSecrets`
 * only. Neither enters the registry, a snapshot, a view or a log line; a
 * credential is minted per handshake and handed straight to the link.
 *
 * **One host, one link.** Each host's `RemoteHostLink` is its Workspace
 * links' most informative state or, while none is open, its tunnel's
 * (`remote-hosts-link.ts`), in the shape VC-576's `hostLinkView` reads.
 *
 * **Flows are single-flight.** Every call on one flow (an answer, a sudo
 * password, a retry, the cleanup of a cancel) waits for the one before it.
 * Cancelling takes effect at once: a step in flight finishes, its result is
 * discarded, and nothing after it runs.
 */
import { isUuidV4, type HostFeature } from "@volli/host-protocol";
import type { HostLink, HostLinkOptions, HostLinkState } from "@volli/host-protocol/client-link";
import {
  OperationUnavailableError,
  REMOTE_HOST_SIGN_IN_UNAVAILABLE,
  REMOTE_HOST_UPDATE_UNAVAILABLE,
  type AddHostAnswer,
  type AddHostEvent,
  type AddHostLogLine,
  type AddHostStartInput,
  type AddHostStepId,
  type AddHostView,
  type RemoteHost,
  type RemoteHostLink,
  type RemoteProjectLink,
  type RemoteHostsSnapshot,
} from "@volli/shared";

import type { ListenAddress } from "./contract";
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
  logLine,
  questionJson,
  stepStatuses,
  stoppedAt,
} from "./remote-hosts-flow";
import { generateDeviceKey, mintDeviceCredential } from "./remote-hosts-device-key";
import { nextRemoteHostLink, remoteHostLinkState, versionFacts } from "./remote-hosts-link";
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
import type { SshTransport } from "./ssh";
import { describeStartup } from "./probe";
import { parseSshTarget, type SshTarget } from "./target";
import type { SshTunnel, TunnelState } from "./tunnel";

export const REMOTE_HOSTS_DISABLED = "Remote hosts are not available in this build.";

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
  | "flow-not-waiting";

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
  /** `null` when there is none yet; anything malformed is tolerated (and logged). */
  load(): RegistryFile | null;
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
  /** Closes its tunnel and links, drops it and its device key. The box is untouched. */
  forget(hostId: string): Promise<void>;
  /** Opens a Workspace on the host: remembered, and linked whenever the tunnel is up. */
  openWorkspace(hostId: string, workspaceId: string): void;
  /** Starts adding a host; follow it with {@link RemoteHosts.subscribeAdd}. */
  startAdd(input: AddHostStartInput): Promise<{ readonly flowId: string }>;
  /** The flow's current view (then its log so far) at once, then every change. */
  subscribeAdd(flowId: string, listener: (event: AddHostEvent) => void): () => void;
  answerAdd(flowId: string, reply: AddHostAnswer): Promise<void>;
  /** Kept in the flow's memory only, for sudo's stdin. */
  sudoPassword(flowId: string, password: string): Promise<void>;
  retryAdd(flowId: string, from?: AddHostStepId): Promise<void>;
  cancelAdd(flowId: string): Promise<void>;
  /** Stops everything: at quit. */
  close(): Promise<void>;
}

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** Backoff for a tunnel's first open, which the tunnel leaves to its owner to retry. */
const OPEN_BACKOFF_MIN_MS = 1_000;
const OPEN_BACKOFF_MAX_MS = 30_000;

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
  readonly listeners: Set<(event: AddHostEvent) => void>;
  state: SshProvisionState;
  /** The results the view shows: the state's, plus each step finished in this run. */
  results: SshStepResults;
  status: AddHostView["status"];
  active: StepId | null;
  hostId: string | null;
  tunnel: SshTunnel | null;
  remote: { listen: ListenAddress } | null;
  /** Adding the host to the registry has begun: too late to cancel. */
  finishing: boolean;
  queue: Promise<void>;
  view: AddHostView;
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

/** `job` after every call on the flow before it: one at a time, whatever each one did. */
function enqueue(flow: Flow, job: () => Promise<void>): Promise<void> {
  const run = flow.queue.then(job);
  flow.queue = run.catch(() => {});
  return run;
}

export function createRemoteHosts(ports: RemoteHostsPorts): RemoteHosts {
  const { logger } = ports;
  const entries = new Map<string, RegistryHost>();
  const runtimes = new Map<string, HostRuntime>();
  const flows = new Map<string, Flow>();
  const listeners = new Set<(snapshot: RemoteHostsSnapshot) => void>();
  let current: RemoteHostsSnapshot = { v: 1, hosts: [], projects: {} };
  let started = false;
  let closed = false;

  const iso = (): string => new Date(ports.now()).toISOString();

  /* ── The registry and the snapshot ───────────────────────────────────── */

  function persist(): void {
    try {
      ports.store.save({ v: 1, hosts: [...entries.values()] });
    } catch (error) {
      logger.error("remote host registry not saved", { error: messageOf(error) });
    }
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
    current = { v: 1, hosts: [...entries.values()].map(hostJson), projects };
    for (const listener of listeners) {
      try {
        listener(current);
      } catch (error) {
        logger.warn("remote hosts listener threw", { error: messageOf(error) });
      }
    }
  }

  function load(): void {
    let raw: RegistryFile | null = null;
    try {
      raw = ports.store.load();
    } catch (error) {
      logger.warn("remote host registry unreadable; starting empty", { error: messageOf(error) });
    }
    if (raw === null) return;
    const { file, problems } = readRegistry(raw);
    if (problems.length > 0) {
      logger.warn("remote host registry had entries it could not use; dropped them", {
        problems: problems.join("; "),
      });
    }
    for (const host of file.hosts) entries.set(host.id, host);
  }

  function ensureStarted(): void {
    if (started) return;
    started = true;
    load();
    for (const entry of entries.values()) startHost(entry);
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
  function track(runtime: HostRuntime, previous: RemoteHostLink | null): void {
    const now = ports.now();
    runtime.link = nextRemoteHostLink(previous, derive(runtime, [...runtime.links.values()]), now);
    for (const workspaceId of entries.get(runtime.id)!.workspaceIds) {
      const held = runtime.links.get(workspaceId);
      runtime.projectLinks.set(
        workspaceId,
        nextRemoteHostLink(
          runtime.projectLinks.get(workspaceId) ?? null,
          derive(runtime, held === undefined ? [] : [held]),
          now,
        ),
      );
    }
  }

  function recompute(runtime: HostRuntime): void {
    track(runtime, runtime.link);
    publish();
  }

  /** A fresh `vdc1` for one handshake, signed with the host's device key. */
  async function credentialFor(hostId: string, workspaceId: string): Promise<string> {
    const entry = entries.get(hostId);
    if (entry === undefined) throw new Error("This host was forgotten.");
    const privateKeyPem = await ports.deviceKeys.get(deviceKeyName(hostId));
    if (privateKeyPem === null) throw new Error(`This Mac has no device key for ${entry.name}.`);
    return mintDeviceCredential({
      privateKeyPem,
      hostId,
      deviceId: entry.deviceId,
      workspaceId,
      now: ports.now(),
    });
  }

  function noteVersion(runtime: HostRuntime, version: string): void {
    const entry = entries.get(runtime.id)!;
    if (entry.version === version) return;
    entries.set(runtime.id, { ...entry, version });
    persist();
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
      for (const workspaceId of entries.get(runtime.id)!.workspaceIds) {
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

  function startHost(
    entry: RegistryHost,
    tunnel?: SshTunnel,
    remote?: { listen: ListenAddress },
  ): void {
    const holder = remote ?? { listen: entry.listen };
    holder.listen = entry.listen;
    const hostTunnel =
      tunnel ??
      ports.tunnel({
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
    track(runtime, null);
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

  /** Stops a host and drops it and its device key. */
  async function dropHost(hostId: string): Promise<void> {
    stopHost(hostId);
    entries.delete(hostId);
    persist();
    publish();
    await ports.deviceKeys.remove(deviceKeyName(hostId));
  }

  /* ── Adding a host ───────────────────────────────────────────────────── */

  function flowOf(flowId: string): Flow {
    const flow = flows.get(flowId);
    if (flow === undefined) throw new RemoteHostsError("unknown-flow", `No add flow ${flowId}.`);
    return flow;
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
      question: status === "question" ? questionJson(state) : null,
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
        if (self.log.length > ADD_HOST_LOG_LIMIT) self.log.shift();
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
    const remote = { listen };
    const tunnel = ports.tunnel({
      target: flow.target,
      resolveRemote: () => Promise.resolve(remote.listen),
      logger: componentLogger(flow.logger, { host: flow.name }),
    });
    flow.tunnel = tunnel;
    flow.remote = remote;
    try {
      return { url: await tunnel.start() };
    } catch (error) {
      tunnel.close();
      flow.tunnel = null;
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
        if (flow.status === "cancelled") {
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

  /** The host is added: keep it, its key and its tunnel, and bring it up. */
  async function finishAdd(flow: Flow, state: SshProvisionState): Promise<void> {
    flow.finishing = true;
    const enroll = state.results.enroll!;
    const hostId = enroll.hostId;
    const privateKeyPem = await ports.deviceKeys.get(flowKeyName(flow.id));
    if (privateKeyPem === null) throw new Error("This Mac's new device key went missing.");
    await ports.deviceKeys.put(deviceKeyName(hostId), privateKeyPem);
    await ports.deviceKeys.remove(flowKeyName(flow.id));
    const pinned = state.request.pinnedHostId;
    // The person agreed the host's identity changed: the old one goes.
    if (pinned !== null && pinned !== hostId && entries.has(pinned)) await dropHost(pinned);
    const kept = entries.get(hostId);
    stopHost(hostId);
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
    };
    entries.set(hostId, entry);
    persist();
    await flow.ssh.close();
    const tunnel = flow.tunnel!;
    flow.tunnel = null;
    flow.hostId = hostId;
    startHost(entry, tunnel, remote);
    publish();
  }

  /** Runs the flow until it is added, fails, or asks; one at a time per flow. */
  async function runFlow(flow: Flow): Promise<void> {
    flow.status = "running";
    flow.results = flow.state.results;
    emitView(flow);
    const state = await advance(flow.state, flowProvider(flow), {
      logger: flow.logger,
      secrets: flow.secrets,
    });
    // Cancelled while it ran: the result is discarded.
    if ((flow.status as AddHostView["status"]) === "cancelled") return;
    flow.state = state;
    flow.results = state.results;
    flow.active = null;
    if (state.status === "done") {
      try {
        await finishAdd(flow, state);
        flow.status = "done";
        flow.secrets.sudoPassword = null;
      } catch (error) {
        flow.finishing = false;
        const { link: _, ...results } = state.results;
        flow.state = {
          ...state,
          results,
          status: "stopped",
          stop: {
            kind: "failed",
            failure: { code: "unexpected-state", step: "link", detail: messageOf(error) },
          },
        };
        flow.results = results;
        flow.status = "failed";
        flow.logger.error("adding the host failed at the end", { error: messageOf(error) });
      }
    } else {
      flow.status = state.stop!.kind === "question" ? "question" : "failed";
    }
    emitView(flow);
  }

  /**
   * Cancels a flow at once: its password forgotten, its tunnel closed (a link
   * step waiting on it finishes now). The rest waits for {@link discard}.
   */
  function cancel(flow: Flow): void {
    flow.status = "cancelled";
    flow.secrets.sudoPassword = null;
    flow.tunnel?.close();
    flow.tunnel = null;
    emitView(flow);
  }

  /** Releases the rest of what a cancelled flow holds: its SSH connection, its unused device key. */
  async function discard(flow: Flow): Promise<void> {
    try {
      await flow.ssh.close();
    } finally {
      await ports.deviceKeys.remove(flowKeyName(flow.id));
    }
  }

  /** Continues a flow stopped on a question or a failure, after `change`. */
  async function resume(
    flowId: string,
    allowed: (flow: Flow) => boolean,
    change: (flow: Flow) => void,
  ): Promise<void> {
    guard();
    const flow = flowOf(flowId);
    await enqueue(flow, async () => {
      if (!allowed(flow)) {
        throw new RemoteHostsError(
          "flow-not-waiting",
          `Add flow ${flowId} is ${flow.status}, not waiting on that.`,
        );
      }
      change(flow);
      await runFlow(flow);
    });
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
    async forget(hostId) {
      guard();
      hostOf(hostId);
      await dropHost(hostId);
    },
    openWorkspace(hostId, workspaceId) {
      guard();
      const entry = hostOf(hostId);
      if (!isUuidV4(workspaceId)) {
        throw new RemoteHostsError("bad-workspace", `${workspaceId} is not a Workspace id.`);
      }
      if (entry.workspaceIds.includes(workspaceId)) return;
      entries.set(hostId, { ...entry, workspaceIds: [...entry.workspaceIds, workspaceId] });
      persist();
      const runtime = runtimes.get(hostId)!;
      const tunnel = runtime.tunnel.state;
      if (tunnel.status === "up") openLink(runtime, workspaceId, tunnel.url);
      recompute(runtime);
    },
    async startAdd(input) {
      guard();
      const targetText = input.target.trim();
      const target = parseSshTarget(targetText);
      if (typeof target === "string") throw new RemoteHostsError("bad-target", target);
      const name = input.name?.trim() || targetText;
      const flowId = ports.newId();
      const key = generateDeviceKey(ports.deviceName);
      await ports.deviceKeys.put(flowKeyName(flowId), key.privateKeyPem);
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
        listeners: new Set(),
        state,
        results: state.results,
        status: "running",
        active: null,
        hostId: null,
        tunnel: null,
        remote: null,
        finishing: false,
        queue: Promise.resolve(),
        view: undefined as unknown as AddHostView,
      };
      flows.set(flowId, flow);
      emitView(flow);
      void enqueue(flow, () => runFlow(flow));
      return { flowId };
    },
    subscribeAdd(flowId, listener) {
      guard();
      const flow = flowOf(flowId);
      listener({ kind: "view", view: flow.view });
      for (const line of flow.log) listener({ kind: "log", flowId, line });
      flow.listeners.add(listener);
      return () => {
        flow.listeners.delete(listener);
      };
    },
    answerAdd(flowId, reply) {
      return resume(
        flowId,
        (flow) => flow.status === "question",
        (flow) => {
          flow.state = answer(flow.state, reply);
        },
      );
    },
    sudoPassword(flowId, password) {
      return resume(
        flowId,
        // A view has a question exactly while the flow waits on one.
        (flow) => flow.view.question?.kind === "sudo-password",
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
        (flow) => flow.status === "failed" || flow.status === "question",
        (flow) => {
          flow.state = retryFrom(flow.state, from);
        },
      );
    },
    async cancelAdd(flowId) {
      guard();
      const flow = flowOf(flowId);
      if (flow.status === "done" || flow.status === "cancelled" || flow.finishing) return;
      cancel(flow);
      // After the step in flight, whose result is discarded.
      await enqueue(flow, () => discard(flow));
    },
    async close() {
      if (closed) return;
      closed = true;
      for (const hostId of runtimes.keys()) stopHost(hostId);
      listeners.clear();
      const open = [...flows.values()].filter(
        (flow) => flow.status !== "done" && flow.status !== "cancelled",
      );
      for (const flow of open) cancel(flow);
      const results = await Promise.allSettled(open.map((flow) => discard(flow)));
      for (const result of results) {
        if (result.status === "rejected") {
          logger.warn("an add flow did not close cleanly", { error: messageOf(result.reason) });
        }
      }
    },
  };
}

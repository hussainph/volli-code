/**
 * Test support for the remote hosts engine (VC-700): a fake box over fake SSH,
 * fake tunnels, links, key store and registry file, and a harness that wires
 * them into `createRemoteHosts`. Shared by this package's tests and the
 * desktop's (through `@volli/host-install/testing`). Never shipped.
 */
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable } from "node:stream";

import type { HostLink, HostLinkOptions, HostLinkState } from "@volli/host-protocol/client-link";
import type { AddHostEvent, AddHostView, RemoteHostsSnapshot } from "@volli/shared";

import { PROBE_SCRIPT } from "../probe";
import {
  createRemoteHosts,
  type RemoteHosts,
  type RemoteHostsPorts,
  type RemoteHostsTunnelOptions,
  type RemoteHostsWakeCause,
} from "../remote-hosts";
import { deviceKeyName, type RegistryFile, type RegistryHost } from "../remote-hosts-registry";
import type { HostKeyOffer, SshExecOptions, SshExecResult, SshTransport } from "../ssh";
import type { SshTarget } from "../target";
import type { SshTunnel, TunnelState } from "../tunnel";
import { recordingLogger } from "./fake-process";

export const HOST_ID = "0f6a3a8e-2b1c-4d5e-8f90-1a2b3c4d5e6f";
export const OTHER_ID = "3f6a3a8e-2b1c-4d5e-8f90-1a2b3c4d5e6f";
export const DEVICE_ID = "1f6a3a8e-2b1c-4d5e-8f90-1a2b3c4d5e6f";
export const WS1 = "2f6a3a8e-2b1c-4d5e-8f90-1a2b3c4d5e6f";
export const WS2 = "4f6a3a8e-2b1c-4d5e-8f90-1a2b3c4d5e6f";
export const BYTES = "pretend tarball";
export const SHA = createHash("sha256").update(BYTES).digest("hex");
export const FILE = "volli-hostd-1.1.0-linux-x64.tar.gz";
export const STAGED = "/home/deploy/.cache/volli-hostd/stage.Ab12Cd";
export const CURRENT = "/opt/volli-hostd/current/bin/volli-hostd";
export const NOW = Date.UTC(2026, 0, 1, 12, 0, 0);
export const PASSWORD = "hunter2-very-secret";
/** The key-store name of this Mac's device key for the default host and device. */
export const HOST_KEY = deviceKeyName(
  "0f6a3a8e-2b1c-4d5e-8f90-1a2b3c4d5e6f",
  "1f6a3a8e-2b1c-4d5e-8f90-1a2b3c4d5e6f",
);

export const FACTS: Record<string, string> = {
  kernel: "Linux",
  arch: "x86_64",
  os_id: "ubuntu",
  os_version: "24.04",
  os_name: "Ubuntu 24.04.1 LTS",
  user: "deploy",
  home: "/home/deploy",
  groups: "deploy sudo",
  systemd: "255",
  user_manager: "yes",
  linger: "no",
  glibc: "2.39",
  disk_home: "10000000",
  disk_system: "10000000",
  mem_kb: "8167236",
  sudo: "nopasswd",
};

export function probeOutput(overrides: Record<string, string | null> = {}, extra = ""): string {
  const facts = { ...FACTS, ...overrides };
  const lines = Object.entries(facts)
    .filter(([, value]) => value !== null)
    .map(([key, value]) => `${key}=${value}`);
  return `${[...lines, ...(extra === "" ? [] : [extra]), "end=ok"].join("\n")}\n`;
}

export const LISTEN = { host: "127.0.0.1", port: 7420 };
export const json = (value: unknown) => ({ stdout: `${JSON.stringify(value)}\n` });
export const INSTALLED = (mode: "system" | "user") => ({
  v: 1,
  ok: true,
  mode,
  version: "1.1.0",
  previous: null,
  adopted: null,
  changed: true,
  actions: [],
  dataDir: "/var/lib/volli-hostd",
  binary:
    mode === "system" ? CURRENT : "/home/deploy/.local/share/volli-hostd/current/bin/volli-hostd",
  listen: LISTEN,
  serviceUser: mode === "system" ? "volli" : null,
});
export const STARTED = (mode: "system" | "user") => ({
  v: 1,
  ok: true,
  mode,
  version: "1.1.0",
  restarted: true,
  hostId: HOST_ID,
  listen: LISTEN,
  linger: mode === "user" ? true : null,
});
export const ENROLLED = (hostId: string, deviceId: string = DEVICE_ID) => ({
  v: 1,
  ok: true,
  hostId,
  deviceId,
  fingerprint: "SHA256:mac",
  created: true,
  version: "1.1.0",
  listen: LISTEN,
});

export const OFFER: HostKeyOffer = {
  entries: ["box ssh-ed25519 AAAA"],
  fingerprints: [{ type: "ED25519", fingerprint: "SHA256:box" }],
};

export type Handler = (
  script: string,
  options: SshExecOptions,
) => Partial<SshExecResult> | Promise<Partial<SshExecResult> | undefined> | undefined;

/** A fake box over fake SSH connections: the first override that answers a script wins. */
export function fakeBoxes(...overrides: Handler[]) {
  const scripts: { script: string; stdin: string | null }[] = [];
  const transports: { target: SshTarget; closed: boolean }[] = [];
  // Host status is automatic read-only work, separate from user-command evidence.
  const statusScripts: { script: string; stdin: string | null }[] = [];
  const statusTransports: { target: SshTarget; closed: boolean }[] = [];
  const box = {
    scripts,
    transports,
    statusScripts,
    statusTransports,
    statusCloseFails: 0,
    enrollHostId: HOST_ID,
    enrollDeviceId: DEVICE_ID,
    /** Whether the person accepted the box's host key: until then, ssh refuses it. */
    trusted: true,
    /** How many of the next closes fail. */
    closeFails: 0,
    ran: () => scripts.map((entry) => entry.script),
    open(target: SshTarget): SshTransport {
      const record = { target, closed: false };
      let status = false;
      transports.push(record);
      return {
        target,
        async exec(script, options = {}) {
          status = options.label === "host-status";
          if (status) {
            transports.splice(transports.indexOf(record), 1);
            statusTransports.push(record);
          }
          let stdin: string | null = null;
          if (typeof options.stdin === "string") stdin = options.stdin;
          else if (options.stdin !== undefined) {
            let sent = 0;
            for await (const chunk of options.stdin as Readable) sent += (chunk as Buffer).length;
            stdin = `<${sent} bytes>`;
          }
          (status ? statusScripts : scripts).push({ script, stdin });
          for (const handler of [...overrides, defaults]) {
            const result = await handler(script, options);
            if (result !== undefined) return { code: 0, stdout: "", stderr: "", ...result };
          }
          throw new Error("unreachable");
        },
        close: async () => {
          record.closed = true;
          const counter = status ? "statusCloseFails" : "closeFails";
          if (box[counter] > 0) {
            box[counter] -= 1;
            throw new Error("ssh would not close");
          }
        },
      };
    },
  };
  const defaults: Handler = (script, options) => {
    if (script === "echo volli-ok") {
      return box.trusted
        ? { stdout: "volli-ok\n" }
        : { code: 255, stderr: "Host key verification failed.\n" };
    }
    if (script === PROBE_SCRIPT) return { stdout: probeOutput() };
    if (options.label === "host-status")
      return json({
        v: 1,
        management: 1,
        verdict: "serving",
        running: { state: "serving", hostId: box.enrollHostId, version: "1.1.0" },
      });
    if (options.label === "upload: check") return { stdout: "\n" };
    if (script.includes("cat > ")) return {};
    if (script.includes(".part' 2>/dev/null; } | cut")) return { stdout: `${SHA}\n` };
    if (script.includes("tar -xzf")) return { stdout: `dir=${STAGED}\nversion=1.1.0\n` };
    if (script.includes(" install --"))
      return json(INSTALLED(script.includes("--user") ? "user" : "system"));
    if (script.includes(" start --"))
      return json(STARTED(script.includes("--user") ? "user" : "system"));
    if (script.includes(" enroll --")) return json(ENROLLED(box.enrollHostId, box.enrollDeviceId));
    return {};
  };
  return box;
}

export type TunnelMode = "up" | "fail" | "hold";

export interface FakeTunnel extends SshTunnel {
  readonly options: RemoteHostsTunnelOptions;
  readonly url: string;
  starts: number;
  wakes: number;
  closed: boolean;
  pending: { resolve(url: string): void; reject(error: Error): void } | null;
  set(state: TunnelState): void;
}

export function fakeTunnels(initial: TunnelMode) {
  const made: FakeTunnel[] = [];
  const control = { mode: initial };
  const factory = (options: RemoteHostsTunnelOptions): SshTunnel => {
    const port = 55_000 + made.length;
    let state: TunnelState = { status: "starting" };
    const listeners = new Set<(state: TunnelState) => void>();
    const tunnel: FakeTunnel = {
      options,
      url: `ws://127.0.0.1:${port}`,
      starts: 0,
      wakes: 0,
      closed: false,
      pending: null,
      get state() {
        return state;
      },
      set(next) {
        state = next;
        for (const listener of listeners) listener(next);
      },
      start() {
        tunnel.starts += 1;
        if (control.mode === "up") {
          tunnel.set({ status: "up", url: tunnel.url, localPort: port });
          return Promise.resolve(tunnel.url);
        }
        if (control.mode === "fail") {
          tunnel.set({ status: "down", error: "ssh: Connection refused", retryInMs: 0 });
          return Promise.reject(new Error("ssh: Connection refused"));
        }
        return new Promise((resolve, reject) => {
          tunnel.pending = { resolve, reject };
        });
      },
      onState(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      wake() {
        tunnel.wakes += 1;
      },
      close() {
        tunnel.closed = true;
        tunnel.pending?.reject(new Error("The tunnel was closed"));
        tunnel.set({ status: "closed" });
      },
    };
    made.push(tunnel);
    return tunnel;
  };
  return { factory, made, control };
}

export interface FakeLink extends HostLink {
  readonly options: HostLinkOptions;
  reconnects: number;
  wakes: string[];
  closed: boolean;
  set(state: HostLinkState): void;
}

export function fakeLinks() {
  const made: FakeLink[] = [];
  const factory = (options: HostLinkOptions): HostLink => {
    let state: HostLinkState = { status: "connecting", attempt: 0 };
    const listeners = new Set<(state: HostLinkState) => void>();
    const link: FakeLink = {
      options,
      workspaceId: options.workspaceId,
      reconnects: 0,
      wakes: [],
      closed: false,
      getState: () => state,
      subscribeState(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      set(next) {
        state = next;
        for (const listener of listeners) listener(next);
      },
      query: () => Promise.reject(new Error("not in this test")),
      mutate: () => Promise.reject(new Error("not in this test")),
      subscribe: () => ({ unsubscribe: () => {} }),
      wake(cause) {
        link.wakes.push(cause);
      },
      reconnect() {
        link.reconnects += 1;
      },
      close() {
        link.closed = true;
      },
    };
    made.push(link);
    return link;
  };
  return { factory, made };
}

export function fakeKeys() {
  const keys = new Map<string, string>();
  const calls: string[] = [];
  const hooks: {
    put?: (name: string) => Promise<void> | void;
    get?: (name: string) => Promise<void> | void;
    remove?: (name: string) => Promise<void> | void;
  } = {};
  return {
    keys,
    calls,
    hooks,
    store: {
      async get(name: string) {
        await hooks.get?.(name);
        return keys.get(name) ?? null;
      },
      async put(name: string, pem: string) {
        calls.push(`put ${name}`);
        await hooks.put?.(name);
        keys.set(name, pem);
      },
      async remove(name: string) {
        calls.push(`remove ${name}`);
        await hooks.remove?.(name);
        keys.delete(name);
      },
    },
  };
}

export function fakeStore(initial: unknown) {
  const state = { file: initial, loads: 0, saveFails: false };
  const saves: RegistryFile[] = [];
  return {
    state,
    saves,
    store: {
      load() {
        state.loads += 1;
        if (state.file instanceof Error) throw state.file;
        return state.file as RegistryFile | null;
      },
      save(file: RegistryFile) {
        if (state.saveFails) throw new Error("disk full");
        saves.push(file);
        state.file = file;
      },
    },
  };
}

/** The tarball every harness's artifact names: one per test process, gone when it exits. */
let tarballPath: string | null = null;
function tarball(): string {
  if (tarballPath === null) {
    const dir = mkdtempSync(join(tmpdir(), "host-install-remote-hosts-"));
    tarballPath = join(dir, FILE);
    writeFileSync(tarballPath, BYTES);
    process.once("exit", () => rmSync(dir, { recursive: true, force: true }));
  }
  return tarballPath;
}

export interface HarnessOptions {
  readonly registry?: unknown;
  readonly overrides?: Handler[];
  readonly enabled?: () => boolean;
  readonly supportedTargets?: string[];
  readonly linkFeatures?: string[];
  readonly tunnelMode?: TunnelMode;
  /** Instead of the fake tunnels: real ones, say. */
  readonly tunnel?: RemoteHostsPorts["tunnel"];
  readonly flowRetention?: RemoteHostsPorts["flowRetention"];
  readonly quitGraceMs?: number;
  /** Whether to give the engine a wake source (the harness's `wake`). */
  readonly wake?: boolean;
}

export function harness(options: HarnessOptions = {}) {
  const box = fakeBoxes(...(options.overrides ?? []));
  const tunnels = fakeTunnels(options.tunnelMode ?? "up");
  const links = fakeLinks();
  const keys = fakeKeys();
  const store = fakeStore(options.registry ?? null);
  const log = recordingLogger();
  const accepted: HostKeyOffer[] = [];
  const clock = { now: NOW };
  const wake = {
    listeners: new Set<(cause: RemoteHostsWakeCause) => void>(),
    fire(cause: RemoteHostsWakeCause) {
      for (const listener of wake.listeners) listener(cause);
    },
  };
  let ids = 0;
  const ports: RemoteHostsPorts = {
    store: store.store,
    deviceKeys: keys.store,
    ssh: (target) => box.open(target),
    hostKeys: () => ({
      discover: async () => OFFER,
      accept: async (offer) => {
        accepted.push(offer);
        box.trusted = true;
      },
    }),
    artifact: async (target) => ({
      version: "1.1.0",
      target,
      fileName: FILE,
      path: tarball(),
      sha256: SHA,
      bytes: BYTES.length,
      source: "cache",
    }),
    supportedTargets: options.supportedTargets ?? ["linux-x64"],
    appVersion: "1.1.0",
    deviceName: "Alice's Mac",
    tunnel: options.tunnel ?? tunnels.factory,
    link: links.factory,
    ...(options.wake === true
      ? {
          wake: (listener: (cause: RemoteHostsWakeCause) => void) => {
            wake.listeners.add(listener);
            return () => wake.listeners.delete(listener);
          },
        }
      : {}),
    ...(options.flowRetention === undefined ? {} : { flowRetention: options.flowRetention }),
    ...(options.quitGraceMs === undefined ? {} : { quitGraceMs: options.quitGraceMs }),
    ...(options.linkFeatures === undefined ? {} : { linkFeatures: options.linkFeatures }),
    now: () => clock.now,
    newId: () => `flow-${(ids += 1)}`,
    logger: log.logger,
    enabled: options.enabled ?? (() => true),
  };
  const engine = createRemoteHosts(ports);
  const snapshots: RemoteHostsSnapshot[] = [];
  return { engine, box, tunnels, links, keys, store, log, accepted, clock, snapshots, wake, ports };
}

export type Harness = ReturnType<typeof harness>;

/** Every event a flow streams, and a wait for the view to settle (or match). */
export function watch(engine: RemoteHosts, flowId: string) {
  const events: AddHostEvent[] = [];
  const waiters: { match: (view: AddHostView) => boolean; resolve: (view: AddHostView) => void }[] =
    [];
  const stop = engine.subscribeAdd(flowId, (event) => {
    events.push(event);
    if (event.kind === "log") return;
    const matched = waiters.filter((waiter) => waiter.match(event.view));
    for (const waiter of matched) {
      waiters.splice(waiters.indexOf(waiter), 1);
      waiter.resolve(event.view);
    }
  });
  const views = () =>
    events.flatMap((event) => (event.kind === "log" ? ([] as AddHostView[]) : [event.view]));
  /** Every log line it saw: the replay's, then each streamed. */
  const lines = () =>
    events.flatMap((event) =>
      event.kind === "log" ? [event.line] : event.kind === "replay" ? event.log : [],
    );
  const until = (match = (view: AddHostView) => view.status !== "running") => {
    const last = views().at(-1)!;
    if (match(last)) return Promise.resolve(last);
    return new Promise<AddHostView>((resolve) => waiters.push({ match, resolve }));
  };
  return { events, views, lines, until, stop };
}

export async function startAdd(
  h: Harness,
  input: { target: string; name?: string } = { target: "deploy@box" },
) {
  const { flowId } = await h.engine.startAdd(input);
  const w = watch(h.engine, flowId);
  const view = await w.until();
  // A done flow tidies after it says so: its old keys, its SSH.
  for (let turn = 0; turn < 5; turn += 1) await flush();
  return { flowId, w, view };
}

export const hostEntry = (overrides: Partial<RegistryHost> = {}): RegistryHost => ({
  id: HOST_ID,
  name: "box",
  target: "deploy@box",
  os: "linux",
  mode: "system",
  version: "1.1.0",
  deviceId: DEVICE_ID,
  addedAt: "2025-12-01T00:00:00.000Z",
  listen: LISTEN,
  workspaceIds: [],
  // What the harness's probe reports, as an add would keep it.
  system: "Ubuntu 24.04.1 LTS",
  arch: "x86-64",
  hostKeys: [],
  ...overrides,
});

export const registry = (...hosts: RegistryHost[]): RegistryFile => ({ v: 1, hosts });

export const ready = (version = "1.1.0"): HostLinkState => ({
  status: "ready",
  welcome: {
    protocolVersion: 1,
    host: { id: HOST_ID, version },
    workspace: { id: WS1, epoch: 1 },
    actor: { kind: "device" },
    features: [],
    proof: null,
  } as unknown as Extract<HostLinkState, { status: "ready" }>["welcome"],
});

export const flush = () => new Promise((resolve) => setImmediate(resolve));

/** The id of the question the flow waits on now, as a fresh subscriber reads it; `"none"` when none. */
export function questionOf(engine: RemoteHosts, flowId: string): string {
  let id = "none";
  const stop = engine.subscribeAdd(flowId, (event) => {
    if (event.kind === "replay") id = event.view.question?.id ?? "none";
  });
  stop();
  return id;
}

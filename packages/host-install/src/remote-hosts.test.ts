import { createHash, createPublicKey, generateKeyPairSync, verify } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable } from "node:stream";

import { base64UrlToBytes, parseDeviceCredential } from "@volli/host-protocol";
import type { HostLink, HostLinkOptions, HostLinkState } from "@volli/host-protocol/client-link";
import {
  REMOTE_HOST_SIGN_IN_UNAVAILABLE,
  REMOTE_HOST_UPDATE_UNAVAILABLE,
  type AddHostEvent,
  type AddHostView,
  type RemoteHostsSnapshot,
} from "@volli/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { PROBE_SCRIPT } from "./probe";
import {
  createRemoteHosts,
  RemoteHostsError,
  RemoteHostsUnavailableError,
  type RemoteHosts,
  type RemoteHostsPorts,
  type RemoteHostsTunnelOptions,
} from "./remote-hosts";
import type { RegistryFile, RegistryHost } from "./remote-hosts-registry";
import type { HostKeyOffer, SshExecOptions, SshExecResult, SshTransport } from "./ssh";
import type { SshTarget } from "./target";
import { recordingLogger } from "./testing/fake-process";
import type { SshTunnel, TunnelState } from "./tunnel";

const HOST_ID = "0f6a3a8e-2b1c-4d5e-8f90-1a2b3c4d5e6f";
const OTHER_ID = "3f6a3a8e-2b1c-4d5e-8f90-1a2b3c4d5e6f";
const DEVICE_ID = "1f6a3a8e-2b1c-4d5e-8f90-1a2b3c4d5e6f";
const WS1 = "2f6a3a8e-2b1c-4d5e-8f90-1a2b3c4d5e6f";
const WS2 = "4f6a3a8e-2b1c-4d5e-8f90-1a2b3c4d5e6f";
const BYTES = "pretend tarball";
const SHA = createHash("sha256").update(BYTES).digest("hex");
const FILE = "volli-hostd-1.1.0-linux-x64.tar.gz";
const STAGED = "/home/deploy/.cache/volli-hostd/stage.Ab12Cd";
const CURRENT = "/opt/volli-hostd/current/bin/volli-hostd";
const NOW = Date.UTC(2026, 0, 1, 12, 0, 0);
const PASSWORD = "hunter2-very-secret";

const FACTS: Record<string, string> = {
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

function probeOutput(overrides: Record<string, string | null> = {}, extra = ""): string {
  const facts = { ...FACTS, ...overrides };
  const lines = Object.entries(facts)
    .filter(([, value]) => value !== null)
    .map(([key, value]) => `${key}=${value}`);
  return `${[...lines, ...(extra === "" ? [] : [extra]), "end=ok"].join("\n")}\n`;
}

const LISTEN = { host: "127.0.0.1", port: 7420 };
const json = (value: unknown) => ({ stdout: `${JSON.stringify(value)}\n` });
const INSTALLED = (mode: "system" | "user") => ({
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
const STARTED = (mode: "system" | "user") => ({
  v: 1,
  ok: true,
  mode,
  version: "1.1.0",
  restarted: true,
  hostId: HOST_ID,
  listen: LISTEN,
  linger: mode === "user" ? true : null,
});
const ENROLLED = (hostId: string) => ({
  v: 1,
  ok: true,
  hostId,
  deviceId: DEVICE_ID,
  fingerprint: "SHA256:mac",
  created: true,
  version: "1.1.0",
  listen: LISTEN,
});

const OFFER: HostKeyOffer = {
  entries: ["box ssh-ed25519 AAAA"],
  fingerprints: [{ type: "ED25519", fingerprint: "SHA256:box" }],
};

type Handler = (
  script: string,
  options: SshExecOptions,
) => Partial<SshExecResult> | Promise<Partial<SshExecResult> | undefined> | undefined;

/** A fake box over fake SSH connections: the first override that answers a script wins. */
function fakeBoxes(...overrides: Handler[]) {
  const scripts: { script: string; stdin: string | null }[] = [];
  const transports: { target: SshTarget; closed: boolean }[] = [];
  const box = {
    scripts,
    transports,
    enrollHostId: HOST_ID,
    /** Whether the person accepted the box's host key: until then, ssh refuses it. */
    trusted: true,
    /** How many of the next closes fail. */
    closeFails: 0,
    ran: () => scripts.map((entry) => entry.script),
    open(target: SshTarget): SshTransport {
      const record = { target, closed: false };
      transports.push(record);
      return {
        target,
        async exec(script, options = {}) {
          let stdin: string | null = null;
          if (typeof options.stdin === "string") stdin = options.stdin;
          else if (options.stdin !== undefined) {
            let sent = 0;
            for await (const chunk of options.stdin as Readable) sent += (chunk as Buffer).length;
            stdin = `<${sent} bytes>`;
          }
          scripts.push({ script, stdin });
          for (const handler of [...overrides, defaults]) {
            const result = await handler(script, options);
            if (result !== undefined) return { code: 0, stdout: "", stderr: "", ...result };
          }
          throw new Error("unreachable");
        },
        close: async () => {
          record.closed = true;
          if (box.closeFails > 0) {
            box.closeFails -= 1;
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
    if (options.label === "upload: check") return { stdout: "\n" };
    if (script.includes("cat > ")) return {};
    if (script.includes(".part' | cut")) return { stdout: `${SHA}\n` };
    if (script.includes("tar -xzf")) return { stdout: `dir=${STAGED}\nversion=1.1.0\n` };
    if (script.includes(" install --"))
      return json(INSTALLED(script.includes("--user") ? "user" : "system"));
    if (script.includes(" start --"))
      return json(STARTED(script.includes("--user") ? "user" : "system"));
    if (script.includes(" enroll --")) return json(ENROLLED(box.enrollHostId));
    return {};
  };
  return box;
}

type TunnelMode = "up" | "fail" | "hold";

interface FakeTunnel extends SshTunnel {
  readonly options: RemoteHostsTunnelOptions;
  readonly url: string;
  starts: number;
  wakes: number;
  closed: boolean;
  pending: { resolve(url: string): void; reject(error: Error): void } | null;
  set(state: TunnelState): void;
}

function fakeTunnels(initial: TunnelMode) {
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

interface FakeLink extends HostLink {
  readonly options: HostLinkOptions;
  reconnects: number;
  wakes: string[];
  closed: boolean;
  set(state: HostLinkState): void;
}

function fakeLinks() {
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

function fakeKeys() {
  const keys = new Map<string, string>();
  const calls: string[] = [];
  const hooks: { put?: (name: string) => Promise<void> | void } = {};
  return {
    keys,
    calls,
    hooks,
    store: {
      get: async (name: string) => keys.get(name) ?? null,
      async put(name: string, pem: string) {
        calls.push(`put ${name}`);
        await hooks.put?.(name);
        keys.set(name, pem);
      },
      async remove(name: string) {
        calls.push(`remove ${name}`);
        keys.delete(name);
      },
    },
  };
}

function fakeStore(initial: unknown) {
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

let root: string;
let tarball: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "host-install-remote-hosts-"));
  tarball = join(root, FILE);
  writeFileSync(tarball, BYTES);
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  vi.useRealTimers();
});

interface HarnessOptions {
  readonly registry?: unknown;
  readonly overrides?: Handler[];
  readonly enabled?: () => boolean;
  readonly supportedTargets?: string[];
  readonly linkFeatures?: string[];
  readonly tunnelMode?: TunnelMode;
}

function harness(options: HarnessOptions = {}) {
  const box = fakeBoxes(...(options.overrides ?? []));
  const tunnels = fakeTunnels(options.tunnelMode ?? "up");
  const links = fakeLinks();
  const keys = fakeKeys();
  const store = fakeStore(options.registry ?? null);
  const log = recordingLogger();
  const accepted: HostKeyOffer[] = [];
  const clock = { now: NOW };
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
      path: tarball,
      sha256: SHA,
      bytes: BYTES.length,
      source: "cache",
    }),
    supportedTargets: options.supportedTargets ?? ["linux-x64"],
    appVersion: "1.1.0",
    deviceName: "Alice's Mac",
    tunnel: tunnels.factory,
    link: links.factory,
    ...(options.linkFeatures === undefined ? {} : { linkFeatures: options.linkFeatures }),
    now: () => clock.now,
    newId: () => `flow-${(ids += 1)}`,
    logger: log.logger,
    enabled: options.enabled ?? (() => true),
  };
  const engine = createRemoteHosts(ports);
  const snapshots: RemoteHostsSnapshot[] = [];
  return { engine, box, tunnels, links, keys, store, log, accepted, clock, snapshots };
}

type Harness = ReturnType<typeof harness>;

/** Every event a flow streams, and a wait for the view to settle (or match). */
function watch(engine: RemoteHosts, flowId: string) {
  const events: AddHostEvent[] = [];
  const waiters: { match: (view: AddHostView) => boolean; resolve: (view: AddHostView) => void }[] =
    [];
  const stop = engine.subscribeAdd(flowId, (event) => {
    events.push(event);
    if (event.kind !== "view") return;
    const matched = waiters.filter((waiter) => waiter.match(event.view));
    for (const waiter of matched) {
      waiters.splice(waiters.indexOf(waiter), 1);
      waiter.resolve(event.view);
    }
  });
  const views = () =>
    events.flatMap((event) => (event.kind === "view" ? [event.view] : ([] as AddHostView[])));
  const until = (match = (view: AddHostView) => view.status !== "running") => {
    const last = views().at(-1)!;
    if (match(last)) return Promise.resolve(last);
    return new Promise<AddHostView>((resolve) => waiters.push({ match, resolve }));
  };
  return { events, views, until, stop };
}

async function startAdd(
  h: Harness,
  input: { target: string; name?: string } = { target: "deploy@box" },
) {
  const { flowId } = await h.engine.startAdd(input);
  const w = watch(h.engine, flowId);
  const view = await w.until();
  return { flowId, w, view };
}

const hostEntry = (overrides: Partial<RegistryHost> = {}): RegistryHost => ({
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
  ...overrides,
});

const registry = (...hosts: RegistryHost[]): RegistryFile => ({ v: 1, hosts });

const ready = (version = "1.1.0"): HostLinkState => ({
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

const flush = () => new Promise((resolve) => setImmediate(resolve));

describe("adding a host end to end", () => {
  it("runs every step in order, keeps the host and its key, and brings its tunnel up", async () => {
    const h = harness();
    h.engine.subscribe((snapshot) => h.snapshots.push(snapshot));
    const { flowId, w, view } = await startAdd(h);

    expect(view).toEqual({
      flowId,
      target: "deploy@box",
      name: "deploy@box",
      status: "done",
      steps: [
        { id: "connect", status: "done" },
        { id: "probe", status: "done" },
        { id: "deliver", status: "done" },
        { id: "install", status: "done" },
        { id: "start", status: "done" },
        { id: "enroll", status: "done" },
        { id: "link", status: "done" },
      ],
      question: null,
      failure: null,
      hostId: HOST_ID,
    });
    // Each step shows running, in order, each after the ones before it are done.
    const running = w
      .views()
      .flatMap((v) => v.steps.filter((step) => step.status === "running").map((step) => step.id));
    expect([...new Set(running)]).toEqual([
      "connect",
      "probe",
      "deliver",
      "install",
      "start",
      "enroll",
      "link",
    ]);
    for (const v of w.views()) {
      const at = v.steps.findIndex((step) => step.status === "running");
      if (at > 0) expect(v.steps.slice(0, at).every((step) => step.status === "done")).toBe(true);
    }
    // The log replayed, then streamed: every step's start, and the end.
    const messages = w.events.flatMap((event) =>
      event.kind === "log" ? [event.line.message] : [],
    );
    expect(messages.filter((message) => message === "step started")).toHaveLength(7);
    expect(messages).toContain("host added");
    expect(w.events.find((event) => event.kind === "log")).toMatchObject({
      flowId,
      line: { level: "info", fields: { component: "host-install", host: "deploy@box" } },
    });

    // The host, in the registry and the snapshot.
    expect(h.store.saves.at(-1)).toEqual(
      registry(
        hostEntry({
          name: "deploy@box",
          addedAt: new Date(NOW).toISOString(),
          version: "1.1.0",
        }),
      ),
    );
    const snapshot = h.engine.snapshot();
    expect(snapshot).toEqual({
      v: 1,
      hosts: [
        {
          id: HOST_ID,
          name: "deploy@box",
          target: "deploy@box",
          transport: "ssh-tunnel",
          os: "linux",
          mode: "system",
          agentsShareAccount: false,
          version: "1.1.0",
          availableUpdate: null,
          hostIsNewer: false,
          deviceId: DEVICE_ID,
          addedAt: new Date(NOW).toISOString(),
          liveSessions: null,
        },
      ],
      projects: {},
    });
    expect(h.snapshots.at(-1)).toBe(snapshot);

    // The device key: one per flow, now under the host, and the enrolled key is its public half.
    expect([...h.keys.keys.keys()]).toEqual([`host:${HOST_ID}`]);
    expect(h.keys.calls).toEqual(["put flow:flow-1", `put host:${HOST_ID}`, "remove flow:flow-1"]);
    const pem = h.keys.keys.get(`host:${HOST_ID}`)!;
    const enroll = h.box.ran().find((script) => script.includes(" enroll --"))!;
    const publicKey = /--public-key '([^']+)'/u.exec(enroll)![1]!;
    expect(
      createPublicKey(pem)
        .export({ type: "spki", format: "der" })
        .equals(Buffer.from(base64UrlToBytes(publicKey)!)),
    ).toBe(true);
    expect(enroll).toContain("--name 'Alice'\\''s Mac'");

    // Never the key anywhere a person or a log could see it.
    const body = pem.split("\n")[1]!;
    const seen = JSON.stringify([w.events, h.snapshots, h.store.saves, h.log.lines, h.box.scripts]);
    expect(seen).not.toContain("PRIVATE KEY");
    expect(seen).not.toContain(body);

    // The flow's SSH is closed; its tunnel is the host's now.
    expect(h.box.transports).toEqual([
      { target: { destination: "deploy@box", port: null, label: "box" }, closed: true },
    ]);
    expect(h.tunnels.made).toHaveLength(1);
    const [tunnel] = h.tunnels.made;
    expect(tunnel!.closed).toBe(false);
    expect(tunnel!.options.target.destination).toBe("deploy@box");
    await expect(tunnel!.options.resolveRemote()).resolves.toEqual(LISTEN);
  });

  it("uses the name given, and keeps logging the host's tunnel to the app log only", async () => {
    const h = harness();
    const { flowId, w } = await startAdd(h, { target: " deploy@box ", name: " Hetzner " });
    expect(w.views().at(-1)).toMatchObject({ name: "Hetzner", target: "deploy@box" });
    expect(h.engine.snapshot().hosts[0]).toMatchObject({ name: "Hetzner" });
    const before = w.events.length;
    h.tunnels.made[0]!.options.logger.warn("tunnel dropped", { code: 255 });
    expect(w.events).toHaveLength(before);
    expect(h.log.lines.at(-1)).toMatchObject({
      msg: "tunnel dropped",
      fields: { flowId, host: "Hetzner", component: "host-install", code: 255 },
    });
    // A late subscriber gets the view, then the log so far.
    const late = watch(h.engine, flowId);
    expect(late.events[0]).toMatchObject({ kind: "view", view: { status: "done" } });
    expect(late.events.slice(1).every((event) => event.kind === "log")).toBe(true);
    late.stop();
    w.stop();
  });

  it("adds a Mac as a user host, its agents sharing the person's account", async () => {
    const h = harness({
      supportedTargets: ["darwin-arm64"],
      overrides: [
        (script) =>
          script === PROBE_SCRIPT
            ? {
                stdout: probeOutput({
                  kernel: "Darwin",
                  arch: "arm64",
                  systemd: null,
                  user_manager: null,
                  glibc: null,
                  sudo: null,
                  groups: "staff",
                  launchd: "yes",
                }),
              }
            : undefined,
      ],
    });
    const { view } = await startAdd(h);
    expect(view.status).toBe("done");
    expect(h.engine.snapshot().hosts[0]).toMatchObject({
      os: "macos",
      mode: "user",
      agentsShareAccount: true,
    });
  });
});

describe("questions", () => {
  it("asks about an unknown host key, then carries on once it is accepted", async () => {
    const h = harness();
    h.box.trusted = false;
    const { flowId, view } = await startAdd(h);
    expect(view).toMatchObject({
      status: "question",
      question: { kind: "host-key", step: "connect", offer: OFFER },
      failure: null,
    });
    expect(view.steps[0]).toEqual({ id: "connect", status: "running" });
    await h.engine.answerAdd(flowId, { kind: "accept-host-key" });
    expect(h.accepted).toEqual([OFFER]);
    expect(h.engine.snapshot().hosts.map((host) => host.id)).toEqual([HOST_ID]);
  });

  it("takes a sudo password into the flow's memory only, and sends it only to sudo", async () => {
    const h = harness({
      overrides: [
        (script) => (script === PROBE_SCRIPT ? { stdout: probeOutput({ sudo: null }) } : undefined),
      ],
    });
    h.engine.subscribe((snapshot) => h.snapshots.push(snapshot));
    const { flowId, w, view } = await startAdd(h);
    expect(view.question).toMatchObject({ kind: "sudo-password", step: "install", retry: false });
    await expect(h.engine.answerAdd(flowId, { kind: "update" })).resolves.toBeUndefined();
    // An answer that is not the password asks again.
    expect(w.views().at(-1)?.question).toMatchObject({ kind: "sudo-password" });
    await h.engine.sudoPassword(flowId, PASSWORD);
    expect(w.views().at(-1)?.status).toBe("done");
    const sudoed = h.box.scripts.filter((entry) => entry.script.startsWith("sudo -S"));
    expect(sudoed.map((entry) => entry.stdin)).toEqual([
      `${PASSWORD}\n`,
      `${PASSWORD}\n`,
      `${PASSWORD}\n`,
    ]);
    const elsewhere = JSON.stringify([
      h.box.ran(),
      w.events,
      h.snapshots,
      h.store.saves,
      h.log.lines,
      [...h.keys.keys.entries()],
    ]);
    expect(elsewhere).not.toContain(PASSWORD);
  });

  it("refuses a password when the flow does not ask for one, and an answer when it asks nothing", async () => {
    const h = harness();
    h.box.trusted = false;
    const { flowId } = await startAdd(h);
    await expect(h.engine.sudoPassword(flowId, PASSWORD)).rejects.toMatchObject({
      code: "flow-not-waiting",
    });
    await h.engine.answerAdd(flowId, { kind: "accept-host-key" });
    await expect(h.engine.answerAdd(flowId, { kind: "adopt" })).rejects.toBeInstanceOf(
      RemoteHostsError,
    );
    await expect(h.engine.sudoPassword(flowId, PASSWORD)).rejects.toMatchObject({
      code: "flow-not-waiting",
    });
    await expect(h.engine.retryAdd(flowId)).rejects.toMatchObject({ code: "flow-not-waiting" });
  });

  it("serializes calls on one flow: two answers at once run one after the other", async () => {
    const h = harness({
      overrides: [
        (script) =>
          script === PROBE_SCRIPT
            ? {
                stdout: probeOutput(
                  {},
                  ["hostd=system managed 1.0.0", `hostd_path=${CURRENT}`, "status="].join("\n"),
                ),
              }
            : undefined,
      ],
    });
    h.box.trusted = false;
    const { flowId, w, view } = await startAdd(h);
    expect(view.question?.kind).toBe("host-key");
    const order: string[] = [];
    const first = h.engine
      .answerAdd(flowId, { kind: "accept-host-key" })
      .then(() => order.push("first"));
    const second = h.engine.answerAdd(flowId, { kind: "update" }).then(() => order.push("second"));
    await Promise.all([first, second]);
    expect(order).toEqual(["first", "second"]);
    const questions = w.views().flatMap((v) => (v.question === null ? [] : [v.question.kind]));
    expect([...new Set(questions)]).toEqual(["host-key", "existing-hostd"]);
    expect(w.views().at(-1)?.status).toBe("done");
  });
});

describe("failures", () => {
  it("shows the line, the recovery and the detail, and retries from the failed step", async () => {
    let refuse = true;
    const h = harness({
      overrides: [
        (script) => {
          if (!script.includes(" install --") || !refuse) return undefined;
          refuse = false;
          return json({
            v: 1,
            ok: false,
            code: "command-failed",
            message: "systemctl failed to install the unit",
            detail: ["journal: unit failed"],
          });
        },
      ],
    });
    const { flowId, w, view } = await startAdd(h);
    expect(view).toMatchObject({
      status: "failed",
      question: null,
      failure: {
        code: "hostd-refused",
        step: "install",
        line: "systemctl failed to install the unit",
        recovery: { action: "retry", label: "Try again", from: "install" },
        detail: "journal: unit failed",
      },
    });
    expect(view.steps.map((step) => step.status)).toEqual([
      "done",
      "done",
      "done",
      "failed",
      "pending",
      "pending",
      "pending",
    ]);
    await h.engine.retryAdd(flowId);
    expect(w.views().at(-1)?.status).toBe("done");
    // The retry ran install again, not the steps before it.
    expect(h.box.ran().filter((script) => script === PROBE_SCRIPT)).toHaveLength(1);
  });

  it("retries from an earlier step when asked", async () => {
    let down = true;
    const h = harness({
      overrides: [
        (script) =>
          script.includes(" start --") && down
            ? { code: 255, stderr: "Connection reset by peer" }
            : undefined,
      ],
    });
    const { flowId, view } = await startAdd(h);
    expect(view.failure).toMatchObject({ code: "connection-lost", step: "start" });
    down = false;
    await h.engine.retryAdd(flowId, "probe");
    expect(h.box.ran().filter((script) => script === PROBE_SCRIPT)).toHaveLength(2);
    expect(h.engine.snapshot().hosts).toHaveLength(1);
  });

  it("fails the link step when the tunnel will not open, closing it", async () => {
    const h = harness({ tunnelMode: "fail" });
    const { flowId, view } = await startAdd(h);
    expect(view.failure).toMatchObject({
      code: "tunnel-failed",
      step: "link",
      detail: "ssh: Connection refused",
    });
    expect(h.tunnels.made[0]!.closed).toBe(true);
    h.tunnels.control.mode = "up";
    await h.engine.retryAdd(flowId);
    expect(h.engine.hostLink(h.engine.snapshot().hosts[0]!.id).state).toEqual({ status: "ready" });
  });

  it("fails at the end when the host's key cannot be stored, and retries the link", async () => {
    const h = harness();
    let refuse = true;
    h.keys.hooks.put = (name) => {
      if (name.startsWith("host:") && refuse) {
        refuse = false;
        // Not an Error: whatever a key store rejects with is worded.
        return Promise.reject({ toString: () => "keychain locked" });
      }
      return undefined;
    };
    const { flowId, w, view } = await startAdd(h);
    expect(view).toMatchObject({
      status: "failed",
      failure: { code: "unexpected-state", step: "link", detail: "keychain locked" },
    });
    expect(view.steps.at(-1)).toEqual({ id: "link", status: "failed" });
    expect(h.engine.snapshot().hosts).toEqual([]);
    await h.engine.retryAdd(flowId);
    expect(w.views().at(-1)?.status).toBe("done");
    // The first link's tunnel was replaced by the retry's.
    expect(h.tunnels.made.map((tunnel) => tunnel.closed)).toEqual([true, false]);
    expect([...h.keys.keys.keys()]).toEqual([`host:${HOST_ID}`]);
  });

  it("fails at the end when the flow's key went missing", async () => {
    const h = harness();
    const { flowId } = await h.engine.startAdd({ target: "deploy@box" });
    h.keys.keys.delete(`flow:${flowId}`);
    const view = await watch(h.engine, flowId).until();
    expect(view.failure).toMatchObject({
      code: "unexpected-state",
      detail: "This Mac's new device key went missing.",
    });
    expect(h.log.lines.some((line) => line.msg === "adding the host failed at the end")).toBe(true);
  });

  it("refuses a target that is not one, before anything runs", async () => {
    const h = harness();
    await expect(h.engine.startAdd({ target: "-oProxyCommand=evil" })).rejects.toMatchObject({
      code: "bad-target",
    });
    expect(h.keys.calls).toEqual([]);
  });
});

describe("cancelling an add", () => {
  it("lets the step in flight finish, discards it, and removes the unused key", async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const h = harness({
      overrides: [
        async (script) => {
          if (!script.includes(" install --")) return undefined;
          await held;
          return json(INSTALLED("system"));
        },
      ],
    });
    const { flowId } = await h.engine.startAdd({ target: "deploy@box" });
    const w = watch(h.engine, flowId);
    await w.until((view) => view.steps[3]?.status === "running");
    const cancelled = h.engine.cancelAdd(flowId);
    expect(w.views().at(-1)).toMatchObject({ status: "cancelled", question: null, failure: null });
    expect(h.box.transports[0]!.closed).toBe(false);
    release();
    await cancelled;
    expect(h.box.ran().some((script) => script.includes(" start --"))).toBe(false);
    expect(h.box.transports[0]!.closed).toBe(true);
    expect([...h.keys.keys.keys()]).toEqual([]);
    expect(h.keys.calls).toEqual(["put flow:flow-1", "remove flow:flow-1"]);
    expect(h.store.saves).toEqual([]);
    expect(w.views().at(-1)?.status).toBe("cancelled");
    // Cancelled is final.
    await h.engine.cancelAdd(flowId);
    await expect(h.engine.answerAdd(flowId, { kind: "open" })).rejects.toMatchObject({
      code: "flow-not-waiting",
    });
  });

  it("closes the link step's tunnel when cancelled while it opens", async () => {
    const h = harness({ tunnelMode: "hold" });
    const { flowId } = await h.engine.startAdd({ target: "deploy@box" });
    const w = watch(h.engine, flowId);
    await w.until((view) => view.steps[6]?.status === "running");
    await flush();
    const tunnel = h.tunnels.made[0]!;
    const cancelled = h.engine.cancelAdd(flowId);
    // At once: the link step waiting on it finishes now.
    expect(tunnel.closed).toBe(true);
    await cancelled;
    expect(h.engine.snapshot().hosts).toEqual([]);
    expect(h.keys.keys.size).toBe(0);
  });

  it("is too late once the host is being added", async () => {
    const h = harness();
    let release!: () => void;
    h.keys.hooks.put = (name) =>
      name.startsWith("host:")
        ? new Promise<void>((resolve) => {
            release = resolve;
          })
        : undefined;
    const { flowId } = await h.engine.startAdd({ target: "deploy@box" });
    const w = watch(h.engine, flowId);
    while (!h.keys.calls.includes(`put host:${HOST_ID}`)) await flush();
    await h.engine.cancelAdd(flowId);
    release();
    expect((await w.until((view) => view.status === "done")).hostId).toBe(HOST_ID);
    await h.engine.cancelAdd(flowId);
    expect(w.views().at(-1)?.status).toBe("done");
  });

  it("caps a flow's log, keeping the newest lines", async () => {
    const h = harness({ tunnelMode: "hold" });
    const { flowId } = await h.engine.startAdd({ target: "deploy@box" });
    await watch(h.engine, flowId).until((view) => view.steps[6]?.status === "running");
    await flush();
    const tunnelLog = h.tunnels.made[0]!.options.logger;
    for (let index = 0; index < 600; index += 1) tunnelLog.debug(`line ${index}`);
    const replay = watch(h.engine, flowId).events.filter((event) => event.kind === "log");
    expect(replay).toHaveLength(500);
    expect(replay.at(-1)).toMatchObject({ line: { level: "debug", message: "line 599" } });
    expect(replay[0]).toMatchObject({ line: { message: "line 100" } });
    await h.engine.cancelAdd(flowId);
  });
});

describe("re-adding a host", () => {
  it("pins the host it knows, keeps its Workspaces and replaces its tunnel and key", async () => {
    const h = harness({ registry: registry(hostEntry({ workspaceIds: [WS1] })) });
    const old = h.tunnels.made[0]!;
    h.keys.keys.set(`host:${HOST_ID}`, "old key");
    const { view } = await startAdd(h, { target: "deploy@box" });
    expect(view.status).toBe("done");
    expect(old.closed).toBe(true);
    const saved = h.store.saves.at(-1)!.hosts;
    expect(saved).toEqual([
      hostEntry({
        name: "deploy@box",
        workspaceIds: [WS1],
        addedAt: "2025-12-01T00:00:00.000Z",
      }),
    ]);
    expect(h.keys.keys.get(`host:${HOST_ID}`)).toMatch(/PRIVATE KEY/u);
    // Its Workspace's link rides the new tunnel.
    expect(h.links.made.at(-1)?.options.url).toBe(h.tunnels.made[1]!.url);
  });

  it("asks when the host's identity changed, and replaces the old host once repaired", async () => {
    const h = harness({ registry: registry(hostEntry({ id: OTHER_ID, workspaceIds: [WS1] })) });
    h.keys.keys.set(`host:${OTHER_ID}`, "old key");
    const { flowId, view } = await startAdd(h);
    expect(view.question).toEqual({
      kind: "identity-changed",
      step: "enroll",
      pinned: OTHER_ID,
      hostId: HOST_ID,
    });
    await h.engine.answerAdd(flowId, { kind: "repair" });
    expect(h.engine.snapshot().hosts.map((host) => host.id)).toEqual([HOST_ID]);
    expect(h.engine.snapshot().projects).toEqual({});
    expect(h.keys.keys.has(`host:${OTHER_ID}`)).toBe(false);
    expect(h.tunnels.made[0]!.closed).toBe(true);
  });

  it("repairs a host forgotten meanwhile without touching anything else", async () => {
    const h = harness({ registry: registry(hostEntry({ id: OTHER_ID })) });
    const { flowId } = await startAdd(h, { target: "deploy@box" });
    await h.engine.forget(OTHER_ID);
    const removes = h.keys.calls.filter((call) => call.startsWith("remove host:"));
    await h.engine.answerAdd(flowId, { kind: "repair" });
    expect(h.keys.calls.filter((call) => call.startsWith("remove host:"))).toEqual(removes);
    expect(h.engine.snapshot().hosts.map((host) => host.id)).toEqual([HOST_ID]);
  });
});

describe("a host's lifecycle", () => {
  it("brings every registered host up at startup", async () => {
    const h = harness({
      tunnelMode: "hold",
      registry: registry(
        hostEntry({ workspaceIds: [WS1] }),
        hostEntry({ id: OTHER_ID, name: "two" }),
      ),
    });
    expect(h.store.state.loads).toBe(1);
    expect(h.tunnels.made).toHaveLength(2);
    expect(h.tunnels.made.map((tunnel) => tunnel.starts)).toEqual([1, 1]);
    await expect(h.tunnels.made[0]!.options.resolveRemote()).resolves.toEqual(LISTEN);
    expect(h.tunnels.made[1]!.options.target).toEqual({
      destination: "deploy@box",
      port: null,
      label: "box",
    });
    const snapshot = h.engine.snapshot();
    expect(snapshot.hosts.map((host) => h.engine.hostLink(host.id))).toEqual([
      { state: { status: "connecting", attempt: 0 }, everReady: false, droppedAt: null },
      { state: { status: "connecting", attempt: 0 }, everReady: false, droppedAt: null },
    ]);
    // A Workspace with no link yet reads as its host's tunnel.
    expect(snapshot.projects).toEqual({
      [WS1]: { hostId: HOST_ID, link: { status: "connecting", attempt: 0 } },
    });
    expect(h.links.made).toHaveLength(0);
  });

  it("derives the link from the tunnel while no Workspace is open", () => {
    const h = harness({ tunnelMode: "hold", registry: registry(hostEntry()) });
    const tunnel = h.tunnels.made[0]!;
    const link = () => h.engine.hostLink(h.engine.snapshot().hosts[0]!.id);
    tunnel.set({ status: "up", url: tunnel.url, localPort: 1 });
    expect(link()).toEqual({ state: { status: "ready" }, everReady: true, droppedAt: null });
    h.clock.now = NOW + 10_000;
    tunnel.set({ status: "down", error: "ssh exited 255", retryInMs: 4_000 });
    expect(link()).toEqual({
      state: {
        status: "unreachable",
        attempt: 1,
        error: {
          code: "SERVICE_UNAVAILABLE",
          reason: "host-unreachable",
          message: "ssh exited 255",
        },
        closeCode: null,
        retryAt: NOW + 14_000,
      },
      everReady: true,
      droppedAt: NOW + 10_000,
    });
    tunnel.set({ status: "starting" });
    expect(link().state).toEqual({ status: "connecting", attempt: 1 });
    tunnel.set({ status: "closed" });
    expect(link().state).toEqual({ status: "closed" });
  });

  it("retries a tunnel's first open with backoff until it is closed", async () => {
    vi.useFakeTimers();
    const h = harness({ tunnelMode: "fail", registry: registry(hostEntry()) });
    const tunnel = h.tunnels.made[0]!;
    await vi.advanceTimersByTimeAsync(0);
    expect(h.engine.hostLink(h.engine.snapshot().hosts[0]!.id).state).toMatchObject({
      status: "unreachable",
      attempt: 1,
      retryAt: NOW + 1_000,
    });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(tunnel.starts).toBe(2);
    expect(h.engine.hostLink(h.engine.snapshot().hosts[0]!.id).state).toMatchObject({
      attempt: 2,
      retryAt: NOW + 2_000,
    });
    await h.engine.close();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(tunnel.starts).toBe(2);
  });

  it("drops a first open's failure that lands after the host stopped", async () => {
    const h = harness({ tunnelMode: "fail", registry: registry(hostEntry()) });
    await h.engine.close();
    await flush();
    expect(h.tunnels.made[0]!.starts).toBe(1);
  });

  it("opens one link per Workspace over the tunnel, and speaks for the host from them", () => {
    const h = harness({
      tunnelMode: "hold",
      linkFeatures: ["queue"],
      registry: registry(hostEntry({ version: "1.0.0", workspaceIds: [WS1, WS2] })),
    });
    const tunnel = h.tunnels.made[0]!;
    const host = () => h.engine.snapshot().hosts[0]!;
    expect(host()).toMatchObject({ availableUpdate: "1.1.0", hostIsNewer: false });
    tunnel.set({ status: "up", url: tunnel.url, localPort: 1 });
    expect(h.links.made.map((link) => [link.options.url, link.workspaceId])).toEqual([
      [tunnel.url, WS1],
      [tunnel.url, WS2],
    ]);
    expect(h.links.made[0]!.options).toMatchObject({
      client: { kind: "desktop", version: "1.1.0" },
      features: ["queue"],
    });
    expect(h.engine.hostLink(host().id).state).toEqual({ status: "connecting", attempt: 0 });
    const [one, two] = h.links.made as [FakeLink, FakeLink];

    one.set({
      status: "refused",
      error: { code: "UNAUTHORIZED", reason: "credential-invalid", message: "Unknown device." },
      closeCode: 4401,
    });
    expect(h.engine.hostLink(host().id).state).toMatchObject({
      status: "refused",
      closeCode: 4401,
    });
    two.set({
      status: "fenced",
      error: { code: "CONFLICT", reason: "workspace-split-brain", message: "Two hosts." },
    });
    expect(h.engine.hostLink(host().id).state.status).toBe("refused");
    one.set({ status: "connecting", attempt: 1 });
    expect(h.engine.hostLink(host().id).state.status).toBe("fenced");

    // Each Workspace keeps its own link: one refused, one fenced.
    expect(h.engine.snapshot().projects).toMatchObject({
      [WS1]: { link: { status: "connecting", attempt: 1 } },
      [WS2]: { link: { status: "fenced" } },
    });

    h.clock.now = NOW + 1_000;
    two.set(ready("1.2.0"));
    expect(h.engine.snapshot().projects).toEqual({
      [WS1]: { hostId: HOST_ID, link: { status: "connecting", attempt: 1 } },
      [WS2]: { hostId: HOST_ID, link: { status: "ready" } },
    });
    expect(host()).toMatchObject({ version: "1.2.0", availableUpdate: null, hostIsNewer: true });
    expect(h.engine.hostLink(HOST_ID)).toEqual({
      state: { status: "ready" },
      everReady: true,
      droppedAt: null,
    });
    expect(h.store.saves.at(-1)?.hosts[0]?.version).toBe("1.2.0");
    const saves = h.store.saves.length;
    one.set(ready("1.2.0"));
    expect(h.store.saves).toHaveLength(saves);

    h.clock.now = NOW + 5_000;
    const unreachable: HostLinkState = {
      status: "unreachable",
      attempt: 2,
      error: { code: "SERVICE_UNAVAILABLE", reason: "host-unreachable", message: "Gone." },
      closeCode: 1006,
      retryAt: NOW + 9_000,
    };
    one.set(unreachable);
    two.set(unreachable);
    expect(h.engine.hostLink(host().id)).toEqual({
      state: {
        status: "unreachable",
        attempt: 2,
        error: { code: "SERVICE_UNAVAILABLE", reason: "host-unreachable", message: "Gone." },
        closeCode: 1006,
        retryAt: NOW + 9_000,
      },
      everReady: true,
      droppedAt: NOW + 5_000,
    });

    // The tunnel back on the same port wakes the links; on a new one, they are opened afresh.
    tunnel.set({ status: "up", url: tunnel.url, localPort: 1 });
    expect(one.wakes).toEqual(["network-online"]);
    tunnel.set({ status: "up", url: "ws://127.0.0.1:60000", localPort: 60_000 });
    expect(one.closed).toBe(true);
    expect(h.links.made.slice(2).map((link) => link.options.url)).toEqual([
      "ws://127.0.0.1:60000",
      "ws://127.0.0.1:60000",
    ]);
    // A closed link no longer moves the host.
    const before = h.engine.hostLink(host().id);
    one.set(ready());
    expect(h.engine.hostLink(host().id)).toBe(before);
  });

  it("mints a fresh credential per handshake, signed with the host's device key", async () => {
    const h = harness({ registry: registry(hostEntry({ workspaceIds: [WS1] })) });
    const pair = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const privateKeyPem = pair.privateKey.export({ type: "pkcs8", format: "pem" }) as string;
    const publicSpki = pair.publicKey;
    h.keys.keys.set(`host:${HOST_ID}`, privateKeyPem);
    h.clock.now = NOW + 1_500;
    const credential = h.links.made[0]!.options.credential as () => Promise<string>;
    const minted = await credential();
    const parsed = parseDeviceCredential(minted)!;
    expect(parsed.claims).toMatchObject({
      hostId: HOST_ID,
      deviceId: DEVICE_ID,
      workspaceId: WS1,
      iat: Math.floor((NOW + 1_500) / 1000),
    });
    expect(parsed.claims.exp - parsed.claims.iat).toBeLessThanOrEqual(300);
    expect(parsed.claims.exp).toBeGreaterThan(parsed.claims.iat);
    expect(
      verify(
        "sha256",
        Buffer.from(parsed.signingInput, "ascii"),
        { key: publicSpki, dsaEncoding: "ieee-p1363" },
        parsed.signature,
      ),
    ).toBe(true);
    const again = parseDeviceCredential(await credential())!;
    expect(again.claims.jti).not.toBe(parsed.claims.jti);
    // Never a credential, nor the key, in the snapshot or the log.
    const seen = JSON.stringify([h.engine.snapshot(), h.log.lines, h.store.saves]);
    expect(seen).not.toContain(minted);
    expect(seen).not.toContain(privateKeyPem.split("\n")[1]!);

    h.keys.keys.delete(`host:${HOST_ID}`);
    await expect(credential()).rejects.toThrow("This Mac has no device key for box.");
    await h.engine.forget(HOST_ID);
    await expect(credential()).rejects.toThrow("This host was forgotten.");
  });

  it("retries now: wakes the tunnel and reconnects every link", () => {
    const h = harness({ registry: registry(hostEntry({ workspaceIds: [WS1, WS2] })) });
    h.engine.retry(HOST_ID);
    expect(h.tunnels.made[0]!.wakes).toBe(1);
    expect(h.links.made.map((link) => link.reconnects)).toEqual([1, 1]);
    expect(() => h.engine.retry(OTHER_ID)).toThrow(RemoteHostsError);
  });

  it("opens a Workspace: remembered, mapped to its host, and linked when the tunnel is up", () => {
    const h = harness({ tunnelMode: "hold", registry: registry(hostEntry()) });
    const tunnel = h.tunnels.made[0]!;
    h.engine.openWorkspace(HOST_ID, WS1);
    expect(h.links.made).toHaveLength(0);
    expect(h.engine.snapshot().projects).toEqual({
      [WS1]: { hostId: HOST_ID, link: { status: "connecting", attempt: 0 } },
    });
    expect(h.store.saves.at(-1)?.hosts[0]?.workspaceIds).toEqual([WS1]);
    tunnel.set({ status: "up", url: tunnel.url, localPort: 1 });
    expect(h.links.made.map((link) => link.workspaceId)).toEqual([WS1]);
    h.engine.openWorkspace(HOST_ID, WS2);
    expect(h.links.made.map((link) => link.workspaceId)).toEqual([WS1, WS2]);
    const saves = h.store.saves.length;
    h.engine.openWorkspace(HOST_ID, WS2);
    expect(h.store.saves).toHaveLength(saves);
    expect(() => h.engine.openWorkspace(HOST_ID, "not-a-workspace")).toThrow(
      expect.objectContaining({ code: "bad-workspace" }),
    );
    expect(() => h.engine.openWorkspace(OTHER_ID, WS1)).toThrow(
      expect.objectContaining({ code: "unknown-host" }),
    );
  });

  it("forgets a host: its tunnel and links closed, its entry and key gone, the box untouched", async () => {
    const h = harness({ registry: registry(hostEntry({ workspaceIds: [WS1] })) });
    h.keys.keys.set(`host:${HOST_ID}`, "key");
    const snapshots: RemoteHostsSnapshot[] = [];
    const stop = h.engine.subscribe((snapshot) => snapshots.push(snapshot));
    await h.engine.forget(HOST_ID);
    expect(h.tunnels.made[0]!.closed).toBe(true);
    expect(h.links.made[0]!.closed).toBe(true);
    expect(h.store.saves.at(-1)).toEqual(registry());
    expect(h.keys.keys.size).toBe(0);
    expect(snapshots.at(-1)).toEqual({ v: 1, hosts: [], projects: {} });
    expect(h.box.scripts).toEqual([]);
    await expect(h.engine.forget(HOST_ID)).rejects.toMatchObject({ code: "unknown-host" });
    stop();
  });
});

describe("refusals", () => {
  it("refuses everything while remote hosts are off, and starts once they are on", async () => {
    let on = false;
    const h = harness({ registry: registry(hostEntry()), enabled: () => on });
    expect(h.store.state.loads).toBe(0);
    const calls: (() => unknown)[] = [
      () => h.engine.snapshot(),
      () => h.engine.subscribe(() => {}),
      () => h.engine.retry(HOST_ID),
      () => h.engine.updateHost(HOST_ID, "now"),
      () => h.engine.cancelScheduledUpdate(HOST_ID),
      () => h.engine.signIn(HOST_ID, "claude"),
      () => h.engine.openWorkspace(HOST_ID, WS1),
      () => h.engine.subscribeAdd("flow-1", () => {}),
    ];
    for (const call of calls) expect(call).toThrow(RemoteHostsUnavailableError);
    for (const call of [
      () => h.engine.forget(HOST_ID),
      () => h.engine.startAdd({ target: "box" }),
      () => h.engine.answerAdd("flow-1", { kind: "open" }),
      () => h.engine.sudoPassword("flow-1", PASSWORD),
      () => h.engine.retryAdd("flow-1"),
      () => h.engine.cancelAdd("flow-1"),
    ]) {
      await expect(call()).rejects.toBeInstanceOf(RemoteHostsUnavailableError);
    }
    on = true;
    expect(h.engine.snapshot().hosts.map((host) => host.id)).toEqual([HOST_ID]);
    expect(h.store.state.loads).toBe(1);
    expect(h.tunnels.made).toHaveLength(1);
  });

  it("refuses updates and sign-in in v1 with the shared words", () => {
    const h = harness({ registry: registry(hostEntry()) });
    expect(() => h.engine.updateHost(HOST_ID, "when-idle")).toThrow(REMOTE_HOST_UPDATE_UNAVAILABLE);
    expect(() => h.engine.cancelScheduledUpdate(HOST_ID)).toThrow(REMOTE_HOST_UPDATE_UNAVAILABLE);
    expect(() => h.engine.signIn(HOST_ID, "claude")).toThrow(REMOTE_HOST_SIGN_IN_UNAVAILABLE);
    try {
      h.engine.signIn(HOST_ID, "claude");
    } catch (error) {
      expect(error).toBeInstanceOf(RemoteHostsUnavailableError);
      expect((error as Error).name).toBe("RemoteHostsUnavailableError");
    }
  });

  it("names an unknown flow", async () => {
    const h = harness();
    expect(() => h.engine.subscribeAdd("nope", () => {})).toThrow(
      expect.objectContaining({ code: "unknown-flow", name: "RemoteHostsError" }),
    );
    await expect(h.engine.answerAdd("nope", { kind: "open" })).rejects.toMatchObject({
      code: "unknown-flow",
    });
    await expect(h.engine.cancelAdd("nope")).rejects.toMatchObject({ code: "unknown-flow" });
  });
});

describe("the registry file", () => {
  it("tolerates a file that is not a registry, and logs it", () => {
    const h = harness({ registry: { v: 7, hosts: "lots" } });
    expect(h.engine.snapshot().hosts).toEqual([]);
    expect(h.log.lines).toContainEqual(
      expect.objectContaining({
        level: "warn",
        fields: { problems: "not a v1 registry" },
      }),
    );
  });

  it("tolerates a file that cannot be read, and logs it", () => {
    const h = harness({ registry: new Error("Unexpected token } in JSON") });
    expect(h.engine.snapshot().hosts).toEqual([]);
    expect(h.log.lines).toContainEqual(
      expect.objectContaining({
        msg: "remote host registry unreadable; starting empty",
        fields: { error: "Unexpected token } in JSON" },
      }),
    );
  });

  it("keeps the hosts it can use", () => {
    const h = harness({ registry: { v: 1, hosts: [hostEntry(), { ...hostEntry(), id: "bad" }] } });
    expect(h.engine.snapshot().hosts.map((host) => host.id)).toEqual([HOST_ID]);
  });

  it("logs a save that failed and carries on", async () => {
    const h = harness({ registry: registry(hostEntry()) });
    h.store.state.saveFails = true;
    h.engine.openWorkspace(HOST_ID, WS1);
    expect(h.engine.snapshot().projects).toEqual({
      [WS1]: { hostId: HOST_ID, link: { status: "connecting", attempt: 0 } },
    });
    expect(h.log.lines).toContainEqual(
      expect.objectContaining({ level: "error", msg: "remote host registry not saved" }),
    );
  });
});

describe("listeners and closing", () => {
  it("survives a listener that throws", async () => {
    const h = harness({ registry: registry(hostEntry()) });
    h.engine.subscribe(() => {
      throw new Error("renderer gone");
    });
    h.engine.openWorkspace(HOST_ID, WS1);
    expect(h.log.lines).toContainEqual(
      expect.objectContaining({ msg: "remote hosts listener threw" }),
    );
    let replayed = false;
    const { flowId } = await h.engine.startAdd({ target: "other@box2" });
    h.engine.subscribeAdd(flowId, (event) => {
      if (event.kind !== "view") return;
      if (replayed) throw new Error("sheet gone");
      replayed = true;
    });
    await watch(h.engine, flowId).until();
    expect(h.log.lines).toContainEqual(expect.objectContaining({ msg: "add-host listener threw" }));
  });

  it("closes everything at quit: hosts, links and open flows", async () => {
    const h = harness({ registry: registry(hostEntry({ workspaceIds: [WS1] })) });
    h.box.trusted = false;
    const { flowId, w } = await startAdd(h, { target: "other@box2" });
    const other = await startAdd(h, { target: "third@box3" });
    expect(other.view.status).toBe("question");
    h.box.closeFails = 1;
    await h.engine.close();
    expect(h.tunnels.made[0]!.closed).toBe(true);
    expect(h.links.made[0]!.closed).toBe(true);
    expect(w.views().at(-1)?.status).toBe("cancelled");
    expect(other.w.views().at(-1)?.status).toBe("cancelled");
    // Each flow's key goes, even when its SSH would not close cleanly.
    expect(h.keys.keys.has(`flow:${flowId}`)).toBe(false);
    expect(h.keys.keys.has(`flow:${other.flowId}`)).toBe(false);
    expect(h.box.transports.every((transport) => transport.closed)).toBe(true);
    expect(h.log.lines).toContainEqual(
      expect.objectContaining({ msg: "an add flow did not close cleanly" }),
    );
    await h.engine.close();
    expect(() => h.engine.snapshot()).toThrow(RemoteHostsUnavailableError);
  });

  it("leaves a finished flow alone at quit, and removes a cancelled flow's key", async () => {
    const h = harness();
    const done = await startAdd(h);
    h.box.trusted = false;
    const asked = await startAdd(h, { target: "other@box2" });
    await h.engine.cancelAdd(asked.flowId);
    h.box.trusted = true;
    await h.engine.close();
    expect(done.w.views().at(-1)?.status).toBe("done");
    expect([...h.keys.keys.keys()]).toEqual([`host:${HOST_ID}`]);
  });
});

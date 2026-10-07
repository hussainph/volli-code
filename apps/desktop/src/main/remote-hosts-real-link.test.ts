// @vitest-environment node
/**
 * Opening a remote project, end to end over a real link (VC-710): the
 * production engine (`createRemoteHosts`) with desktop main's own
 * `REMOTE_HOST_LINK_FEATURES` and VC-670's real `createHostLink`, reaching a
 * real host protocol listener on a free loopback port through a tunnel that is
 * simply up. This fixture isolates Workspace links (no HOST factory); dedicated
 * HOST lifetime/routing has separate VC-722 acceptance tests. `openWorkspace`
 * opens a link granted every feature the later tickets use, which a host from
 * before them grants less of. A Workspace the host does not have is refused.
 *
 * Nothing real runs on a box: the SSH runner, the key store and the registry
 * are the engine's test fakes; the device key is a fresh one, and the
 * listener's verifier admits it.
 */
import { admittedHandlers, createHostHandlers, ROUTER_POLICY } from "@volli/host-core/handlers";
import { createLogRing } from "@volli/host-core/log";
import type { HostFeature } from "@volli/host-protocol";
import { createHostLink } from "@volli/host-protocol/client-link";
import {
  createRemoteHosts,
  deviceKeyName,
  generateDeviceKey,
  type RemoteHosts,
  type SshTunnel,
  type TunnelState,
} from "@volli/host-install";
import {
  DEVICE_ID,
  fakeBoxes,
  fakeKeys,
  fakeStore,
  HOST_ID,
  hostEntry,
  recordingLogger,
  registry,
} from "@volli/host-install/testing";
import { createHostRouter, RpcDiagnosticLog } from "@volli/session-rpc";
import { startHostProtocolListener } from "@volli/session-rpc/websocket";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { REMOTE_HOST_LINK_FEATURES } from "./remote-hosts";

const WORKSPACE = "6f1d2c3b-4a5e-4f60-8a7b-9c0d1e2f3a4b";
const UNKNOWN = "7f1d2c3b-4a5e-4f60-8a7b-9c0d1e2f3a4b";

/** What today's hostd offers a device (`apps/hostd/src/host-protocol.ts`), its log included. */
const TODAYS_HOST: readonly HostFeature[] = [
  "sessions",
  "sessions.subscribe",
  "sessions.history",
  "sessions.queue",
  "sessions.listing",
  "session.read",
  "board.read",
  "board.write",
  "sign-ins",
  "auth.callback",
  "host.logs",
];

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

async function until(check: () => boolean, what: string): Promise<void> {
  for (let tries = 0; tries < 400; tries++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** A host serving one Workspace, offering `features`; its log is an empty ring. */
async function host(features: readonly HostFeature[]) {
  const handlers = admittedHandlers(
    createHostHandlers({ events: { publish() {} }, attention: { deliver: () => ({}) } } as never, {
      db: null,
      dataDir: "",
      runtime: null,
      sessions: null,
      modelAccess: null,
      experiments: null,
      automations: { kind: "degraded" } as never,
      busyWorktreeSites: async () => [],
      logs: createLogRing(),
    }),
    ROUTER_POLICY,
  );
  const listener = await startHostProtocolListener({
    router: createHostRouter(),
    bind: { host: "127.0.0.1", port: 0 },
    host: { id: HOST_ID, version: "1.1.0" },
    workspace: (id) => (id === WORKSPACE ? { id: WORKSPACE, epoch: 1 } : null),
    verifier: {
      verify: async () => ({
        actor: { kind: "device", deviceId: DEVICE_ID, workspaceId: WORKSPACE },
        current: () => true,
      }),
    },
    features,
    context: () => ({ handlers, diagnostics: new RpcDiagnosticLog() }),
  });
  cleanups.push(() => listener.close());
  return listener;
}

/** A tunnel that is up at once, its local end the listener. */
function upTunnel(url: string): SshTunnel {
  let state: TunnelState = { status: "starting" };
  const listeners = new Set<(state: TunnelState) => void>();
  const set = (next: TunnelState): void => {
    state = next;
    for (const listener of listeners) listener(next);
  };
  return {
    get state() {
      return state;
    },
    start() {
      set({ status: "up", url, localPort: Number(new URL(url).port) });
      return Promise.resolve(url);
    },
    onState(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    wake() {},
    close() {
      set({ status: "closed" });
    },
  };
}

/** The production engine with desktop main's link features and the real client link. */
async function engineFor(url: string): Promise<RemoteHosts> {
  const keys = fakeKeys();
  keys.keys.set(deviceKeyName(HOST_ID, DEVICE_ID), generateDeviceKey("Alice's Mac").privateKeyPem);
  const box = fakeBoxes();
  const engine = createRemoteHosts({
    store: fakeStore(registry(hostEntry())).store,
    deviceKeys: keys.store,
    ssh: (target) => box.open(target),
    hostKeys: () => ({ discover: async () => null, accept: async () => {} }),
    artifact: async () => {
      throw new Error("not in this test");
    },
    supportedTargets: ["linux-x64"],
    appVersion: "1.1.0",
    deviceName: "Alice's Mac",
    tunnel: () => upTunnel(url),
    link: (options) =>
      createHostLink({ ...options, timing: { backoffBaseMs: 20, backoffCapMs: 40 } }),
    linkFeatures: REMOTE_HOST_LINK_FEATURES,
    now: Date.now,
    newId: () => "flow-1",
    logger: recordingLogger().logger,
    enabled: () => true,
  });
  cleanups.push(() => engine.close());
  return engine;
}

const projectLink = (engine: RemoteHosts, workspaceId: string) =>
  engine.snapshot().projects[workspaceId]?.link.status;

describe("opening a remote project over a real link", () => {
  it("opens the link only on openWorkspace, granted every widened feature, and serves one", async () => {
    const listener = await host(TODAYS_HOST);
    const engine = await engineFor(listener.url);
    // In this Workspace-only fixture no project is open, so no link exists.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(listener.connections).toBe(0);
    expect(engine.signInLink(HOST_ID)).toBeNull();

    engine.openWorkspace(HOST_ID, WORKSPACE);
    await until(() => projectLink(engine, WORKSPACE) === "ready", "the Workspace link");
    const link = engine.workspaceLink(WORKSPACE);
    expect(link).not.toBeNull();
    const state = link!.getState();
    if (state.status !== "ready") throw new Error("not ready");
    expect([...state.welcome.features].toSorted()).toEqual(
      [...REMOTE_HOST_LINK_FEATURES].toSorted(),
    );
    // A widened feature's operation answers over it: the host's log.
    expect(await link!.query("logs.tail", {})).toMatchObject({ entries: [], gap: false });

    // Closed on this Mac: its link goes, and the host keeps serving others.
    engine.closeWorkspace(HOST_ID, WORKSPACE);
    expect(engine.snapshot().projects).toEqual({});
    expect(engine.signInLink(HOST_ID)).toBeNull();
    await until(() => listener.connections === 0, "the link to close");
  });

  it("is granted less by a host from before the widened features (N−1)", async () => {
    const listener = await host(["sessions", "sign-ins", "auth.callback"]);
    const engine = await engineFor(listener.url);
    engine.openWorkspace(HOST_ID, WORKSPACE);
    await until(() => projectLink(engine, WORKSPACE) === "ready", "the Workspace link");
    const state = engine.workspaceLink(WORKSPACE)!.getState();
    if (state.status !== "ready") throw new Error("not ready");
    expect([...state.welcome.features].toSorted()).toEqual(
      ["auth.callback", "sessions", "sign-ins"].toSorted(),
    );
    await expect(engine.workspaceLink(WORKSPACE)!.query("logs.tail", {})).rejects.toBeTruthy();
  });

  it("is refused for a Workspace the host does not have", async () => {
    const listener = await host(TODAYS_HOST);
    const engine = await engineFor(listener.url);
    engine.openWorkspace(HOST_ID, UNKNOWN);
    await until(() => projectLink(engine, UNKNOWN) === "refused", "the refusal");
    expect(engine.signInLink(HOST_ID)).toBeNull();
  });
});

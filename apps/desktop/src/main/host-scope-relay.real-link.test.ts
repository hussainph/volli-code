// @vitest-environment node
/** No project exists: the real HOST listener, main relay, generic IPC bridge and renderer door. */
import { admittedHandlers, createHostHandlers, ROUTER_POLICY } from "@volli/host-core/handlers";
import { createLogRing } from "@volli/host-core/log";
import { initTRPC, tracked, TRPCError } from "@trpc/server";
import { generateDeviceKey, mintDeviceCredential } from "@volli/host-install";
import { signedDeviceVerifier } from "../../../../packages/host-install/src/testing/signed-device-verifier";
import { HOST_SCOPE_FEATURES, type HostConnectionWelcome } from "@volli/host-protocol";
import { createHostScopeLink } from "@volli/host-protocol/client-link";
import { servedIpcContractLink } from "@volli/host-protocol/testing";
import { createIpcServer } from "@volli/host-protocol/ipc-server";
import {
  createDesktopRouter,
  createHostRouter,
  LOCAL_DESKTOP_CALLER,
  RpcDiagnosticLog,
  type DesktopIpcRouter,
} from "@volli/session-rpc";
import { startHostProtocolListener } from "@volli/session-rpc/websocket";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { relayHostScope } from "../renderer/src/lib/relay-host-scope";
import { createHostScopeRelay, engineHostScopeLinks } from "./host-link-relay";

vi.mock("./broadcast", () => ({ resetDataChangedForTest() {} }));

const HOST = "6f1d2c3b-4a5e-4f60-8a7b-9c0d1e2f3a4b";
const DEVICE = "7e8d9c0b-1a2f-4e3d-9c4b-5a6f7e8d9c0b";
const PROJECT = "8e8d9c0b-1a2f-4e3d-9c4b-5a6f7e8d9c0b";
const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});
async function until(check: () => boolean) {
  const deadline = Date.now() + 4000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("HOST relay did not settle");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
function handlers(options: Parameters<typeof createHostHandlers>[1]) {
  return admittedHandlers(
    createHostHandlers(
      { events: { publish() {} }, attention: { deliver: () => ({}) } } as never,
      options,
    ),
    ROUTER_POLICY,
  );
}
const base = {
  db: null,
  dataDir: "",
  runtime: null,
  sessions: null,
  modelAccess: null,
  experiments: null,
  automations: { kind: "degraded" } as never,
  busyWorktreeSites: async () => [],
};

describe("no-project desktop HOST routing", () => {
  it("lists/creates and tails/follows through real IPC and HOST transport without borrowing a Workspace", async () => {
    const logs = createLogRing();
    const workspace = vi.fn(() => null);
    const list = vi.fn(async () => ({ workspaces: [], omitted: 0 }));
    const create = vi.fn(async () => ({
      ok: true as const,
      workspace: { id: PROJECT, name: "app", path: "/srv/app", gitRemoteUrl: null },
    }));
    const listener = await startHostProtocolListener({
      router: createHostRouter(),
      bind: { host: "127.0.0.1", port: 5384 },
      host: { id: HOST, version: "1.2.0" },
      workspace,
      features: HOST_SCOPE_FEATURES,
      verifier: {
        verify: (presentation) =>
          "scope" in presentation
            ? { actor: { scope: "host", kind: "device", deviceId: DEVICE }, current: () => true }
            : null,
      },
      context: () => ({
        diagnostics: new RpcDiagnosticLog(),
        handlers: handlers({ ...base, logs, workspaces: { list, create } }),
      }),
    });
    cleanups.push(() => listener.close());
    const link = createHostScopeLink({
      url: listener.url,
      hostId: HOST,
      client: { kind: "desktop", version: "1.2.0" },
      credential: () => "test-only-device",
      features: HOST_SCOPE_FEATURES,
    });
    cleanups.push(() => link.close());
    await until(() => link.getState().status === "ready");
    const relay = createHostScopeRelay(
      engineHostScopeLinks({
        snapshot: () => ({ hosts: [{ id: HOST }] }),
        hostScopeLink: (id) => (id === HOST && link.getState().status === "ready" ? link : null),
      }),
    );
    const map = handlers({ ...base, hostScopeRelay: relay });
    const connection = await servedIpcContractLink<undefined, DesktopIpcRouter>({
      serve: async () =>
        createIpcServer({
          routers: [createDesktopRouter()],
          served: ["hostScope.query", "hostScope.mutate", "hostScope.subscribe"],
          createContext: () => ({
            caller: LOCAL_DESKTOP_CALLER,
            handlers: map,
            diagnostics: new RpcDiagnosticLog(),
          }),
        }),
    }).open(undefined);
    cleanups.push(() => connection.close());
    const view = relayHostScope(HOST, {
      rpc: connection.client,
      state: {
        getState: () => ({ status: link.getState().status === "ready" ? "open" : "connecting" }),
        subscribe: (changed) => link.subscribeState(() => changed()),
      },
    });
    expect(await view.query("workspaces.list")).toEqual({ workspaces: [], omitted: 0 });
    const command = { commandId: DEVICE, source: { path: "/srv/app" } };
    expect(await view.mutate("workspaces.create", command)).toMatchObject({
      ok: true,
      workspace: { id: PROJECT },
    });
    expect(create).toHaveBeenCalledWith(command);
    expect(await view.query("logs.tail", { limit: 5 })).toMatchObject({ entries: [], gap: false });
    const data = vi.fn();
    const started = vi.fn();
    const stream = view.subscribe(
      "logs.follow",
      { limit: 5 },
      { onStarted: started, onData: data, onError: vi.fn(), onResnapshot: vi.fn() },
    );
    await until(() => started.mock.calls.length > 0);
    const record = {
      ts: "2026-10-07T12:00:00.000Z",
      level: "info" as const,
      component: "test",
      msg: "host log",
    };
    logs.write(record, JSON.stringify(record));
    await until(() => data.mock.calls.length > 0);
    expect(data.mock.calls[0]?.[0]).toMatchObject({ data: { entries: [{ record }] } });
    expect(relay.open(HOST)).toBe(1);
    stream.unsubscribe();
    await until(() => relay.open() === 0);
    expect(workspace).not.toHaveBeenCalled();
    expect(link.getState()).toMatchObject({
      status: "ready",
      welcome: { scope: "host", actor: { kind: "device", scope: "host" } },
    });
    link.close();
    await expect(view.query("workspaces.list")).rejects.toThrow("can’t be reached");
    expect(list).toHaveBeenCalledOnce();
  });
});

describe("signed HOST peer output before real renderer IPC", () => {
  it("redacts reflected credentials/URL secrets/controls and refuses invalid catalogs from a hostile peer", async () => {
    const key = generateDeviceKey("loopback-only output fixture");
    const auth = signedDeviceVerifier(HOST, Date.now);
    auth.enroll(DEVICE, key.privateKeyPem);
    const credential = mintDeviceCredential({
      privateKeyPem: key.privateKeyPem,
      hostId: HOST,
      deviceId: DEVICE,
      scope: "host",
      now: Date.now(),
    });
    const row = { id: PROJECT, name: "app", path: "/srv/app", gitRemoteUrl: null as string | null };
    const unsafe = `${credential} https://user:fixture-password@host/repo?token=fixture-query#fixture-fragment\u0007\n`;
    const batch = {
      entries: [
        {
          cursor: "fixture:1",
          record: {
            ts: "2026-10-07T12:00:00Z",
            level: "warn",
            component: "test",
            msg: unsafe,
            details: { reflected: credential, token: "opaque-fixture-secret" },
          },
        },
      ],
      gap: false,
      cursor: "fixture:1",
    };
    let followAnswer: unknown = batch;
    let trackingId = batch.cursor;
    let catalog: unknown = { workspaces: [row], omitted: 0 };
    let answer: unknown = { ok: false, failure: { code: "clone-failed", message: credential } };
    // Deliberately no output validators: a compromised enrolled host need not run our server code.
    const t = initTRPC.context<{ welcome?: HostConnectionWelcome }>().create();
    const router = t.router({
      protocol: t.router({
        welcome: t.procedure.query(({ ctx }) => ctx.welcome),
        hostWelcome: t.procedure.query(({ ctx }) => ({
          ...ctx.welcome,
          proof: { scheme: "fixture", value: credential },
        })),
      }),
      workspaces: t.router({
        list: t.procedure.query(() => {
          if (catalog instanceof TRPCError) throw catalog;
          return catalog;
        }),
        create: t.procedure.input((input: unknown) => input).mutation(() => answer),
      }),
      logs: t.router({
        tail: t.procedure.input((input: unknown) => input).query(() => batch),
        follow: t.procedure
          .input((input: unknown) => input)
          .subscription(async function* () {
            yield tracked(trackingId, followAnswer);
          }),
      }),
    });
    const listener = await startHostProtocolListener({
      router,
      bind: { host: "127.0.0.1", port: 5386 },
      host: { id: HOST, version: "1.2.0" },
      workspace: () => null,
      features: ["host.logs", "host.workspaces"],
      verifier: auth.verifier,
      context: () => ({}),
    });
    cleanups.push(() => listener.close());
    const link = createHostScopeLink({
      url: listener.url,
      hostId: HOST,
      client: { kind: "desktop", version: "1.2.0" },
      features: HOST_SCOPE_FEATURES,
      credential: () => credential,
    });
    cleanups.push(() => link.close());
    await until(() => link.getState().status === "ready");
    expect(auth.accepted).toHaveLength(1);
    const relay = createHostScopeRelay(
      engineHostScopeLinks({
        snapshot: () => ({ hosts: [{ id: HOST }] }),
        hostScopeLink: () => link,
      }),
    );
    const connection = await servedIpcContractLink<undefined, DesktopIpcRouter>({
      serve: async () =>
        createIpcServer({
          routers: [createDesktopRouter()],
          served: ["hostScope.query", "hostScope.mutate", "hostScope.subscribe"],
          createContext: () => ({
            caller: LOCAL_DESKTOP_CALLER,
            diagnostics: new RpcDiagnosticLog(),
            handlers: handlers({ ...base, hostScopeRelay: relay }),
          }),
        }),
    }).open(undefined);
    cleanups.push(() => connection.close());
    const view = relayHostScope(HOST, {
      rpc: connection.client,
      state: { getState: () => ({ status: "open" }), subscribe: () => () => {} },
    });
    const command = { commandId: DEVICE, source: { path: "/srv/app" } };
    const assertSafe = (value: unknown) => {
      const encoded = JSON.stringify(value);
      for (const secret of [
        credential,
        "fixture-password",
        "fixture-query",
        "fixture-fragment",
        "opaque-fixture-secret",
        "\\u0007",
      ])
        expect(encoded.includes(secret)).toBe(false);
    };
    await expect(view.query("protocol.hostWelcome")).rejects.toMatchObject({
      data: {
        hostError: {
          reason: "response-invalid",
          message: "The host returned an invalid response.",
        },
      },
    });
    const reflected = await view.mutate("workspaces.create", command);
    expect(reflected).toEqual({
      ok: false,
      failure: { code: "clone-failed", message: "[redacted]" },
    });
    answer = {
      ok: false,
      failure: { code: "clone-failed", message: unsafe.slice(credential.length) },
    };
    assertSafe(await view.mutate("workspaces.create", command));
    assertSafe(await view.query("logs.tail", {}));
    const received: unknown[] = [];
    const stream = view.subscribe(
      "logs.follow",
      {},
      {
        onData: (data) => received.push(data),
        onError: (error) => {
          throw error;
        },
        onResnapshot: () => {},
      },
    );
    await until(() => received.length === 1);
    assertSafe(received[0]);
    stream.unsubscribe();
    const trackingError = vi.fn();
    const unsafeTrackingData = vi.fn();
    trackingId = credential;
    view.subscribe(
      "logs.follow",
      {},
      { onData: unsafeTrackingData, onError: trackingError, onResnapshot: vi.fn() },
    );
    await until(() => trackingError.mock.calls.length === 1);
    expect(unsafeTrackingData).not.toHaveBeenCalled();
    expect(trackingError.mock.calls[0]![0]).toMatchObject({
      hostError: { reason: "response-invalid", message: "The host returned an invalid response." },
    });
    trackingId = batch.cursor;
    followAnswer = null;
    const invalidData = vi.fn();
    const streamError = vi.fn();
    view.subscribe(
      "logs.follow",
      {},
      { onData: invalidData, onError: streamError, onResnapshot: vi.fn() },
    );
    await until(() => streamError.mock.calls.length === 1);
    expect(invalidData).not.toHaveBeenCalled();
    expect(streamError.mock.calls[0]![0]).toMatchObject({
      hostError: { reason: "response-invalid", message: "The host returned an invalid response." },
    });
    catalog = new TRPCError({ code: "BAD_GATEWAY", message: credential });
    await expect(view.query("workspaces.list")).rejects.toMatchObject({ message: "[redacted]" });
    answer = { ok: false, failure: { code: "clone-failed", message: "x".repeat(513) } };
    await expect(view.mutate("workspaces.create", command)).rejects.toMatchObject({
      data: { hostError: { reason: "response-invalid" } },
    });
    catalog = { workspaces: [{ ...row, gitRemoteUrl: "https://TOKEN@host/repo.git" }], omitted: 0 };
    expect(await view.query("workspaces.list")).toEqual({ workspaces: [row], omitted: 0 });
    for (const bad of [
      null,
      { workspaces: Array.from({ length: 501 }, () => row), omitted: 0 },
      { workspaces: [{ ...row, path: "/srv/app\u0000other" }], omitted: 0 },
      { workspaces: [{ ...row, name: "app\u202e" }], omitted: 0 },
      { workspaces: [{ ...row, path: "x".repeat(4097) }], omitted: 0 },
    ]) {
      catalog = bad;
      await expect(view.query("workspaces.list")).rejects.toMatchObject({
        data: {
          hostError: {
            code: "BAD_GATEWAY",
            reason: "response-invalid",
            message: "The host returned an invalid response.",
          },
        },
      });
    }
  });
});

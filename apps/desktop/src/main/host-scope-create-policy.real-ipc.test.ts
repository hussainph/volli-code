// @vitest-environment node
/** Direct renderer IPC cannot send prohibited repository credentials to a host. */
import { admittedHandlers, createHostHandlers, ROUTER_POLICY } from "@volli/host-core/handlers";
import { HOST_SCOPE_FEATURES, type HostConnectionWelcome } from "@volli/host-protocol";
import { initTRPC } from "@trpc/server";
import { createHostScopeLink } from "@volli/host-protocol/client-link";
import { createIpcServer } from "@volli/host-protocol/ipc-server";
import { servedIpcContractLink } from "@volli/host-protocol/testing";
import {
  createDesktopRouter,
  createHostRouter,
  LOCAL_DESKTOP_CALLER,
  RpcDiagnosticLog,
  type DesktopIpcRouter,
} from "@volli/session-rpc";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { startHostProtocolListener } from "@volli/session-rpc/websocket";
import { createHostScopeRelay, engineHostScopeLinks } from "./host-link-relay";
import { admitHostCreateSource } from "./host-scope-create-policy";

// Main-test disposal must not resolve Electron in this transport-only fixture.
vi.mock("./broadcast", () => ({ resetDataChangedForTest() {} }));

const HOST = "6f1d2c3b-4a5e-4f60-8a7b-9c0d1e2f3a4b";
const DEVICE = "7e8d9c0b-1a2f-4e3d-9c4b-5a6f7e8d9c0b";
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
function handlers(options: Parameters<typeof createHostHandlers>[1]) {
  return admittedHandlers(
    createHostHandlers(
      { events: { publish() {} }, attention: { deliver: () => ({}) } } as never,
      options,
    ),
    ROUTER_POLICY,
  );
}
const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).toReversed()) await close();
});
async function until(check: () => boolean) {
  const deadline = Date.now() + 4000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("HOST did not settle");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("HOST create Mac-side admission", () => {
  it("refuses malformed sources without reflecting their values", () => {
    for (const input of [
      null,
      undefined,
      "bad",
      {},
      { source: null },
      { source: "bad" },
      { source: { gitUrl: 1 } },
    ])
      expect(() => admitHostCreateSource(input)).toThrow();
    expect(() => admitHostCreateSource({ source: { path: "/srv/app" } })).not.toThrow();
  });
  it("blocks direct subscription IPC to a hostile peer's create subscription before transport", async () => {
    const received: unknown[] = [];
    const t = initTRPC.context<{ welcome?: HostConnectionWelcome }>().create();
    const router = t.router({
      protocol: t.router({
        welcome: t.procedure.query(({ ctx }) => ctx.welcome),
        hostWelcome: t.procedure.query(({ ctx }) => ctx.welcome),
      }),
      workspaces: t.router({
        list: t.procedure.query(() => ({ workspaces: [], omitted: 0 })),
        // A compromised peer accepts the wrong kind; main must never ask it.
        create: t.procedure
          .input((input: unknown) => input)
          .subscription(async function* ({ input }) {
            received.push(input);
            yield { ok: false, failure: { code: "clone-failed", message: "wrong kind" } };
          }),
      }),
    });
    const listener = await startHostProtocolListener({
      router,
      bind: { host: "127.0.0.1", port: 5387 },
      host: { id: HOST, version: "1.2.0" },
      workspace: () => null,
      features: ["host.workspaces"],
      verifier: {
        verify: (presentation) =>
          "scope" in presentation
            ? { actor: { scope: "host", kind: "device", deviceId: DEVICE }, current: () => true }
            : null,
      },
      context: () => ({}),
    });
    cleanups.push(() => listener.close());
    const link = createHostScopeLink({
      url: listener.url,
      hostId: HOST,
      client: { kind: "desktop", version: "1.2.0" },
      features: ["host.workspaces"],
      credential: () => "fixture-only",
    });
    cleanups.push(() => link.close());
    await until(() => link.getState().status === "ready");
    const relay = createHostScopeRelay(
      engineHostScopeLinks({
        snapshot: () => ({ hosts: [{ id: HOST }] }),
        hostScopeLink: () => link,
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
            diagnostics: new RpcDiagnosticLog(),
            handlers: map,
          }),
        }),
    }).open(undefined);
    cleanups.push(() => connection.close());
    for (const gitUrl of [
      "https://TOKEN@host/repo.git",
      "https://user:pass@host/repo.git",
      "https://host/repo.git",
    ]) {
      const events: unknown[] = [];
      const request = {
        hostId: HOST,
        path: "workspaces.create",
        input: { commandId: DEVICE, source: { gitUrl } },
      };
      const subscription = connection.client.hostScope.subscribe.subscribe(request, {
        onData: (event) => events.push(event),
        onError: (error) => {
          throw error;
        },
      });
      await until(() => events.length > 0);
      expect(events[0]).toMatchObject({
        kind: "error",
        error: { reason: "verb-refused", code: "FORBIDDEN" },
      });
      subscription.unsubscribe();
      await expect(connection.client.hostScope.query.query(request)).rejects.toMatchObject({
        data: { hostError: { reason: "verb-refused" } },
      });
    }
    await expect(
      connection.client.hostScope.mutate.mutate({
        hostId: HOST,
        path: "workspaces.list",
        input: null,
      }),
    ).rejects.toMatchObject({ data: { hostError: { reason: "verb-refused" } } });
    expect(received).toEqual([]);
    expect(relay.open()).toBe(0);
  });
  it("rejects the full shared Git URL policy before the remote handler, while preserving SSH usernames", async () => {
    const create = vi.fn(async () => ({
      ok: true as const,
      workspace: { id: DEVICE, name: "app", path: "/srv/app", gitRemoteUrl: null },
    }));
    const listener = await startHostProtocolListener({
      router: createHostRouter(),
      bind: { host: "127.0.0.1", port: 5383 },
      host: { id: HOST, version: "1.2.0" },
      workspace: () => null,
      features: HOST_SCOPE_FEATURES,
      verifier: {
        verify: (presentation) =>
          "scope" in presentation
            ? { actor: { scope: "host", kind: "device", deviceId: DEVICE }, current: () => true }
            : null,
      },
      context: () => ({
        diagnostics: new RpcDiagnosticLog(),
        handlers: handlers({
          ...base,
          workspaces: { list: async () => ({ workspaces: [], omitted: 0 }), create },
        }),
      }),
    });
    cleanups.push(() => listener.close());
    const link = createHostScopeLink({
      url: listener.url,
      hostId: HOST,
      client: { kind: "desktop", version: "1.2.0" },
      features: HOST_SCOPE_FEATURES,
      credential: () => "test-only",
    });
    cleanups.push(() => link.close());
    await until(() => link.getState().status === "ready");
    const relay = createHostScopeRelay(
      engineHostScopeLinks({
        snapshot: () => ({ hosts: [{ id: HOST }] }),
        hostScopeLink: () => link,
      }),
    );
    const map = handlers({ ...base, hostScopeRelay: relay });
    const connection = await servedIpcContractLink<undefined, DesktopIpcRouter>({
      serve: async () =>
        createIpcServer({
          routers: [createDesktopRouter()],
          served: ["hostScope.mutate"],
          createContext: () => ({
            caller: LOCAL_DESKTOP_CALLER,
            diagnostics: new RpcDiagnosticLog(),
            handlers: map,
          }),
        }),
    }).open(undefined);
    cleanups.push(() => connection.close());
    const mutate = (gitUrl: string) =>
      connection.client.hostScope.mutate.mutate({
        hostId: HOST,
        path: "workspaces.create",
        input: { commandId: DEVICE, source: { gitUrl } },
      });
    for (const url of [
      "https://TOKEN@github.com/owner/repo.git",
      "https://user:password@github.com/owner/repo.git",
      "https://github.com/owner/repo.git?token=dummy",
      "https://github.com/owner/repo.git#dummy",
      "https://github.com/owner/%72epo.git",
      "file:///repo.git",
      "-repo",
      "https://github.com/owner/ repo.git",
      "https://github.com/",
      "nonsense",
    ])
      await expect(mutate(url)).rejects.toThrow();
    expect(create).not.toHaveBeenCalled();
    for (const url of [
      "https://github.com/owner/repo.git",
      "ssh://git@github.com/owner/repo.git",
      "git@github.com:owner/repo.git",
    ]) {
      await expect(mutate(url)).resolves.toMatchObject({ ok: true });
      expect(create).toHaveBeenLastCalledWith({ commandId: DEVICE, source: { gitUrl: url } });
    }
    expect(create).toHaveBeenCalledTimes(3);
  });
});

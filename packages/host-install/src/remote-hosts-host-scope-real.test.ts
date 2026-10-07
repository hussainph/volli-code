import { createPublicKey } from "node:crypto";
import { base64UrlToBytes, HOST_SCOPE_FEATURES } from "@volli/host-protocol";
import {
  createHostLink,
  createHostScopeLink,
  type HostLink,
  type HostScopeLink,
} from "@volli/host-protocol/client-link";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { createHostRouter } from "../../session-rpc/src/host-router";
import { RpcDiagnosticLog } from "../../session-rpc/src/index";
import { startHostProtocolListener } from "../../session-rpc/src/websocket-server";
import { createRemoteHosts } from "./remote-hosts";
import { generateDeviceKey } from "./remote-hosts-device-key";
import { signedDeviceVerifier } from "./testing/signed-device-verifier";
import {
  DEVICE_ID,
  HOST_ID,
  HOST_KEY,
  OTHER_ID,
  WS1,
  flush,
  harness,
  hostEntry,
  registry,
  watch,
} from "./testing/remote-hosts-harness";
import type { SshTunnel } from "./tunnel";

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).toReversed()) await close();
});
async function until(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 4_000;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error("host scope did not settle");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function fixture(add = false, workspaceIds: string[] = []) {
  const h = harness({
    enabled: () => false,
    registry: add ? null : registry(hostEntry({ workspaceIds })),
  });
  const auth = signedDeviceVerifier(HOST_ID, () => h.clock.now);
  const key = generateDeviceKey("loopback device");
  h.keys.keys.set(HOST_KEY, key.privateKeyPem);
  auth.enroll(DEVICE_ID, key.privateKeyPem);
  const host = { id: HOST_ID, version: "1.2.0" };
  const workspace = vi.fn((workspaceId: string) => ({ id: workspaceId, epoch: 1 }));
  const page = { entries: [], gap: false, cursor: "ring:0" };
  const listener = await startHostProtocolListener({
    router: createHostRouter(),
    bind: { host: "127.0.0.1", port: 0 },
    host,
    workspace,
    features: [...HOST_SCOPE_FEATURES, "sessions"],
    verifier: auth.verifier,
    limits: { grantRecheckMs: 20 },
    context: () => ({
      diagnostics: new RpcDiagnosticLog(),
      handlers: {
        "logs.tail": () => page,
        "workspaces.list": () => ({ workspaces: [], omitted: 0 }),
        "workspaces.create": () => ({
          ok: true,
          workspace: {
            id: WS1,
            name: "app",
            path: "/srv/app",
            gitRemoteUrl: null,
          },
        }),
      } as never,
    }),
  });
  cleanups.push(() => listener.close());
  const state = { status: "up" as const, url: listener.url, localPort: listener.address.port };
  const tunnel: SshTunnel = {
    state,
    start: async () => state.url,
    wake() {},
    close() {},
    onState: () => () => {},
  };
  const scopes: HostScopeLink[] = [];
  const workspaces: HostLink[] = [];
  // The fake SSH enrollment actually records the public SPKI sent by the install engine.
  const ssh = h.ports.ssh;
  const timing = {
    heartbeatIntervalMs: 100,
    heartbeatTimeoutMs: 100,
    backoffBaseMs: 30,
    backoffCapMs: 50,
  };
  const engine = createRemoteHosts({
    ...h.ports,
    enabled: () => true,
    tunnel: () => tunnel,
    ssh: (target) => {
      const transport = ssh(target);
      return {
        ...transport,
        async exec(script, options) {
          const publicKey = script.match(/--public-key '([^']+)'/u)?.[1];
          if (publicKey !== undefined)
            auth.enroll(
              h.box.enrollDeviceId,
              createPublicKey({
                key: Buffer.from(base64UrlToBytes(publicKey)!),
                format: "der",
                type: "spki",
              }),
            );
          return transport.exec(script, options);
        },
      };
    },
    hostScopeLink: (options) => {
      const link = createHostScopeLink({ ...options, timing });
      scopes.push(link);
      return link;
    },
    link: (options) => {
      const link = createHostLink({ ...options, timing });
      workspaces.push(link);
      return link;
    },
  });
  cleanups.push(() => engine.close());
  return { h, auth, host, workspace, listener, scopes, workspaces, engine, page };
}

describe("real signed enrolled host-scope connection, no Workspace required", () => {
  it("welcomes, grants sign-ins/logs/projects, and survives the last Workspace close", async () => {
    const f = await fixture();
    await until(() => f.engine.hostScopeLink(HOST_ID) !== null);
    expect(f.workspace).not.toHaveBeenCalled();
    expect(f.listener.connections).toBe(1);
    expect(f.workspaces).toHaveLength(0);
    expect(f.h.box.statusScripts).toHaveLength(0);
    expect(f.engine.snapshot().hosts[0]).toMatchObject({
      hostScope: { status: "ready", granted: HOST_SCOPE_FEATURES },
      reachability: { state: { status: "ready" } },
    });
    const scope = f.engine.hostScopeLink(HOST_ID)!;
    expect(f.engine.signInLink(HOST_ID)).toBe(scope);
    expect(await scope.query("logs.tail", { limit: 5 })).toEqual(f.page);
    expect(await scope.query("workspaces.list")).toEqual({ workspaces: [], omitted: 0 });
    expect(
      await scope.mutate("workspaces.create", { commandId: WS1, source: { path: "/srv/app" } }),
    ).toEqual({
      ok: true,
      workspace: { id: WS1, name: "app", path: "/srv/app", gitRemoteUrl: null },
    });
    await expect(scope.query("session.projection", { sessionId: "s" })).rejects.toMatchObject({
      data: { hostError: { reason: "workspace-scope-required" } },
    });
    f.engine.openWorkspace(HOST_ID, WS1);
    await until(() => f.engine.workspaceLink(WS1) !== null);
    expect(f.listener.connections).toBe(2);
    f.engine.closeWorkspace(HOST_ID, WS1);
    await until(() => f.listener.connections === 1);
    expect(f.engine.hostScopeLink(HOST_ID)).toBe(scope);
    expect(f.engine.signInLink(HOST_ID)).toBe(scope);
    expect(
      f.auth.accepted.map((credential) => ("scope" in credential.claims ? "host" : "workspace")),
    ).toEqual(["host", "workspace"]);
  });

  it("fails closed on pinned-host mismatch, never falling back to a ready Workspace", async () => {
    const f = await fixture();
    await until(() => f.engine.hostScopeLink(HOST_ID) !== null);
    f.engine.openWorkspace(HOST_ID, WS1);
    await until(() => f.engine.workspaceLink(WS1) !== null);
    f.host.id = OTHER_ID;
    f.auth.enrolled.delete(DEVICE_ID);
    await until(() => f.scopes[0]!.getState().status === "refused");
    f.auth.enroll(DEVICE_ID, f.h.keys.keys.get(HOST_KEY)!);
    f.engine.retry(HOST_ID);
    await until(() => f.scopes[0]!.getState().status === "refused");
    expect(f.scopes[0]!.getState()).toMatchObject({ error: { reason: "welcome-invalid" } });
    expect(f.engine.hostScopeLink(HOST_ID)).toBeNull();
    expect(f.engine.signInLink(HOST_ID)).toBeNull();
    expect(f.engine.snapshot().hosts[0]!.hostScope).toEqual({ status: "unavailable", granted: [] });
    expect(f.h.box.statusScripts).toHaveLength(0);
  });

  it("revocation rejects traffic, retries with fresh signed credentials, then explicit Retry recovers", async () => {
    const f = await fixture();
    await until(() => f.engine.hostScopeLink(HOST_ID) !== null);
    const scope = f.scopes[0]!;
    const accepted = f.auth.accepted[0]!;
    f.auth.enrolled.delete(DEVICE_ID);
    await until(() => scope.getState().status === "refused");
    await expect(scope.mutate("workspaces.create", {})).rejects.toMatchObject({
      hostError: { reason: "credential-invalid" },
    });
    expect(f.engine.snapshot().hosts[0]!.hostScope!.status).toBe("unavailable");
    expect(f.engine.signInLink(HOST_ID)).toBeNull();
    f.auth.enroll(DEVICE_ID, f.h.keys.keys.get(HOST_KEY)!);
    f.engine.retry(HOST_ID);
    await until(() => f.engine.hostScopeLink(HOST_ID) !== null);
    expect(f.auth.accepted.at(-1)!.claims.jti).not.toBe(accepted.claims.jti);
    expect(f.h.box.statusScripts).toHaveLength(0);
    f.h.wake.fire("power-resume");
    await f.engine.forget(HOST_ID);
    expect(scope.getState().status).toBe("closed");
  });

  it("opens exactly 24 real client sockets including the host link; Add cannot create a 25th", async () => {
    const ids = Array.from(
      { length: 23 },
      (_, i) => `00000000-0000-4000-8000-${i.toString().padStart(12, "0")}`,
    );
    const f = await fixture(false, ids);
    await until(
      () =>
        f.engine.hostScopeLink(HOST_ID) !== null &&
        ids.every((id) => f.engine.workspaceLink(id) !== null),
    );
    expect(f.scopes).toHaveLength(1);
    expect(f.workspaces).toHaveLength(23);
    expect(f.listener.connections).toBe(24);
    f.h.box.enrollDeviceId = OTHER_ID;
    const { flowId } = await f.engine.startAdd({ target: "another-box" });
    const w = watch(f.engine, flowId);
    expect((await w.until()).status).toBe("failed");
    expect(f.scopes).toHaveLength(1);
    expect(f.listener.connections).toBe(24);
  });

  it("Add waits on authenticated welcome and hands the same connection to the runtime", async () => {
    const f = await fixture(true);
    const { flowId } = await f.engine.startAdd({ target: "deploy@box" });
    const w = watch(f.engine, flowId);
    expect((await w.until()).status).toBe("done");
    await flush();
    expect(f.scopes).toHaveLength(1);
    expect(f.listener.connections).toBe(1);
    expect(f.engine.hostScopeLink(HOST_ID)).toBe(f.scopes[0]);
    expect(f.auth.accepted).toHaveLength(1);
    expect(f.auth.accepted[0]!.claims).toMatchObject({
      scope: "host",
      hostId: HOST_ID,
      deviceId: DEVICE_ID,
    });
    expect(f.h.box.statusScripts).toHaveLength(0);
    const scope = f.scopes[0]!;
    f.auth.enrolled.delete(DEVICE_ID);
    await until(() => scope.getState().status === "refused");
    f.auth.enroll(DEVICE_ID, f.h.keys.keys.get(HOST_KEY)!);
    f.engine.retry(HOST_ID);
    await until(() => scope.getState().status === "ready");
    expect(f.auth.accepted).toHaveLength(2);
  });
});

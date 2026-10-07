import { HOST_SCOPE_FEATURES, parseDeviceCredential } from "@volli/host-protocol";
import type { HostScopeLinkState } from "@volli/host-protocol/client-link";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { createRemoteHosts, RemoteHostsUnavailableError } from "./remote-hosts";
import { generateDeviceKey } from "./remote-hosts-device-key";
import { isOlderHostScope } from "./remote-hosts-link";
import {
  DEVICE_ID,
  HOST_ID,
  HOST_KEY,
  OTHER_ID,
  WS1,
  WS2,
  flush,
  harness,
  hostEntry,
  json,
  ready,
  registry,
  watch,
  type Harness,
} from "./testing/remote-hosts-harness";

const connecting: HostScopeLinkState = { status: "connecting", attempt: 0 };
const scopeReady = (features: readonly string[] = HOST_SCOPE_FEATURES): HostScopeLinkState => ({
  status: "ready",
  welcome: {
    scope: "host",
    protocolVersion: 1,
    host: { id: HOST_ID, version: "1.2.0" },
    actor: { scope: "host", kind: "device", deviceId: DEVICE_ID },
    features,
    proof: null,
  },
});
const held: Harness[] = [];
const modern = (options: Parameters<typeof harness>[0] = {}) => {
  const h = harness({
    registry: registry(hostEntry()),
    wake: true,
    hostScopeState: connecting,
    ...options,
  });
  held.push(h);
  return h;
};
afterEach(async () => {
  for (const h of held.splice(0)) await h.engine.close();
  vi.useRealTimers();
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("host-scope compatibility is explicit and closed", () => {
  it.each([
    ["hello-invalid", "BAD_REQUEST", 4400, true],
    [undefined, "NOT_FOUND", null, true],
    ["operation-unavailable", "NOT_IMPLEMENTED", null, true],
    ["credential-invalid", "UNAUTHORIZED", 4401, false],
    ["credential-invalid", "NOT_FOUND", null, false],
    ["protocol-version-unsupported", "BAD_REQUEST", 4400, false],
    ["welcome-invalid", "BAD_REQUEST", null, false],
    [undefined, "FORBIDDEN", 4400, false],
    [undefined, "NOT_FOUND", 4400, false],
  ] as const)("%s / %s / %s classifies older=%s", (reason, code, closeCode, expected) => {
    const state = {
      status: "refused",
      error: { code, message: "Refused", ...(reason === undefined ? {} : { reason }) },
      closeCode,
    } as HostScopeLinkState;
    expect(isOlderHostScope(state)).toBe(expected);
    const h = modern();
    h.hostScopes.made[0]!.set(state);
    expect(h.engine.snapshot().hosts[0]!.hostScope!.status).toBe(
      expected ? "older" : "unavailable",
    );
    expect(h.box.statusScripts).toHaveLength(expected ? 1 : 0);
  });
  it("never classifies transient or terminal transport states as old", () => {
    for (const state of [connecting, scopeReady(), { status: "closed" } as const])
      expect(isOlderHostScope(state)).toBe(false);
  });
});

describe("one process-owned host-scope link per box", () => {
  it("grants no-project health and sign-ins only from welcome; Workspace health cannot replace it", async () => {
    const h = modern();
    expect(h.engine.hostScopeLink(HOST_ID)).toBeNull();
    expect(h.engine.signInLink(HOST_ID)).toBeNull();
    expect(h.engine.hostLink(HOST_ID).everReady).toBe(false);
    const host = h.hostScopes.made[0]!;
    host.set(scopeReady());
    expect(h.engine.hostScopeLink(HOST_ID)).toBe(host);
    expect(h.engine.signInLink(HOST_ID)).toBe(host);
    expect(h.box.statusScripts).toHaveLength(0);
    const welcome = h.engine.snapshot().hosts[0]!.lastWelcome;
    h.engine.openWorkspace(HOST_ID, WS1);
    h.links.made[0]!.set(ready("9.9.9"));
    expect(h.engine.snapshot().hosts[0]!.lastWelcome).toEqual(welcome);
    h.links.made[0]!.set({
      ...ready(),
      welcome: {
        ...(ready() as Extract<ReturnType<typeof ready>, { status: "ready" }>).welcome,
        features: ["sign-ins"],
      },
    } as never);
    host.set({
      status: "unreachable",
      error: { code: "SERVICE_UNAVAILABLE", reason: "host-unreachable", message: "Lost" },
      attempt: 1,
      closeCode: 1006,
      retryAt: 0,
    });
    expect(h.engine.hostLink(HOST_ID).state.status).toBe("unreachable");
    expect(h.engine.signInLink(HOST_ID)).toBeNull();
    expect(h.engine.workspaceLink(WS1)).toBe(h.links.made[0]);
    host.set(scopeReady([]));
    expect(h.engine.signInLink(HOST_ID)).toBeNull();
    h.engine.closeWorkspace(HOST_ID, WS1);
    expect(h.engine.hostScopeLink(HOST_ID)).toBe(host);
    expect(host.closed).toBe(false);
    h.engine.retry(HOST_ID);
    h.wake.fire("power-resume");
    expect(host.reconnects).toBe(1);
    expect(host.wakes).toContain("power-resume");
    await expect(h.engine.projects(HOST_ID)).rejects.toBeInstanceOf(RemoteHostsUnavailableError);
    await expect(
      h.engine.createProject({ hostId: HOST_ID, path: "/srv/app" }),
    ).rejects.toBeInstanceOf(RemoteHostsUnavailableError);
    expect(h.box.scripts).toHaveLength(0);
  });

  it("credentials are freshly host-scoped and pinned; late key reads after Forget never sign", async () => {
    const h = modern();
    h.keys.keys.set(HOST_KEY, generateDeviceKey("test").privateKeyPem);
    const options = h.hostScopes.made[0]!.options;
    const a = parseDeviceCredential(await options.credential())!;
    const b = parseDeviceCredential(await options.credential())!;
    expect(a.claims).toMatchObject({ scope: "host", hostId: HOST_ID, deviceId: DEVICE_ID });
    expect(a.claims).not.toHaveProperty("workspaceId");
    expect(a.claims.jti).not.toBe(b.claims.jti);
    const welcome = (scopeReady() as Extract<HostScopeLinkState, { status: "ready" }>).welcome;
    expect(options.verifyProof!(welcome, {} as never)).toBeNull();
    expect(
      options.verifyProof!(
        { ...welcome, actor: { ...welcome.actor, deviceId: OTHER_ID } },
        {} as never,
      ),
    ).toMatchObject({ reason: "welcome-invalid" });
    const waiting = deferred<void>();
    h.keys.hooks.get = () => waiting.promise;
    const credential = Promise.resolve(options.credential());
    const refusal = expect(credential).rejects.toThrow("replaced");
    await h.engine.forget(HOST_ID);
    waiting.resolve();
    await refusal;
    await expect(options.credential()).rejects.toThrow("forgotten");
    expect(h.hostScopes.made[0]!.listeners.size).toBe(0);
  });

  it("a queued Forget can settle during quit without reopening any client links", async () => {
    const h = modern();
    const forget = h.engine.forget(HOST_ID);
    await h.engine.close();
    await forget;
    expect(h.hostScopes.made).toHaveLength(1);
    expect(h.hostScopes.made[0]!.closed).toBe(true);
  });

  it("replacement and queued old callbacks cannot publish late welcomes, even on the same host id", async () => {
    const h = modern({
      enabled: () => false,
      registry: registry(hostEntry({ workspaceIds: [WS1] })),
    });
    const callbacks: ((state: HostScopeLinkState) => void)[] = [];
    const engine = createRemoteHosts({
      ...h.ports,
      enabled: () => true,
      hostScopeLink: (options) => {
        const link = h.hostScopes.factory(options);
        return {
          ...link,
          subscribeState(listener) {
            callbacks.push(listener);
            return link.subscribeState(listener);
          },
        };
      },
    });
    try {
      const before = engine.snapshot();
      const tunnel = h.tunnels.made[0]!;
      tunnel.set({ status: "up", url: tunnel.url, localPort: 55_000 });
      expect(h.hostScopes.made).toHaveLength(1);
      tunnel.set({ status: "up", url: "ws://127.0.0.1:2", localPort: 2 });
      expect(h.hostScopes.made).toHaveLength(2);
      expect(h.hostScopes.made[0]!.closed).toBe(true);
      const replacement = engine.snapshot();
      callbacks[0]!(scopeReady());
      expect(engine.snapshot()).toBe(replacement);
      h.hostScopes.made[1]!.set(scopeReady());
      expect(engine.snapshot()).not.toBe(before);
      await engine.forget(HOST_ID);
      callbacks[1]!(scopeReady());
      expect(engine.snapshot().hosts).toEqual([]);
    } finally {
      await engine.close();
    }
    callbacks[1]!(scopeReady());
  });

  it("tunnel loss immediately withdraws ready grants, keeps its host slot, and reconnects on the same URL", async () => {
    const h = modern({ enabled: () => false });
    let notification!: (state: HostScopeLinkState) => void;
    const engine = createRemoteHosts({
      ...h.ports,
      enabled: () => true,
      hostScopeLink: (options) => {
        const link = h.hostScopes.factory(options);
        return {
          ...link,
          subscribeState(listener) {
            notification = listener;
            return link.subscribeState(listener);
          },
        };
      },
    });
    try {
      h.hostScopes.made[0]!.set(scopeReady());
      const oldNotification = notification;
      const tunnel = h.tunnels.made[0]!;
      tunnel.set({ status: "down", error: "lost route", retryInMs: 100 });
      expect(engine.hostScopeLink(HOST_ID)).toBeNull();
      expect(engine.signInLink(HOST_ID)).toBeNull();
      expect(engine.snapshot().hosts[0]!.hostScope).toEqual({ status: "unavailable", granted: [] });
      expect(h.hostScopes.made[0]!.closed).toBe(true);
      expect(h.hostScopes.made[0]!.listeners.size).toBe(0);
      const before = engine.snapshot();
      oldNotification(scopeReady());
      expect(engine.snapshot()).toBe(before);
      tunnel.set({ status: "up", url: tunnel.url, localPort: 55_000 });
      expect(h.hostScopes.made).toHaveLength(2);
      h.hostScopes.made[1]!.set(scopeReady());
      expect(engine.hostScopeLink(HOST_ID)).not.toBeNull();
      expect(h.box.statusScripts).toHaveLength(0);
    } finally {
      await engine.close();
    }
  });

  it("absent client composition is unavailable, never implicit legacy mode", async () => {
    const h = modern({ enabled: () => false });
    const engine = createRemoteHosts({ ...h.ports, enabled: () => true, hostScopeLink: undefined });
    try {
      expect(engine.snapshot().hosts[0]!.hostScope).toEqual({ status: "unavailable", granted: [] });
      expect(engine.signInLink(HOST_ID)).toBeNull();
      expect(h.box.statusScripts).toHaveLength(0);
      const { flowId } = await engine.startAdd({ target: "other-box" });
      const w = watch(engine, flowId);
      expect((await w.until()).status).toBe("failed");
    } finally {
      await engine.close();
    }
  });
});

const ids = (count: number) =>
  Array.from(
    { length: count },
    (_, i) => `00000000-0000-4000-8000-${i.toString().padStart(12, "0")}`,
  );

describe("24 total host + Workspace + add-flow sockets", () => {
  it("two boxes share the exact cap, and closing or forgetting replenishes free slots", async () => {
    const workspaces = ids(40);
    const h = modern({
      registry: registry(
        hostEntry({ workspaceIds: workspaces }),
        hostEntry({ id: OTHER_ID, target: "other", workspaceIds: [WS1, WS2] }),
      ),
    });
    expect(h.hostScopes.made).toHaveLength(2);
    expect(h.links.made).toHaveLength(22);
    expect(h.engine.snapshot().projects[workspaces[22]!]!.link).toMatchObject({
      status: "refused",
      error: { reason: "too-many-projects" },
    });
    h.engine.closeWorkspace(HOST_ID, workspaces[0]!);
    expect(h.links.made.filter((link) => !link.closed)).toHaveLength(22);
    expect(h.links.made.at(-1)!.workspaceId).toBe(workspaces[22]);
    await h.engine.forget(HOST_ID);
    expect(h.hostScopes.made.filter((link) => !link.closed)).toHaveLength(1);
    expect(h.links.made.filter((link) => !link.closed)).toHaveLength(2);
  });

  it("add flows consume the same last two slots; a third stops at link without a 25th socket", async () => {
    const h = modern({ registry: registry(hostEntry({ workspaceIds: ids(21) })) });
    for (const target of ["one", "two", "three"]) {
      const { flowId } = await h.engine.startAdd({ target });
      const w = watch(h.engine, flowId);
      await w.until((view) =>
        view.steps.some((step) => step.id === "link" && step.status === "running"),
      );
      await flush();
    }
    expect(h.hostScopes.made).toHaveLength(3); // one runtime + two add attempts
    expect(h.links.made).toHaveLength(21);
    expect(h.engine.activeAdds().map((add) => add.status)).toEqual([
      "failed",
      "running",
      "running",
    ]);
    expect(h.engine.snapshot().hosts).toHaveLength(1);
    await h.engine.cancelAdd("flow-1");
    expect(h.hostScopes.made[1]!.closed).toBe(true);
    expect(h.hostScopes.made[1]!.listeners.size).toBe(0);
    await h.engine.close();
    expect(h.hostScopes.made.every((link) => link.closed)).toBe(true);
    expect(h.links.made.every((link) => link.closed)).toBe(true);
  });
});

describe("Add authenticates before registration and preserves VC-720 ownership", () => {
  it("detaching leaves the welcome wait active; cancellation rejects late welcome and credentials", async () => {
    const h = modern({ registry: null });
    const { flowId } = await h.engine.startAdd({ target: "box" });
    const w = watch(h.engine, flowId);
    await w.until((view) =>
      view.steps.some((step) => step.id === "link" && step.status === "running"),
    );
    await flush();
    expect(w.views().at(-1)).toMatchObject({
      status: "running",
      steps: expect.arrayContaining([{ id: "link", status: "running" }]),
    });
    expect(h.engine.snapshot().hosts).toEqual([]);
    const scope = h.hostScopes.made[0]!;
    const waiting = deferred<void>();
    h.keys.hooks.get = () => waiting.promise;
    const credential = Promise.resolve(scope.options.credential());
    const refusal = expect(credential).rejects.toThrow();
    w.stop();
    expect(h.engine.activeAdds()).toHaveLength(1);
    expect(await h.engine.startAdd({ target: "box" })).toEqual({ flowId });
    await h.engine.cancelAdd(flowId);
    waiting.resolve();
    await refusal;
    scope.set(scopeReady());
    await flush();
    expect(h.engine.activeAdds()).toEqual([]);
    expect(h.engine.snapshot().hosts).toEqual([]);
    expect(h.keys.keys.size).toBe(0);
    expect(scope.listeners.size).toBe(0);
  });

  it("hands a welcome-validated link to runtime without a duplicate connection and uses the promoted key", async () => {
    const h = modern({ registry: null });
    const { flowId } = await h.engine.startAdd({ target: "box" });
    const w = watch(h.engine, flowId);
    await w.until((view) =>
      view.steps.some((step) => step.id === "link" && step.status === "running"),
    );
    await flush();
    const scope = h.hostScopes.made[0]!;
    const options = scope.options;
    const first = parseDeviceCredential(await options.credential())!;
    const welcome = (scopeReady() as Extract<HostScopeLinkState, { status: "ready" }>).welcome;
    expect(options.verifyProof!(welcome, {} as never)).toBeNull();
    expect(
      options.verifyProof!(
        { ...welcome, actor: { ...welcome.actor, deviceId: OTHER_ID } },
        {} as never,
      ),
    ).toMatchObject({ reason: "welcome-invalid" });
    options.log!({ kind: "wake", cause: "power-resume", status: "connecting", traceId: "a" });
    options.log!({ kind: "state", from: "connecting", to: "ready", traceId: "a" });
    scope.set(scopeReady());
    expect((await w.until()).status).toBe("done");
    await flush();
    expect(h.hostScopes.made).toHaveLength(1);
    expect(h.engine.hostScopeLink(HOST_ID)).toBe(scope);
    expect(h.keys.keys.has(`flow:${flowId}`)).toBe(false);
    const next = parseDeviceCredential(await options.credential())!;
    expect(first.claims.jti).not.toBe(next.claims.jti);
    expect(h.box.statusScripts).toHaveLength(0);
  });

  it("a missing flow key fails fresh credentials, and a closed host link fails Add", async () => {
    const h = modern({ registry: null });
    const { flowId } = await h.engine.startAdd({ target: "box" });
    const w = watch(h.engine, flowId);
    await w.until((view) =>
      view.steps.some((step) => step.id === "link" && step.status === "running"),
    );
    await flush();
    const scope = h.hostScopes.made[0]!;
    h.keys.keys.delete(`flow:${flowId}`);
    await expect(scope.options.credential()).rejects.toThrow("went missing");
    scope.set({ status: "closed" });
    expect((await w.until()).status).toBe("failed");
    expect(h.engine.snapshot().hosts).toEqual([]);
  });

  it.each(["credential-invalid", "welcome-invalid"] as const)(
    "%s fails Add, never fallback status",
    async (reason) => {
      const h = modern({ registry: null });
      const { flowId } = await h.engine.startAdd({ target: "box" });
      const w = watch(h.engine, flowId);
      await w.until((view) =>
        view.steps.some((step) => step.id === "link" && step.status === "running"),
      );
      await flush();
      h.hostScopes.made[0]!.set({
        status: "refused",
        closeCode: 4401,
        error: { code: "UNAUTHORIZED", reason, message: "No grant" },
      });
      expect((await w.until()).status).toBe("failed");
      expect(h.engine.snapshot().hosts).toEqual([]);
      expect(h.hostScopes.made[0]!.closed).toBe(true);
      expect(h.box.statusScripts).toHaveLength(0);
    },
  );

  it("an explicitly old host cannot finish Add from TCP if pinned bounded status is not ready", async () => {
    const h = modern({
      registry: null,
      hostScopeState: {
        status: "refused",
        closeCode: 4400,
        error: { code: "BAD_REQUEST", reason: "hello-invalid", message: "old" },
      },
      overrides: [
        (_script, options) =>
          options.label === "host-status" ? json({ v: 1, verdict: "not-serving" }) : undefined,
      ],
    });
    const { flowId } = await h.engine.startAdd({ target: "box" });
    const w = watch(h.engine, flowId);
    expect((await w.until()).status).toBe("failed");
    expect(h.engine.snapshot().hosts).toEqual([]);
  });

  it("loss of authenticated readiness while saving the promoted key prevents registration", async () => {
    const h = modern({ registry: null });
    const gate = deferred<void>();
    h.keys.hooks.put = (name) => (name === HOST_KEY ? gate.promise : undefined);
    const { flowId } = await h.engine.startAdd({ target: "box" });
    const w = watch(h.engine, flowId);
    await w.until((view) =>
      view.steps.some((step) => step.id === "link" && step.status === "running"),
    );
    await flush();
    const scope = h.hostScopes.made[0]!;
    scope.set(scopeReady());
    await flush();
    scope.set(connecting);
    gate.resolve();
    expect((await w.until()).status).toBe("failed");
    expect(h.engine.snapshot().hosts).toEqual([]);
    const retry = h.engine.retryAdd(flowId);
    await vi.waitFor(() => expect(h.hostScopes.made).toHaveLength(2));
    expect(scope.closed).toBe(true);
    h.hostScopes.made[1]!.set(scopeReady());
    await retry;
    expect(h.engine.hostScopeLink(HOST_ID)).toBe(h.hostScopes.made[1]);
  });
});

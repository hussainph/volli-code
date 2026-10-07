import type { RemoteHost, RemoteHostLinkState, RemoteHostsSnapshot } from "@volli/shared";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  createHostConnectionStore,
  HOST_OFFLINE_AFTER_MS,
  THIS_MAC_HOST_ID,
} from "./host-connection";
import {
  attachRemoteHostsWhileCloud,
  createRemoteHostSource,
  remoteHostsClient,
  type RemoteHostsClient,
  type RemoteHostsRpc,
} from "./remote-host-source";
import { createThisMacSource } from "./host-sources";

const HOST = "0f6a3a8e-2b1c-4d5e-8f90-1a2b3c4d5e6f";
const ERROR = { code: "SERVICE_UNAVAILABLE", reason: "host-unreachable", message: "down" };

function remote(overrides: Partial<RemoteHost> = {}): RemoteHost {
  return {
    id: HOST,
    name: "hetzner-1",
    target: "deploy@hetzner-1",
    transport: "ssh-tunnel",
    os: "linux",
    mode: "system",
    agentsShareAccount: false,
    version: "1.1.0",
    availableUpdate: null,
    hostIsNewer: false,
    deviceId: "7e8d9c0b-1a2f-4e3d-9c4b-5a6f7e8d9c0b",
    addedAt: "2026-10-07T00:00:00.000Z",
    liveSessions: null,
    ...overrides,
  };
}

function snapshot(
  hosts: RemoteHost[],
  projects: Record<string, RemoteHostLinkState> = {},
  hostOf: (projectId: string) => string = () => HOST,
): RemoteHostsSnapshot {
  return {
    v: 1,
    hosts,
    projects: Object.fromEntries(
      Object.entries(projects).map(([id, link]) => [id, { hostId: hostOf(id), link }]),
    ),
    readOnly: null,
  };
}

function fakeClient() {
  const handlers: Parameters<RemoteHostsClient["subscribe"]>[0][] = [];
  const calls: unknown[][] = [];
  let unsubscribed = 0;
  let refuse: unknown = null;
  const answer = (...call: unknown[]) => {
    calls.push(call);
    return refuse === null ? Promise.resolve(null) : Promise.reject(refuse);
  };
  const client: RemoteHostsClient = {
    subscribe(handler) {
      handlers.push(handler);
      return () => {
        unsubscribed += 1;
      };
    },
    retry: (hostId) => answer("retry", hostId),
    updateHost: (hostId, when) => answer("updateHost", hostId, when),
    cancelScheduledUpdate: (hostId) => answer("cancelScheduledUpdate", hostId),
    signIn: (hostId, providerId) => answer("signIn", hostId, providerId),
  };
  return {
    client,
    calls,
    push: (next: RemoteHostsSnapshot) => handlers.at(-1)!.onData(next),
    fail: (error: unknown) => handlers.at(-1)!.onError(error),
    refuseWith: (error: unknown) => {
      refuse = error;
    },
    unsubscribed: () => unsubscribed,
  };
}

function timers(clock: { now: number }) {
  const armed: { run: () => void; at: number; cancelled: boolean }[] = [];
  return {
    armed,
    setTimer: (run: () => void, ms: number) => {
      const timer = { run, at: clock.now + ms, cancelled: false };
      armed.push(timer);
      return () => {
        timer.cancelled = true;
      };
    },
  };
}

describe("the remote host source", () => {
  it("sends hosts with no link of their own, and each project with its own", () => {
    const fake = fakeClient();
    const source = createRemoteHostSource(fake.client, { now: () => 1_000 });
    expect(source.getSnapshot()).toEqual({ hosts: [], projects: {} });
    const seen = vi.fn();
    source.subscribe(seen);
    fake.push(
      snapshot(
        [remote(), remote({ id: "b", name: "pi", availableUpdate: "1.2.0" })],
        {
          p1: { status: "ready" },
          p2: { status: "connecting", attempt: 0 },
          p3: { status: "ready" },
        },
        (id) => (id === "p3" ? "b" : HOST),
      ),
    );
    expect(seen).toHaveBeenCalledTimes(1);
    expect(source.getSnapshot()).toEqual({
      hosts: [
        {
          id: HOST,
          name: "hetzner-1",
          local: false,
          os: "linux",
          version: "1.1.0",
          liveSessions: null,
          update: null,
          expiredSignIns: [],
        },
        expect.objectContaining({ id: "b", name: "pi" }),
      ],
      projects: {
        // Project A open while project B on the same box still handshakes.
        p1: { hostId: HOST, link: { status: "open" } },
        p2: { hostId: HOST, link: { status: "connecting" } },
        p3: { hostId: "b", link: { status: "version-skewed", availableVersion: "1.2.0" } },
      },
    });
    expect(source.getSnapshot().hosts[0]).not.toHaveProperty("link");
  });

  it("words every Workspace link state the way any other source would", () => {
    const fake = fakeClient();
    const source = createRemoteHostSource(fake.client, { now: () => 100_000 });
    fake.push(
      snapshot(
        [remote(), remote({ id: "n", hostIsNewer: true })],
        {
          o: { status: "unreachable", attempt: 3, error: ERROR, closeCode: null, retryAt: 101_000 },
          r: {
            status: "refused",
            error: { ...ERROR, code: "UNAUTHORIZED", reason: "credential-invalid" },
            closeCode: 4401,
          },
          n: {
            status: "refused",
            error: { ...ERROR, reason: "protocol-version-unsupported" },
            closeCode: 4400,
          },
          f: { status: "fenced", error: ERROR },
          x: { status: "closed" },
        },
        (id) => (id === "n" ? "n" : HOST),
      ),
    );
    const links = Object.fromEntries(
      Object.entries(source.getSnapshot().projects).map(([id, project]) => [id, project.link]),
    );
    expect(links).toMatchObject({
      o: { status: "offline", retryAt: 101_000 },
      r: { status: "incompatible", reason: "refused" },
      n: { status: "incompatible", reason: "host-too-new" },
      f: { status: "incompatible", reason: "fenced" },
      x: { status: "offline", retryAt: null },
    });
  });

  it("re-words a dropped project as offline once its grace ends, though main sent nothing", () => {
    const fake = fakeClient();
    const clock = { now: 10_000 };
    const timer = timers(clock);
    const source = createRemoteHostSource(fake.client, {
      now: () => clock.now,
      setTimer: timer.setTimer,
    });
    const seen = vi.fn();
    source.subscribe(seen);
    fake.push(snapshot([remote()], { p1: { status: "ready" } }));
    const open = source.getSnapshot().projects["p1"];
    expect(open?.link).toEqual({ status: "open" });
    // An unchanged snapshot keeps the very same objects, and tells nobody.
    fake.push(snapshot([remote()], { p1: { status: "ready" } }));
    expect(source.getSnapshot().projects["p1"]).toBe(open);
    expect(seen).toHaveBeenCalledTimes(1);
    clock.now = 11_000;
    fake.push(
      snapshot([remote()], {
        p1: { status: "unreachable", attempt: 1, error: ERROR, closeCode: null, retryAt: 13_000 },
      }),
    );
    expect(source.getSnapshot().projects["p1"]?.link).toEqual({ status: "reconnecting" });
    const grace = timer.armed.at(-1)!;
    expect(grace.at).toBe(11_000 + HOST_OFFLINE_AFTER_MS);
    clock.now = grace.at;
    grace.run();
    expect(source.getSnapshot().projects["p1"]?.link).toMatchObject({
      status: "offline",
      since: 11_000,
    });
    expect(seen).toHaveBeenCalledTimes(3);
    source.close();
    expect(fake.unsubscribed()).toBe(1);
    fake.push(snapshot([remote()], { p1: { status: "ready" } }));
    fake.fail(new Error("late"));
    expect(source.getSnapshot().projects["p1"]?.link.status).toBe("offline");
  });

  it("forgets a project main stops naming, and reads no hosts when main offers none", () => {
    const fake = fakeClient();
    const source = createRemoteHostSource(fake.client, { now: () => 0 });
    const seen = vi.fn();
    source.subscribe(seen);
    fake.push(snapshot([remote()], { p1: { status: "ready" }, p2: { status: "ready" } }));
    fake.push(snapshot([remote()], { p1: { status: "ready" } }));
    expect(Object.keys(source.getSnapshot().projects)).toEqual(["p1"]);
    fake.push(snapshot([remote({ name: "renamed" })], { p1: { status: "ready" } }));
    expect(source.getSnapshot().hosts[0]?.name).toBe("renamed");
    fake.fail(new Error("Remote hosts are unavailable on this host"));
    expect(source.getSnapshot()).toEqual({ hosts: [], projects: {} });
    const calls = seen.mock.calls.length;
    fake.fail(new Error("still off"));
    expect(seen).toHaveBeenCalledTimes(calls);
  });

  it("sends each action once, and says so when one is refused", async () => {
    const fake = fakeClient();
    const errors: string[] = [];
    const source = createRemoteHostSource(fake.client, {
      onActionError: (message) => errors.push(message),
    });
    source.retry(HOST);
    source.updateHost(HOST, "when-idle");
    source.cancelScheduledUpdate(HOST);
    source.signIn(HOST, "anthropic");
    expect(fake.calls).toEqual([
      ["retry", HOST],
      ["updateHost", HOST, "when-idle"],
      ["cancelScheduledUpdate", HOST],
      ["signIn", HOST, "anthropic"],
    ]);
    fake.refuseWith(new Error("Updating a host from this Mac comes in a later build."));
    source.updateHost(HOST, "now");
    await vi.waitFor(() =>
      expect(errors).toEqual(["Updating a host from this Mac comes in a later build."]),
    );
    fake.refuseWith("not an error");
    source.retry(HOST);
    await vi.waitFor(() => expect(errors).toHaveLength(2));
    expect(errors[1]).toBe("That didn’t work.");
    source.close();
  });

  it("opens the host's sign-ins once main's preflight for Sign in answers (VC-702)", async () => {
    const fake = fakeClient();
    const opened: unknown[] = [];
    const source = createRemoteHostSource(fake.client, {
      now: () => 0,
      onSignIn: (target) => opened.push(target),
    });
    fake.push(snapshot([remote()], {}));
    source.signIn(HOST, "anthropic");
    source.signIn("not-a-host-we-know", "xai");
    await vi.waitFor(() => expect(opened).toHaveLength(2));
    expect(opened).toEqual([
      { hostId: HOST, hostName: source.getSnapshot().hosts[0]!.name, providerId: "anthropic" },
      { hostId: "not-a-host-we-know", hostName: "the host", providerId: "xai" },
    ]);
    source.close();
  });

  it("merges beside This Mac: a remote project's claim wins, and actions reach it", () => {
    const store = createHostConnectionStore();
    const projects = {
      getState: () => ({ projects: [{ id: "p1" }, { id: "p2" }] }),
      subscribe: () => () => {},
    };
    store.getState().attach(createThisMacSource(projects));
    const fake = fakeClient();
    const detach = store.getState().attach(createRemoteHostSource(fake.client, { now: () => 0 }));
    fake.push(snapshot([remote()], { p1: { status: "ready" } }));
    expect(store.getState().projects["p1"]?.hostId).toBe(HOST);
    expect(store.getState().projects["p2"]?.hostId).toBe(THIS_MAC_HOST_ID);
    store.getState().retry(HOST);
    expect(fake.calls).toEqual([["retry", HOST]]);
    detach();
    expect(store.getState().projects["p1"]?.hostId).toBe(THIS_MAC_HOST_ID);
  });
});

describe("the tier client and the flag", () => {
  it("speaks hosts.* over the desktop tier", async () => {
    const calls: unknown[] = [];
    let unsubscribed = false;
    let handlers: Parameters<RemoteHostsRpc["hosts"]["subscribe"]["subscribe"]>[1] | null = null;
    const mutate = (name: string) => ({
      mutate: async (input: unknown) => {
        calls.push([name, input]);
        return null;
      },
    });
    const rpc: RemoteHostsRpc = {
      hosts: {
        subscribe: {
          subscribe(_input, next) {
            handlers = next;
            return {
              unsubscribe: () => {
                unsubscribed = true;
              },
            };
          },
        },
        retry: mutate("retry"),
        updateHost: mutate("updateHost"),
        cancelScheduledUpdate: mutate("cancelScheduledUpdate"),
        signIn: mutate("signIn"),
      },
    };
    const client = remoteHostsClient(rpc);
    const data = vi.fn();
    const failed = vi.fn();
    const stop = client.subscribe({ onData: data, onError: failed });
    handlers!.onData(snapshot([remote()]));
    handlers!.onError(new Error("x"));
    expect(data).toHaveBeenCalledWith(snapshot([remote()]));
    expect(failed).toHaveBeenCalledOnce();
    stop();
    expect(unsubscribed).toBe(true);
    await client.retry(HOST);
    await client.updateHost(HOST, "now");
    await client.cancelScheduledUpdate(HOST);
    await client.signIn(HOST, "anthropic");
    expect(calls).toEqual([
      ["retry", { hostId: HOST }],
      ["updateHost", { hostId: HOST, when: "now" }],
      ["cancelScheduledUpdate", { hostId: HOST }],
      ["signIn", { hostId: HOST, providerId: "anthropic" }],
    ]);
  });

  it("attaches only while cloud is on, and ends the subscription when it goes off", () => {
    let on = false;
    const listeners = new Set<() => void>();
    const experiments = {
      getState: () => ({ snapshot: (on ? { cloud: { enabled: true } } : null) as never }),
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    };
    const flip = (next: boolean) => {
      on = next;
      for (const listener of listeners) listener();
    };
    const store = createHostConnectionStore();
    const fake = fakeClient();
    let made = 0;
    const stop = attachRemoteHostsWhileCloud({
      experiments,
      hosts: store,
      createSource: () => {
        made += 1;
        return createRemoteHostSource(fake.client, { now: () => 0 });
      },
    });
    // Flag off: no source, no subscription to main.
    expect(made).toBe(0);
    flip(true);
    flip(true);
    expect(made).toBe(1);
    fake.push(snapshot([remote()], { p1: { status: "ready" } }));
    expect(store.getState().projects["p1"]?.hostId).toBe(HOST);
    flip(false);
    expect(fake.unsubscribed()).toBe(1);
    expect(store.getState().projects["p1"]).toBeUndefined();
    flip(true);
    stop();
    expect(fake.unsubscribed()).toBe(2);
    expect(listeners.size).toBe(0);
  });
});

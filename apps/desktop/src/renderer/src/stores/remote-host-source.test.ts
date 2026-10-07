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
import { useExperimentsStore } from "./experiments";
import { useRemoteHostsStore } from "./remote-hosts";
import { sessionRpcClient } from "../lib/session-rpc-ipc-link";
import { hostDetail } from "../components/hosts/host-surface-model";
import { toast } from "sonner";

vi.mock("../lib/session-rpc-ipc-link", () => ({ sessionRpcClient: vi.fn() }));
vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));

const HOST = "0f6a3a8e-2b1c-4d5e-8f90-1a2b3c4d5e6f";
const ERROR = { code: "SERVICE_UNAVAILABLE", reason: "host-unreachable", message: "down" };

// Synthetic peer/transport diagnostics: none are credentials from this machine.
const DIAGNOSTICS = [
  { name: "controls", raw: "link\u0007\t closed\n\r\u0000 now", safe: "link closed now" },
  {
    name: "URL credentials, query and fragment",
    raw: "https://user:p4ss@host/path?token=verysecret#fragment-secret",
    safe: "https://host/path?[redacted]",
  },
  {
    name: "URL credentials without a query",
    raw: "https://user:p4ss@host/path",
    safe: "https://[redacted]@host/path",
  },
  {
    name: "GitHub token",
    raw: "link ghp_abcdefghijklmnopqrstuvwxyz0123456789 closed",
    safe: "link [redacted] closed",
  },
  { name: "overlength text", raw: "x".repeat(1_000), safe: `${"x".repeat(599)}…` },
];

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
    system: null,
    arch: null,
    hostKeys: [],
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
    handlers,
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
  it.each(DIAGNOSTICS)("sanitizes $name from peer states through host detail", ({ raw, safe }) => {
    const fake = fakeClient();
    const source = createRemoteHostSource(fake.client, { now: () => 10_000 });
    const store = createHostConnectionStore();
    const detach = store.getState().attach(source);
    try {
      for (const state of [
        {
          status: "unreachable" as const,
          attempt: 0,
          retryAt: 0,
          closeCode: 1006,
          error: { ...ERROR, message: raw },
        },
        {
          status: "refused" as const,
          closeCode: 4401,
          error: { ...ERROR, reason: raw },
        },
      ]) {
        fake.push(
          snapshot([remote({ reachability: { state, everReady: false, droppedAt: 0 } })], {
            p1: state,
          }),
        );
        const host = store.getState().hosts[0]!;
        const link = host.link;
        const expected =
          state.status === "unreachable"
            ? { status: "offline", detail: safe }
            : { status: "incompatible", refusalCode: safe };
        expect(link).toMatchObject(expected);
        expect(store.getState().projects.p1?.link).toMatchObject(expected);
        expect(hostDetail(host)).toMatchObject({
          text:
            state.status === "unreachable"
              ? `Can’t reach hetzner-1 · ${safe}`
              : `Connection refused (${safe})`,
        });
        // Identical wire updates still keep the published host identity.
        fake.push(
          snapshot([remote({ reachability: { state, everReady: false, droppedAt: 0 } })], {
            p1: state,
          }),
        );
        expect(store.getState().hosts[0]).toBe(host);
      }
      // SSH copy overrides the peer diagnostic, but must not bypass sanitization.
      fake.push(
        snapshot([
          remote({
            reachability: {
              state: {
                status: "unreachable",
                attempt: 0,
                retryAt: 0,
                closeCode: null,
                error: ERROR,
              },
              everReady: false,
              droppedAt: 0,
            },
            lastSshFailure: { code: "key-refused", line: raw },
          }),
        ]),
      );
      expect(store.getState().hosts[0]?.link).toMatchObject({ status: "offline", detail: safe });
      expect(hostDetail(store.getState().hosts[0]!)).toMatchObject({
        text: `Can’t reach hetzner-1 · ${safe}`,
      });
    } finally {
      detach();
      source.close();
    }
  });

  it.each(DIAGNOSTICS)(
    "sanitizes $name in subscription errors before publication",
    ({ raw, safe }) => {
      const fake = fakeClient();
      const clock = { now: 0 };
      const timer = timers(clock);
      const onHosts = vi.fn();
      const source = createRemoteHostSource(fake.client, {
        now: () => clock.now,
        setTimer: timer.setTimer,
        onHosts,
      });
      const store = createHostConnectionStore();
      const detach = store.getState().attach(source);
      try {
        const host = remote();
        fake.push(snapshot([host], { p1: { status: "ready" } }));
        fake.fail(new Error(raw));
        const line = `Couldn’t read host state: ${safe}`;
        const expected = line.length > 600 ? `${line.slice(0, 599)}…` : line;
        expect(source.getSnapshot().error).toBe(expected);
        expect(store.getState().sourceError).toBe(expected);
        expect(store.getState().projects.p1?.link).toMatchObject({
          status: "offline",
          detail: expected,
        });
        expect(store.getState().hosts[0]?.link).toMatchObject({
          status: "offline",
          detail: expected,
        });
        expect(hostDetail(store.getState().hosts[0]!)).toMatchObject({
          text: `Can’t reach hetzner-1 · ${expected}`,
        });
        expect(onHosts).toHaveBeenLastCalledWith([host], expected);
      } finally {
        detach();
        source.close();
      }
    },
  );

  it("uses engine host health even with no projects or a refused project, and maps known expiry", () => {
    const fake = fakeClient();
    const clock = { now: 1_000 };
    const timer = timers(clock);
    const source = createRemoteHostSource(fake.client, {
      now: () => clock.now,
      setTimer: timer.setTimer,
    });
    const store = createHostConnectionStore();
    store.getState().attach(source);
    const ready = remote({
      reachability: { state: { status: "ready" }, everReady: true, droppedAt: null },
      signInExpiry: [
        { providerId: "anthropic", name: "Claude", expiresAt: 500, expired: true },
        { providerId: "openai", name: "OpenAI", expiresAt: 5_000, expired: false },
      ],
    });
    fake.push(snapshot([ready]));
    const first = store.getState().hosts[0];
    expect(first).toMatchObject({
      link: { status: "open" },
      expiredSignIns: [{ providerId: "anthropic", name: "Claude" }],
    });
    fake.push(snapshot([ready]));
    expect(store.getState().hosts[0]).toBe(first);
    fake.push(
      snapshot([ready], {
        p1: {
          status: "refused",
          error: { ...ERROR, reason: "workspace-unknown" },
          closeCode: 4404,
        },
      }),
    );
    expect(store.getState().hosts[0]?.link.status).toBe("open");
    expect(store.getState().projects.p1?.link).toMatchObject({
      status: "incompatible",
      refusalCode: "workspace-unknown",
      workspaceId: "p1",
    });
    const down = remote({
      reachability: {
        state: { status: "unreachable", error: ERROR, attempt: 0, retryAt: 0, closeCode: null },
        everReady: true,
        droppedAt: 1_000,
      },
    });
    fake.push(snapshot([down]));
    expect(store.getState().hosts[0]?.link.status).toBe("reconnecting");
    clock.now = 6_000;
    timer.armed.at(-1)!.run();
    expect(store.getState().hosts[0]?.link).toMatchObject({
      status: "offline",
      since: 1_000,
      detail: "down",
    });
    fake.push(
      snapshot([
        {
          ...down,
          lastSshFailure: { code: "key-refused", line: "No SSH key loaded for hetzner-1." },
        },
      ]),
    );
    expect(store.getState().hosts[0]?.link).toMatchObject({
      detail: "No SSH key loaded for hetzner-1.",
    });
    expect(hostDetail(store.getState().hosts[0]!)).toMatchObject({
      text: "Can’t reach hetzner-1 · No SSH key loaded for hetzner-1.",
    });
    fake.push(snapshot([ready]));
    expect(store.getState().hosts[0]?.link.status).toBe("open");
    source.close();
  });

  it("arms the earliest grace across projects and engine host states, in either order", () => {
    const fake = fakeClient();
    const clock = { now: 0 };
    const timer = timers(clock);
    const source = createRemoteHostSource(fake.client, {
      now: () => clock.now,
      setTimer: timer.setTimer,
    });
    fake.push(snapshot([remote()], { a: { status: "ready" }, b: { status: "ready" } }));
    const down: RemoteHostLinkState = {
      status: "unreachable",
      error: ERROR,
      attempt: 0,
      retryAt: 0,
      closeCode: null,
    };
    clock.now = 1000;
    fake.push(snapshot([remote()], { a: down, b: { status: "ready" } }));
    clock.now = 2000;
    fake.push(snapshot([remote()], { a: down, b: down }));
    expect(timer.armed.at(-1)?.at).toBe(6000);
    fake.push(
      snapshot(
        [
          remote({ reachability: { state: down, everReady: true, droppedAt: 500 } }),
          remote({ id: "second", reachability: { state: down, everReady: true, droppedAt: 1500 } }),
        ],
        { b: down, a: down },
      ),
    );
    expect(timer.armed.at(-1)?.at).toBe(5500);
    source.close();
  });

  it("bounds subscription backoff, ignores superseded callbacks, and cancels retries on close", () => {
    const fake = fakeClient();
    const clock = { now: 0 };
    const timer = timers(clock);
    const source = createRemoteHostSource(fake.client, {
      now: () => clock.now,
      setTimer: timer.setTimer,
    });
    const first = fake.handlers[0]!;
    fake.fail("bad read");
    expect(source.getSnapshot().error).toContain("connection failed");
    const failed = source.getSnapshot();
    first.onData(snapshot([remote()]));
    first.onError(new Error("late"));
    expect(source.getSnapshot()).toBe(failed);
    for (const delay of [1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000]) {
      const next = timer.armed.at(-1)!;
      expect(next.at - clock.now).toBe(delay);
      clock.now = next.at;
      next.run();
      fake.fail(new Error("again"));
    }
    source.retry(HOST);
    expect(timer.armed.at(-1)?.cancelled).toBe(true);
    expect(fake.calls).toEqual([]);
    fake.fail(new Error("again"));
    source.retrySubscription?.();
    fake.push(snapshot([remote()]));
    fake.fail(new Error("after recovery"));
    expect(timer.armed.at(-1)!.at - clock.now).toBe(1_000);
    const last = timer.armed.at(-1)!;
    source.close();
    expect(last.cancelled).toBe(true);
    last.run();
    source.retrySubscription?.();
    fake.fail(new Error("after close"));
  });

  it("handles synchronous subscription errors and thrown setup without leaking the subscription", () => {
    const clock = { now: 0 };
    const timer = timers(clock);
    const fake = fakeClient();
    const stop = vi.fn();
    const source = createRemoteHostSource(
      {
        ...fake.client,
        subscribe(handlers) {
          handlers.onError(new Error("sync"));
          return stop;
        },
      },
      { setTimer: timer.setTimer, now: () => 0 },
    );
    expect(source.getSnapshot().error).toContain("sync");
    expect(stop).toHaveBeenCalledOnce();
    source.close();
    const thrown = createRemoteHostSource(
      {
        ...fake.client,
        subscribe() {
          throw new Error("thrown");
        },
      },
      { setTimer: timer.setTimer },
    );
    expect(thrown.getSnapshot().error).toContain("thrown");
    thrown.close();
  });

  it("names what each ready project's link granted, keeping the same array while it is the same (VC-712)", () => {
    const fake = fakeClient();
    const source = createRemoteHostSource(fake.client, { now: () => 1_000 });
    const granting = (granted: readonly string[] | undefined): RemoteHostsSnapshot => ({
      ...snapshot([remote()]),
      projects: {
        p1: {
          hostId: HOST,
          link: { status: "ready" },
          ...(granted === undefined ? {} : { granted }),
        },
      },
    });
    fake.push(granting(["sign-ins", "host.logs"]));
    const first = source.getSnapshot().projects["p1"]!;
    expect(first).toEqual({
      hostId: HOST,
      link: { status: "open" },
      granted: ["sign-ins", "host.logs"],
    });
    // The same grant in a fresh array: the same project, the same array.
    fake.push(granting(["sign-ins", "host.logs"]));
    expect(source.getSnapshot().projects["p1"]).toBe(first);
    // A different grant, of the same length or not: a new one.
    fake.push(granting(["sign-ins", "board.read"]));
    expect(source.getSnapshot().projects["p1"]!.granted).toEqual(["sign-ins", "board.read"]);
    fake.push(granting(["sign-ins"]));
    expect(source.getSnapshot().projects["p1"]!.granted).toEqual(["sign-ins"]);
    // No grant said: none named.
    fake.push(granting(undefined));
    expect(source.getSnapshot().projects["p1"]).toEqual({ hostId: HOST, link: { status: "open" } });
    fake.push(granting(["host.logs"]));
    expect(source.getSnapshot().projects["p1"]!.granted).toEqual(["host.logs"]);
  });

  it("keeps unknown host health connecting, independently of ready projects", () => {
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
          link: { status: "connecting" },
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
    expect(source.getSnapshot().hosts[0]?.link).toEqual({ status: "connecting" });
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

  it("keeps remote claims on a subscription error, then resubscribes and recovers", () => {
    const fake = fakeClient();
    const clock = { now: 0 };
    const timer = timers(clock);
    const onHosts = vi.fn();
    const source = createRemoteHostSource(fake.client, {
      now: () => clock.now,
      setTimer: timer.setTimer,
      onHosts,
    });
    const store = createHostConnectionStore();
    store.getState().attach(source);
    fake.push(snapshot([remote()], { p1: { status: "ready" }, p2: { status: "ready" } }));
    fake.push(snapshot([remote()], { p1: { status: "ready" } }));
    expect(Object.keys(source.getSnapshot().projects)).toEqual(["p1"]);
    fake.fail(new Error("stream lost"));
    expect(store.getState().sourceError).toContain("stream lost");
    expect(store.getState().projects.p1).toMatchObject({
      hostId: HOST,
      link: { status: "offline", detail: expect.stringContaining("stream lost") },
    });
    expect(store.getState().hosts[0]?.link.status).toBe("offline");
    expect(onHosts).toHaveBeenLastCalledWith([remote()], expect.stringContaining("stream lost"));
    expect(timer.armed.at(-1)?.at).toBe(1000);
    expect(fake.unsubscribed()).toBe(1);
    clock.now = 1000;
    timer.armed.at(-1)!.run();
    fake.push(
      snapshot(
        [
          remote({
            reachability: { state: { status: "ready" }, everReady: true, droppedAt: null },
          }),
        ],
        { p1: { status: "ready" } },
      ),
    );
    expect(store.getState().sourceError).toBeNull();
    expect(store.getState().hosts[0]?.link).toEqual({ status: "open" });
    expect(store.getState().projects.p1?.link).toEqual({ status: "open" });
    source.close();
  });

  it("sends each action once, and says so when one is refused", async () => {
    const fake = fakeClient();
    const errors: string[] = [];
    const source = createRemoteHostSource(fake.client, {
      onActionError: (message) => errors.push(message),
    });
    source.retry(HOST);
    source.signIn(HOST, "anthropic");
    expect(fake.calls).toEqual([
      ["retry", HOST],
      ["signIn", HOST, "anthropic"],
    ]);
    fake.refuseWith(new Error("Retry failed."));
    source.retry(HOST);
    await vi.waitFor(() => expect(errors).toEqual(["Retry failed."]));
    fake.refuseWith("not an error");
    source.retry(HOST);
    await vi.waitFor(() => expect(errors).toHaveLength(2));
    expect(errors[1]).toBe("That didn’t work.");
    source.close();
  });

  it("re-adds from the current wire target for both compatibility actions without an RPC", () => {
    const fake = fakeClient();
    const source = createRemoteHostSource(fake.client);
    const open = vi.spyOn(useRemoteHostsStore.getState(), "openAddHost");
    try {
      source.updateHost(HOST, "now");
      source.cancelScheduledUpdate("unknown");
      expect(open).not.toHaveBeenCalled();

      fake.push(snapshot([remote()]));
      source.updateHost(HOST, "now");
      expect(open).toHaveBeenLastCalledWith("deploy@hetzner-1");
      expect(useRemoteHostsStore.getState().addHost).toEqual({
        open: true,
        target: "deploy@hetzner-1",
      });

      // Target-only changes need not change the projected HostSourceRecord.
      const before = source.getSnapshot().hosts[0];
      fake.push(snapshot([remote({ target: "admin@new-box" })]));
      expect(source.getSnapshot().hosts[0]).toBe(before);
      source.updateHost(HOST, "when-idle");
      source.cancelScheduledUpdate(HOST);
      expect(open).toHaveBeenCalledTimes(3);
      expect(open).toHaveBeenLastCalledWith("admin@new-box");
      expect(useRemoteHostsStore.getState().addHost).toEqual({
        open: true,
        target: "admin@new-box",
      });
      expect(fake.calls).toEqual([]);

      source.updateHost("unknown", "when-idle");
      source.cancelScheduledUpdate("unknown");
      fake.push(snapshot([]));
      source.updateHost(HOST, "now");
      source.cancelScheduledUpdate(HOST);
      fake.push(snapshot([remote()]));
      source.close();
      source.updateHost(HOST, "now");
      source.cancelScheduledUpdate(HOST);
      expect(open).toHaveBeenCalledTimes(3);
      expect(fake.calls).toEqual([]);
    } finally {
      source.close();
      open.mockRestore();
      useRemoteHostsStore.getState().closeAddHost();
    }
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
  it("uses the production binding and keeps Settings hosts on a read failure", () => {
    let handlers: Parameters<RemoteHostsClient["subscribe"]>[0] | undefined;
    const unsubscribe = vi.fn();
    const mutate = vi.fn<RemoteHostsRpc["hosts"]["retry"]["mutate"]>().mockResolvedValue(null);
    const rpc: RemoteHostsRpc = {
      hosts: {
        subscribe: {
          subscribe(_input, next) {
            handlers = next;
            return { unsubscribe };
          },
        },
        retry: { mutate },
        signIn: { mutate },
      },
    };
    vi.mocked(sessionRpcClient).mockReturnValue(rpc as ReturnType<typeof sessionRpcClient>);
    useExperimentsStore.setState({ snapshot: { cloud: { enabled: true, source: "storage" } } });
    const stop = attachRemoteHostsWhileCloud();
    handlers!.onData(snapshot([remote()]));
    expect(useRemoteHostsStore.getState().hosts).toEqual([remote()]);
    handlers!.onError(new Error("failed read"));
    expect(useRemoteHostsStore.getState().hosts).toEqual([remote()]);
    expect(useRemoteHostsStore.getState().readOnly).toContain("failed read");
    stop();
    expect(useRemoteHostsStore.getState().hosts).toEqual([]);
    expect(unsubscribe).toHaveBeenCalledOnce();
    useExperimentsStore.setState({ snapshot: null });
  });

  it("runs the default timer and toast, and words a project before its host is named", async () => {
    vi.useFakeTimers();
    const fake = fakeClient();
    const source = createRemoteHostSource(fake.client);
    try {
      fake.push(snapshot([], { orphan: { status: "ready" } }));
      expect(source.getSnapshot().projects.orphan?.link.status).toBe("open");
      fake.refuseWith(new Error("action failed"));
      source.retry(HOST);
      await Promise.resolve();
      expect(toast.error).toHaveBeenCalledWith("action failed");
      fake.fail(new Error("lost"));
      await vi.advanceTimersByTimeAsync(1000);
      expect(fake.handlers).toHaveLength(2);
      fake.push(snapshot([]));
      expect(source.getSnapshot()).toEqual({ hosts: [], projects: {} });
    } finally {
      source.close();
      vi.useRealTimers();
    }
  });

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
    expect(client).not.toHaveProperty("updateHost");
    expect(client).not.toHaveProperty("cancelScheduledUpdate");
    await client.signIn(HOST, "anthropic");
    expect(calls).toEqual([
      ["retry", { hostId: HOST }],
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

describe("HOST welcome facts", () => {
  it("carries hostScope without projects, retaining record identity for equal facts", () => {
    const fake = fakeClient();
    const source = createRemoteHostSource(fake.client);
    const store = createHostConnectionStore();
    const detach = store.getState().attach(source);
    const scope = { status: "ready" as const, granted: ["host.logs", "host.workspaces"] };
    fake.push(snapshot([remote({ hostScope: scope })]));
    const before = store.getState().hosts[0]!;
    expect(before.hostScope).toBe(scope);
    fake.push(snapshot([remote({ hostScope: { ...scope, granted: [...scope.granted] } })]));
    expect(store.getState().hosts[0]).toBe(before);
    fake.push(snapshot([remote({ hostScope: { ...scope, granted: ["host.logs"] } })]));
    expect(store.getState().hosts[0]).not.toBe(before);
    const changed = store.getState().hosts[0]!;
    fake.push(snapshot([remote({ hostScope: { status: "unavailable", granted: [] } })]));
    expect(store.getState().hosts[0]).not.toBe(changed);
    expect(store.getState().hosts[0]!.hostScope?.status).toBe("unavailable");
    expect(store.getState().projects).toEqual({});
    detach();
    source.close();
  });
});

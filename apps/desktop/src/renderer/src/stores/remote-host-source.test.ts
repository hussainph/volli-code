import type { RemoteHost, RemoteHostsSnapshot } from "@volli/shared";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  createHostConnectionStore,
  HOST_OFFLINE_AFTER_MS,
  THIS_MAC_HOST,
  THIS_MAC_HOST_ID,
} from "./host-connection";
import { createRemoteHostSource, type RemoteHostsClient } from "./remote-host-source";
import { createFakeHostSource } from "./host-sources";

const HOST = "0f6a3a8e-2b1c-4d5e-8f90-1a2b3c4d5e6f";

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
    link: { state: { status: "ready" }, everReady: true, droppedAt: null },
    liveSessions: null,
    ...overrides,
  };
}

const snapshot = (...hosts: RemoteHost[]): RemoteHostsSnapshot => ({ v: 1, hosts, projects: {} });

function fakeClient() {
  const handlers: Parameters<RemoteHostsClient["subscribe"]>[0][] = [];
  const calls: unknown[][] = [];
  let unsubscribed = 0;
  let refuse: Error | null = null;
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
    refuseWith: (error: Error) => {
      refuse = error;
    },
    unsubscribed: () => unsubscribed,
  };
}

describe("the remote host source", () => {
  it("turns main's registry into VC-576's records, worded by hostLinkView", () => {
    const fake = fakeClient();
    const source = createRemoteHostSource(fake.client, { now: () => 1_000 });
    expect(source.getSnapshot()).toEqual({ hosts: [], projects: {} });
    const seen = vi.fn();
    source.subscribe(seen);
    fake.push({
      ...snapshot(remote(), remote({ id: "b", name: "pi", availableUpdate: "1.2.0" })),
      projects: { p1: HOST },
    });
    expect(seen).toHaveBeenCalledTimes(1);
    expect(source.getSnapshot()).toEqual({
      hosts: [
        {
          id: HOST,
          name: "hetzner-1",
          local: false,
          os: "linux",
          version: "1.1.0",
          link: { status: "open" },
          liveSessions: null,
          update: null,
          expiredSignIns: [],
        },
        expect.objectContaining({
          id: "b",
          link: { status: "version-skewed", availableVersion: "1.2.0" },
        }),
      ],
      projects: { p1: HOST },
    });
  });

  it("words every link state the way any other source would", () => {
    const fake = fakeClient();
    const source = createRemoteHostSource(fake.client, { now: () => 100_000 });
    const error = { code: "SERVICE_UNAVAILABLE", reason: "host-unreachable", message: "down" };
    fake.push(
      snapshot(
        remote({
          id: "c",
          link: { state: { status: "connecting", attempt: 0 }, everReady: false, droppedAt: null },
        }),
        remote({
          id: "o",
          link: {
            state: { status: "unreachable", attempt: 3, error, closeCode: null, retryAt: 101_000 },
            everReady: false,
            droppedAt: null,
          },
        }),
        remote({
          id: "r",
          link: {
            state: {
              status: "refused",
              error: { ...error, code: "UNAUTHORIZED", reason: "credential-invalid" },
              closeCode: 4401,
            },
            everReady: true,
            droppedAt: 50_000,
          },
        }),
        remote({
          id: "n",
          hostIsNewer: true,
          link: {
            state: {
              status: "refused",
              error: { ...error, reason: "protocol-version-unsupported" },
              closeCode: 4400,
            },
            everReady: false,
            droppedAt: null,
          },
        }),
        remote({
          id: "f",
          link: { state: { status: "fenced", error }, everReady: true, droppedAt: 1 },
        }),
        remote({
          id: "x",
          link: { state: { status: "closed" }, everReady: true, droppedAt: 90_000 },
        }),
      ),
    );
    expect(
      Object.fromEntries(source.getSnapshot().hosts.map((host) => [host.id, host.link])),
    ).toEqual({
      c: { status: "connecting" },
      o: { status: "offline", since: 100_000, retryAt: 101_000 },
      r: { status: "incompatible", reason: "refused" },
      n: { status: "incompatible", reason: "host-too-new" },
      f: { status: "incompatible", reason: "fenced" },
      x: { status: "offline", since: 90_000, retryAt: null },
    });
  });

  it("re-words a dropped host as offline once its grace ends, though main sent nothing", () => {
    const fake = fakeClient();
    let clock = 10_000;
    const timers: { run: () => void; at: number; cancelled: boolean }[] = [];
    const source = createRemoteHostSource(fake.client, {
      now: () => clock,
      setTimer: (run, ms) => {
        const timer = { run, at: clock + ms, cancelled: false };
        timers.push(timer);
        return () => {
          timer.cancelled = true;
        };
      },
    });
    const seen = vi.fn();
    source.subscribe(seen);
    const error = { code: "SERVICE_UNAVAILABLE", reason: "host-unreachable", message: "down" };
    fake.push(
      snapshot(
        remote({
          link: {
            state: { status: "unreachable", attempt: 1, error, closeCode: null, retryAt: 12_000 },
            everReady: true,
            droppedAt: 9_000,
          },
        }),
      ),
    );
    expect(source.getSnapshot().hosts[0]!.link).toEqual({ status: "reconnecting" });
    expect(timers.at(-1)!.at).toBe(9_000 + HOST_OFFLINE_AFTER_MS);
    clock = timers.at(-1)!.at;
    timers.at(-1)!.run();
    expect(source.getSnapshot().hosts[0]!.link).toEqual({
      status: "offline",
      since: 9_000,
      retryAt: 12_000,
    });
    expect(seen).toHaveBeenCalledTimes(2);
    // A newer drop arms a new re-word; closing the source withdraws it.
    fake.push(
      snapshot(
        remote({
          link: {
            state: { status: "unreachable", attempt: 2, error, closeCode: null, retryAt: 20_000 },
            everReady: true,
            droppedAt: clock,
          },
        }),
      ),
    );
    expect(source.getSnapshot().hosts[0]!.link).toEqual({ status: "reconnecting" });
    expect(timers.at(-1)!.cancelled).toBe(false);
    source.close();
    expect(timers.at(-1)!.cancelled).toBe(true);
    expect(fake.unsubscribed()).toBe(1);
  });

  it("reads no hosts when main has none to offer (flag off), and ignores a closed source", () => {
    const fake = fakeClient();
    const source = createRemoteHostSource(fake.client);
    fake.push(snapshot(remote()));
    expect(source.getSnapshot().hosts).toHaveLength(1);
    fake.fail(new Error("Remote hosts are unavailable on this host"));
    expect(source.getSnapshot()).toEqual({ hosts: [], projects: {} });
    source.close();
    fake.push(snapshot(remote()));
    fake.fail(new Error("late"));
    expect(source.getSnapshot()).toEqual({ hosts: [], projects: {} });
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
    fake.refuseWith("not an error" as unknown as Error);
    source.retry(HOST);
    await vi.waitFor(() => expect(errors).toHaveLength(2));
    expect(errors[1]).toBe("That didn’t work.");
  });

  it("merges into the host-connection store beside This Mac, and claims its projects", () => {
    const store = createHostConnectionStore();
    const local = createFakeHostSource({
      hosts: [THIS_MAC_HOST],
      projects: { p1: THIS_MAC_HOST_ID, p2: THIS_MAC_HOST_ID },
    });
    store.getState().attach(local);
    const fake = fakeClient();
    const source = createRemoteHostSource(fake.client, { now: () => 0 });
    const detach = store.getState().attach(source);
    fake.push({ ...snapshot(remote()), projects: { p1: HOST } });
    expect(store.getState().projectHosts).toEqual({ p1: HOST, p2: THIS_MAC_HOST_ID });
    store.getState().retry(HOST);
    expect(fake.calls).toEqual([["retry", HOST]]);
    detach();
    expect(store.getState().projectHosts).toEqual({ p1: THIS_MAC_HOST_ID, p2: THIS_MAC_HOST_ID });
  });
});

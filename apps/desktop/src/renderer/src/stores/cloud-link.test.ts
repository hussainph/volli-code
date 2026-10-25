import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  CLOUD_RESUME_SETTLE_MS,
  CLOUD_STALL_AFTER_MS,
  INITIAL_CLOUD_LINK_INPUT,
  cloudLinkView,
  cloudLinkViewChangesAt,
  createCloudHostSource,
  createCloudLinkInputStore,
  createCloudLinkTracker,
  readConnection,
  useCloudLinkInputs,
  wokeBetween,
  type CloudConnection,
  type CloudLinkInput,
} from "./cloud-link";
import { CLOUD_HOST_ID, HOST_OFFLINE_AFTER_MS, createHostConnectionStore } from "./host-connection";

const UP: CloudConnection = {
  connected: true,
  everConnected: true,
  inflightMutations: 0,
  oldestInflightAt: null,
};

const SIGNED_IN = { state: "signed-in", backend: "synced", failure: null } as const;

/** What a serving link reads while this build writes nothing to a cloud board. */
const SERVING = { status: "incompatible", reason: "writes-unavailable" } as const;

function input(patch: Partial<CloudLinkInput> = {}): CloudLinkInput {
  return {
    ...INITIAL_CLOUD_LINK_INPUT,
    client: "running",
    connection: UP,
    authenticated: true,
    account: SIGNED_IN,
    ...patch,
  };
}

const at = (now: number, downSince: number | null = null) => ({ now, downSince });

describe("Volli Cloud's link view (VC-889)", () => {
  it("serves read-only while the socket is up, the sign-in accepted and the OS online", () => {
    expect(cloudLinkView(input(), at(0))).toEqual(SERVING);
    // A build that writes to the board reads it open.
    expect(cloudLinkView(input({ writes: true }), at(0))).toEqual({ status: "open" });
    // Before auth has said anything, an open socket still serves.
    expect(cloudLinkView(input({ authenticated: null, account: null }), at(0))).toEqual(SERVING);
  });

  it("is connecting until the client has connected once", () => {
    expect(cloudLinkView(INITIAL_CLOUD_LINK_INPUT, at(0))).toEqual({ status: "connecting" });
    expect(cloudLinkView(input({ connection: null }), at(0))).toEqual({ status: "connecting" });
    const never = { ...UP, everConnected: false };
    expect(cloudLinkView(input({ connection: never }), at(0))).toEqual({ status: "connecting" });
    const unreached = input({ connection: { ...never, connected: false } });
    expect(cloudLinkView(unreached, at(1_000, 0))).toEqual({ status: "connecting" });
    // A backend never reached reads offline past the grace: the Island says so.
    expect(cloudLinkView(unreached, at(HOST_OFFLINE_AFTER_MS, 0))).toEqual({
      status: "offline",
      since: 0,
      retryAt: null,
    });
  });

  it("reconnects for the grace after the socket drops, then reads offline", () => {
    const down = input({ connection: { ...UP, connected: false } });
    expect(cloudLinkView(down, at(1_000, 1_000))).toEqual({ status: "reconnecting" });
    expect(cloudLinkView(down, at(1_000 + HOST_OFFLINE_AFTER_MS - 1, 1_000))).toEqual({
      status: "reconnecting",
    });
    expect(cloudLinkView(down, at(1_000 + HOST_OFFLINE_AFTER_MS, 1_000))).toEqual({
      status: "offline",
      since: 1_000,
      retryAt: null,
    });
    // With no outage start known, the outage starts now.
    expect(cloudLinkView(down, at(50))).toEqual({ status: "reconnecting" });
  });

  it("believes the OS at once when it says it is offline", () => {
    expect(cloudLinkView(input({ online: false }), at(7))).toEqual({
      status: "offline",
      since: 7,
      retryAt: null,
    });
  });

  it("counts a write unanswered past the stall as a drop, and a fresh wake as one", () => {
    const stalled = input({ connection: { ...UP, inflightMutations: 1, oldestInflightAt: 0 } });
    expect(cloudLinkView(stalled, at(CLOUD_STALL_AFTER_MS - 1))).toEqual(SERVING);
    expect(cloudLinkView(stalled, at(CLOUD_STALL_AFTER_MS, CLOUD_STALL_AFTER_MS))).toEqual({
      status: "reconnecting",
    });
    const unknownAge = input({ connection: { ...UP, inflightMutations: 1 } });
    expect(cloudLinkView(unknownAge, at(60_000))).toEqual(SERVING);
    const woke = input({ resumedAt: 100 });
    expect(cloudLinkView(woke, at(100, 100))).toEqual({ status: "reconnecting" });
    expect(cloudLinkView(woke, at(100 + CLOUD_RESUME_SETTLE_MS))).toEqual(SERVING);
  });

  it("refuses writes when Volli Cloud refused the sign-in", () => {
    expect(cloudLinkView(input({ authenticated: false }), at(0))).toEqual({
      status: "incompatible",
      reason: "sign-in-refused",
    });
    expect(cloudLinkView(input({ account: { ...SIGNED_IN, backend: "refused" } }), at(0))).toEqual({
      status: "incompatible",
      reason: "sign-in-refused",
    });
  });

  it("is signed out once the sign-in ends: a restart once the client closed, sign in again otherwise", () => {
    expect(cloudLinkView(input({ client: "closed" }), at(0))).toEqual({
      status: "incompatible",
      reason: "signed-out",
      recovery: "relaunch",
    });
    expect(
      cloudLinkView(
        input({
          account: { state: "signed-out", backend: null, failure: null },
        }),
        at(0),
      ),
    ).toEqual({ status: "incompatible", reason: "signed-out", recovery: "sign-in" });
  });

  it("knows when the view changes with time alone", () => {
    expect(cloudLinkViewChangesAt(input(), at(0))).toBeNull();
    expect(cloudLinkViewChangesAt(input({ client: "closed" }), at(0, 0))).toBeNull();
    expect(cloudLinkViewChangesAt(input({ connection: null }), at(0, 0))).toBeNull();
    expect(cloudLinkViewChangesAt(INITIAL_CLOUD_LINK_INPUT, at(0, 0))).toBeNull();
    expect(cloudLinkViewChangesAt(input(), at(0, 10))).toBe(10 + HOST_OFFLINE_AFTER_MS);
    const pending = input({ connection: { ...UP, inflightMutations: 2, oldestInflightAt: 3 } });
    expect(cloudLinkViewChangesAt(pending, at(4))).toBe(3 + CLOUD_STALL_AFTER_MS);
    expect(cloudLinkViewChangesAt(input({ resumedAt: 20 }), at(21))).toBe(
      20 + CLOUD_RESUME_SETTLE_MS,
    );
    // Moments already past are not moments to wait for.
    expect(cloudLinkViewChangesAt(input({ resumedAt: 0 }), at(1_000_000))).toBeNull();
  });

  it("tracks one outage from its start, keeping the same view object while it holds", () => {
    const tracker = createCloudLinkTracker();
    const open = tracker.view(input(), 0);
    expect(open.link).toEqual(SERVING);
    expect(tracker.view(input(), 1).link).toBe(open.link);
    const down = input({ connection: { ...UP, connected: false } });
    const first = tracker.view(down, 100);
    expect(first).toEqual({
      link: { status: "reconnecting" },
      recheckAt: 100 + HOST_OFFLINE_AFTER_MS,
    });
    expect(tracker.view(down, 200).link).toBe(first.link);
    expect(tracker.view(down, 100 + HOST_OFFLINE_AFTER_MS).link).toEqual({
      status: "offline",
      since: 100,
      retryAt: null,
    });
    expect(tracker.view(input(), 9_000).link).toEqual(SERVING);
    expect(tracker.view(down, 9_001).link).toEqual({ status: "reconnecting" });
  });

  it("reads Convex's connection state through one adapter", () => {
    expect(
      readConnection({
        isWebSocketConnected: true,
        hasEverConnected: true,
        inflightMutations: 2,
        timeOfOldestInflightRequest: new Date(42),
      }),
    ).toEqual({ connected: true, everConnected: true, inflightMutations: 2, oldestInflightAt: 42 });
    expect(readConnection(undefined)).toEqual({
      connected: false,
      everConnected: false,
      inflightMutations: 0,
      oldestInflightAt: null,
    });
  });

  it("detects a wake from a tick that came far later than due", () => {
    expect(wokeBetween(0, 5_000, 5_000)).toBe(false);
    expect(wokeBetween(0, 15_001, 5_000)).toBe(true);
  });
});

describe("the link's inputs", () => {
  it("changes only on a real change", () => {
    const store = createCloudLinkInputStore();
    const seen = vi.fn();
    store.subscribe(seen);
    store.getState().update({ online: true });
    expect(seen).not.toHaveBeenCalled();
    store.getState().update({ online: false });
    expect(store.getState().input.online).toBe(false);
    expect(seen).toHaveBeenCalledOnce();
    expect(useCloudLinkInputs.getState().input).toBe(INITIAL_CLOUD_LINK_INPUT);
  });
});

function projectList(ids: string[]) {
  let projects = ids.map((id) => ({ id }));
  const listeners = new Set<() => void>();
  return {
    getState: () => ({ projects }),
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    set(next: string[]) {
      projects = next.map((id) => ({ id }));
      for (const listener of listeners) listener();
    },
  };
}

describe("the cloud host source", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("claims every project for one Volli Cloud host whose link the inputs decide", () => {
    vi.useFakeTimers();
    const inputs = createCloudLinkInputStore();
    const projects = projectList(["a", "b"]);
    const source = createCloudHostSource({ projects, inputs });
    const hosts = createHostConnectionStore();
    const detach = hosts.getState().attach(source);
    expect(hosts.getState().hosts.map(({ id, name, local }) => [id, name, local])).toEqual([
      [CLOUD_HOST_ID, "Volli Cloud", false],
    ]);
    expect(Object.keys(hosts.getState().projects)).toEqual(["a", "b"]);
    expect(hosts.getState().projects.a!.link).toEqual({ status: "connecting" });

    inputs.getState().update({ client: "running", connection: UP, authenticated: true });
    expect(hosts.getState().projects.a!.link).toEqual(SERVING);
    const snapshot = source.getSnapshot();
    projects.set(["a", "b"]);
    expect(source.getSnapshot()).toBe(snapshot);
    projects.set(["a"]);
    expect(Object.keys(hosts.getState().projects)).toEqual(["a"]);

    // A drop reads reconnecting, then offline once the grace ends, by the source's own timer.
    inputs.getState().update({ connection: { ...UP, connected: false } });
    expect(hosts.getState().projects.a!.link).toEqual({ status: "reconnecting" });
    vi.advanceTimersByTime(HOST_OFFLINE_AFTER_MS);
    expect(hosts.getState().projects.a!.link.status).toBe("offline");

    // It has nothing to retry, update or sign in to.
    source.retry(CLOUD_HOST_ID);
    source.updateHost(CLOUD_HOST_ID, "now");
    source.cancelScheduledUpdate(CLOUD_HOST_ID);
    source.signIn(CLOUD_HOST_ID, "p");
    detach();
    expect(hosts.getState().hosts).toEqual([]);
  });

  it("stops following and its timer with its last listener, and follows again for the next", () => {
    vi.useFakeTimers();
    const inputs = createCloudLinkInputStore();
    inputs.getState().update({ client: "running", connection: { ...UP, connected: false } });
    const projects = projectList(["a"]);
    const source = createCloudHostSource({ projects, inputs });
    const first = vi.fn();
    const second = vi.fn();
    const stopFirst = source.subscribe(first);
    const stopSecond = source.subscribe(second);
    stopFirst();
    stopFirst();
    inputs.getState().update({ connection: UP });
    expect(second).toHaveBeenCalledOnce();
    inputs.getState().update({ connection: { ...UP, connected: false } });
    stopSecond();
    vi.advanceTimersByTime(HOST_OFFLINE_AFTER_MS);
    expect(second).toHaveBeenCalledTimes(2);
    const third = vi.fn();
    source.subscribe(third);
    projects.set(["a", "b"]);
    expect(third).toHaveBeenCalledOnce();
  });

  it("rechecks at a moment that changes nothing without telling anyone", () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    const inputs = createCloudLinkInputStore();
    const source = createCloudHostSource({ projects: projectList(["a"]), inputs });
    const listener = vi.fn();
    source.subscribe(listener);
    // Down now, with a write sent 3 s ago: its stall moment (in 2 s) changes nothing.
    inputs.getState().update({
      client: "running",
      connection: { ...UP, connected: false, inflightMutations: 1, oldestInflightAt: 7_000 },
    });
    expect(listener).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(2_000);
    expect(listener).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(3_000);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("reads the app's inputs and clock by default", () => {
    const source = createCloudHostSource({ projects: projectList([]) });
    expect(source.getSnapshot().hosts[0]!.link).toEqual({ status: "connecting" });
  });
});

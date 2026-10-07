import { describe, expect, it, vi } from "vite-plus/test";
import type { HostLinkState } from "@volli/host-protocol/client-link";
import { hostError, type HostWelcome } from "@volli/host-protocol";

import {
  aggregateLink,
  canWriteProject,
  createHostConnectionStore,
  createHostLinkTracker,
  HOST_OFFLINE_AFTER_MS,
  hostIdOfProject,
  hostLinkView,
  hostLinkViewChangesAt,
  hostOfProject,
  isBlocking,
  OPEN_LINK,
  projectCounts,
  projectLinkOf,
  THIS_MAC_HOST,
  THIS_MAC_HOST_ID,
  type HostLinkContext,
  type HostLinkView,
} from "./host-connection";
import { createFakeHostSource, hostSnapshot, remoteHost } from "./host-sources";

const HETZNER = remoteHost("host-1", "hetzner-1");
const MINI = remoteHost("host-2", "mac-mini", { os: "macos" });
const OFFLINE: HostLinkView = { status: "offline", since: 100, retryAt: 900 };
const FENCED: HostLinkView = { status: "incompatible", reason: "fenced" };

function thisMac(projects: readonly string[]) {
  return createFakeHostSource(
    hostSnapshot([THIS_MAC_HOST], Object.fromEntries(projects.map((id) => [id, THIS_MAC_HOST_ID]))),
  );
}

describe("host-connection store", () => {
  it("starts empty and answers This Mac, open, for any project", () => {
    const store = createHostConnectionStore();
    expect(store.getState().hosts).toEqual([]);
    expect(hostOfProject(store.getState(), "p1")).toBe(THIS_MAC_HOST);
    expect(hostOfProject(store.getState(), null)).toBe(THIS_MAC_HOST);
    expect(projectLinkOf(store.getState(), "p1")).toBe(OPEN_LINK);
    expect(projectLinkOf(store.getState(), null)).toBe(OPEN_LINK);
    expect(canWriteProject(store.getState(), "p1")).toBe(true);
  });

  it("merges N sources: This Mac first, then each source's hosts in order", () => {
    const store = createHostConnectionStore();
    const remote = createFakeHostSource(
      hostSnapshot([HETZNER, MINI], { p2: HETZNER.id, p3: MINI.id }),
    );
    store.getState().attach(remote);
    store.getState().attach(thisMac(["p1", "p2", "p3"]));

    expect(store.getState().hosts.map((host) => host.name)).toEqual([
      "This Mac",
      "hetzner-1",
      "mac-mini",
    ]);
    // A remote claim outranks This Mac's, whichever attached first.
    expect(hostIdOfProject(store.getState(), "p1")).toBe(THIS_MAC_HOST_ID);
    expect(hostIdOfProject(store.getState(), "p2")).toBe(HETZNER.id);
    expect(hostIdOfProject(store.getState(), "p3")).toBe(MINI.id);
    expect(hostIdOfProject(store.getState(), null)).toBe(THIS_MAC_HOST_ID);
    expect(hostOfProject(store.getState(), "p2")).toBe(HETZNER);
    expect(hostOfProject(store.getState(), "unknown")).toBe(THIS_MAC_HOST);
    expect(projectCounts(store.getState())).toEqual(
      new Map([
        [THIS_MAC_HOST_ID, 1],
        [HETZNER.id, 1],
        [MINI.id, 1],
      ]),
    );
  });

  it("keeps the first claim between two remote hosts, and the first owner of a host id", () => {
    const store = createHostConnectionStore();
    store.getState().attach(thisMac(["p1"]));
    store.getState().attach(createFakeHostSource(hostSnapshot([HETZNER], { p1: HETZNER.id })));
    store.getState().attach(
      createFakeHostSource(
        // The second claim stands down, and so does a claim for a host this
        // source does not own.
        hostSnapshot([MINI, { ...HETZNER, name: "impostor" }], { p1: MINI.id, p9: HETZNER.id }),
      ),
    );
    expect(store.getState().hosts.map((host) => host.name)).toEqual([
      "This Mac",
      "hetzner-1",
      "mac-mini",
    ]);
    expect(Object.keys(store.getState().projects)).toEqual(["p1"]);
    expect(hostIdOfProject(store.getState(), "p1")).toBe(HETZNER.id);
  });

  it("follows a source's changes, and forgets it once detached (twice is harmless)", () => {
    const store = createHostConnectionStore();
    const remote = createFakeHostSource(hostSnapshot([HETZNER], { p1: HETZNER.id }));
    const detach = store.getState().attach(remote);

    remote.setHost(HETZNER.id, { link: { status: "reconnecting" } });
    expect(hostOfProject(store.getState(), "p1").link).toEqual({ status: "reconnecting" });
    expect(projectLinkOf(store.getState(), "p1")).toEqual({ status: "reconnecting" });

    detach();
    detach();
    expect(store.getState().hosts).toEqual([]);
    remote.setHost(HETZNER.id, { link: OPEN_LINK });
    expect(store.getState().hosts).toEqual([]);
  });

  it("falls back to This Mac, open, when a claimed host is gone", () => {
    const store = createHostConnectionStore();
    store.getState().attach(thisMac([]));
    const orphaned = {
      hosts: store.getState().hosts,
      projects: { p1: { hostId: "gone", link: OFFLINE } },
    };
    expect(hostOfProject(orphaned, "p1")).toBe(THIS_MAC_HOST);
    expect(projectLinkOf(orphaned, "p1")).toBe(OPEN_LINK);
    expect(canWriteProject(orphaned, "p1")).toBe(true);
  });

  it("keeps each project's own link: one fenced project blocks only itself", () => {
    const store = createHostConnectionStore();
    const remote = createFakeHostSource(hostSnapshot([HETZNER], { a: HETZNER.id, b: HETZNER.id }));
    store.getState().attach(thisMac(["a", "b", "c"]));
    store.getState().attach(remote);

    remote.setProjectLink("a", FENCED);
    expect(projectLinkOf(store.getState(), "a")).toBe(FENCED);
    expect(projectLinkOf(store.getState(), "b")).toBe(OPEN_LINK);
    expect(canWriteProject(store.getState(), "a")).toBe(false);
    expect(canWriteProject(store.getState(), "b")).toBe(true);
    expect(canWriteProject(store.getState(), "c")).toBe(true);
    // The chip reads the host's aggregate: the worst of its projects.
    expect(hostOfProject(store.getState(), "b").link).toBe(FENCED);

    remote.setProjectLink("nobody", OFFLINE);
    expect(projectLinkOf(store.getState(), "nobody")).toBe(OPEN_LINK);
  });

  it("keeps the same objects when a change does not touch them", () => {
    const store = createHostConnectionStore();
    const remote = createFakeHostSource(
      hostSnapshot([HETZNER, MINI], { a: HETZNER.id, b: MINI.id }),
    );
    store.getState().attach(remote);
    const { hosts, projects } = store.getState();
    const hetzner = hostOfProject(store.getState(), "a");

    // A new snapshot with the same records and links changes nothing.
    remote.set({ ...remote.getSnapshot() });
    expect(store.getState().hosts).toBe(hosts);
    expect(store.getState().projects).toBe(projects);

    remote.setProjectLink("b", OFFLINE);
    expect(store.getState().hosts).not.toBe(hosts);
    expect(hostOfProject(store.getState(), "a")).toBe(hetzner);
    expect(hostOfProject(store.getState(), "b").link).toBe(OFFLINE);

    // A project dropping out changes the claims, not the hosts.
    const before = store.getState().hosts;
    remote.set({ ...remote.getSnapshot(), projects: { a: remote.getSnapshot().projects.a! } });
    expect(Object.keys(store.getState().projects)).toEqual(["a"]);
    expect(hostOfProject(store.getState(), "a")).toBe(hetzner);
    expect(store.getState().hosts).not.toBe(before);
  });

  it("routes each action to the source that owns the host, and drops one for no host", () => {
    const store = createHostConnectionStore();
    const local = thisMac([]);
    const remote = createFakeHostSource(hostSnapshot([HETZNER], {}));
    store.getState().attach(local);
    store.getState().attach(remote);

    store.getState().retry(HETZNER.id);
    store.getState().updateHost(HETZNER.id, "when-idle");
    store.getState().cancelScheduledUpdate(HETZNER.id);
    store.getState().signIn(HETZNER.id, "anthropic");
    store.getState().retry("nobody");

    expect(remote.calls).toEqual([
      { kind: "retry", hostId: HETZNER.id },
      { kind: "updateHost", hostId: HETZNER.id, when: "when-idle" },
      { kind: "cancelScheduledUpdate", hostId: HETZNER.id },
      { kind: "signIn", hostId: HETZNER.id, providerId: "anthropic" },
    ]);
    expect(local.calls).toEqual([]);
  });

  it("holds the entry points VC-700 registers, one at a time", () => {
    const store = createHostConnectionStore();
    expect(store.getState().entryPoints).toEqual({ addHost: null, manageHosts: null });
    const addHost = vi.fn();
    store.getState().setEntryPoints({ addHost });
    expect(store.getState().entryPoints).toEqual({ addHost, manageHosts: null });
  });
});

describe("aggregateLink", () => {
  const RECONNECTING: HostLinkView = { status: "reconnecting" };
  const CONNECTING: HostLinkView = { status: "connecting" };
  const SKEWED: HostLinkView = { status: "version-skewed", availableVersion: "0.3.0" };
  const OLDER_OUTAGE: HostLinkView = { status: "offline", since: 50, retryAt: null };
  const TOO_OLD: HostLinkView = { status: "incompatible", reason: "host-too-old" };
  const DATABASE: HostLinkView = { status: "incompatible", reason: "database-too-new" };

  it("reads open for a host serving nothing, or only open projects", () => {
    expect(aggregateLink([])).toBe(OPEN_LINK);
    expect(aggregateLink([{ status: "open" }])).toBe(OPEN_LINK);
  });

  it("answers the worst link, as the very object a project holds", () => {
    expect(aggregateLink([OPEN_LINK, SKEWED])).toBe(SKEWED);
    expect(aggregateLink([SKEWED, CONNECTING])).toBe(CONNECTING);
    expect(aggregateLink([CONNECTING, RECONNECTING])).toBe(RECONNECTING);
    expect(aggregateLink([RECONNECTING, OFFLINE, OLDER_OUTAGE])).toBe(OLDER_OUTAGE);
    expect(aggregateLink([OFFLINE, TOO_OLD])).toBe(TOO_OLD);
    expect(aggregateLink([TOO_OLD, FENCED, DATABASE])).toBe(DATABASE);
    expect(aggregateLink([FENCED, TOO_OLD])).toBe(FENCED);
  });

  it("never reads a host as this Mac's own link cap: the projects past it are their own", () => {
    const OVER: HostLinkView = { status: "incompatible", reason: "too-many-projects" };
    expect(aggregateLink([OVER])).toBe(OPEN_LINK);
    expect(aggregateLink([OVER, SKEWED, OVER])).toBe(SKEWED);
    expect(aggregateLink([OFFLINE, OVER])).toBe(OFFLINE);
  });
});

describe("isBlocking", () => {
  const cases: [HostLinkView, boolean][] = [
    [{ status: "connecting" }, false],
    [{ status: "open" }, false],
    [{ status: "reconnecting" }, false],
    [{ status: "version-skewed", availableVersion: "0.3.0" }, false],
    [{ status: "offline", since: 0, retryAt: null }, true],
    [{ status: "incompatible", reason: "database-too-new" }, true],
  ];
  it.each(cases)("%j blocks: %s", (link, blocking) => {
    expect(isBlocking(link)).toBe(blocking);
  });
});

describe("hostLinkView", () => {
  const welcome = {} as HostWelcome;
  const base: HostLinkContext = { everReady: true, droppedAt: 1_000, now: 2_000 };
  const unreachable: HostLinkState = {
    status: "unreachable",
    attempt: 2,
    error: hostError("host-unreachable", "gone"),
    closeCode: 1006,
    retryAt: 9_000,
  };

  it("reads ready as open, or version-skewed when a compatible update waits", () => {
    expect(hostLinkView({ status: "ready", welcome }, base)).toEqual({ status: "open" });
    expect(hostLinkView({ status: "ready", welcome }, { ...base, availableUpdate: null })).toEqual({
      status: "open",
    });
    expect(
      hostLinkView({ status: "ready", welcome }, { ...base, availableUpdate: "0.3.0" }),
    ).toEqual({ status: "version-skewed", availableVersion: "0.3.0" });
  });

  it("reads a first attempt as connecting and a retry inside the grace as reconnecting", () => {
    const first: HostLinkState = { status: "connecting", attempt: 0 };
    expect(hostLinkView(first, { ...base, everReady: false, droppedAt: null })).toEqual({
      status: "connecting",
    });
    expect(hostLinkView(first, base)).toEqual({ status: "reconnecting" });
    expect(hostLinkView(first, { ...base, droppedAt: null })).toEqual({
      status: "reconnecting",
    });
  });

  it("keeps an outage offline through a retry's handshake, past five seconds (B3)", () => {
    const retrying: HostLinkState = { status: "connecting", attempt: 3 };
    const offlineAt = 1_000 + HOST_OFFLINE_AFTER_MS;
    expect(hostLinkView(unreachable, { ...base, now: offlineAt })).toEqual({
      status: "offline",
      since: 1_000,
      retryAt: 9_000,
    });
    // The retry starts a millisecond later: still offline, its countdown at "Retrying".
    expect(hostLinkView(retrying, { ...base, now: offlineAt + 1 })).toEqual({
      status: "offline",
      since: 1_000,
      retryAt: offlineAt + 1,
    });
    // A never-served link that already failed once stays offline while it retries.
    expect(hostLinkView(retrying, { everReady: false, droppedAt: 1_000, now: 1_001 })).toEqual({
      status: "offline",
      since: 1_000,
      retryAt: 1_001,
    });
  });

  it("reads a fresh drop as reconnecting, and offline once the grace has passed", () => {
    expect(hostLinkView(unreachable, base)).toEqual({ status: "reconnecting" });
    expect(hostLinkView(unreachable, { ...base, now: 1_000 + HOST_OFFLINE_AFTER_MS })).toEqual({
      status: "offline",
      since: 1_000,
      retryAt: 9_000,
    });
    // Never served: unreachable is offline at once, since now.
    expect(hostLinkView(unreachable, { everReady: false, droppedAt: null, now: 5 })).toEqual({
      status: "offline",
      since: 5,
      retryAt: 9_000,
    });
  });

  it("reads a refused protocol as the side that is behind, and any other refusal as refused", () => {
    const tooOld: HostLinkState = {
      status: "refused",
      error: hostError("protocol-version-unsupported", "no"),
      closeCode: 4400,
    };
    expect(hostLinkView(tooOld, base)).toEqual({ status: "incompatible", reason: "host-too-old" });
    expect(hostLinkView(tooOld, { ...base, requiredVersion: "0.3.0" })).toEqual({
      status: "incompatible",
      reason: "host-too-old",
      requiredVersion: "0.3.0",
    });
    expect(hostLinkView(tooOld, { ...base, hostIsNewer: true })).toEqual({
      status: "incompatible",
      reason: "host-too-new",
    });
    expect(
      hostLinkView(
        { status: "refused", error: hostError("credential-invalid", "no"), closeCode: 4401 },
        base,
      ),
    ).toEqual({ status: "incompatible", reason: "refused" });
    // Desktop main's own refusal past its link cap (VC-700), never a host's.
    expect(
      hostLinkView(
        {
          status: "refused",
          error: hostError("too-many-projects" as never, "Too many projects open on box"),
          closeCode: null,
        },
        base,
      ),
    ).toEqual({ status: "incompatible", reason: "too-many-projects" });
  });

  it("reads a fence as fenced and a closed link as offline with no retry", () => {
    expect(
      hostLinkView({ status: "fenced", error: hostError("workspace-split-brain", "two") }, base),
    ).toEqual({ status: "incompatible", reason: "fenced" });
    expect(hostLinkView({ status: "closed" }, base)).toEqual({
      status: "offline",
      since: 1_000,
      retryAt: null,
    });
    expect(hostLinkView({ status: "closed" }, { ...base, droppedAt: null })).toEqual({
      status: "offline",
      since: 2_000,
      retryAt: null,
    });
  });
});

describe("hostLinkViewChangesAt", () => {
  const context: HostLinkContext = { everReady: true, droppedAt: 1_000, now: 2_000 };
  const retrying: HostLinkState = { status: "connecting", attempt: 1 };

  it("asks for a remap when a quiet outage's grace ends", () => {
    expect(hostLinkViewChangesAt(retrying, context)).toBe(1_000 + HOST_OFFLINE_AFTER_MS);
  });

  it("asks for nothing once offline, before any drop, for a never-served link, or while served", () => {
    expect(hostLinkViewChangesAt(retrying, { ...context, now: 9_000 })).toBeNull();
    expect(hostLinkViewChangesAt(retrying, { ...context, droppedAt: null })).toBeNull();
    expect(hostLinkViewChangesAt(retrying, { ...context, everReady: false })).toBeNull();
    expect(hostLinkViewChangesAt({ status: "closed" }, context)).toBeNull();
  });
});

function gone(attempt: number, retryAt: number): HostLinkState {
  return {
    status: "unreachable",
    attempt,
    error: hostError("host-unreachable", "gone"),
    closeCode: 1006,
    retryAt,
  };
}

function connecting(attempt: number): HostLinkState {
  return { status: "connecting", attempt };
}

describe("createHostLinkTracker", () => {
  const welcome = {} as HostWelcome;
  const ready: HostLinkState = { status: "ready", welcome };

  it("stays offline through a multi-retry outage until the link is ready again", () => {
    const tracker = createHostLinkTracker();
    expect(tracker.view(connecting(0), 0)).toEqual({
      link: { status: "connecting" },
      recheckAt: null,
    });
    expect(tracker.view(ready, 10).link).toEqual({ status: "open" });

    // Dropped at 1 000; the backoff retries inside the grace read reconnecting.
    expect(tracker.view(gone(1, 1_250), 1_000)).toEqual({
      link: { status: "reconnecting" },
      recheckAt: 1_000 + HOST_OFFLINE_AFTER_MS,
    });
    expect(tracker.view(connecting(1), 1_250).link).toEqual({ status: "reconnecting" });
    // A handshake stalls across the five seconds: the timer it asked for flips it.
    expect(tracker.view(connecting(1), 6_000).link).toEqual({
      status: "offline",
      since: 1_000,
      retryAt: 6_000,
    });
    // Every later attempt and failure stays offline, the outage still dated 1 000.
    const seen: HostLinkView[] = [];
    let now = 6_000;
    for (let attempt = 2; attempt < 8; attempt++) {
      now += 2_000;
      seen.push(tracker.view(gone(attempt, now + 4_000), now).link);
      now += 4_000;
      seen.push(tracker.view(connecting(attempt), now).link);
    }
    expect(seen.every((link) => link.status === "offline" && link.since === 1_000)).toBe(true);
    expect(seen.every(isBlocking)).toBe(true);

    expect(tracker.view(ready, now + 1).link).toEqual({ status: "open" });
    // The next drop is a new outage, with a fresh grace.
    expect(tracker.view(connecting(0), now + 2).link).toEqual({ status: "reconnecting" });
  });

  it("dates a never-served link's outage from its first failure", () => {
    const tracker = createHostLinkTracker();
    expect(tracker.view(gone(1, 500), 100).link).toEqual({
      status: "offline",
      since: 100,
      retryAt: 500,
    });
    expect(tracker.view(connecting(1), 500).link).toEqual({
      status: "offline",
      since: 100,
      retryAt: 500,
    });
  });

  it("keeps the same object while the view says the same, and passes the version facts", () => {
    const tracker = createHostLinkTracker();
    const first = tracker.view(ready, 0, { availableUpdate: "0.3.0" }).link;
    expect(first).toEqual({ status: "version-skewed", availableVersion: "0.3.0" });
    expect(tracker.view(ready, 1, { availableUpdate: "0.3.0" }).link).toBe(first);
    expect(tracker.view(ready, 2).link).toEqual({ status: "open" });
  });
});

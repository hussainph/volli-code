import { describe, expect, it, vi } from "vite-plus/test";
import type { HostLinkState } from "@volli/host-protocol/client-link";
import { hostError, type HostWelcome } from "@volli/host-protocol";

import {
  createHostConnectionStore,
  HOST_OFFLINE_AFTER_MS,
  hostLinkView,
  hostOfProject,
  isBlocking,
  projectCounts,
  THIS_MAC_HOST,
  THIS_MAC_HOST_ID,
  type HostLinkContext,
  type HostLinkView,
} from "./host-connection";
import { createFakeHostSource, remoteHost } from "./host-sources";

const HETZNER = remoteHost("host-1", "hetzner-1");
const MINI = remoteHost("host-2", "mac-mini", { os: "macos" });

function thisMac(projects: readonly string[]) {
  return createFakeHostSource({
    hosts: [THIS_MAC_HOST],
    projects: Object.fromEntries(projects.map((id) => [id, THIS_MAC_HOST_ID])),
  });
}

describe("host-connection store", () => {
  it("starts empty and answers This Mac for any project", () => {
    const store = createHostConnectionStore();
    expect(store.getState().hosts).toEqual([]);
    expect(hostOfProject(store.getState(), "p1")).toBe(THIS_MAC_HOST);
    expect(hostOfProject(store.getState(), null)).toBe(THIS_MAC_HOST);
  });

  it("merges N sources: This Mac first, then each source's hosts in order", () => {
    const store = createHostConnectionStore();
    const remote = createFakeHostSource({
      hosts: [HETZNER, MINI],
      projects: { p2: HETZNER.id, p3: MINI.id },
    });
    store.getState().attach(remote);
    store.getState().attach(thisMac(["p1", "p2", "p3"]));

    expect(store.getState().hosts.map((host) => host.name)).toEqual([
      "This Mac",
      "hetzner-1",
      "mac-mini",
    ]);
    // A remote claim outranks This Mac's, whichever attached first.
    expect(store.getState().projectHosts).toEqual({
      p1: THIS_MAC_HOST_ID,
      p2: HETZNER.id,
      p3: MINI.id,
    });
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
    store
      .getState()
      .attach(createFakeHostSource({ hosts: [HETZNER], projects: { p1: HETZNER.id } }));
    store.getState().attach(
      createFakeHostSource({
        hosts: [MINI, { ...HETZNER, name: "impostor" }],
        // The second claim stands down, and so does a claim for a host this
        // source does not own.
        projects: { p1: MINI.id, p9: HETZNER.id },
      }),
    );
    expect(store.getState().hosts.map((host) => host.name)).toEqual([
      "This Mac",
      "hetzner-1",
      "mac-mini",
    ]);
    expect(store.getState().projectHosts).toEqual({ p1: HETZNER.id });
  });

  it("follows a source's changes, and forgets it once detached (twice is harmless)", () => {
    const store = createHostConnectionStore();
    const remote = createFakeHostSource({ hosts: [HETZNER], projects: { p1: HETZNER.id } });
    const detach = store.getState().attach(remote);

    remote.setHost(HETZNER.id, { link: { status: "reconnecting" } });
    expect(hostOfProject(store.getState(), "p1").link).toEqual({ status: "reconnecting" });

    detach();
    detach();
    expect(store.getState().hosts).toEqual([]);
    remote.setHost(HETZNER.id, { link: { status: "open" } });
    expect(store.getState().hosts).toEqual([]);
  });

  it("falls back to the merged This Mac record when a claimed host is gone", () => {
    const store = createHostConnectionStore();
    const local = thisMac([]);
    store.getState().attach(local);
    expect(
      hostOfProject({ hosts: store.getState().hosts, projectHosts: { p1: "gone" } }, "p1"),
    ).toBe(THIS_MAC_HOST);
  });

  it("routes each action to the source that owns the host, and drops one for no host", () => {
    const store = createHostConnectionStore();
    const local = thisMac([]);
    const remote = createFakeHostSource({ hosts: [HETZNER], projects: {} });
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

  it("reads a first attempt as connecting and a later one as reconnecting", () => {
    const connecting: HostLinkState = { status: "connecting", attempt: 0 };
    expect(hostLinkView(connecting, { ...base, everReady: false })).toEqual({
      status: "connecting",
    });
    expect(hostLinkView(connecting, base)).toEqual({ status: "reconnecting" });
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

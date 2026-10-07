import { describe, expect, it, vi } from "vite-plus/test";
import { create } from "zustand";

import { createExperimentsStore } from "./experiments";
import {
  createHostConnectionStore,
  OPEN_LINK,
  THIS_MAC_HOST,
  type HostRecord,
  THIS_MAC_HOST_ID,
} from "./host-connection";
import {
  attachThisMacWhileCloud,
  createFakeHostSource,
  createThisMacSource,
  hostSnapshot,
  remoteHost,
} from "./host-sources";

const LOCAL = { hostId: THIS_MAC_HOST_ID, link: OPEN_LINK };

function projectList(ids: readonly string[]) {
  return create<{ projects: readonly { id: string }[]; other: number }>()(() => ({
    projects: ids.map((id) => ({ id })),
    other: 0,
  }));
}

describe("This Mac source", () => {
  it("is one open, local host serving every listed project", () => {
    const source = createThisMacSource(projectList(["a", "b"]));
    expect(source.getSnapshot()).toEqual({
      hosts: [THIS_MAC_HOST],
      projects: { a: LOCAL, b: LOCAL },
    });
    expect(THIS_MAC_HOST.link).toEqual({ status: "open" });
  });

  it("announces a new snapshot only when the project list changes", () => {
    const projects = projectList(["a"]);
    const source = createThisMacSource(projects);
    const listener = vi.fn();
    const unsubscribe = source.subscribe(listener);
    const first = source.getSnapshot();

    projects.setState({ other: 1 });
    expect(listener).not.toHaveBeenCalled();
    expect(source.getSnapshot()).toBe(first);

    projects.setState({ projects: [{ id: "b" }] });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(source.getSnapshot().projects).toEqual({ b: LOCAL });

    projects.setState({ projects: [{ id: "b" }, { id: "c" }] });
    expect(listener).toHaveBeenCalledTimes(2);

    unsubscribe();
    projects.setState({ projects: [] });
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("has nothing to retry, update or sign in to", () => {
    const source = createThisMacSource(projectList([]));
    expect(() => {
      source.retry(THIS_MAC_HOST_ID);
      source.updateHost(THIS_MAC_HOST_ID, "now");
      source.cancelScheduledUpdate(THIS_MAC_HOST_ID);
      source.signIn(THIS_MAC_HOST_ID, "anthropic");
    }).not.toThrow();
  });

  it("reads the app's projects store by default", () => {
    expect(createThisMacSource().getSnapshot().hosts).toEqual([THIS_MAC_HOST]);
  });
});

function cloud(enabled: boolean) {
  return { cloud: { enabled, source: "storage" as const } };
}

describe("This Mac while cloud is on", () => {
  it("attaches nothing with cloud off, and creates no source", () => {
    const experiments = createExperimentsStore(async () => cloud(false));
    const hosts = createHostConnectionStore();
    const createSource = vi.fn(() => createThisMacSource(projectList(["a"])));
    const stop = attachThisMacWhileCloud({ experiments, hosts, createSource });

    expect(createSource).not.toHaveBeenCalled();
    experiments.getState().receive(cloud(false));
    expect(createSource).not.toHaveBeenCalled();
    expect(hosts.getState().hosts).toEqual([]);
    stop();
  });

  it("attaches once cloud turns on, detaches when it turns off, and stops cleanly", () => {
    const experiments = createExperimentsStore(async () => cloud(false));
    const hosts = createHostConnectionStore();
    const projects = projectList(["a"]);
    const subscribe = vi.spyOn(projects, "subscribe");
    const stop = attachThisMacWhileCloud({
      experiments,
      hosts,
      createSource: () => createThisMacSource(projects),
    });
    expect(subscribe).not.toHaveBeenCalled();

    experiments.getState().receive(cloud(true));
    expect(hosts.getState().hosts).toEqual([THIS_MAC_HOST]);
    expect(subscribe).toHaveBeenCalledTimes(1);
    // A second on-snapshot does not attach twice.
    experiments.getState().receive(cloud(true));
    expect(subscribe).toHaveBeenCalledTimes(1);

    experiments.getState().receive(cloud(false));
    expect(hosts.getState().hosts).toEqual([]);

    experiments.getState().receive(cloud(true));
    expect(hosts.getState().hosts).toEqual([THIS_MAC_HOST]);
    stop();
    expect(hosts.getState().hosts).toEqual([]);
    experiments.getState().receive(cloud(true));
    expect(hosts.getState().hosts).toEqual([]);
    stop();
  });

  it("attaches at once when cloud is already on, and binds the app's stores by default", () => {
    const experiments = createExperimentsStore(async () => cloud(true));
    experiments.getState().receive(cloud(true));
    const hosts = createHostConnectionStore();
    const stop = attachThisMacWhileCloud({ experiments, hosts });
    expect(hosts.getState().hosts).toEqual([THIS_MAC_HOST]);
    stop();
    attachThisMacWhileCloud()();
  });
});

describe("fake host source", () => {
  it("holds what it is given, patches one host, and tells its listeners", () => {
    const host = remoteHost("h", "hetzner-1");
    const source = createFakeHostSource(
      hostSnapshot([host, remoteHost("m", "mac-mini")], { p: "h", q: "h", r: "m", s: "gone" }),
    );
    expect(source.getSnapshot().projects.s).toEqual({ hostId: "gone", link: OPEN_LINK });
    const listener = vi.fn();
    const unsubscribe = source.subscribe(listener);

    // A host-wide link reaches every project the host serves.
    source.setHost("h", { link: { status: "reconnecting" } });
    expect((source.getSnapshot().hosts[0] as HostRecord | undefined)?.link).toEqual({
      status: "reconnecting",
    });
    expect(source.getSnapshot().projects.p?.link).toEqual({ status: "reconnecting" });
    expect(source.getSnapshot().projects.q?.link).toEqual({ status: "reconnecting" });
    expect(source.getSnapshot().projects.r?.link).toEqual({ status: "open" });
    // A patch without a link leaves the projects alone.
    const projects = source.getSnapshot().projects;
    source.setHost("m", { version: "0.2.4" });
    expect(source.getSnapshot().projects).toBe(projects);

    // One project alone.
    source.setProjectLink("q", { status: "incompatible", reason: "fenced" });
    expect(source.getSnapshot().projects.q).toEqual({
      hostId: "h",
      link: { status: "incompatible", reason: "fenced" },
    });
    expect(source.getSnapshot().projects.p?.link).toEqual({ status: "reconnecting" });
    expect(listener).toHaveBeenCalledTimes(3);
    source.setProjectLink("nobody", OPEN_LINK);
    expect(listener).toHaveBeenCalledTimes(3);

    source.set({ hosts: [], projects: { p: { hostId: "h", link: OPEN_LINK } } });
    expect(listener).toHaveBeenCalledTimes(4);

    source.setHost("nobody", { name: "ghost" });
    expect(source.getSnapshot().hosts).toEqual([]);
    expect(listener).toHaveBeenCalledTimes(4);

    unsubscribe();
    source.set({ hosts: [], projects: {} });
    expect(listener).toHaveBeenCalledTimes(4);
  });

  it("records every action and hands it to onCall", () => {
    const onCall = vi.fn();
    const source = createFakeHostSource({ hosts: [], projects: {} }, onCall);
    source.retry("h");
    source.updateHost("h", "now");
    source.cancelScheduledUpdate("h");
    source.signIn("h", "openai");
    expect(source.calls).toHaveLength(4);
    expect(onCall).toHaveBeenNthCalledWith(1, { kind: "retry", hostId: "h" }, source);
    expect(onCall).toHaveBeenLastCalledWith(
      { kind: "signIn", hostId: "h", providerId: "openai" },
      source,
    );
  });

  it("works without onCall", () => {
    const source = createFakeHostSource({ hosts: [], projects: {} });
    source.retry("h");
    expect(source.calls).toEqual([{ kind: "retry", hostId: "h" }]);
  });

  it("fills a remote host's every field, with overrides", () => {
    expect(remoteHost("h", "box", { version: "0.2.4" })).toEqual({
      id: "h",
      name: "box",
      local: false,
      os: "linux",
      version: "0.2.4",
      link: { status: "open" },
      liveSessions: null,
      update: null,
      expiredSignIns: [],
    });
  });
});

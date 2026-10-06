import { describe, expect, it, vi } from "vite-plus/test";
import { create } from "zustand";

import { THIS_MAC_HOST, THIS_MAC_HOST_ID } from "./host-connection";
import { createFakeHostSource, createThisMacSource, remoteHost } from "./host-sources";

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
      projects: { a: THIS_MAC_HOST_ID, b: THIS_MAC_HOST_ID },
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
    expect(source.getSnapshot().projects).toEqual({ b: THIS_MAC_HOST_ID });

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

describe("fake host source", () => {
  it("holds what it is given, patches one host, and tells its listeners", () => {
    const host = remoteHost("h", "hetzner-1");
    const source = createFakeHostSource({
      hosts: [host, remoteHost("m", "mac-mini")],
      projects: {},
    });
    const listener = vi.fn();
    const unsubscribe = source.subscribe(listener);

    source.setHost("h", { link: { status: "reconnecting" } });
    expect(source.getSnapshot().hosts[0]?.link).toEqual({ status: "reconnecting" });
    expect(source.getSnapshot().hosts[1]?.link).toEqual({ status: "open" });

    source.set({ hosts: [], projects: { p: "h" } });
    expect(source.getSnapshot()).toEqual({ hosts: [], projects: { p: "h" } });
    expect(listener).toHaveBeenCalledTimes(2);

    source.setHost("nobody", { name: "ghost" });
    expect(source.getSnapshot().hosts).toEqual([]);

    unsubscribe();
    source.set({ hosts: [], projects: {} });
    expect(listener).toHaveBeenCalledTimes(3);
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

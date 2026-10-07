/**
 * The remote hosts store and its API over the desktop-only tier (VC-700 PR 3):
 * each call maps to its procedure with exactly its input, the store holds the
 * registry's hosts and the sheet's state, and the bridge's API is made once
 * and swappable. The bridge is a stand-in: no IPC.
 */
import type { AddHostEvent } from "@volli/shared";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

const bridge = vi.hoisted(() => {
  const calls: unknown[][] = [];
  const handlers: { onData(event: unknown): void; onError(error: unknown): void }[] = [];
  const unsubscribe = vi.fn();
  const record =
    (path: string, answer: unknown = null) =>
    async (input: unknown) => {
      calls.push([path, input]);
      return answer;
    };
  return {
    calls,
    handlers,
    unsubscribe,
    client: {
      hosts: {
        rename: { mutate: record("hosts.rename") },
        forget: { mutate: record("hosts.forget") },
        devices: { query: record("hosts.devices", { hostId: "h", devices: [] }) },
        projects: { query: record("hosts.projects", { hostId: "h", projects: [] }) },
        createProject: { mutate: record("hosts.createProject", { ok: true }) },
        openWorkspace: { mutate: record("hosts.openWorkspace") },
        closeWorkspace: { mutate: record("hosts.closeWorkspace") },
      },
      hostAdd: {
        active: { query: record("hostAdd.active", []) },
        start: { mutate: record("hostAdd.start", { flowId: "flow-1" }) },
        subscribe: {
          subscribe(
            input: unknown,
            handler: { onData(event: unknown): void; onError(error: unknown): void },
          ) {
            calls.push(["hostAdd.subscribe", input]);
            handlers.push(handler);
            return { unsubscribe };
          },
        },
        answer: { mutate: record("hostAdd.answer") },
        sudoPassword: { mutate: record("hostAdd.sudoPassword") },
        retry: { mutate: record("hostAdd.retry") },
        cancel: { mutate: record("hostAdd.cancel") },
        facts: { query: record("hostAdd.facts", { user: "deploy" }) },
      },
    },
  };
});

vi.mock("../lib/session-rpc-ipc-link", () => ({ sessionRpcClient: () => bridge.client }));

import {
  createRemoteHostsStore,
  remoteHostOf,
  remoteHosts,
  setRemoteHostsApi,
} from "./remote-hosts";
import {
  createFakeRemoteHostsApi,
  flowView,
  NO_FACTS,
  registryHost,
} from "./remote-hosts.test-support";

const LINE = { at: "t", level: "info", message: "m", fields: {} } as const;

afterEach(() => {
  setRemoteHostsApi(null);
  bridge.calls.length = 0;
});

describe("the remote hosts API over the tier", () => {
  it("sends each call to its procedure with exactly its input, made once", async () => {
    const api = remoteHosts();
    expect(remoteHosts()).toBe(api);
    expect(await api.activeAdds()).toEqual([]);
    expect(await api.startAdd({ target: "deploy@box" })).toEqual({ flowId: "flow-1" });
    await api.answerAdd("flow-1", "q1", { kind: "accept-host-key" });
    await api.sudoPassword("flow-1", "q2", "pw");
    await api.retryAdd("flow-1");
    await api.retryAdd("flow-1", "probe");
    await api.cancelAdd("flow-1");
    await api.rename("h", "Build box");
    await api.forget("h");
    expect(await api.devices("h")).toEqual({ hostId: "h", devices: [] });
    expect(await api.addFacts("flow-1")).toEqual({ user: "deploy" });
    expect(await api.projects("h")).toEqual({ hostId: "h", projects: [] });
    expect(await api.createProject({ hostId: "h", gitUrl: "u" })).toEqual({ ok: true });
    await api.openWorkspace("h", "w");
    await api.closeWorkspace("h", "w");
    expect(bridge.calls).toEqual([
      ["hostAdd.active", undefined],
      ["hostAdd.start", { target: "deploy@box" }],
      [
        "hostAdd.answer",
        { flowId: "flow-1", questionId: "q1", answer: { kind: "accept-host-key" } },
      ],
      ["hostAdd.sudoPassword", { flowId: "flow-1", questionId: "q2", password: "pw" }],
      ["hostAdd.retry", { flowId: "flow-1" }],
      ["hostAdd.retry", { flowId: "flow-1", from: "probe" }],
      ["hostAdd.cancel", { flowId: "flow-1" }],
      ["hosts.rename", { hostId: "h", name: "Build box" }],
      ["hosts.forget", { hostId: "h" }],
      ["hosts.devices", { hostId: "h" }],
      ["hostAdd.facts", { flowId: "flow-1" }],
      ["hosts.projects", { hostId: "h" }],
      ["hosts.createProject", { hostId: "h", gitUrl: "u" }],
      ["hosts.openWorkspace", { hostId: "h", workspaceId: "w" }],
      ["hosts.closeWorkspace", { hostId: "h", workspaceId: "w" }],
    ]);
  });

  it("follows a flow's events, and its end, until unsubscribed", () => {
    const events: AddHostEvent[] = [];
    const errors: unknown[] = [];
    const stop = remoteHosts().subscribeAdd("flow-1", {
      onEvent: (event) => events.push(event),
      onError: (error) => errors.push(error),
    });
    expect(bridge.calls.at(-1)).toEqual(["hostAdd.subscribe", { flowId: "flow-1" }]);
    const event = {
      kind: "log",
      flowId: "flow-1",
      line: { at: "t", level: "info", message: "m", fields: {} },
    };
    bridge.handlers.at(-1)!.onData(event);
    bridge.handlers.at(-1)!.onError(new Error("gone"));
    expect(events).toEqual([event]);
    expect(errors).toHaveLength(1);
    stop();
    expect(bridge.unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("is swappable, and swapped back to the bridge's", () => {
    const fake = createFakeRemoteHostsApi();
    setRemoteHostsApi(fake);
    expect(remoteHosts()).toBe(fake);
    setRemoteHostsApi(null);
    expect(remoteHosts()).not.toBe(fake);
  });
});

describe("the remote hosts store", () => {
  it("holds the registry's hosts and why they cannot change, and the sheet's state", () => {
    const store = createRemoteHostsStore();
    const host = registryHost();
    store.getState().setHosts([host], "read-only");
    expect(store.getState()).toMatchObject({ hosts: [host], readOnly: "read-only" });
    store.getState().setHosts([]);
    expect(store.getState().hosts).toEqual([]);
    expect(store.getState().readOnly).toBeNull();
    // No hosts is always the one frozen empty list: readers do not redraw for it.
    const none = store.getState().hosts;
    store.getState().setHosts([]);
    expect(store.getState().hosts).toBe(none);
    store.getState().openAddHost("deploy@box");
    expect(store.getState().addHost).toEqual({ open: true, target: "deploy@box" });
    store.getState().closeAddHost();
    expect(store.getState().addHost).toEqual({ open: false, target: "deploy@box" });
    store.getState().openAddHost();
    expect(store.getState().addHost).toEqual({ open: true, target: "" });
    // "Open a project on <host>…" (VC-710): it keeps its host while it fades out.
    expect(store.getState().openProject).toEqual({
      open: false,
      hostId: null,
      start: "list",
      opening: 0,
    });
    store.getState().openProjectSheet("h");
    expect(store.getState().openProject).toEqual({
      open: true,
      hostId: "h",
      start: "list",
      opening: 1,
    });
    store.getState().closeProjectSheet();
    expect(store.getState().openProject).toMatchObject({ open: false, hostId: "h", opening: 1 });
    // Each opening is a new one, the same host's again or another's while open.
    store.getState().openProjectSheet("h", "new");
    store.getState().openProjectSheet("g");
    expect(store.getState().openProject).toEqual({
      open: true,
      hostId: "g",
      start: "list",
      opening: 3,
    });
  });

  it("finds one host's record, or none for This Mac", () => {
    const host = registryHost();
    expect(remoteHostOf([host], host.id)).toBe(host);
    expect(remoteHostOf([host], null)).toBeUndefined();
    expect(remoteHostOf([host], "other")).toBeUndefined();
  });
});

describe("the scripted fake", () => {
  it("answers a host's projects and a create as set, else none and made (VC-710)", async () => {
    const fake = createFakeRemoteHostsApi();
    expect(await fake.projects("h")).toEqual({
      hostId: "h",
      projects: [],
      adds: { kind: "ready" },
    });
    fake.projectsOf.set("h", new Error("unreachable"));
    await expect(fake.projects("h")).rejects.toThrow("unreachable");
    expect(await fake.createProject({ hostId: "h", path: "/a" })).toMatchObject({
      ok: true,
      project: { name: "Acme" },
    });
    fake.nextCreate = new Error("lost");
    await expect(fake.createProject({ hostId: "h", path: "/a" })).rejects.toThrow("lost");
    await fake.openWorkspace("h", "w");
    fake.refuseNext("closeWorkspace", "no");
    await expect(fake.closeWorkspace("h", "w")).rejects.toThrow("no");
  });

  it("tolerates events and ends for a flow nobody follows", () => {
    const fake = createFakeRemoteHostsApi();
    expect(fake.following("flow-9")).toBe(false);
    expect(() => fake.emit("flow-9", { kind: "view", view: flowView() })).not.toThrow();
    expect(() => fake.fail("flow-9")).not.toThrow();
  });

  it("answers a flow's facts: as set, else the last view's that carried some, else none", async () => {
    const fake = createFakeRemoteHostsApi();
    expect(await fake.addFacts("flow-1")).toBe(NO_FACTS);
    const facts = { ...NO_FACTS, user: "deploy" };
    fake.emit("flow-1", { kind: "replay", view: flowView({ facts }), log: [], omitted: 0 });
    // A view as main sends it, without facts, leaves the last ones.
    const { facts: _none, ...bare } = flowView();
    fake.emit("flow-1", { kind: "view", view: bare });
    fake.emit("flow-1", { kind: "log", flowId: "flow-1", line: LINE });
    expect(await fake.addFacts("flow-1")).toBe(facts);
    fake.factsOf.set("flow-1", new Error("let go"));
    await expect(fake.addFacts("flow-1")).rejects.toThrow("let go");
  });
});

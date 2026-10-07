import type { HostWorkspaceCreateInput } from "@volli/shared";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  createProjectOnHost,
  hostWorkspacesApi,
  projectsOnHost,
  setHostWorkspacesApi,
  setRemoteHostsApi,
  usesLegacyProjects,
} from "./remote-hosts";
import { relayHostScope } from "../lib/relay-host-scope";
vi.mock("../lib/relay-host-scope", () => ({ relayHostScope: vi.fn() }));

import { createFakeRemoteHostsApi, registryHost } from "./remote-hosts.test-support";

const COMMAND = "6f1d2c3b-4a5e-4f60-8a7b-9c0d1e2f3a4b";
const ROW = { id: COMMAND, name: "A", path: "/a", gitRemoteUrl: null };
const INPUT: HostWorkspaceCreateInput = { commandId: COMMAND, source: { path: "/a" } };
const modern = (mode: "system" | "user" = "user") =>
  registryHost({ mode, hostScope: { status: "ready", granted: ["host.workspaces"] } });

function fake() {
  const legacy = createFakeRemoteHostsApi();
  const list = vi.fn(async () => ({ workspaces: [ROW], omitted: 2 }));
  const create = vi.fn(async (_input: HostWorkspaceCreateInput) => ({
    ok: true as const,
    workspace: ROW,
  }));
  const factory = vi.fn(() => ({ list, create }));
  setRemoteHostsApi(legacy);
  setHostWorkspacesApi(factory);
  return { legacy, list, create, factory };
}

afterEach(() => {
  setRemoteHostsApi(null);
  setHostWorkspacesApi(null);
});

describe("HOST project catalog routing", () => {
  it.each(["user", "system"] as const)(
    "lists and creates on a modern %s host without SSH, counts, prefix or sudo",
    async (mode) => {
      const f = fake();
      const host = modern(mode);
      expect(await projectsOnHost(host)).toEqual({
        hostId: host.id,
        projects: [ROW],
        omitted: 2,
        adds: { kind: "ready" },
      });
      expect(await createProjectOnHost(host, INPUT, "not-used")).toEqual({
        ok: true,
        project: ROW,
      });
      expect(f.create).toHaveBeenCalledWith(INPUT);
      expect(f.factory).toHaveBeenCalledWith(host.id);
      expect(f.legacy.calls).toEqual([]);
    },
  );

  it.each(["connecting", "unavailable"] as const)(
    "fails %s visibly even if Workspace links exist; never falls back to SSH",
    async (status) => {
      const f = fake();
      const host = { ...modern(), hostScope: { status, granted: ["host.workspaces"] } };
      expect(usesLegacyProjects(host)).toBe(false);
      await expect(projectsOnHost(host)).rejects.toThrow("Try again when it reconnects");
      await expect(createProjectOnHost(host, INPUT)).rejects.toThrow(
        "Try again when it reconnects",
      );
      expect(f.factory).not.toHaveBeenCalled();
      expect(f.legacy.calls).toEqual([]);
    },
  );

  it("refuses missing HOST grants instead of calling SSH", async () => {
    const f = fake();
    const host = { ...modern(), hostScope: { status: "ready" as const, granted: [] } };
    await expect(projectsOnHost(host)).rejects.toThrow("did not grant project access");
    await expect(createProjectOnHost(host, INPUT)).rejects.toThrow("did not grant project access");
    expect(f.factory).not.toHaveBeenCalled();
    expect(f.legacy.calls).toEqual([]);
  });

  it("does not reinterpret an ambiguous modern failure as an older host", async () => {
    const f = fake();
    f.list.mockRejectedValueOnce(new Error("host-unreachable"));
    f.create.mockRejectedValueOnce(new Error("transport-closed: outcome unknown"));
    await expect(projectsOnHost(modern())).rejects.toThrow("host-unreachable");
    await expect(createProjectOnHost(modern(), INPUT)).rejects.toThrow("outcome unknown");
    expect(f.legacy.calls).toEqual([]);
  });

  it.each([
    "invalid-source",
    "path-unreadable",
    "target-exists",
    "clone-failed",
    "clone-timeout",
    "registration-failed",
    "still-running",
    "interrupted",
    "capacity",
  ] as const)("preserves the named HOST refusal %s", async (code) => {
    const f = fake();
    setHostWorkspacesApi(() => ({
      list: f.list,
      create: async () => ({ ok: false, failure: { code, message: code } }),
    }));
    expect(await createProjectOnHost(modern(), INPUT)).toEqual({
      ok: false,
      failure: { code, message: code, command: null },
    });
    expect(f.legacy.calls).toEqual([]);
  });

  it.each([undefined, { status: "older" as const, granted: [] }])(
    "keeps SSH only for genuinely older system hosts (%j)",
    async (hostScope) => {
      const f = fake();
      const host = registryHost({ mode: "system", hostScope });
      expect(usesLegacyProjects(host)).toBe(true);
      await projectsOnHost(host);
      await createProjectOnHost(
        host,
        { ...INPUT, name: "Named", source: { gitUrl: "https://example.test/r.git" } },
        "pw",
      );
      expect(f.legacy.calls).toEqual([
        ["projects", host.id],
        [
          "createProject",
          {
            hostId: host.id,
            gitUrl: "https://example.test/r.git",
            name: "Named",
            sudoPassword: "pw",
          },
        ],
      ]);
      expect(f.factory).not.toHaveBeenCalled();
    },
  );

  it("keeps older user projects readable, but creation requires Re-add", async () => {
    const f = fake();
    const host = registryHost({ mode: "user", hostScope: { status: "older", granted: [] } });
    expect(await projectsOnHost(host)).toMatchObject({ adds: { kind: "user-install" } });
    await expect(createProjectOnHost(host, INPUT)).rejects.toThrow(
      `Update ${host.name} to create projects from here`,
    );
    expect(f.legacy.calls).toEqual([["projects", host.id]]);
    expect(f.factory).not.toHaveBeenCalled();
  });
});

it("uses a typed HostRouter client over the dedicated HOST relay in production", async () => {
  const query = vi.fn(async () => ({ workspaces: [ROW], omitted: 0 }));
  const mutate = vi.fn(async () => ({ ok: true, workspace: ROW }));
  vi.mocked(relayHostScope).mockImplementation((hostId) => ({
    hostId,
    getState: () => ({ status: "open" }),
    subscribeState: () => () => {},
    query,
    mutate,
    subscribe: vi.fn(),
  }));
  const api = hostWorkspacesApi("host-a");
  expect(await api.list()).toEqual({ workspaces: [ROW], omitted: 0 });
  expect(await api.create(INPUT)).toEqual({ ok: true, workspace: ROW });
  expect(relayHostScope).toHaveBeenCalledWith("host-a");
  expect(query).toHaveBeenCalledWith("workspaces.list", undefined, {});
  expect(mutate).toHaveBeenCalledWith("workspaces.create", INPUT, {});
  setHostWorkspacesApi(null);
  expect(await createProjectOnHost(modern(), INPUT)).toEqual({ ok: true, project: ROW });
});

it("sends the minimum old system path input without an optional name or sudo", async () => {
  const f = fake();
  const host = registryHost({ mode: "system" });
  await createProjectOnHost(host, INPUT);
  expect(f.legacy.calls).toEqual([["createProject", { hostId: host.id, path: "/a" }]]);
});

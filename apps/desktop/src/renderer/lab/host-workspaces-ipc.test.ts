// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vite-plus/test";
import { hostWorkspacesApi } from "@renderer/lib/host-workspaces-api";
import { useHostConnectionStore } from "@renderer/stores/host-connection";
import { remoteHost } from "@renderer/stores/host-sources";
import { createHostWorkspacesIpcFixture } from "./host-workspaces-ipc";
import { installFakeApi } from "./fake-api";

const HOST = "6f1d2c3b-4a5e-4f60-8a7b-9c0d1e2f3a4b";
const ROW = { id: HOST, name: "A", path: "/a", gitRemoteUrl: null };
const original = useHostConnectionStore.getState().hosts;
afterEach(() => {
  useHostConnectionStore.setState({ hosts: original });
  installFakeApi();
});

it("runs the production default over lab IPC and restores the fixture on cleanup", async () => {
  const fixture = createHostWorkspacesIpcFixture();
  installFakeApi({ sessionRpc: fixture.bridge });
  useHostConnectionStore.setState({
    hosts: [
      remoteHost(HOST, "box", {
        hostScope: { status: "ready", granted: ["host.workspaces"] },
      }),
    ],
  });
  const list = vi.fn(async () => ({ workspaces: [ROW], omitted: 0 }));
  const create = vi.fn(async () => ({ ok: true as const, workspace: ROW }));
  const cleanup = fixture.connect(HOST, { list, create });
  const api = hostWorkspacesApi(HOST);
  expect(await api.list()).toEqual({ workspaces: [ROW], omitted: 0 });
  const input = { commandId: HOST, source: { path: "/a" } };
  expect(await api.create(input)).toEqual({ ok: true, workspace: ROW });
  expect(create).toHaveBeenCalledWith(input);
  cleanup();
  cleanup();
  await expect(api.list()).rejects.toThrow("No active lab HOST catalog fixture");
  expect(list).toHaveBeenCalledTimes(1);
  const cleanup2 = fixture.connect(HOST, { list, create });
  const foreign = hostWorkspacesApi("other-host");
  await expect(foreign.list()).rejects.toThrow();
  cleanup2();
});

it("refuses non-catalog operations at the lab fixture boundary", async () => {
  const fixture = createHostWorkspacesIpcFixture();
  const cleanup = fixture.connect(HOST, { list: vi.fn(), create: vi.fn() });
  for (const request of [
    {
      type: "query" as const,
      path: "hostScope.query",
      input: { hostId: "unknown", path: "workspaces.list" },
    },
    {
      type: "query" as const,
      path: "hostScope.query",
      input: { hostId: HOST, path: "signIns.list" },
    },
    {
      type: "mutation" as const,
      path: "hostScope.mutate",
      input: { hostId: HOST, path: "workspaces.list" },
    },
    { type: "query" as const, path: "hostScope.query", input: null },
  ]) {
    expect(await fixture.bridge.request(request)).toMatchObject({ ok: false });
  }
  cleanup();
});

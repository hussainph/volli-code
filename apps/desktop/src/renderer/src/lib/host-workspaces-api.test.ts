import { expect, it, vi } from "vite-plus/test";
import type { HostWorkspaceCreateInput } from "@volli/shared";
import { hostWorkspacesApi } from "./host-workspaces-api";
import { relayHostScope } from "./relay-host-scope";
vi.mock("./relay-host-scope", () => ({ relayHostScope: vi.fn() }));

const ROW = {
  id: "6f1d2c3b-4a5e-4f60-8a7b-9c0d1e2f3a4b",
  name: "A",
  path: "/a",
  gitRemoteUrl: null,
};
const INPUT: HostWorkspaceCreateInput = { commandId: ROW.id, source: { path: "/a" } };

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
});

// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";
import { useHostConnectionStore } from "@renderer/stores/host-connection";
import { useRemoteHostsStore } from "@renderer/stores/remote-hosts";
import { useExperimentsStore } from "@renderer/stores/experiments";
import { hostWorkspacesApi } from "@renderer/lib/host-workspaces-api";
import { installFakeApi } from "../fake-api";
import HostOpenProjectScratch, { api } from "./host-open-project";

vi.mock("@renderer/components/hosts/hosts-chrome", () => ({ HostsChrome: () => null }));
vi.mock("@renderer/lib/app-state-storage", () => ({
  appStateStorage: { getItem: () => null, setItem() {}, removeItem() {} },
}));

it("switches scenarios over production HOST IPC and restores stores/catalog on unmount", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers();
  const connectionBefore = useHostConnectionStore.getState().hosts;
  const experimentsBefore = useExperimentsStore.getState().snapshot;
  const element = document.createElement("div");
  const root = createRoot(element);
  installFakeApi(api);
  try {
    await act(async () => root.render(<HostOpenProjectScratch />));
    const select = element.querySelector("select")!;
    await act(async () => {
      select.value = "modern-mac";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    const host = useRemoteHostsStore.getState().hosts[0]!;
    expect(host.hostScope?.status).toBe("ready");
    expect(
      useHostConnectionStore.getState().hosts.filter((record) => record.id === host.id),
    ).toHaveLength(1);
    const catalog = hostWorkspacesApi(host.id);
    const pending = catalog.list();
    await act(async () => vi.runAllTimersAsync());
    expect(await pending).toEqual({ workspaces: [], omitted: 0 });
    await act(async () => root.unmount());
    expect(useHostConnectionStore.getState().hosts).toBe(connectionBefore);
    expect(useExperimentsStore.getState().snapshot).toBe(experimentsBefore);
    expect(useRemoteHostsStore.getState().hosts).toEqual([]);
    await expect(
      api.sessionRpc.request({
        path: "hostScope.query",
        type: "query",
        input: { hostId: host.id, path: "workspaces.list" },
      }),
    ).resolves.toMatchObject({ ok: false });
  } finally {
    await act(async () => root.unmount());
    vi.useRealTimers();
    installFakeApi();
    vi.unstubAllGlobals();
  }
});

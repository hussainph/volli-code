/**
 * The world the host surfaces' tests stand in (VC-576): the app's own stores,
 * the `cloud` flag set through the experiments store, a fake source for This
 * Mac and one for remote hosts, and a jsdom root to render into.
 */
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { vi } from "vite-plus/test";
import type { Project } from "@volli/shared";

import { useExperimentsStore } from "@renderer/stores/experiments";
import {
  THIS_MAC_HOST,
  THIS_MAC_HOST_ID,
  useHostConnectionStore,
  type HostRecord,
} from "@renderer/stores/host-connection";
import {
  createFakeHostSource,
  hostSnapshot,
  remoteHost,
  type FakeHostSource,
} from "@renderer/stores/host-sources";
import { useProjectsStore } from "@renderer/stores/projects";

export const HETZNER_ID = "host-hetzner";
export const MINI_ID = "host-mini";

export function project(id: string, name: string, sortOrder: number): Project {
  return {
    id,
    name,
    path: `/Users/me/${id}`,
    ticketPrefix: "VC",
    colorIndex: 0,
    sortOrder,
    createdAt: 0,
    updatedAt: 0,
  };
}

export interface HostWorld {
  readonly remote: FakeHostSource;
  readonly local: FakeHostSource;
  setHetzner(patch: Partial<Omit<HostRecord, "id">>): void;
  render(node: ReactNode): Promise<HTMLElement>;
  rerender(node: ReactNode): Promise<void>;
  cleanup(): Promise<void>;
}

/**
 * Projects `local` (This Mac), `remote` (hetzner-1) and `spare` (mac-mini).
 * The selected project decides the current host.
 */
export function hostWorld({
  cloud = true,
  selected = "remote",
  hetzner = {},
}: {
  cloud?: boolean;
  selected?: string;
  hetzner?: Partial<Omit<HostRecord, "id" | "name">>;
} = {}): HostWorld {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  useExperimentsStore.setState({
    snapshot: { cloud: { enabled: cloud, source: "storage" } },
  });
  useProjectsStore.setState({
    projects: [
      project("local", "Local", 0),
      project("remote", "Remote", 1),
      project("spare", "Spare", 2),
    ],
    selectedProjectId: selected,
  });
  const local = createFakeHostSource(
    hostSnapshot([THIS_MAC_HOST], {
      local: THIS_MAC_HOST_ID,
      remote: THIS_MAC_HOST_ID,
      spare: THIS_MAC_HOST_ID,
    }),
  );
  const remote = createFakeHostSource(
    hostSnapshot(
      [
        remoteHost(HETZNER_ID, "hetzner-1", hetzner),
        remoteHost(MINI_ID, "mac-mini", {
          os: "macos",
          link: { status: "offline", since: 0, retryAt: null },
        }),
      ],
      { remote: HETZNER_ID, spare: MINI_ID },
    ),
  );
  const detachLocal = useHostConnectionStore.getState().attach(local);
  const detachRemote = useHostConnectionStore.getState().attach(remote);

  let container: HTMLElement | null = null;
  let root: Root | null = null;
  return {
    remote,
    local,
    setHetzner(patch) {
      act(() => remote.setHost(HETZNER_ID, patch));
    },
    async render(node) {
      container = document.createElement("div");
      document.body.append(container);
      root = createRoot(container);
      await act(async () => root?.render(node));
      return container;
    },
    async rerender(node) {
      await act(async () => root?.render(node));
    },
    async cleanup() {
      await act(async () => root?.unmount());
      container?.remove();
      document.querySelectorAll('[data-slot="popover-content"]').forEach((node) => node.remove());
      detachLocal();
      detachRemote();
      useHostConnectionStore.setState({ entryPoints: { addHost: null, manageHosts: null } });
      useExperimentsStore.setState({ snapshot: null });
      vi.unstubAllGlobals();
    },
  };
}

/** Clicks a button by its visible text or accessible name. */
export async function click(scope: ParentNode, name: string): Promise<void> {
  const button = [...scope.querySelectorAll("button")].find(
    (candidate) =>
      candidate.textContent?.trim() === name || candidate.getAttribute("aria-label") === name,
  );
  if (button === undefined) throw new Error(`No button "${name}"`);
  await act(async () => button.click());
}

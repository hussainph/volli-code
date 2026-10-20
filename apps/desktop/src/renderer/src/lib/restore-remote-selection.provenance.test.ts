import { afterEach, expect, it, vi } from "vite-plus/test";
import { useProjectsStore } from "@renderer/stores/projects";
import { useHostConnectionStore } from "@renderer/stores/host-connection";
import { useExperimentsStore } from "@renderer/stores/experiments";
import { createThisMacSource, createFakeHostSource } from "@renderer/stores/host-sources";
import { followRemoteProjects } from "./boot";
import { restoreRemoteSelection } from "./restore-remote-selection";

vi.mock("sonner", () => ({ toast: { error: vi.fn(), warning: vi.fn() } }));

const stops: (() => void)[] = [];
afterEach(() => {
  for (const stop of stops.splice(0).toReversed()) stop();
  useProjectsStore.getState().hydrate([], null);
  useExperimentsStore.setState({ snapshot: null });
  vi.unstubAllGlobals();
});

it.each(["forgotten", "claims withdrawn"])(
  "restore fallback never sends a formerly remote row to local theme IPC: %s",
  async (loss) => {
    const state = vi.fn(async () => ({ ok: false, error: "fixture" }));
    vi.stubGlobal("window", {
      api: {
        theme: { state },
        appState: { set: vi.fn(async () => ({ ok: true })) },
      },
    });
    useExperimentsStore.setState({ snapshot: { cloud: { enabled: true, source: "storage" } } });
    useProjectsStore.setState({
      projects: [],
      selectedProjectId: null,
      pendingRemoteSelection: null,
    });
    useProjectsStore.getState().hydrate([], null); // This Mac has zero local projects.
    const selection = { hostId: "box-id", projectId: "saved-remote", hostName: "box" };
    useProjectsStore.getState().beginRemoteRestore(selection);
    // Production boot order: restore is listening before the board claim follower.
    stops.push(
      restoreRemoteSelection({
        selection,
        hosts: useHostConnectionStore,
        projects: useProjectsStore,
        failed: vi.fn(),
      }),
    );
    stops.push(useHostConnectionStore.getState().attach(createThisMacSource()));
    const remoteSource = createFakeHostSource({
      hosts: [
        {
          id: "box-id",
          name: "box",
          local: false,
          os: "linux",
          version: null,
          link: { status: "open" },
          liveSessions: null,
          update: null,
          expiredSignIns: [],
        },
      ],
      projects: {
        "saved-remote": { hostId: "box-id", link: { status: "connecting" } },
        "other-remote": { hostId: "box-id", link: { status: "open" } },
      },
    });
    stops.push(useHostConnectionStore.getState().attach(remoteSource));
    stops.push(followRemoteProjects({ open: async () => {}, close: vi.fn() }));
    // B's snapshot arrives first while the saved A is still pending.
    useProjectsStore.getState().adoptProject({
      id: "other-remote",
      name: "Other",
      path: "/box/other",
      ticketPrefix: "OTH",
      colorIndex: 0,
      sortOrder: 0,
      createdAt: 0,
      updatedAt: 0,
    });
    remoteSource.set({
      hosts: loss === "forgotten" ? [] : remoteSource.getSnapshot().hosts,
      projects: {},
    });
    await Promise.resolve();
    expect(state).not.toHaveBeenCalledWith({ projectId: "other-remote" });
    expect(useProjectsStore.getState().selectedProjectId).toBeNull();
    expect(useProjectsStore.getState().pendingRemoteSelection).toBeNull();
    expect(useProjectsStore.getState().projects).toEqual([]);
  },
);

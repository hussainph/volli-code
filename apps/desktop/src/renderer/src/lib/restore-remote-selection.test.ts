import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { createStore } from "zustand/vanilla";
import type { HostConnectionState, HostRecord } from "../stores/host-connection";
import { restoreRemoteSelection, REMOTE_SELECTION_RESTORE_MS } from "./restore-remote-selection";

const selection = { hostId: "box-id", projectId: "remote", hostName: "box" };
const host: HostRecord = {
  id: "box-id",
  name: "renamed-box",
  local: false,
  os: "linux",
  version: null,
  link: { status: "connecting" },
  liveSessions: null,
  update: null,
  expiredSignIns: [],
};
const claim = { hostId: host.id, link: { status: "connecting" as const } };

function setup() {
  vi.useFakeTimers();
  const hosts = createStore<Pick<HostConnectionState, "hosts" | "projects">>(() => ({
    hosts: [],
    projects: {},
  }));
  const settled = vi.fn();
  const projects = createStore(() => ({
    projects: [] as { id: string }[],
    pendingRemoteSelection: selection as typeof selection | null,
    settleRemoteRestore: settled,
  }));
  const failed = vi.fn();
  const hostStop = vi.fn();
  const projectStop = vi.fn();
  const stop = restoreRemoteSelection({
    selection,
    hosts: {
      getState: hosts.getState,
      subscribe: (listener) => {
        const unsubscribe = hosts.subscribe(listener);
        return () => {
          hostStop();
          unsubscribe();
        };
      },
    },
    projects: {
      getState: projects.getState,
      subscribe: (listener) => {
        const unsubscribe = projects.subscribe(listener);
        return () => {
          projectStop();
          unsubscribe();
        };
      },
    },
    failed,
  });
  return { hosts, projects, settled, failed, stop, hostStop, projectStop };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("one bounded remote selection restore", () => {
  it.each(["claim-first", "row-first"])("restores only when claim and row match (%s)", (order) => {
    const f = setup();
    if (order === "claim-first") {
      f.hosts.setState({ hosts: [host], projects: { remote: claim } });
      expect(f.settled).not.toHaveBeenCalled();
      f.projects.setState({ projects: [{ id: "remote" }] });
    } else {
      f.projects.setState({ projects: [{ id: "remote" }] });
      expect(f.settled).not.toHaveBeenCalled();
      f.hosts.setState({ hosts: [host], projects: { remote: claim } });
    }
    expect(f.settled).toHaveBeenCalledExactlyOnceWith(selection, true);
    expect(f.hostStop).toHaveBeenCalledOnce();
    expect(f.projectStop).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    f.stop();
    expect(f.failed).not.toHaveBeenCalled();
  });

  it.each(["absent", "unreachable", "row never arrives"])(
    "falls back at the original deadline: %s",
    (state) => {
      const f = setup();
      if (state !== "absent")
        f.hosts.setState({
          hosts: [{ ...host, link: { status: "offline", since: 0, retryAt: null } }],
          projects: state === "row never arrives" ? { remote: claim } : {},
        });
      vi.advanceTimersByTime(REMOTE_SELECTION_RESTORE_MS - 1);
      f.hosts.setState({ hosts: f.hosts.getState().hosts.slice() });
      expect(f.settled).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(f.settled).toHaveBeenCalledExactlyOnceWith(selection, false);
      expect(f.failed).toHaveBeenCalledExactlyOnceWith(
        `Couldn't reopen the project on ${state === "absent" ? "box" : "renamed-box"}. Showing This Mac.`,
      );
      f.projects.setState({ projects: [{ id: "remote" }] });
      f.hosts.setState({ hosts: [host], projects: { remote: claim } });
      expect(f.settled).toHaveBeenCalledOnce();
      expect(f.hostStop).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it.each(["forgotten", "withdrawn", "moved"])(
    "falls back immediately when an observed identity leaves: %s",
    (change) => {
      const f = setup();
      f.hosts.setState({ hosts: [host], projects: { remote: claim } });
      f.hosts.setState(
        change === "forgotten"
          ? { hosts: [], projects: {} }
          : {
              projects: change === "withdrawn" ? {} : { remote: { ...claim, hostId: "other-box" } },
            },
      );
      expect(f.settled).toHaveBeenCalledExactlyOnceWith(selection, false);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("a ready host that no longer offers the project falls back", () => {
    const f = setup();
    f.hosts.setState({ hosts: [{ ...host, link: { status: "open" } }] });
    expect(f.settled).toHaveBeenCalledExactlyOnceWith(selection, false);
  });

  it.each([null, { ...selection }])("a person's pick or replacement identity wins", (pending) => {
    const f = setup();
    f.projects.setState({ pendingRemoteSelection: pending });
    f.hosts.setState({ hosts: [host], projects: { remote: claim } });
    f.projects.setState({ projects: [{ id: "remote" }] });
    vi.advanceTimersByTime(REMOTE_SELECTION_RESTORE_MS);
    expect(f.settled).not.toHaveBeenCalled();
    expect(f.failed).not.toHaveBeenCalled();
    expect(f.projectStop).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("owner disposal ends the wait locally without a fallback", () => {
    const f = setup();
    f.stop();
    f.stop();
    f.hosts.setState({ hosts: [host], projects: { remote: claim } });
    vi.advanceTimersByTime(REMOTE_SELECTION_RESTORE_MS);
    expect(f.failed).not.toHaveBeenCalled();
    expect(f.settled).not.toHaveBeenCalled();
    expect(f.hostStop).toHaveBeenCalledOnce();
    expect(f.projectStop).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
});

import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type { Project } from "@volli/shared";

import type { CloudSession } from "@renderer/lib/cloud-client";
import { NOT_CONNECTED } from "@renderer/lib/cloud-board-api";

import { fakeCloud, refusal } from "./fake-cloud.test-support";
import { INITIAL_CLOUD_LINK_INPUT, useCloudLinkInputs } from "../cloud-link";
import { projectRows, type CloudProjectRow } from "./projection";
import { CLOUD_READ_ONLY } from "./source";
import type { BoardSnapshot } from "./snapshot";
import {
  createCloudProject,
  selectCloudWorkspace,
  followCloudWorkspace,
  useCloudWorkspaceStore,
  type CloudWorkspaceDeps,
} from "./workspace";

function projectRow(id: string, overrides: Partial<CloudProjectRow> = {}): CloudProjectRow {
  return {
    id,
    name: id.toUpperCase(),
    ticketPrefix: id.toUpperCase(),
    colorIndex: 0,
    createdAt: 1,
    updatedAt: 1,
    archivedAt: null,
    ...overrides,
  };
}

const W1 = { workspaceId: "w1", name: "Dana's Workspace" };
const W2 = { workspaceId: "w2", name: "Team" };

function harness(
  persisted: CloudWorkspaceDeps["persisted"] = null,
  offline?: { snapshot: BoardSnapshot | null | (() => Promise<BoardSnapshot | null>) },
) {
  const cloud = fakeCloud();
  cloud.queries.set("workspaces:get", (args) =>
    (args as { workspaceId: string }).workspaceId === "w1" ? W1 : W2,
  );
  let listener: ((session: CloudSession | null) => void) | null = null;
  const state = {
    projects: [] as Project[],
    selectedProjectId: null as string | null,
    hydrateCloud: vi.fn((_workspaceId: string, projects: Project[], selected: string | null) => {
      state.projects = projects;
      state.selectedProjectId = selected;
    }),
    clearCloud: vi.fn(() => {
      state.projects = [];
      state.selectedProjectId = null;
    }),
    showCloudSnapshot: vi.fn(
      (_workspaceId: string, projects: Project[], selected: string | null) => {
        state.projects = projects;
        state.selectedProjectId = selected;
      },
    ),
  };
  const timers: (() => void)[] = [];
  const shown = vi.fn<(savedAt: number | null) => void>();
  const snapshot = vi.fn(async () => {
    const kept = offline?.snapshot ?? null;
    return typeof kept === "function" ? kept() : kept;
  });
  const deps: CloudWorkspaceDeps = {
    follow: (next) => {
      listener = next;
      return () => {
        listener = null;
      };
    },
    projects: { getState: () => state },
    board: { seedProject: vi.fn(), forget: vi.fn(), paintBoard: vi.fn() },
    workspace: useCloudWorkspaceStore,
    persisted,
    failed: vi.fn(),
    notice: vi.fn(),
    ...(offline === undefined
      ? {}
      : {
          offline: {
            afterMs: 4_000,
            snapshot,
            shown,
            follow: vi.fn(),
            setTimeout: (run: () => void) => timers.push(run) - 1,
            clearTimeout: vi.fn(),
          },
        }),
  };
  const stop = followCloudWorkspace(deps);
  return {
    cloud,
    deps,
    state,
    stop,
    connect: () => listener!(cloud.session),
    close: () => listener!(null),
    listening: () => listener !== null,
    shown,
    snapshot,
    /** The offline timer runs out, and the snapshot (if any) is read. */
    timeout: async () => {
      timers[0]!();
      await Promise.resolve();
      await Promise.resolve();
    },
  };
}

const SNAPSHOT: BoardSnapshot = {
  version: 1,
  userId: "user-1",
  savedAt: 42,
  workspace: { id: "w1", name: W1.name },
  projects: projectRows([projectRow("a"), projectRow("b")]),
  boards: {
    a: {
      tickets: [
        {
          id: "t1",
          projectId: "a",
          ticketNumber: 1,
          title: "Kept",
          body: "",
          status: "todo",
          priority: "medium",
          labels: [],
          usesWorktree: true,
          preferredHarnessId: "claude-code",
          order: 0,
          worktreePath: null,
          branch: null,
          baseBranch: null,
          prUrl: null,
          createdAt: 1,
          updatedAt: 1,
        },
      ],
      labels: [],
    },
  },
};

afterEach(() => {
  useCloudWorkspaceStore.setState({ workspace: null, localProjects: 0, projectsReady: false });
  useCloudLinkInputs.setState({ input: { ...INITIAL_CLOUD_LINK_INPUT } });
});

describe("joining and leaving a Workspace", () => {
  it("confirms an ordinary membership refusal even before listMine updates", async () => {
    const h = harness();
    h.connect();
    h.cloud.answer("workspaces:listMine", {}, [W1, W2]);
    h.cloud.answer("projects:list", { workspaceId: "w1" }, [projectRow("a")]);
    h.cloud.queries.set("workspaces:get", () => {
      throw refusal("not_a_member", "Gone.");
    });
    h.cloud.fail("projects:list", { workspaceId: "w1" }, refusal("not_a_member", "Gone."));
    await Promise.resolve();
    await Promise.resolve();
    expect(h.state.projects).toEqual([]);
    expect(useCloudWorkspaceStore.getState().workspace?.id).toBe("w2");
    expect(h.deps.notice).toHaveBeenCalledExactlyOnceWith(
      "You're no longer a member of Dana's Workspace",
    );
    h.stop();
  });
  it("holds an accepted Workspace through a stale listMine answer, confirming actual removal", async () => {
    const h = harness();
    h.connect();
    h.cloud.answer("workspaces:listMine", {}, [W1]);
    h.cloud.queries.set("workspaces:get", () => W2);
    await selectCloudWorkspace("w2", h.cloud.session);
    h.cloud.answer("workspaces:listMine", {}, [{ ...W1, name: "Renamed" }]);
    await Promise.resolve();
    await Promise.resolve();
    expect(useCloudWorkspaceStore.getState().workspace?.id).toBe("w2");
    expect(h.deps.notice).not.toHaveBeenCalled();
    h.cloud.queries.set("workspaces:get", () => {
      throw refusal("not_a_member", "Gone.");
    });
    h.cloud.fail("projects:list", { workspaceId: "w2" }, refusal("not_a_member", "Gone."));
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(useCloudWorkspaceStore.getState().workspace?.id).toBe("w1");
    expect(h.deps.notice).toHaveBeenCalledExactlyOnceWith("You're no longer a member of Team");
    h.stop();
  });
  it("clears and persists the new scope before its projects answer, ignoring old answers", async () => {
    const h = harness();
    h.connect();
    h.cloud.answer("workspaces:listMine", {}, [W1, W2]);
    h.cloud.answer("projects:list", { workspaceId: "w1" }, [projectRow("a")]);
    h.cloud.queries.set("workspaces:get", () => W2);
    await selectCloudWorkspace("w2", h.cloud.session);
    expect(h.state.hydrateCloud).toHaveBeenLastCalledWith("w2", [], null);
    expect(useCloudWorkspaceStore.getState().projectsReady).toBe(false);
    expect(h.deps.board.forget).toHaveBeenCalledWith("a", { preserveDrafts: true });
    expect(h.state.projects).toEqual([]);
    expect(h.state.selectedProjectId).toBeNull();
    h.cloud.answer("projects:list", { workspaceId: "w1" }, [projectRow("old")]);
    expect(h.state.projects).toEqual([]);
    h.cloud.answer("projects:list", { workspaceId: "w2" }, []);
    expect(useCloudWorkspaceStore.getState().workspace?.id).toBe("w2");
    expect(useCloudWorkspaceStore.getState().projectsReady).toBe(true);
    h.stop();
  });
  it("only applies the newest explicit selection even if an earlier request finishes last", async () => {
    const h = harness();
    h.connect();
    h.cloud.answer("workspaces:listMine", {}, [W1, W2]);
    let answer!: (row: typeof W2) => void;
    h.cloud.queries.set(
      "workspaces:get",
      () =>
        new Promise<typeof W2>((resolve) => {
          answer = resolve;
        }),
    );
    const first = selectCloudWorkspace("w2", h.cloud.session);
    h.cloud.queries.set("workspaces:get", () => W1);
    await selectCloudWorkspace("w1", h.cloud.session);
    answer(W2);
    await first;
    expect(useCloudWorkspaceStore.getState().workspace?.id).toBe("w1");
    h.stop();
  });
  it("refuses a selection when the socket drops during its membership read", async () => {
    const h = harness();
    h.connect();
    h.cloud.queries.set("workspaces:get", () => {
      h.cloud.connected = false;
      return W2;
    });
    await expect(selectCloudWorkspace("w2", h.cloud.session)).rejects.toThrow(CLOUD_READ_ONLY);
    expect(h.cloud.watchers("projects:list", { workspaceId: "w2" })).toBe(0);
    h.stop();
  });
  it("refuses selection before the client starts, over a snapshot, or while the OS is offline", async () => {
    await expect(selectCloudWorkspace("w2")).rejects.toThrow(NOT_CONNECTED);
    const h = harness();
    h.connect();
    useCloudLinkInputs.getState().update({ snapshotAt: 42 });
    await expect(selectCloudWorkspace("w2", h.cloud.session)).rejects.toThrow(CLOUD_READ_ONLY);
    useCloudLinkInputs.getState().update({ snapshotAt: null, online: false });
    await expect(selectCloudWorkspace("w2", h.cloud.session)).rejects.toThrow(CLOUD_READ_ONLY);
    useCloudLinkInputs.getState().update({ online: true });
    h.stop();
  });
  it("does not reopen a Workspace when a selection read finishes after the client closes", async () => {
    const h = harness();
    h.connect();
    let answer!: (row: typeof W2) => void;
    h.cloud.queries.set(
      "workspaces:get",
      () =>
        new Promise<typeof W2>((resolve) => {
          answer = resolve;
        }),
    );
    const selecting = selectCloudWorkspace("w2", h.cloud.session);
    h.close();
    answer(W2);
    await selecting;
    expect(h.cloud.watchers("projects:list", { workspaceId: "w2" })).toBe(0);
    expect(useCloudWorkspaceStore.getState().workspace).toBeNull();
    h.stop();
  });
  it("announces membership loss once, not once per previous project", () => {
    const h = harness();
    h.connect();
    h.cloud.answer("workspaces:listMine", {}, [W1, W2]);
    h.cloud.answer("projects:list", { workspaceId: "w1" }, [projectRow("a"), projectRow("b")]);
    h.cloud.fail("projects:list", { workspaceId: "w1" }, refusal("not_a_member", "Gone."));
    expect(h.deps.failed).not.toHaveBeenCalled();
    h.cloud.answer("workspaces:listMine", {}, [W2]);
    expect(h.state.projects).toEqual([]);
    expect(h.state.selectedProjectId).toBeNull();
    h.cloud.answer("projects:list", { workspaceId: "w2" }, [projectRow("c")]);
    h.cloud.answer("workspaces:listMine", {}, [W2]);
    expect(h.deps.notice).toHaveBeenCalledExactlyOnceWith(
      "You're no longer a member of Dana's Workspace",
    );
    h.stop();
  });
  it("opens the accepted Workspace before listMine catches up and persists through hydration", async () => {
    const h = harness();
    h.connect();
    h.cloud.answer("workspaces:listMine", {}, [W1]);
    h.cloud.answer("projects:list", { workspaceId: "w1" }, [projectRow("a")]);
    h.cloud.queries.set("workspaces:get", () => W2);
    await selectCloudWorkspace("w2", h.cloud.session);
    expect(useCloudWorkspaceStore.getState().workspace).toEqual({ id: "w2", name: "Team" });
    expect(h.cloud.watchers("projects:list", { workspaceId: "w1" })).toBe(0);
    h.cloud.answer("projects:list", { workspaceId: "w2" }, [projectRow("b")]);
    expect(h.state.hydrateCloud).toHaveBeenLastCalledWith("w2", expect.any(Array), "b");
    expect(h.deps.notice).not.toHaveBeenCalled();
    h.cloud.answer("projects:list", { workspaceId: "w2" }, []);
    expect(h.deps.notice).toHaveBeenCalledExactlyOnceWith("B isn’t available any more");
    h.cloud.answer("workspaces:listMine", {}, [W1, W2]);
    expect(useCloudWorkspaceStore.getState().workspace?.id).toBe("w2");
    h.stop();
  });
  it("refuses selection offline and surfaces failed membership reads", async () => {
    const h = harness();
    h.connect();
    h.cloud.connected = false;
    await expect(selectCloudWorkspace("w2", h.cloud.session)).rejects.toThrow(CLOUD_READ_ONLY);
    h.cloud.connected = true;
    h.cloud.queries.set("workspaces:get", () => {
      throw refusal("not_a_member", "You are no longer a member.");
    });
    await expect(selectCloudWorkspace("w2", h.cloud.session)).rejects.toThrow(
      "You are no longer a member.",
    );
    h.stop();
  });
  it("clears a formerly live board when the last Workspace is left", () => {
    const h = harness();
    h.connect();
    h.cloud.answer("workspaces:listMine", {}, [W1]);
    h.cloud.answer("projects:list", { workspaceId: "w1" }, [projectRow("a")]);
    h.cloud.answer("workspaces:listMine", {}, []);
    expect(useCloudWorkspaceStore.getState().workspace).toBeNull();
    expect(h.state.projects).toEqual([]);
    expect(h.cloud.watchers("projects:list", { workspaceId: "w1" })).toBe(0);
    h.stop();
  });
});

describe("the current Volli Cloud Workspace (VC-889)", () => {
  it("opens the first Workspace, lists its live projects, and seeds a board for each", () => {
    const h = harness();
    h.connect();
    h.cloud.answer("workspaces:listMine", {}, [W1, W2]);
    expect(useCloudWorkspaceStore.getState().workspace).toEqual({ id: "w1", name: W1.name });
    expect(h.state.hydrateCloud).not.toHaveBeenCalled();
    h.cloud.answer("projects:list", { workspaceId: "w1" }, [
      projectRow("a"),
      projectRow("old", { archivedAt: 5 }),
      projectRow("b"),
    ]);
    expect(h.state.projects.map(({ id }) => id)).toEqual(["a", "b"]);
    expect(h.state.selectedProjectId).toBe("a");
    expect(vi.mocked(h.deps.board.seedProject).mock.calls).toEqual([["a"], ["b"]]);
  });

  it("restores the last cloud selection on the first answer, and keeps the current one after", () => {
    const h = harness({ workspaceId: "w2", projectId: "c" });
    h.connect();
    h.cloud.answer("workspaces:listMine", {}, [W1, W2]);
    expect(useCloudWorkspaceStore.getState().workspace?.id).toBe("w2");
    h.cloud.answer("projects:list", { workspaceId: "w2" }, [projectRow("b"), projectRow("c")]);
    expect(h.state.selectedProjectId).toBe("c");
    h.state.selectedProjectId = "b";
    h.cloud.answer("projects:list", { workspaceId: "w2" }, [projectRow("b"), projectRow("c")]);
    expect(h.state.selectedProjectId).toBe("b");
    // The Workspace list changing keeps the one on screen.
    h.cloud.answer("workspaces:listMine", {}, [W2, W1]);
    expect(h.state.hydrateCloud).toHaveBeenCalledTimes(2);
  });

  it("drops a project that leaves, saying so once, and falls back for the selection", () => {
    const h = harness({ workspaceId: "w1", projectId: "gone-before" });
    h.connect();
    h.cloud.answer("workspaces:listMine", {}, [W1]);
    h.cloud.answer("projects:list", { workspaceId: "w1" }, [projectRow("a"), projectRow("b")]);
    expect(h.state.selectedProjectId).toBe("a");
    h.cloud.answer("projects:list", { workspaceId: "w1" }, [projectRow("b")]);
    expect(h.deps.board.forget).toHaveBeenCalledWith("a");
    expect(h.deps.notice).toHaveBeenCalledWith("A isn’t available any more");
    expect(h.state.selectedProjectId).toBe("b");
    h.cloud.answer("projects:list", { workspaceId: "w1" }, []);
    expect(h.state.selectedProjectId).toBeNull();
  });

  it("moves to another Workspace when it loses the one on screen", () => {
    const h = harness();
    h.connect();
    h.cloud.answer("workspaces:listMine", {}, [W1, W2]);
    h.cloud.answer("projects:list", { workspaceId: "w1" }, [projectRow("a")]);
    h.cloud.answer("workspaces:listMine", {}, [W2]);
    expect(h.deps.board.forget).toHaveBeenCalledWith("a");
    expect(h.cloud.watchers("projects:list", { workspaceId: "w1" })).toBe(0);
    // A late answer for the Workspace it left changes nothing.
    h.cloud.answer("projects:list", { workspaceId: "w2" }, [projectRow("t")]);
    expect(h.state.projects.map(({ id }) => id)).toEqual(["t"]);
    expect(h.state.hydrateCloud).toHaveBeenLastCalledWith("w2", expect.anything(), "t");
  });

  it("says once that it could not read, until a read lands, and waits for a first Workspace", () => {
    const h = harness();
    h.connect();
    h.cloud.answer("workspaces:listMine", {}, []);
    expect(useCloudWorkspaceStore.getState().workspace).toBeNull();
    h.cloud.fail("workspaces:listMine", {}, refusal("unauthenticated", "Sign in."));
    h.cloud.fail("workspaces:listMine", {}, refusal("unauthenticated", "Sign in."));
    expect(h.deps.failed).toHaveBeenCalledExactlyOnceWith(
      "Couldn’t read your Workspaces: Sign in.",
    );
    h.cloud.answer("workspaces:listMine", {}, [W1]);
    h.cloud.fail("projects:list", { workspaceId: "w1" }, new Error("down"));
    expect(h.deps.failed).toHaveBeenLastCalledWith("Couldn’t read the Workspace’s projects: down");
  });

  it("empties the rail and every board when the client closes, and stops following", () => {
    const h = harness();
    h.close();
    expect(h.state.hydrateCloud).not.toHaveBeenCalled();
    h.connect();
    h.cloud.answer("workspaces:listMine", {}, [W1]);
    h.cloud.answer("projects:list", { workspaceId: "w1" }, [projectRow("a")]);
    h.close();
    expect(h.deps.board.forget).toHaveBeenCalledWith("a");
    expect(h.state.clearCloud).toHaveBeenCalledOnce();
    expect(h.state.hydrateCloud).toHaveBeenCalledOnce();
    expect(h.cloud.watchers("workspaces:listMine", {})).toBe(0);
    h.connect();
    h.stop();
    expect(h.listening()).toBe(false);
    expect(h.cloud.watchers("workspaces:listMine", {})).toBe(0);
  });
});

describe("a new project in the Workspace (VC-889)", () => {
  it("is refused while the offline snapshot is on screen", async () => {
    useCloudLinkInputs.getState().update({ snapshotAt: 5 });
    try {
      const cloud = fakeCloud();
      expect(await createCloudProject({ name: "X" }, cloud.session, "w1")).toEqual({
        ok: false,
        error: CLOUD_READ_ONLY,
      });
      expect(cloud.mutations).toEqual([]);
    } finally {
      useCloudLinkInputs.getState().update({ snapshotAt: null });
    }
  });

  it("is refused while the socket is down, or before a Workspace is known", async () => {
    const cloud = fakeCloud();
    cloud.connected = false;
    expect(await createCloudProject({ name: "X" }, cloud.session, "w1")).toEqual({
      ok: false,
      error: "Can’t reach Volli Cloud · Read-only",
    });
    expect(await createCloudProject({ name: "X" }, null, "w1")).toMatchObject({ ok: false });
    expect(await createCloudProject({ name: "X" }, fakeCloud().session, null)).toMatchObject({
      ok: false,
    });
    expect(cloud.mutations).toEqual([]);
  });

  it("creates a blank project with the client's id and the prefix asked for", async () => {
    const cloud = fakeCloud();
    const creating = createCloudProject({ name: "Site", ticketPrefix: "WEB" }, cloud.session, "w1");
    const [mutation] = cloud.mutations;
    expect(mutation).toMatchObject({
      name: "projects:create",
      args: { workspaceId: "w1", name: "Site", ticketPrefix: "WEB", origin: "blank" },
    });
    mutation!.resolve({ projectId: mutation!.args["projectId"] });
    expect(await creating).toEqual({ ok: true, projectId: mutation!.args["projectId"] });
    void createCloudProject({ name: "Plain" }, cloud.session, "w1");
    expect(cloud.mutations[1]!.args).not.toHaveProperty("ticketPrefix");
  });

  it("says a refusal in the backend's words", async () => {
    const cloud = fakeCloud();
    const refused = createCloudProject({ name: "X" }, cloud.session, "w1");
    cloud.mutations[0]!.reject(refusal("prefix_taken", "Prefix taken."));
    expect(await refused).toEqual({ ok: false, error: "Prefix taken." });
  });
});

describe("the offline snapshot at launch (VC-889, D3)", () => {
  it("does not paint another Workspace’s delayed disk snapshot over an explicit choice", async () => {
    let answer!: (kept: BoardSnapshot) => void;
    const h = harness(null, {
      snapshot: () =>
        new Promise<BoardSnapshot>((resolve) => {
          answer = resolve;
        }),
    });
    h.connect();
    await h.timeout();
    h.cloud.answer("workspaces:listMine", {}, [W1, W2]);
    h.cloud.queries.set("workspaces:get", () => W2);
    await selectCloudWorkspace("w2", h.cloud.session);
    answer(SNAPSHOT);
    await Promise.resolve();
    await Promise.resolve();
    expect(h.shown).not.toHaveBeenCalled();
    expect(useCloudWorkspaceStore.getState().workspace?.id).toBe("w2");
    h.stop();
  });
  it("shows the last-seen board, read-only, when no live list answers in time", async () => {
    const h = harness({ workspaceId: "w1", projectId: "b" }, { snapshot: SNAPSHOT });
    h.connect();
    await h.timeout();
    expect(useCloudWorkspaceStore.getState().workspace).toEqual({ id: "w1", name: W1.name });
    expect(h.deps.board.paintBoard).toHaveBeenCalledWith(
      "a",
      SNAPSHOT.boards["a"]!.tickets,
      [],
      new Set(["t1"]),
    );
    // A project whose board the snapshot did not hold paints empty.
    expect(h.deps.board.paintBoard).toHaveBeenCalledWith("b", [], [], new Set());
    expect(h.state.showCloudSnapshot).toHaveBeenCalledWith("w1", SNAPSHOT.projects, "b");
    expect(h.shown).toHaveBeenCalledExactlyOnceWith(42);
    expect(h.deps.board.seedProject).not.toHaveBeenCalled();
  });

  it("swaps to the live board when it answers, with no relaunch and nothing announced", async () => {
    const h = harness(null, { snapshot: SNAPSHOT });
    h.connect();
    await h.timeout();
    expect(h.state.selectedProjectId).toBe("a");
    h.state.selectedProjectId = "b";
    h.cloud.answer("workspaces:listMine", {}, [W1]);
    // Still the snapshot until the projects answer.
    expect(h.deps.board.forget).not.toHaveBeenCalled();
    h.cloud.answer("projects:list", { workspaceId: "w1" }, [projectRow("b"), projectRow("c")]);
    // What the live list no longer holds goes, unannounced; what it keeps
    // stays on screen while its live board is followed.
    expect(vi.mocked(h.deps.board.forget).mock.calls).toEqual([["a"]]);
    expect(h.deps.offline!.follow).toHaveBeenCalledExactlyOnceWith("b");
    expect(h.deps.notice).not.toHaveBeenCalled();
    expect(h.shown).toHaveBeenLastCalledWith(null);
    expect(vi.mocked(h.deps.board.seedProject).mock.calls).toEqual([["b"], ["c"]]);
    expect(h.state.selectedProjectId).toBe("b");
  });

  it("clears a removed Workspace’s snapshot before the fallback list answers", async () => {
    const h = harness(null, { snapshot: SNAPSHOT });
    h.connect();
    await h.timeout();
    h.cloud.answer("workspaces:listMine", {}, [W2]);
    expect(h.deps.board.forget).toHaveBeenCalledWith("a");
    expect(h.state.projects).toEqual([]);
    expect(h.deps.notice).toHaveBeenCalledExactlyOnceWith(
      "You're no longer a member of Dana's Workspace",
    );
    h.cloud.answer("projects:list", { workspaceId: "w2" }, [projectRow("t")]);
    expect(h.state.projects.map(({ id }) => id)).toEqual(["t"]);
  });

  it("keeps the snapshot through a new client, and drops it when the client closes", async () => {
    const h = harness(null, { snapshot: SNAPSHOT });
    h.connect();
    await h.timeout();
    h.connect();
    expect(h.state.clearCloud).not.toHaveBeenCalled();
    expect(h.state.projects).toHaveLength(2);
    h.close();
    expect(h.state.clearCloud).toHaveBeenCalledOnce();
    expect(h.shown).toHaveBeenLastCalledWith(null);
  });

  it("shows nothing when the live list answered first, nothing was kept, or the client closed", async () => {
    const live = harness(null, { snapshot: SNAPSHOT });
    live.connect();
    live.cloud.answer("workspaces:listMine", {}, [W1]);
    live.cloud.answer("projects:list", { workspaceId: "w1" }, []);
    // The wait is called off at the first live answer; a late timer reads nothing.
    expect(live.deps.offline!.clearTimeout).toHaveBeenCalledWith(0);
    await live.timeout();
    expect(live.snapshot).not.toHaveBeenCalled();
    expect(live.shown).not.toHaveBeenCalled();

    // The live list answering while the snapshot is read wins.
    let answer: ((kept: BoardSnapshot) => void) | undefined;
    const racing = harness(null, {
      snapshot: () => new Promise<BoardSnapshot>((resolve) => (answer = resolve)),
    });
    racing.connect();
    await racing.timeout();
    racing.cloud.answer("workspaces:listMine", {}, [W1]);
    racing.cloud.answer("projects:list", { workspaceId: "w1" }, []);
    answer!(SNAPSHOT);
    await Promise.resolve();
    expect(racing.shown).not.toHaveBeenCalled();

    const none = harness(null, { snapshot: null });
    none.connect();
    await none.timeout();
    expect(none.shown).not.toHaveBeenCalled();

    const closed = harness(null, { snapshot: SNAPSHOT });
    closed.connect();
    closed.close();
    await closed.timeout();
    expect(closed.shown).not.toHaveBeenCalled();
  });

  it("shows the snapshot when the client arrives after the wait ran out", async () => {
    const h = harness(null, { snapshot: SNAPSHOT });
    await h.timeout();
    expect(h.shown).not.toHaveBeenCalled();
    h.connect();
    await Promise.resolve();
    await Promise.resolve();
    expect(h.shown).toHaveBeenCalledExactlyOnceWith(42);
    // A second client finds it on screen already.
    h.connect();
    await Promise.resolve();
    expect(h.snapshot).toHaveBeenCalledOnce();
  });

  it("names the live Workspace again when its projects replace a snapshot shown after it opened", async () => {
    const h = harness(null, {
      snapshot: { ...SNAPSHOT, workspace: { id: "w1", name: "Old name" } },
    });
    h.connect();
    h.cloud.answer("workspaces:listMine", {}, [W1]);
    expect(useCloudWorkspaceStore.getState().workspace?.name).toBe(W1.name);
    await h.timeout();
    expect(useCloudWorkspaceStore.getState().workspace?.name).toBe("Old name");
    // A Workspace-list change meanwhile keeps the snapshot's name on screen.
    h.cloud.answer("workspaces:listMine", {}, [{ ...W1, name: "Renamed" }]);
    expect(useCloudWorkspaceStore.getState().workspace?.name).toBe("Old name");
    h.cloud.answer("projects:list", { workspaceId: "w1" }, [projectRow("a")]);
    expect(useCloudWorkspaceStore.getState().workspace).toEqual({ id: "w1", name: "Renamed" });
  });

  it("drops the snapshot when the live answer is that there is no Workspace", async () => {
    const h = harness(null, { snapshot: SNAPSHOT });
    h.connect();
    await h.timeout();
    h.cloud.answer("workspaces:listMine", {}, []);
    expect(h.state.clearCloud).toHaveBeenCalledOnce();
    expect(h.deps.board.forget).toHaveBeenCalledWith("a");
    expect(useCloudWorkspaceStore.getState().workspace).toBeNull();
    expect(h.shown).toHaveBeenLastCalledWith(null);
    // Still nothing: nothing more to drop.
    h.cloud.answer("workspaces:listMine", {}, []);
    expect(h.state.clearCloud).toHaveBeenCalledOnce();
  });

  it("says when the snapshot could not be shown", async () => {
    const h = harness(null, {
      snapshot: () => Promise.reject(new Error("unreadable")),
    });
    h.connect();
    await h.timeout();
    await vi.waitFor(() =>
      expect(h.deps.failed).toHaveBeenCalledWith("Couldn’t show the last-seen board: unreadable"),
    );
  });

  it("stops its timer when it stops following, and only once", async () => {
    const h = harness(null, { snapshot: SNAPSHOT });
    h.stop();
    expect(h.deps.offline!.clearTimeout).toHaveBeenCalledExactlyOnceWith(0);
    const ran = harness(null, { snapshot: null });
    await ran.timeout();
    ran.stop();
    expect(ran.deps.offline!.clearTimeout).not.toHaveBeenCalled();
  });
});

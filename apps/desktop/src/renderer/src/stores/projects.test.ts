import type { Project, Ticket } from "@volli/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { toast } from "sonner";
import { useBoardStore } from "./board";
import {
  PROJECTS_UI_APP_STATE_KEY,
  type ProjectsGateway,
  createProjectsStore,
  decodeProjectsUiState,
  encodeProjectsUiState,
} from "./projects";
import { scratchScope, ticketScope, useSessionsStore } from "./sessions";
import { useWorkspaceStore } from "./workspace";

vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));

// removeProject's cascade touches the REAL board/workspace/sessions
// singletons directly (by design — see stores/projects.ts's module doc), and
// useWorkspaceStore's persist middleware now writes through the app_state
// bridge (window.api.appState.set) on every real state change. Stub `window`
// every test so that write never throws on an undefined bridge, and reset the
// singletons so no test's writes leak into the next.
beforeEach(() => {
  vi.stubGlobal("window", {
    api: {
      terminal: { kill: vi.fn().mockResolvedValue({ ok: true }) },
      appState: { set: vi.fn().mockResolvedValue({ ok: true }) },
    },
  });
  useBoardStore.setState({ ticketsByProject: {}, labelsByProject: {} });
  useWorkspaceStore.setState({ byProject: {} });
  useSessionsStore.setState({ byOwner: {}, sessionOwner: {}, lastOutputAt: {}, starting: {} });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

/** Flush a fire-and-forget promise's `.then`/`.catch` chain. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function project(overrides: Partial<Project> & { id: string; path: string }): Project {
  return {
    name: overrides.name ?? "Project",
    ticketPrefix: overrides.ticketPrefix ?? "PRJ",
    colorIndex: overrides.colorIndex ?? 0,
    sortOrder: overrides.sortOrder ?? 0,
    createdAt: overrides.createdAt ?? 0,
    updatedAt: overrides.updatedAt ?? 0,
    ...overrides,
  };
}

/** A fake in-memory gateway implementing ProjectsGateway's result unions, controllable per test. */
function fakeGateway(overrides: Partial<ProjectsGateway> = {}): ProjectsGateway {
  const create = vi.fn<ProjectsGateway["create"]>(async (input) => ({
    ok: true,
    created: true,
    project: project({ id: `id-${input.path}`, path: input.path, name: input.name }),
  }));
  const remove = vi.fn<ProjectsGateway["remove"]>(async () => ({ ok: true }));
  const update = vi.fn<ProjectsGateway["update"]>(async ({ id, baseBranch, setupCommand }) => ({
    ok: true,
    project: project({
      id,
      path: "/repo",
      baseBranch,
      ...(setupCommand !== undefined ? { setupCommand } : {}),
    }),
  }));
  const reorder = vi.fn<ProjectsGateway["reorder"]>(async () => ({ ok: true }));
  const setSelection = vi.fn<ProjectsGateway["setSelection"]>(async () => ({ ok: true }));
  return { create, update, remove, reorder, setSelection, ...overrides };
}

/** Fresh store over a fresh fake gateway — never shared across tests. */
function freshStore(gateway: ProjectsGateway = fakeGateway()) {
  return { store: createProjectsStore(gateway), gateway };
}

describe("encodeProjectsUiState / decodeProjectsUiState", () => {
  it("round-trips a selected id", () => {
    expect(decodeProjectsUiState(encodeProjectsUiState("p1"))).toBe("p1");
  });

  it("round-trips null", () => {
    expect(decodeProjectsUiState(encodeProjectsUiState(null))).toBeNull();
  });

  it("emits the byte-compatible shape existing databases already hold", () => {
    expect(encodeProjectsUiState("p1")).toBe(JSON.stringify({ selectedProjectId: "p1" }));
    expect(encodeProjectsUiState(null)).toBe(JSON.stringify({ selectedProjectId: null }));
  });

  it("decodes undefined (key absent) to null", () => {
    expect(decodeProjectsUiState(undefined)).toBeNull();
  });

  it("decodes malformed JSON to null", () => {
    expect(decodeProjectsUiState("{not json")).toBeNull();
  });

  it("decodes valid JSON that isn't an object (array, primitive, null) to null", () => {
    expect(decodeProjectsUiState("[1,2,3]")).toBeNull();
    expect(decodeProjectsUiState('"just a string"')).toBeNull();
    expect(decodeProjectsUiState("null")).toBeNull();
  });

  it("decodes an object missing selectedProjectId to null", () => {
    expect(decodeProjectsUiState("{}")).toBeNull();
  });

  it("decodes a non-string selectedProjectId to null", () => {
    expect(decodeProjectsUiState(JSON.stringify({ selectedProjectId: 42 }))).toBeNull();
  });
});

/** A minimal, deterministic ticket for board-store gateway stubs. */
function ticket(overrides: Partial<Ticket> & { id: string; projectId: string }): Ticket {
  return {
    ticketNumber: 1,
    title: "Ticket",
    body: "",
    status: "backlog",
    priority: "medium",
    labels: [],
    usesWorktree: true,
    preferredHarnessId: "claude-code",
    order: 0,
    worktreePath: null,
    branch: null,
    baseBranch: null,
    prUrl: null,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

describe("addProject", () => {
  it("appends the gateway's created project and selects it", async () => {
    const { store } = freshStore();

    await store.getState().addProject({ path: "/a", defaultName: "A" });

    const [a] = store.getState().projects;
    expect(a).toBeDefined();
    expect(a!.path).toBe("/a");
    expect(store.getState().selectedProjectId).toBe(a!.id);
  });

  it("seeds the board's ticket/label slices for the new project", async () => {
    const { store } = freshStore();

    await store.getState().addProject({ path: "/a", defaultName: "A" });

    const [a] = store.getState().projects;
    expect(useBoardStore.getState().ticketsByProject[a!.id]).toEqual([]);
    expect(useBoardStore.getState().labelsByProject[a!.id]).toEqual([]);
  });

  it("lets a ticket created right after addProject land on the board", async () => {
    // Without the board seed above, addTicket's success append silently drops
    // via reconcileSlice's missing-slice guard — the ticket lands in SQLite
    // but never appears on the board until relaunch.
    const created = ticket({ id: "new-1", projectId: "id-/a", status: "backlog" });
    vi.stubGlobal("window", {
      api: {
        terminal: { kill: vi.fn().mockResolvedValue({ ok: true }) },
        appState: { set: vi.fn().mockResolvedValue({ ok: true }) },
        tickets: { create: vi.fn().mockResolvedValue({ ok: true, ticket: created }) },
      },
    });
    const { store } = freshStore();

    await store.getState().addProject({ path: "/a", defaultName: "A" });
    const [a] = store.getState().projects;

    const result = await useBoardStore.getState().addTicket(a!.id, "backlog", "New ticket");

    expect(result).toEqual(created);
    expect(useBoardStore.getState().ticketsByProject[a!.id]).toContainEqual(created);
  });

  it("selects the existing project instead of appending a duplicate when created is false", async () => {
    const existing = project({ id: "existing-id", path: "/repo", name: "Repo" });
    const gateway = fakeGateway({
      create: vi.fn<ProjectsGateway["create"]>(async () => ({
        ok: true,
        created: false,
        project: existing,
      })),
    });
    const { store } = freshStore(gateway);
    store.getState().hydrate([existing], null);

    await store.getState().addProject({ path: "/repo", defaultName: "Repo Renamed" });

    expect(store.getState().projects).toEqual([existing]);
    expect(store.getState().selectedProjectId).toBe(existing.id);
  });

  it("never clobbers a live board slice when created is false for an already-known project", async () => {
    const existing = project({ id: "existing-id", path: "/repo", name: "Repo" });
    const gateway = fakeGateway({
      create: vi.fn<ProjectsGateway["create"]>(async () => ({
        ok: true,
        created: false,
        project: existing,
      })),
    });
    const { store } = freshStore(gateway);
    store.getState().hydrate([existing], null);
    const liveTickets = [{ id: "t1" } as Ticket];
    useBoardStore.setState({
      ticketsByProject: { [existing.id]: liveTickets },
      labelsByProject: {},
    });

    await store.getState().addProject({ path: "/repo", defaultName: "Repo Renamed" });

    expect(useBoardStore.getState().ticketsByProject[existing.id]).toBe(liveTickets);
  });

  it("appends the existing project defensively when created:false but it isn't in local state yet", async () => {
    const existing = project({ id: "existing-id", path: "/repo", name: "Repo" });
    const gateway = fakeGateway({
      create: vi.fn<ProjectsGateway["create"]>(async () => ({
        ok: true,
        created: false,
        project: existing,
      })),
    });
    const { store } = freshStore(gateway);

    await store.getState().addProject({ path: "/repo", defaultName: "Repo" });

    expect(store.getState().projects).toEqual([existing]);
    expect(store.getState().selectedProjectId).toBe(existing.id);
  });

  it("persists the auto-selected project so the choice survives relaunch", async () => {
    const { store, gateway } = freshStore();

    await store.getState().addProject({ path: "/a", defaultName: "A" });
    await flush();

    const [a] = store.getState().projects;
    expect(gateway.setSelection).toHaveBeenCalledWith(a!.id);
  });

  it("toasts and leaves state unchanged on a typed gateway failure", async () => {
    const gateway = fakeGateway({
      create: vi.fn<ProjectsGateway["create"]>(async () => ({ ok: false, error: "disk full" })),
    });
    const { store } = freshStore(gateway);

    await store.getState().addProject({ path: "/a", defaultName: "A" });

    expect(store.getState().projects).toEqual([]);
    expect(vi.mocked(toast.error)).toHaveBeenCalledWith("Could not add project: disk full", {
      duration: 8000,
      closeButton: true,
    });
  });

  it("does not persist a selection when creation fails", async () => {
    const gateway = fakeGateway({
      create: vi.fn<ProjectsGateway["create"]>(async () => ({ ok: false, error: "disk full" })),
    });
    const { store } = freshStore(gateway);

    await store.getState().addProject({ path: "/a", defaultName: "A" });
    await flush();

    expect(gateway.setSelection).not.toHaveBeenCalled();
  });

  it("toasts when the gateway call rejects", async () => {
    const gateway = fakeGateway({
      create: vi.fn<ProjectsGateway["create"]>(async () => {
        throw new Error("ipc gone");
      }),
    });
    const { store } = freshStore(gateway);

    await store.getState().addProject({ path: "/a", defaultName: "A" });

    expect(store.getState().projects).toEqual([]);
    expect(vi.mocked(toast.error)).toHaveBeenCalledWith("Could not add project: ipc gone", {
      duration: 8000,
      closeButton: true,
    });
  });
});

describe("removeProject", () => {
  it("removes on a successful gateway call and selects the item now occupying the removed index", async () => {
    const [a, b, c] = [
      project({ id: "a", path: "/a" }),
      project({ id: "b", path: "/b" }),
      project({ id: "c", path: "/c" }),
    ];
    const { store } = freshStore();
    store.getState().hydrate([a, b, c], b.id);

    await store.getState().removeProject(b.id);

    expect(store.getState().projects.map((p) => p.id)).toEqual([a.id, c.id]);
    expect(store.getState().selectedProjectId).toBe(c.id);
  });

  it("selects null when removing the only project", async () => {
    const only = project({ id: "only", path: "/a" });
    const { store } = freshStore();
    store.getState().hydrate([only], only.id);

    await store.getState().removeProject(only.id);

    expect(store.getState().projects).toEqual([]);
    expect(store.getState().selectedProjectId).toBeNull();
  });

  it("leaves the selection unchanged when removing a non-selected project", async () => {
    const [a, b] = [project({ id: "a", path: "/a" }), project({ id: "b", path: "/b" })];
    const { store } = freshStore();
    store.getState().hydrate([a, b], a.id);

    await store.getState().removeProject(b.id);

    expect(store.getState().projects.map((p) => p.id)).toEqual([a.id]);
    expect(store.getState().selectedProjectId).toBe(a.id);
  });

  it("persists the neighbor selection when the removed project was selected", async () => {
    const [a, b, c] = [
      project({ id: "a", path: "/a" }),
      project({ id: "b", path: "/b" }),
      project({ id: "c", path: "/c" }),
    ];
    const { store, gateway } = freshStore();
    store.getState().hydrate([a, b, c], b.id);

    await store.getState().removeProject(b.id);
    await flush();

    expect(gateway.setSelection).toHaveBeenCalledWith(c.id);
  });

  it("persists a null selection when removing the only project", async () => {
    const only = project({ id: "only", path: "/a" });
    const { store, gateway } = freshStore();
    store.getState().hydrate([only], only.id);

    await store.getState().removeProject(only.id);
    await flush();

    expect(gateway.setSelection).toHaveBeenCalledWith(null);
  });

  it("does not persist a selection when removing a non-selected project", async () => {
    const [a, b] = [project({ id: "a", path: "/a" }), project({ id: "b", path: "/b" })];
    const { store, gateway } = freshStore();
    store.getState().hydrate([a, b], a.id);

    await store.getState().removeProject(b.id);
    await flush();

    expect(gateway.setSelection).not.toHaveBeenCalled();
  });

  it("forgets the removed project's per-workspace UI record", async () => {
    const only = project({ id: "only", path: "/a" });
    const { store } = freshStore();
    store.getState().hydrate([only], only.id);
    useWorkspaceStore.getState().setNav(only.id, "files");

    await store.getState().removeProject(only.id);

    expect(useWorkspaceStore.getState().byProject[only.id]).toBeUndefined();
  });

  it("forgets the removed project's board state", async () => {
    const only = project({ id: "only", path: "/a" });
    const { store } = freshStore();
    store.getState().hydrate([only], only.id);
    useBoardStore.getState().hydrate({ [only.id]: [] }, {});

    await store.getState().removeProject(only.id);

    expect(useBoardStore.getState().ticketsByProject[only.id]).toBeUndefined();
  });

  it("kills the removed project's live PTYs and forgets its terminal sessions", async () => {
    // removeProject must tear PTYs down explicitly (no terminal view is
    // mounted here — or in headless flows — to do it as an unmount side effect).
    // Keeps `appState` in the stub too: zustand's `persist` middleware writes
    // through on EVERY action call, even a logical no-op (see the module doc
    // above) — removeProject's cascade always touches useWorkspaceStore.
    const kill = vi
      .fn<(sessionId: string) => Promise<{ ok: boolean }>>()
      .mockResolvedValue({ ok: true });
    vi.stubGlobal("window", {
      api: { terminal: { kill }, appState: { set: vi.fn().mockResolvedValue({ ok: true }) } },
    });
    const only = project({ id: "only", path: "/a" });
    const { store } = freshStore();
    store.getState().hydrate([only], only.id);
    useSessionsStore.getState().addSession(scratchScope(only.id), "s1", "Terminal 1");

    await store.getState().removeProject(only.id);

    expect(useSessionsStore.getState().byOwner[only.id]).toBeUndefined();
    expect(kill).toHaveBeenCalledWith("s1");
  });

  it("kills the removed project's ticket-scoped sessions too", async () => {
    const kill = vi
      .fn<(sessionId: string) => Promise<{ ok: boolean }>>()
      .mockResolvedValue({ ok: true });
    vi.stubGlobal("window", {
      api: { terminal: { kill }, appState: { set: vi.fn().mockResolvedValue({ ok: true }) } },
    });
    const only = project({ id: "only", path: "/a" });
    const { store } = freshStore();
    store.getState().hydrate([only], only.id);
    // A live ticket of the project, with a ticket-scoped terminal session.
    useBoardStore.setState({
      ticketsByProject: { only: [{ id: "tk1" } as Ticket] },
      labelsByProject: {},
    });
    useSessionsStore.getState().addSession(ticketScope(only.id, "tk1"), "ts1", "Session 1");

    await store.getState().removeProject(only.id);

    expect(useSessionsStore.getState().byOwner["tk1"]).toBeUndefined();
    expect(kill).toHaveBeenCalledWith("ts1");
  });

  it("is a no-op (no IPC call) for an unknown id", async () => {
    const only = project({ id: "only", path: "/a" });
    const gateway = fakeGateway();
    const { store } = freshStore(gateway);
    store.getState().hydrate([only], only.id);
    const before = store.getState();

    await store.getState().removeProject("does-not-exist");

    expect(store.getState()).toBe(before);
    expect(gateway.remove).not.toHaveBeenCalled();
  });

  it("toasts and leaves state unchanged on a typed gateway failure", async () => {
    const only = project({ id: "only", path: "/a" });
    const gateway = fakeGateway({
      remove: vi.fn<ProjectsGateway["remove"]>(async () => ({ ok: false, error: "locked" })),
    });
    const { store } = freshStore(gateway);
    store.getState().hydrate([only], only.id);

    await store.getState().removeProject(only.id);

    expect(store.getState().projects).toEqual([only]);
    expect(vi.mocked(toast.error)).toHaveBeenCalledWith("Could not remove project: locked", {
      duration: 8000,
      closeButton: true,
    });
  });

  it("toasts when the gateway call rejects", async () => {
    const only = project({ id: "only", path: "/a" });
    const gateway = fakeGateway({
      remove: vi.fn<ProjectsGateway["remove"]>(async () => {
        throw new Error("ipc gone");
      }),
    });
    const { store } = freshStore(gateway);
    store.getState().hydrate([only], only.id);

    await store.getState().removeProject(only.id);

    expect(store.getState().projects).toEqual([only]);
    expect(vi.mocked(toast.error)).toHaveBeenCalledWith("Could not remove project: ipc gone", {
      duration: 8000,
      closeButton: true,
    });
  });

  it("does not clobber a project added while the remove IPC was in flight", async () => {
    const [a, b] = [project({ id: "a", path: "/a" }), project({ id: "b", path: "/b" })];
    const added = project({ id: "c", path: "/c" });
    let resolveRemove!: (result: { ok: true }) => void;
    const gateway = fakeGateway({
      remove: vi.fn<ProjectsGateway["remove"]>(
        () => new Promise((resolve) => (resolveRemove = resolve)),
      ),
      create: vi.fn<ProjectsGateway["create"]>(async () => ({
        ok: true,
        created: true,
        project: added,
      })),
    });
    const { store } = freshStore(gateway);
    store.getState().hydrate([a, b], a.id);

    const remove = store.getState().removeProject(b.id);
    await store.getState().addProject({ path: "/c", defaultName: "C" }); // lands mid-flight
    resolveRemove({ ok: true });
    await remove;

    // b is gone, but the concurrently-added c survives (pre-fix, removeProject's
    // pre-await snapshot overwrote `projects` and dropped c though SQLite had it).
    expect(store.getState().projects.map((p) => p.id)).toEqual([a.id, added.id]);
  });
});

describe("reorder", () => {
  it("moves the active project down to the over project's index (local, no IPC call)", () => {
    const [a, b, c] = [
      project({ id: "a", path: "/a" }),
      project({ id: "b", path: "/b" }),
      project({ id: "c", path: "/c" }),
    ];
    const gateway = fakeGateway();
    const { store } = freshStore(gateway);
    store.getState().hydrate([a, b, c], null);

    store.getState().reorder(a.id, c.id);

    expect(store.getState().projects.map((p) => p.id)).toEqual([b.id, c.id, a.id]);
    expect(gateway.reorder).not.toHaveBeenCalled();
  });

  it("is a no-op for unknown ids", () => {
    const [a, b] = [project({ id: "a", path: "/a" }), project({ id: "b", path: "/b" })];
    const { store } = freshStore();
    store.getState().hydrate([a, b], null);
    const before = store.getState().projects;

    store.getState().reorder("missing", a.id);
    store.getState().reorder(a.id, "missing");
    store.getState().reorder("missing", "also-missing");

    expect(store.getState().projects).toBe(before);
  });

  it("is a no-op when activeId and overId are the same", () => {
    const [a, b] = [project({ id: "a", path: "/a" }), project({ id: "b", path: "/b" })];
    const { store } = freshStore();
    store.getState().hydrate([a, b], null);
    const before = store.getState().projects;

    store.getState().reorder(a.id, a.id);

    expect(store.getState().projects).toBe(before);
  });
});

describe("commitReorder", () => {
  it("persists the current order via the gateway", async () => {
    const [a, b] = [project({ id: "a", path: "/a" }), project({ id: "b", path: "/b" })];
    const gateway = fakeGateway();
    const { store } = freshStore(gateway);
    store.getState().hydrate([a, b], null);
    const previousOrder = store.getState().projects;
    store.getState().reorder(a.id, b.id);

    await store.getState().commitReorder(previousOrder);

    expect(gateway.reorder).toHaveBeenCalledWith([b.id, a.id]);
  });

  it("is a no-op (no IPC call) when the order is unchanged from previousOrder", async () => {
    const [a, b] = [project({ id: "a", path: "/a" }), project({ id: "b", path: "/b" })];
    const gateway = fakeGateway();
    const { store } = freshStore(gateway);
    store.getState().hydrate([a, b], null);
    const previousOrder = store.getState().projects;

    await store.getState().commitReorder(previousOrder);

    expect(gateway.reorder).not.toHaveBeenCalled();
  });

  it("reverts to previousOrder and toasts on a typed failure", async () => {
    const [a, b] = [project({ id: "a", path: "/a" }), project({ id: "b", path: "/b" })];
    const gateway = fakeGateway({
      reorder: vi.fn<ProjectsGateway["reorder"]>(async () => ({ ok: false, error: "conflict" })),
    });
    const { store } = freshStore(gateway);
    store.getState().hydrate([a, b], null);
    const previousOrder = store.getState().projects;
    store.getState().reorder(a.id, b.id);

    await store.getState().commitReorder(previousOrder);

    expect(store.getState().projects).toEqual(previousOrder);
    expect(vi.mocked(toast.error)).toHaveBeenCalledWith("Could not save project order: conflict", {
      duration: 8000,
      closeButton: true,
    });
  });

  it("reverts to previousOrder and toasts when the gateway call rejects", async () => {
    const [a, b] = [project({ id: "a", path: "/a" }), project({ id: "b", path: "/b" })];
    const gateway = fakeGateway({
      reorder: vi.fn<ProjectsGateway["reorder"]>(async () => {
        throw new Error("ipc gone");
      }),
    });
    const { store } = freshStore(gateway);
    store.getState().hydrate([a, b], null);
    const previousOrder = store.getState().projects;
    store.getState().reorder(a.id, b.id);

    await store.getState().commitReorder(previousOrder);

    expect(store.getState().projects).toEqual(previousOrder);
    expect(vi.mocked(toast.error)).toHaveBeenCalledWith("Could not save project order: ipc gone", {
      duration: 8000,
      closeButton: true,
    });
  });

  it("restores the previous order on failure but keeps a project added mid-flight", async () => {
    const [a, b] = [project({ id: "a", path: "/a" }), project({ id: "b", path: "/b" })];
    const added = project({ id: "c", path: "/c" });
    let rejectReorder!: (result: { ok: false; error: string }) => void;
    const gateway = fakeGateway({
      reorder: vi.fn<ProjectsGateway["reorder"]>(
        () => new Promise((resolve) => (rejectReorder = resolve)),
      ),
      create: vi.fn<ProjectsGateway["create"]>(async () => ({
        ok: true,
        created: true,
        project: added,
      })),
    });
    const { store } = freshStore(gateway);
    store.getState().hydrate([a, b], null);
    const previousOrder = store.getState().projects;
    store.getState().reorder(a.id, b.id); // optimistic → [b, a]

    const commit = store.getState().commitReorder(previousOrder);
    await store.getState().addProject({ path: "/c", defaultName: "C" }); // lands mid-flight → [b, a, c]
    rejectReorder({ ok: false, error: "conflict" });
    await commit;

    // Order of the pre-drag members is restored ([a, b]); the newcomer c isn't
    // wiped by the revert (pre-fix, set(previousOrder) dropped it).
    expect(store.getState().projects.map((p) => p.id)).toEqual([a.id, b.id, added.id]);
  });
});

describe("select", () => {
  it("selects a project that exists and fire-and-forgets its persistence", async () => {
    const [a, b] = [project({ id: "a", path: "/a" }), project({ id: "b", path: "/b" })];
    const gateway = fakeGateway();
    const { store } = freshStore(gateway);
    store.getState().hydrate([a, b], null);

    store.getState().select(a.id);

    expect(store.getState().selectedProjectId).toBe(a.id);
    await flush();
    expect(gateway.setSelection).toHaveBeenCalledWith(a.id);
  });

  it("is a no-op for an unknown id", () => {
    const only = project({ id: "only", path: "/a" });
    const { store } = freshStore();
    store.getState().hydrate([only], only.id);

    store.getState().select("missing");

    expect(store.getState().selectedProjectId).toBe(only.id);
  });

  it("toasts on a typed persistence failure", async () => {
    const only = project({ id: "only", path: "/a" });
    const gateway = fakeGateway({
      setSelection: vi.fn<ProjectsGateway["setSelection"]>(async () => ({
        ok: false,
        error: "locked",
      })),
    });
    const { store } = freshStore(gateway);
    store.getState().hydrate([only], null);

    store.getState().select(only.id);
    await flush();

    expect(vi.mocked(toast.error)).toHaveBeenCalledWith("Could not save selected project: locked", {
      duration: 8000,
      closeButton: true,
    });
  });

  it("toasts when the persistence call rejects", async () => {
    const only = project({ id: "only", path: "/a" });
    const gateway = fakeGateway({
      setSelection: vi.fn<ProjectsGateway["setSelection"]>(async () => {
        throw new Error("ipc gone");
      }),
    });
    const { store } = freshStore(gateway);
    store.getState().hydrate([only], null);

    store.getState().select(only.id);
    await flush();

    expect(vi.mocked(toast.error)).toHaveBeenCalledWith(
      "Could not save selected project: ipc gone",
      { duration: 8000, closeButton: true },
    );
  });
});

describe("selectByIndex", () => {
  it("selects the project at that position in current array order", () => {
    const [a, , c] = [
      project({ id: "a", path: "/a" }),
      project({ id: "b", path: "/b" }),
      project({ id: "c", path: "/c" }),
    ];
    const { store } = freshStore();
    store.getState().hydrate([a, project({ id: "b", path: "/b" }), c], null);

    store.getState().selectByIndex(0);
    expect(store.getState().selectedProjectId).toBe(a.id);

    store.getState().selectByIndex(2);
    expect(store.getState().selectedProjectId).toBe(c.id);
  });

  it("is a no-op when the index is out of range", () => {
    const only = project({ id: "only", path: "/a" });
    const { store } = freshStore();
    store.getState().hydrate([only], only.id);

    store.getState().selectByIndex(-1);
    expect(store.getState().selectedProjectId).toBe(only.id);

    store.getState().selectByIndex(5);
    expect(store.getState().selectedProjectId).toBe(only.id);
  });
});

describe("hydrate", () => {
  it("seeds projects and selectedProjectId wholesale", () => {
    const [a, b] = [project({ id: "a", path: "/a" }), project({ id: "b", path: "/b" })];
    const { store } = freshStore();

    store.getState().hydrate([a, b], b.id);

    expect(store.getState().projects).toEqual([a, b]);
    expect(store.getState().selectedProjectId).toBe(b.id);
  });
});

describe("updateBaseBranch", () => {
  it("reconciles the selected project from the persisted result", async () => {
    const original = project({ id: "p1", path: "/repo", baseBranch: "main" });
    const gateway = fakeGateway({
      update: vi.fn<ProjectsGateway["update"]>(async () => ({
        ok: true,
        project: { ...original, baseBranch: "release/next", updatedAt: 10 },
      })),
    });
    const { store } = freshStore(gateway);
    const other = project({ id: "p2", path: "/other", baseBranch: "main" });
    store.getState().hydrate([original, other], original.id);

    const saved = await store.getState().updateBaseBranch(original.id, "release/next");

    expect(saved).toBe(true);
    expect(gateway.update).toHaveBeenCalledWith({ id: original.id, baseBranch: "release/next" });
    expect(store.getState().projects[0]?.baseBranch).toBe("release/next");
    expect(store.getState().projects[1]).toEqual(other);
  });

  it("returns false and preserves state when persistence fails", async () => {
    const original = project({ id: "p1", path: "/repo", baseBranch: "main" });
    const gateway = fakeGateway({
      update: vi.fn<ProjectsGateway["update"]>(async () => ({ ok: false, error: "locked" })),
    });
    const { store } = freshStore(gateway);
    store.getState().hydrate([original], original.id);

    await expect(store.getState().updateBaseBranch(original.id, "next")).resolves.toBe(false);
    expect(store.getState().projects).toEqual([original]);
  });

  it("keeps the per-project update queue usable after a queued update itself rejects", async () => {
    // Every update for a project id chains behind the last one (queueProjectUpdate)
    // so writes can't land out of order. A gateway result that's typed `ok` but
    // missing `project` makes the reconciliation step (`result.project.id`) throw
    // instead of resolving — this must not wedge later updates to the same id.
    const original = project({ id: "p1", path: "/repo", baseBranch: "main" });
    const update = vi.fn<ProjectsGateway["update"]>();
    update.mockResolvedValueOnce({ ok: true } as never);
    update.mockResolvedValueOnce({
      ok: true,
      project: { ...original, baseBranch: "release/next" },
    });
    const gateway = fakeGateway({ update });
    const { store } = freshStore(gateway);
    store.getState().hydrate([original], original.id);

    await expect(store.getState().updateBaseBranch(original.id, "broken")).rejects.toThrow();

    const second = await store.getState().updateBaseBranch(original.id, "release/next");
    expect(second).toBe(true);
    expect(store.getState().projects[0]?.baseBranch).toBe("release/next");
  });
});

describe("updateSetupCommand", () => {
  it("re-sends the project's current baseBranch alongside the new setupCommand", async () => {
    const original = project({ id: "p1", path: "/repo", baseBranch: "release/next" });
    const gateway = fakeGateway();
    const { store } = freshStore(gateway);
    store.getState().hydrate([original], original.id);

    const saved = await store.getState().updateSetupCommand(original.id, "pnpm install");

    expect(saved).toBe(true);
    expect(gateway.update).toHaveBeenCalledWith({
      id: original.id,
      baseBranch: "release/next",
      setupCommand: "pnpm install",
    });
    expect(store.getState().projects[0]?.setupCommand).toBe("pnpm install");
  });

  it("clears the setup command with null", async () => {
    const original = project({
      id: "p1",
      path: "/repo",
      baseBranch: "main",
      setupCommand: "pnpm install",
    });
    const gateway = fakeGateway();
    const { store } = freshStore(gateway);
    store.getState().hydrate([original], original.id);

    await store.getState().updateSetupCommand(original.id, null);

    expect(gateway.update).toHaveBeenCalledWith({
      id: original.id,
      baseBranch: "main",
      setupCommand: null,
    });
    expect(store.getState().projects[0]?.setupCommand).toBeNull();
  });

  it("is a no-op (no IPC call) for an unknown id", async () => {
    const only = project({ id: "only", path: "/a" });
    const gateway = fakeGateway();
    const { store } = freshStore(gateway);
    store.getState().hydrate([only], only.id);

    const saved = await store.getState().updateSetupCommand("missing", "pnpm install");

    expect(saved).toBe(false);
    expect(gateway.update).not.toHaveBeenCalled();
  });

  it("re-sends null when the project has no pinned baseBranch, and leaves other projects untouched", async () => {
    const target = project({ id: "p1", path: "/repo", baseBranch: null });
    const other = project({ id: "p2", path: "/other", baseBranch: "main" });
    const gateway = fakeGateway();
    const { store } = freshStore(gateway);
    store.getState().hydrate([target, other], target.id);

    const saved = await store.getState().updateSetupCommand(target.id, "pnpm install");

    expect(saved).toBe(true);
    expect(gateway.update).toHaveBeenCalledWith({
      id: target.id,
      baseBranch: null,
      setupCommand: "pnpm install",
    });
    expect(store.getState().projects[0]?.setupCommand).toBe("pnpm install");
    // The unrelated project passes through the reconciliation map unchanged.
    expect(store.getState().projects[1]).toEqual(other);
  });

  it("returns false and preserves state when persistence fails", async () => {
    const original = project({ id: "p1", path: "/repo", baseBranch: "main" });
    const gateway = fakeGateway({
      update: vi.fn<ProjectsGateway["update"]>(async () => ({ ok: false, error: "locked" })),
    });
    const { store } = freshStore(gateway);
    store.getState().hydrate([original], original.id);

    await expect(store.getState().updateSetupCommand(original.id, "pnpm install")).resolves.toBe(
      false,
    );
    expect(store.getState().projects).toEqual([original]);
  });
});

describe("createProjectsStore() with the default gateway", () => {
  // No fake gateway injected here — these exercise the real
  // `defaultGateway` wrappers (window.api.projects.* and
  // window.api.appState.set), which every other test in this file bypasses
  // by always constructing with a fake. removeProject's cascade still
  // touches the real board/workspace/sessions singletons (reset in the
  // top-level beforeEach), so `terminal.kill` is stubbed here too.

  it("addProject calls window.api.projects.create", async () => {
    const create = vi.fn(async (input: { path: string; name: string }) => ({
      ok: true as const,
      created: true as const,
      project: project({ id: "new", path: input.path, name: input.name }),
    }));
    vi.stubGlobal("window", {
      api: {
        projects: { create, remove: vi.fn(), reorder: vi.fn() },
        terminal: { kill: vi.fn().mockResolvedValue({ ok: true }) },
        appState: { set: vi.fn().mockResolvedValue({ ok: true }) },
      },
    });
    const store = createProjectsStore();

    await store.getState().addProject({ path: "/a", defaultName: "A" });

    expect(create).toHaveBeenCalledWith({ path: "/a", name: "A" });
  });

  it("updateBaseBranch calls window.api.projects.update", async () => {
    const original = project({ id: "p1", path: "/repo", baseBranch: "main" });
    const update = vi.fn(async () => ({
      ok: true as const,
      project: { ...original, baseBranch: "next" },
    }));
    vi.stubGlobal("window", {
      api: {
        projects: { create: vi.fn(), update, remove: vi.fn(), reorder: vi.fn() },
        terminal: { kill: vi.fn().mockResolvedValue({ ok: true }) },
        appState: { set: vi.fn().mockResolvedValue({ ok: true }) },
      },
    });
    const store = createProjectsStore();
    store.getState().hydrate([original], original.id);

    await store.getState().updateBaseBranch(original.id, "next");

    expect(update).toHaveBeenCalledWith({ id: original.id, baseBranch: "next" });
  });

  it("removeProject calls window.api.projects.remove", async () => {
    const remove = vi.fn(async () => ({ ok: true as const }));
    vi.stubGlobal("window", {
      api: {
        projects: { create: vi.fn(), remove, reorder: vi.fn() },
        terminal: { kill: vi.fn().mockResolvedValue({ ok: true }) },
        appState: { set: vi.fn().mockResolvedValue({ ok: true }) },
      },
    });
    const only = project({ id: "only", path: "/a" });
    const store = createProjectsStore();
    store.getState().hydrate([only], only.id);

    await store.getState().removeProject(only.id);

    expect(remove).toHaveBeenCalledWith(only.id);
  });

  it("commitReorder calls window.api.projects.reorder", async () => {
    const reorder = vi.fn(async () => ({ ok: true as const }));
    vi.stubGlobal("window", {
      api: {
        projects: { create: vi.fn(), remove: vi.fn(), reorder },
        terminal: { kill: vi.fn().mockResolvedValue({ ok: true }) },
        appState: { set: vi.fn().mockResolvedValue({ ok: true }) },
      },
    });
    const [a, b] = [project({ id: "a", path: "/a" }), project({ id: "b", path: "/b" })];
    const store = createProjectsStore();
    store.getState().hydrate([a, b], null);
    const previousOrder = store.getState().projects;
    store.getState().reorder(a.id, b.id);

    await store.getState().commitReorder(previousOrder);

    expect(reorder).toHaveBeenCalledWith([b.id, a.id]);
  });

  it("select calls window.api.appState.set with the selection payload", async () => {
    const appStateSet = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("window", {
      api: {
        projects: { create: vi.fn(), remove: vi.fn(), reorder: vi.fn() },
        terminal: { kill: vi.fn().mockResolvedValue({ ok: true }) },
        appState: { set: appStateSet },
      },
    });
    const only = project({ id: "only", path: "/a" });
    const store = createProjectsStore();
    store.getState().hydrate([only], null);

    store.getState().select(only.id);
    await flush();

    expect(appStateSet).toHaveBeenCalledWith(
      PROJECTS_UI_APP_STATE_KEY,
      JSON.stringify({ selectedProjectId: only.id }),
    );
  });
});

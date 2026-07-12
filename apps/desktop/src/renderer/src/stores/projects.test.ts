import type { Project } from "@volli/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { toast } from "sonner";
import { useBoardStore } from "./board";
import { PROJECTS_UI_APP_STATE_KEY, type ProjectsGateway, createProjectsStore } from "./projects";
import { useSessionsStore } from "./sessions";
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
  useSessionsStore.setState({ byProject: {}, startingProjects: {} });
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
  const reorder = vi.fn<ProjectsGateway["reorder"]>(async () => ({ ok: true }));
  const setSelection = vi.fn<ProjectsGateway["setSelection"]>(async () => ({ ok: true }));
  return { create, remove, reorder, setSelection, ...overrides };
}

/** Fresh store over a fresh fake gateway — never shared across tests. */
function freshStore(gateway: ProjectsGateway = fakeGateway()) {
  return { store: createProjectsStore(gateway), gateway };
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

  it("toasts and leaves state unchanged on a typed gateway failure", async () => {
    const gateway = fakeGateway({
      create: vi.fn<ProjectsGateway["create"]>(async () => ({ ok: false, error: "disk full" })),
    });
    const { store } = freshStore(gateway);

    await store.getState().addProject({ path: "/a", defaultName: "A" });

    expect(store.getState().projects).toEqual([]);
    expect(vi.mocked(toast.error)).toHaveBeenCalledWith("Could not add project: disk full");
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
    expect(vi.mocked(toast.error)).toHaveBeenCalledWith("Could not add project: ipc gone");
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
    useSessionsStore.getState().addSession(only.id, "s1");

    await store.getState().removeProject(only.id);

    expect(useSessionsStore.getState().byProject[only.id]).toBeUndefined();
    expect(kill).toHaveBeenCalledWith("s1");
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
    expect(vi.mocked(toast.error)).toHaveBeenCalledWith("Could not remove project: locked");
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
    expect(vi.mocked(toast.error)).toHaveBeenCalledWith("Could not remove project: ipc gone");
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
    expect(vi.mocked(toast.error)).toHaveBeenCalledWith("Could not save project order: conflict");
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
    expect(vi.mocked(toast.error)).toHaveBeenCalledWith("Could not save project order: ipc gone");
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

    expect(vi.mocked(toast.error)).toHaveBeenCalledWith("Could not save selected project: locked");
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

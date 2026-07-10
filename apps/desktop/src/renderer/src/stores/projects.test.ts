import { derivePrefix, PROJECT_COLORS, type Project } from "@volli/shared";
import { describe, expect, it } from "vite-plus/test";
import { createProjectsStore } from "./projects";
import { useSessionsStore } from "./sessions";
import { useWorkspaceStore } from "./workspace";

/** Simple in-memory `StateStorage` so each test gets its own isolated backing. */
function createMemoryStorage() {
  const data = new Map<string, string>();
  return {
    getItem: (name: string) => data.get(name) ?? null,
    setItem: (name: string, value: string) => {
      data.set(name, value);
    },
    removeItem: (name: string) => {
      data.delete(name);
    },
  };
}

/** Fresh store over fresh, isolated storage — never shared across tests. */
function freshStore() {
  return createProjectsStore(createMemoryStorage());
}

describe("addProject", () => {
  it("assigns round-robin colorIndex, derives ticketPrefix, and generates unique ids", () => {
    const store = freshStore();
    for (let i = 0; i < 9; i++) {
      store.getState().addProject({ path: `/repo-${i}`, defaultName: `Repo ${i}` });
    }

    const { projects } = store.getState();
    expect(projects).toHaveLength(9);
    expect(projects.map((p) => p.colorIndex)).toEqual(
      Array.from({ length: 9 }, (_, i) => i % PROJECT_COLORS.length),
    );
    expect(projects.every((p) => p.ticketPrefix === derivePrefix(p.name))).toBe(true);
    expect(new Set(projects.map((p) => p.id)).size).toBe(9);
  });

  it("selects the newly added project", () => {
    const store = freshStore();
    store.getState().addProject({ path: "/a", defaultName: "A" });
    const first = store.getState().projects[0]!;
    expect(store.getState().selectedProjectId).toBe(first.id);

    store.getState().addProject({ path: "/b", defaultName: "B" });
    const second = store.getState().projects[1]!;
    expect(store.getState().selectedProjectId).toBe(second.id);
  });

  it("selects the existing project instead of appending a duplicate for a tracked path", () => {
    const store = freshStore();
    store.getState().addProject({ path: "/repo", defaultName: "Repo" });
    const original = store.getState().projects[0]!;
    store.getState().addProject({ path: "/other", defaultName: "Other" });

    store.getState().addProject({ path: "/repo", defaultName: "Repo Renamed" });

    expect(store.getState().projects).toHaveLength(2);
    expect(store.getState().selectedProjectId).toBe(original.id);
  });
});

describe("removeProject", () => {
  it("selects the item now occupying the removed index when removing the selected middle project", () => {
    const store = freshStore();
    store.getState().addProject({ path: "/a", defaultName: "A" });
    store.getState().addProject({ path: "/b", defaultName: "B" });
    store.getState().addProject({ path: "/c", defaultName: "C" });
    const [a, b, c] = store.getState().projects;
    store.getState().select(b!.id);

    store.getState().removeProject(b!.id);

    expect(store.getState().projects.map((p) => p.id)).toEqual([a!.id, c!.id]);
    expect(store.getState().selectedProjectId).toBe(c!.id);
  });

  it("selects the new last project when removing the selected last project", () => {
    const store = freshStore();
    store.getState().addProject({ path: "/a", defaultName: "A" });
    store.getState().addProject({ path: "/b", defaultName: "B" });
    store.getState().addProject({ path: "/c", defaultName: "C" });
    const [, b, c] = store.getState().projects;
    expect(store.getState().selectedProjectId).toBe(c!.id); // last added is selected

    store.getState().removeProject(c!.id);

    expect(store.getState().selectedProjectId).toBe(b!.id);
  });

  it("selects null when removing the only project", () => {
    const store = freshStore();
    store.getState().addProject({ path: "/a", defaultName: "A" });
    const only = store.getState().projects[0]!;

    store.getState().removeProject(only.id);

    expect(store.getState().projects).toEqual([]);
    expect(store.getState().selectedProjectId).toBeNull();
  });

  it("forgets the removed project's per-workspace UI record", () => {
    const store = freshStore();
    store.getState().addProject({ path: "/a", defaultName: "A" });
    const only = store.getState().projects[0]!;
    useWorkspaceStore.getState().setNav(only.id, "files");

    store.getState().removeProject(only.id);

    expect(useWorkspaceStore.getState().byProject[only.id]).toBeUndefined();
  });

  it("forgets the removed project's terminal sessions", () => {
    const store = freshStore();
    store.getState().addProject({ path: "/a", defaultName: "A" });
    const only = store.getState().projects[0]!;
    useSessionsStore.getState().addSession(only.id, "s1", "Session 1");

    store.getState().removeProject(only.id);

    expect(useSessionsStore.getState().byProject[only.id]).toBeUndefined();
  });

  it("leaves the selection unchanged when removing a non-selected project", () => {
    const store = freshStore();
    store.getState().addProject({ path: "/a", defaultName: "A" });
    store.getState().addProject({ path: "/b", defaultName: "B" });
    const [a, b] = store.getState().projects;
    store.getState().select(a!.id);

    store.getState().removeProject(b!.id);

    expect(store.getState().projects.map((p) => p.id)).toEqual([a!.id]);
    expect(store.getState().selectedProjectId).toBe(a!.id);
  });

  it("is a no-op for an unknown id", () => {
    const store = freshStore();
    store.getState().addProject({ path: "/a", defaultName: "A" });
    const before = store.getState();

    store.getState().removeProject("does-not-exist");

    expect(store.getState()).toBe(before); // early return — set() never called
  });
});

describe("reorder", () => {
  it("moves the active project down to the over project's index", () => {
    const store = freshStore();
    store.getState().addProject({ path: "/a", defaultName: "A" });
    store.getState().addProject({ path: "/b", defaultName: "B" });
    store.getState().addProject({ path: "/c", defaultName: "C" });
    const [a, b, c] = store.getState().projects;

    store.getState().reorder(a!.id, c!.id);

    expect(store.getState().projects.map((p) => p.id)).toEqual([b!.id, c!.id, a!.id]);
  });

  it("moves the active project up to the over project's index", () => {
    const store = freshStore();
    store.getState().addProject({ path: "/a", defaultName: "A" });
    store.getState().addProject({ path: "/b", defaultName: "B" });
    store.getState().addProject({ path: "/c", defaultName: "C" });
    const [a, b, c] = store.getState().projects;

    store.getState().reorder(c!.id, a!.id);

    expect(store.getState().projects.map((p) => p.id)).toEqual([c!.id, a!.id, b!.id]);
  });

  it("is a no-op for unknown ids", () => {
    const store = freshStore();
    store.getState().addProject({ path: "/a", defaultName: "A" });
    store.getState().addProject({ path: "/b", defaultName: "B" });
    const before = store.getState().projects;

    store.getState().reorder("missing", before[0]!.id);
    store.getState().reorder(before[0]!.id, "missing");
    store.getState().reorder("missing", "also-missing");

    expect(store.getState().projects).toBe(before);
  });

  it("is a no-op when activeId and overId are the same", () => {
    const store = freshStore();
    store.getState().addProject({ path: "/a", defaultName: "A" });
    store.getState().addProject({ path: "/b", defaultName: "B" });
    const before = store.getState().projects;

    store.getState().reorder(before[0]!.id, before[0]!.id);

    expect(store.getState().projects).toBe(before);
  });
});

describe("select", () => {
  it("selects a project that exists", () => {
    const store = freshStore();
    store.getState().addProject({ path: "/a", defaultName: "A" });
    store.getState().addProject({ path: "/b", defaultName: "B" });
    const a = store.getState().projects[0]!;

    store.getState().select(a.id);

    expect(store.getState().selectedProjectId).toBe(a.id);
  });

  it("is a no-op for an unknown id", () => {
    const store = freshStore();
    store.getState().addProject({ path: "/a", defaultName: "A" });
    const before = store.getState().selectedProjectId;

    store.getState().select("missing");

    expect(store.getState().selectedProjectId).toBe(before);
  });
});

describe("selectByIndex", () => {
  it("selects the project at that position in current array order", () => {
    const store = freshStore();
    store.getState().addProject({ path: "/a", defaultName: "A" });
    store.getState().addProject({ path: "/b", defaultName: "B" });
    store.getState().addProject({ path: "/c", defaultName: "C" });
    const [a, , c] = store.getState().projects;

    store.getState().selectByIndex(0);
    expect(store.getState().selectedProjectId).toBe(a!.id);

    store.getState().selectByIndex(2);
    expect(store.getState().selectedProjectId).toBe(c!.id);
  });

  it("is a no-op when the index is out of range", () => {
    const store = freshStore();
    store.getState().addProject({ path: "/a", defaultName: "A" });
    const only = store.getState().projects[0]!;
    store.getState().select(only.id);

    store.getState().selectByIndex(-1);
    expect(store.getState().selectedProjectId).toBe(only.id);

    store.getState().selectByIndex(5);
    expect(store.getState().selectedProjectId).toBe(only.id);
  });
});

describe("persistence", () => {
  it("writes only { projects, selectedProjectId } under the 'volli:projects' key", () => {
    const storage = createMemoryStorage();
    const store = createProjectsStore(storage);
    store.getState().addProject({ path: "/a", defaultName: "A" });

    const raw = storage.getItem("volli:projects");
    expect(raw).not.toBeNull();

    const parsed = JSON.parse(raw!) as {
      state: { projects: Project[]; selectedProjectId: string | null };
      version: number;
    };
    expect(Object.keys(parsed.state).toSorted()).toEqual(["projects", "selectedProjectId"]);
    expect(parsed.state.projects).toEqual(store.getState().projects);
    expect(parsed.state.selectedProjectId).toBe(store.getState().selectedProjectId);
  });

  it("rehydrates the same projects and selection in a new store over the same storage", () => {
    const storage = createMemoryStorage();
    const store = createProjectsStore(storage);
    store.getState().addProject({ path: "/a", defaultName: "A" });
    store.getState().addProject({ path: "/b", defaultName: "B" });
    store.getState().select(store.getState().projects[0]!.id);

    const rehydrated = createProjectsStore(storage);

    expect(rehydrated.getState().projects).toEqual(store.getState().projects);
    expect(rehydrated.getState().selectedProjectId).toBe(store.getState().selectedProjectId);
  });
});

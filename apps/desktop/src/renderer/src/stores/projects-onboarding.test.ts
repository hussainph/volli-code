import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { DEFAULT_CANVAS, type Project, type WorkspaceIdentity } from "@volli/shared";
import { createProjectsStore, type ProjectsGateway } from "./projects";
import { useBoardStore } from "./board";

vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));
const identity: WorkspaceIdentity = {
  choice: { kind: "glyph", name: "tree" },
  surface: "etched",
  monogramStyle: "editorial",
};
const existing: Project = {
  id: "existing",
  path: "/existing",
  name: "Existing",
  ticketPrefix: "EX",
  colorIndex: 0,
  sortOrder: 0,
  createdAt: 1,
  updatedAt: 1,
  workspaceIdentity: identity,
};
function setup(overrides: Partial<ProjectsGateway> = {}) {
  const gateway: ProjectsGateway = {
    create: vi.fn<ProjectsGateway["create"]>(async (input) => ({
      ok: true,
      created: true,
      project: {
        ...existing,
        ...input,
        id: "new",
        workspaceIdentity: input.workspaceIdentity,
        themeCanvas: input.themeCanvas,
      },
    })),
    update: vi.fn<ProjectsGateway["update"]>(async () => ({ ok: true, project: existing })),
    remove: vi.fn<ProjectsGateway["remove"]>(async () => ({ ok: true })),
    relink: vi.fn<ProjectsGateway["relink"]>(async ({ path }) => ({
      ok: true,
      project: { ...existing, path },
      aftermath: {
        liveSessions: 0,
        worktrees: 0,
        worktreesRepaired: true,
        containerMoveNeeded: false,
        containerMoved: true,
      },
    })),
    checkFolder: vi.fn<ProjectsGateway["checkFolder"]>(async () => ({
      ok: true,
      path: "/existing",
      state: "present",
    })),
    reorder: vi.fn<ProjectsGateway["reorder"]>(async () => ({ ok: true })),
    setSelection: vi.fn<ProjectsGateway["setSelection"]>(async () => ({ ok: true })),
    ...overrides,
  };
  const listener = vi.fn();
  const store = createProjectsStore(gateway, listener);
  return { store, gateway, listener };
}
const folder = { path: "/new-folder", defaultName: "Canopy", onboard: true } as const;
const draft = { name: "  Canopy  ", workspaceIdentity: identity, themeCanvas: DEFAULT_CANVAS };
beforeEach(() => {
  vi.stubGlobal("window", { api: { appState: { set: vi.fn(async () => ({ ok: true })) } } });
  useBoardStore.setState({ ticketsByProject: {}, labelsByProject: {} });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("picked-folder onboarding", () => {
  it("prepares a stable-seed draft without creating anything, and cancel leaves no project", async () => {
    const { store, gateway } = setup();
    expect(await store.getState().addProject(folder)).toBe(false);
    expect(store.getState().newProjectDraft).toMatchObject({
      path: folder.path,
      defaultName: folder.defaultName,
    });
    expect(store.getState().newProjectDraft?.seed).toBeTruthy();
    expect(gateway.create).not.toHaveBeenCalled();
    store.getState().dismissNewProject();
    expect(store.getState().newProjectDraft).toBeNull();
    expect(store.getState().projects).toEqual([]);
    expect(gateway.setSelection).not.toHaveBeenCalled();
  });

  it("commits name, identity, and canvas together, then seeds/selects the returned row", async () => {
    const { store, gateway, listener } = setup();
    await store.getState().addProject(folder);
    expect(await store.getState().createDraftProject(draft)).toBe(true);
    expect(gateway.create).toHaveBeenCalledExactlyOnceWith({
      path: folder.path,
      name: "Canopy",
      workspaceIdentity: identity,
      themeCanvas: DEFAULT_CANVAS,
    });
    expect(store.getState().newProjectDraft).toBeNull();
    expect(store.getState().selectedProjectId).toBe("new");
    expect(store.getState().projects[0]?.workspaceIdentity).toEqual(identity);
    expect(store.getState().projects[0]?.themeCanvas).toEqual(DEFAULT_CANVAS);
    expect(useBoardStore.getState().ticketsByProject.new).toEqual([]);
    expect(listener).toHaveBeenCalledWith("new");
  });

  it("retains the same draft on create failure so a corrected name can be retried", async () => {
    const create = vi
      .fn<ProjectsGateway["create"]>()
      .mockResolvedValueOnce({ ok: false, error: "Prefix already used" })
      .mockResolvedValue({ ok: true, created: true, project: { ...existing, id: "new" } });
    const { store } = setup({ create });
    await store.getState().addProject(folder);
    const seed = store.getState().newProjectDraft?.seed;
    expect(await store.getState().createDraftProject(draft)).toBe(false);
    expect(store.getState().newProjectDraft?.seed).toBe(seed);
    expect(store.getState().creatingProject).toBe(false);
    expect(store.getState().projects).toEqual([]);
    expect(await store.getState().createDraftProject({ ...draft, name: "Other" })).toBe(true);
    expect(create).toHaveBeenLastCalledWith({
      path: folder.path,
      name: "Other",
      workspaceIdentity: identity,
      themeCanvas: DEFAULT_CANVAS,
    });
  });

  it("prevents duplicate submission and dismissal while the durable create is in flight", async () => {
    let finish!: (result: Awaited<ReturnType<ProjectsGateway["create"]>>) => void;
    const create = vi.fn<ProjectsGateway["create"]>(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const { store } = setup({ create });
    await store.getState().addProject(folder);
    const pending = store.getState().createDraftProject(draft);
    expect(store.getState().creatingProject).toBe(true);
    store.getState().dismissNewProject();
    expect(store.getState().newProjectDraft).not.toBeNull();
    expect(await store.getState().createDraftProject(draft)).toBe(false);
    finish({ ok: true, created: true, project: { ...existing, id: "new" } });
    await pending;
    expect(create).toHaveBeenCalledTimes(1);
    expect(store.getState().creatingProject).toBe(false);
    expect(store.getState().newProjectDraft).toBeNull();
  });

  it("selects a known picked folder without onboarding or changing its mark", async () => {
    const { store, gateway } = setup({
      create: vi.fn<ProjectsGateway["create"]>(async () => ({
        ok: true,
        created: false,
        project: existing,
      })),
    });
    store.getState().hydrate([existing], null);
    expect(await store.getState().addProject({ ...folder, path: existing.path })).toBe(true);
    expect(store.getState().newProjectDraft).toBeNull();
    expect(store.getState().selectedProjectId).toBe(existing.id);
    expect(store.getState().projects).toEqual([existing]);
    expect(gateway.create).toHaveBeenCalledWith({ path: existing.path, name: folder.defaultName });
  });

  it("adopts an existing backend row if another window created this path while editing", async () => {
    const { store } = setup({
      create: vi.fn<ProjectsGateway["create"]>(async () => ({
        ok: true,
        created: false,
        project: existing,
      })),
    });
    await store.getState().addProject(folder);
    await store.getState().createDraftProject({
      ...draft,
      workspaceIdentity: { ...identity, choice: { kind: "glyph", name: "coffee" } },
    });
    expect(store.getState().projects).toEqual([existing]);
    expect(store.getState().newProjectDraft).toBeNull();
  });

  it("answers the missing-folder claim before onboarding; relink preserves the existing identity", async () => {
    const { store, gateway } = setup({
      checkFolder: vi.fn<ProjectsGateway["checkFolder"]>(async () => ({
        ok: true,
        state: "missing",
        path: existing.path,
      })),
    });
    store.getState().hydrate([existing], null);
    await store.getState().addProject(folder);
    expect(store.getState().folderClaim?.onboard).toBe(true);
    expect(store.getState().newProjectDraft).toBeNull();
    await store.getState().resolveClaimAsRelink(existing.id);
    expect(gateway.create).not.toHaveBeenCalled();
    expect(store.getState().newProjectDraft).toBeNull();
    expect(store.getState().projects[0]?.workspaceIdentity).toEqual(identity);
    expect(store.getState().projects[0]?.path).toBe(folder.path);
  });

  it("answering a claim as new opens the editor, but cancellation still creates nothing", async () => {
    const { store, gateway } = setup({
      checkFolder: vi.fn<ProjectsGateway["checkFolder"]>(async () => ({
        ok: true,
        state: "missing",
        path: existing.path,
      })),
    });
    store.getState().hydrate([existing], null);
    await store.getState().addProject(folder);
    await store.getState().resolveClaimAsNewProject();
    expect(store.getState().folderClaim).toBeNull();
    expect(store.getState().newProjectDraft?.path).toBe(folder.path);
    expect(gateway.create).not.toHaveBeenCalled();
    store.getState().dismissNewProject();
    expect(store.getState().projects).toEqual([existing]);
  });

  it("does not create without a pending draft or with a blank name", async () => {
    const { store, gateway } = setup();
    expect(await store.getState().createDraftProject(draft)).toBe(false);
    await store.getState().addProject(folder);
    expect(await store.getState().createDraftProject({ ...draft, name: " " })).toBe(false);
    expect(gateway.create).not.toHaveBeenCalled();
    expect(store.getState().newProjectDraft).not.toBeNull();
  });
});

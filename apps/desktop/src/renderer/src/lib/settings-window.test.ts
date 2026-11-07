import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { SettingsWindowNavigation, SettingsWindowOpenInput } from "../../../ipc/settings-window";

const seams = vi.hoisted(() => ({
  ui: {
    settingsOpen: false,
    settingsNavigationRevision: 0,
    settingsProjectId: undefined as string | null | undefined,
    settingsWorkspaceId: undefined as string | undefined,
    settingsNavigationPending: false,
    settingsNavigationError: null as string | null,
    settingsCategory: null as string | null,
    configureCategory: null as string | null,
    settingsSignInProviderId: null as string | null,
  },
  projects: { selectedProjectId: "main-project" as string | null },
  workspace: { workspace: { id: "main-workspace", name: "Main" } },
  opener: null as ((navigation: SettingsWindowOpenInput) => void) | null,
  prepare: vi.fn<(navigation: { workspaceId?: string; projectId?: string | null }, signal: AbortSignal) => Promise<void>>(),
  open: vi.fn<(navigation: SettingsWindowOpenInput) => Promise<{ ok: true } | { ok: false; error: string }>>(),
  toastError: vi.fn(),
}));

vi.mock("@renderer/stores/ui", () => ({
  setSettingsWindowOpener: (opener: (navigation: SettingsWindowOpenInput) => void) => { seams.opener = opener; },
  useUiStore: {
    getState: () => seams.ui,
    setState: (patch: Partial<typeof seams.ui>) => Object.assign(seams.ui, patch),
  },
}));
vi.mock("@renderer/stores/projects", () => ({
  useProjectsStore: {
    getState: () => seams.projects,
    setState: (patch: Partial<typeof seams.projects>) => Object.assign(seams.projects, patch),
  },
}));
vi.mock("@renderer/stores/cloud-board/workspace", () => ({
  useCloudWorkspaceStore: { getState: () => seams.workspace },
}));
vi.mock("./workspace-window-navigation", () => ({ prepareWindowNavigation: seams.prepare }));
vi.mock("./toast", () => ({ toastError: seams.toastError }));

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

/** Drain the navigation's then/catch/finally callbacks without timers or a real client. */
async function settle() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

let routing: typeof import("./settings-window");
beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  seams.prepare.mockReset().mockResolvedValue(undefined);
  seams.open.mockReset().mockResolvedValue({ ok: true });
  seams.opener = null;
  Object.assign(seams.ui, {
    settingsOpen: false, settingsNavigationRevision: 0,
    settingsProjectId: undefined, settingsWorkspaceId: undefined,
    settingsNavigationPending: false, settingsNavigationError: null,
    settingsCategory: null, configureCategory: null, settingsSignInProviderId: null,
  });
  seams.projects.selectedProjectId = "main-project";
  seams.workspace.workspace = { id: "main-workspace", name: "Main" };
  vi.stubGlobal("window", { location: { hash: "#settings" }, api: { settingsWindow: { open: seams.open } } });
  routing = await import("./settings-window");
});
afterEach(() => { vi.unstubAllGlobals(); });

describe("native Settings renderer routing", () => {
  it("recognizes only the standalone Settings entry", () => {
    expect(routing.isSettingsWindow()).toBe(true);
    window.location.hash = "";
    expect(routing.isSettingsWindow()).toBe(false);
  });

  it("opens with the caller's current project and cloud Workspace, without navigating its renderer", async () => {
    routing.installSettingsWindowRouting();
    seams.projects.selectedProjectId = "new-project";
    seams.workspace.workspace = { id: "new-workspace", name: "New" };
    seams.opener!({ configureCategory: "skills" });
    await settle();

    expect(seams.open).toHaveBeenCalledExactlyOnceWith({
      configureCategory: "skills", projectId: "new-project", workspaceId: "new-workspace",
    });
    expect(seams.prepare).not.toHaveBeenCalled();
    expect(seams.ui.settingsOpen).toBe(false);
  });

  it("surfaces both rejected opening envelopes and transport errors", async () => {
    routing.installSettingsWindowRouting();
    seams.open.mockResolvedValueOnce({ ok: false, error: "Window refused" });
    seams.opener!({ category: "general" });
    await settle();
    expect(seams.toastError).toHaveBeenCalledWith("Couldn't open Settings: Window refused");

    seams.open.mockRejectedValueOnce(new Error("Transport closed"));
    seams.opener!({ category: "general" });
    await settle();
    expect(seams.toastError).toHaveBeenCalledWith("Couldn't open Settings: Transport closed");
  });

  it("keeps navigation pending until its receiving Workspace/project preparation completes", async () => {
    const preparation = deferred();
    seams.prepare.mockReturnValueOnce(preparation.promise);
    const navigation: SettingsWindowNavigation = {
      revision: 1, workspaceId: "team", projectId: "team-project",
      configureCategory: "skills", signInProviderId: "provider",
    };
    routing.acceptSettingsNavigation(navigation);

    expect(seams.ui).toMatchObject({
      settingsOpen: true, settingsNavigationRevision: 1,
      settingsWorkspaceId: "team", settingsProjectId: "team-project",
      settingsNavigationPending: true, settingsNavigationError: null,
      configureCategory: "skills", settingsSignInProviderId: "provider",
    });
    expect(seams.prepare).toHaveBeenCalledWith(navigation, expect.any(AbortSignal));
    expect(seams.projects.selectedProjectId).toBe("main-project");
    preparation.resolve();
    await settle();
    expect(seams.ui.settingsNavigationPending).toBe(false);
    expect(seams.projects.selectedProjectId).toBe("team-project");
  });

  it("does not replay consumed sign-in/configure intent from duplicate or stale revisions", async () => {
    const navigation = { revision: 3, projectId: "p3", configureCategory: "skills", signInProviderId: "provider" };
    routing.acceptSettingsNavigation(navigation);
    await settle();
    Object.assign(seams.ui, { configureCategory: null, settingsSignInProviderId: null });
    routing.acceptSettingsNavigation(navigation);
    routing.acceptSettingsNavigation({ revision: 2, projectId: "old", configureCategory: "mcp" });
    await settle();

    expect(seams.prepare).toHaveBeenCalledTimes(1);
    expect(seams.ui.configureCategory).toBeNull();
    expect(seams.ui.settingsSignInProviderId).toBeNull();
    expect(seams.ui.settingsNavigationRevision).toBe(3);
    expect(seams.projects.selectedProjectId).toBe("p3");
  });

  it("aborts older preparation and ignores its late completion", async () => {
    const first = deferred();
    const second = deferred();
    seams.prepare.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    routing.acceptSettingsNavigation({ revision: 1, workspaceId: "old", projectId: "p1" });
    const oldSignal = seams.prepare.mock.calls[0]![1];
    routing.acceptSettingsNavigation({ revision: 2, workspaceId: "new", projectId: "p2" });
    expect(oldSignal.aborted).toBe(true);
    first.resolve();
    await settle();
    expect(seams.ui.settingsNavigationPending).toBe(true);
    expect(seams.projects.selectedProjectId).toBe("main-project");

    second.resolve();
    await settle();
    expect(seams.ui.settingsNavigationPending).toBe(false);
    expect(seams.projects.selectedProjectId).toBe("p2");
  });

  it("makes the current permission/read-only failure renderable instead of staying hidden", async () => {
    seams.prepare.mockRejectedValueOnce(new Error("You are no longer a member."));
    routing.acceptSettingsNavigation({ revision: 1, workspaceId: "removed", projectId: "p1" });
    await settle();
    expect(seams.ui).toMatchObject({
      settingsNavigationRevision: 1, settingsNavigationPending: false,
      settingsNavigationError: "You are no longer a member.",
    });
    expect(seams.projects.selectedProjectId).toBe("main-project");
  });

  it("does not replace a newer pending request with an abandoned request's error", async () => {
    const old = deferred();
    const latest = deferred();
    seams.prepare.mockReturnValueOnce(old.promise).mockReturnValueOnce(latest.promise);
    routing.acceptSettingsNavigation({ revision: 1, workspaceId: "old", projectId: "p1" });
    routing.acceptSettingsNavigation({ revision: 2, workspaceId: "new", projectId: "p2" });
    old.reject(new Error("Old membership failed"));
    await settle();
    expect(seams.ui.settingsNavigationError).toBeNull();
    expect(seams.ui.settingsNavigationPending).toBe(true);
    latest.resolve();
    await settle();
    expect(seams.ui.settingsNavigationError).toBeNull();
    expect(seams.projects.selectedProjectId).toBe("p2");
  });
});

import type { BootstrapPayload } from "@volli/shared";
import { describe, expect, it, vi } from "vite-plus/test";

import { useBoardStore } from "@renderer/stores/board";
import { useProjectsStore } from "@renderer/stores/projects";
import { useUiStore } from "@renderer/stores/ui";
import { useWorkspaceStore } from "@renderer/stores/workspace";

import { boot, type BootGateway, type BootStorage } from "./boot";
import { takeBootNotice } from "./boot-notice";

/** A full BootstrapPayload, defaulting to the "nothing here yet" shape. */
function payload(overrides: Partial<BootstrapPayload> = {}): BootstrapPayload {
  return {
    firstRun: false,
    projects: [],
    ticketsByProject: {},
    labelsByProject: {},
    appState: {},
    ...overrides,
  };
}

/** A fake in-memory gateway implementing BootGateway's result unions, controllable per test. */
function fakeGateway(overrides: Partial<BootGateway> = {}): BootGateway {
  const bootstrap = vi.fn<BootGateway["bootstrap"]>(async () => ({ ok: true, data: payload() }));
  const importLegacy = vi.fn<BootGateway["importLegacy"]>(async () => ({
    ok: true,
    data: payload(),
  }));
  return { bootstrap, importLegacy, ...overrides };
}

/** A fake localStorage-shaped BootStorage, Map-backed so `key`/`length` behave like the real thing. */
function fakeStorage(initial: Record<string, string> = {}): BootStorage {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (key) => data.get(key) ?? null,
    removeItem: (key) => {
      data.delete(key);
    },
    key: (index) => [...data.keys()][index] ?? null,
    get length() {
      return data.size;
    },
  };
}

describe("boot", () => {
  it("returns the bootstrap failure untouched and never attempts an import", async () => {
    const gateway = fakeGateway({
      bootstrap: vi.fn<BootGateway["bootstrap"]>(async () => ({
        ok: false,
        error: "db locked",
      })),
    });
    const storage = fakeStorage({ "volli:projects": "untouched" });

    const result = await boot(gateway, storage);

    expect(result).toEqual({ ok: false, error: "db locked" });
    expect(gateway.importLegacy).not.toHaveBeenCalled();
    expect(storage.getItem("volli:projects")).toBe("untouched");
  });

  it("skips the legacy import when firstRun is false, but still clears stray volli:* keys and hydrates stores", async () => {
    const project = {
      id: "p1",
      name: "P1",
      path: "/p1",
      ticketPrefix: "P1",
      colorIndex: 0,
      sortOrder: 0,
      createdAt: 1,
      updatedAt: 1,
    };
    const gateway = fakeGateway({
      bootstrap: vi.fn<BootGateway["bootstrap"]>(async () => ({
        ok: true,
        data: payload({ firstRun: false, projects: [project] }),
      })),
    });
    const storage = fakeStorage({
      "volli:projects": "stale",
      "volli:board": "stale-demo-scaffold",
      "other:key": "keep-me",
    });

    const result = await boot(gateway, storage);

    expect(result).toEqual({ ok: true });
    expect(gateway.importLegacy).not.toHaveBeenCalled();
    expect(storage.getItem("volli:projects")).toBeNull();
    expect(storage.getItem("volli:board")).toBeNull();
    expect(storage.getItem("other:key")).toBe("keep-me");
    expect(useProjectsStore.getState().projects).toEqual([project]);
  });

  it("does not attempt an import when firstRun but volli:projects is absent", async () => {
    const gateway = fakeGateway({
      bootstrap: vi.fn<BootGateway["bootstrap"]>(async () => ({
        ok: true,
        data: payload({ firstRun: true }),
      })),
    });

    await boot(gateway, fakeStorage());

    expect(gateway.importLegacy).not.toHaveBeenCalled();
  });

  it("imports on first run: unwraps the persist envelope, sanitizes projects, synthesizes volli:projects-ui, passes through ui/workspace, and clears localStorage after", async () => {
    const legacyProjects = [
      { id: "p1", name: "P1", path: "/p1", ticketPrefix: "P1", colorIndex: 0, createdAt: 1 },
      { id: 2, name: "bad-id-type" }, // fails sanitizeLegacyProjects — dropped
    ];
    const uiJson = JSON.stringify({ state: { sidebarWidth: 400, uiScale: 1 }, version: 1 });
    const workspaceJson = JSON.stringify({ state: { byProject: {} }, version: 1 });
    const storage = fakeStorage({
      "volli:projects": JSON.stringify({
        state: { projects: legacyProjects, selectedProjectId: "p1" },
        version: 1,
      }),
      "volli:ui": uiJson,
      "volli:workspace": workspaceJson,
      "volli:board": "demo-scaffold-never-read",
    });
    const importedPayload = payload({
      projects: [
        {
          id: "p1",
          name: "P1",
          path: "/p1",
          ticketPrefix: "P1",
          colorIndex: 0,
          sortOrder: 0,
          createdAt: 1,
          updatedAt: 1,
        },
      ],
      appState: {
        "volli:ui": uiJson,
        "volli:workspace": workspaceJson,
        "volli:projects-ui": JSON.stringify({ selectedProjectId: "p1" }),
      },
    });
    const importLegacy = vi.fn<BootGateway["importLegacy"]>(async () => ({
      ok: true,
      data: importedPayload,
    }));
    const gateway = fakeGateway({
      bootstrap: vi.fn<BootGateway["bootstrap"]>(async () => ({
        ok: true,
        data: payload({ firstRun: true }),
      })),
      importLegacy,
    });

    const result = await boot(gateway, storage);

    expect(result).toEqual({ ok: true });
    expect(importLegacy).toHaveBeenCalledTimes(1);
    const request = importLegacy.mock.calls[0]![0];
    // The malformed entry is dropped; the valid one survives sanitization.
    expect(request.projects).toEqual([
      { id: "p1", name: "P1", path: "/p1", ticketPrefix: "P1", colorIndex: 0, createdAt: 1 },
    ]);
    expect(request.appState["volli:ui"]).toBe(uiJson);
    expect(request.appState["volli:workspace"]).toBe(workspaceJson);
    expect(JSON.parse(request.appState["volli:projects-ui"]!)).toEqual({
      selectedProjectId: "p1",
    });
    expect(request.appState["volli:board"]).toBeUndefined();

    // Every volli:* key is gone afterward — including volli:board, never imported.
    expect(storage.getItem("volli:projects")).toBeNull();
    expect(storage.getItem("volli:ui")).toBeNull();
    expect(storage.getItem("volli:workspace")).toBeNull();
    expect(storage.getItem("volli:board")).toBeNull();

    // Stores hydrate from the IMPORT's returned payload, not the original (empty) bootstrap data.
    expect(useProjectsStore.getState().projects).toEqual(importedPayload.projects);
    expect(useProjectsStore.getState().selectedProjectId).toBe("p1");
    // A clean import never raises a boot notice.
    expect(takeBootNotice()).toBeNull();
  });

  it("keeps localStorage and surfaces a notice when the import itself fails (never destroys the source)", async () => {
    const legacyProjects = JSON.stringify({
      state: { projects: [], selectedProjectId: null },
      version: 1,
    });
    const storage = fakeStorage({ "volli:projects": legacyProjects });
    const originalPayload = payload({ firstRun: true, projects: [] });
    const gateway = fakeGateway({
      bootstrap: vi.fn<BootGateway["bootstrap"]>(async () => ({ ok: true, data: originalPayload })),
      importLegacy: vi.fn<BootGateway["importLegacy"]>(async () => ({
        ok: false,
        error: "constraint violation",
      })),
    });

    const result = await boot(gateway, storage);

    // The app still boots (with the empty bootstrap payload) — a failed legacy
    // import is non-fatal...
    expect(result).toEqual({ ok: true });
    // ...but the source localStorage is preserved for a retry next launch,
    // never wiped (the pre-fix regression destroyed it silently)...
    expect(storage.getItem("volli:projects")).toBe(legacyProjects);
    // ...and the failure is surfaced (AppShell drains the stashed notice into
    // a toast on mount, since boot runs before the Toaster).
    expect(takeBootNotice()).toContain("constraint violation");
    expect(useProjectsStore.getState().projects).toEqual(originalPayload.projects);
  });

  it("selects the persisted selectedProjectId only when it points at a loaded project", async () => {
    const project = {
      id: "p1",
      name: "P1",
      path: "/p1",
      ticketPrefix: "P1",
      colorIndex: 0,
      sortOrder: 0,
      createdAt: 1,
      updatedAt: 1,
    };
    const gateway = fakeGateway({
      bootstrap: vi.fn<BootGateway["bootstrap"]>(async () => ({
        ok: true,
        data: payload({
          projects: [project],
          appState: { "volli:projects-ui": JSON.stringify({ selectedProjectId: "missing" }) },
        }),
      })),
    });

    await boot(gateway, fakeStorage());

    expect(useProjectsStore.getState().selectedProjectId).toBeNull();
  });

  it("hydrates the board store's tickets and labels", async () => {
    const ticket = {
      id: "t1",
      projectId: "p1",
      ticketNumber: 1,
      title: "T",
      body: "",
      status: "backlog" as const,
      priority: "medium" as const,
      labels: ["bug"],
      usesWorktree: true,
      harnessId: "claude-code",
      order: 0,
      createdAt: 0,
      updatedAt: 0,
    };
    const label = { id: "l1", projectId: "p1", name: "bug", color: null };
    const gateway = fakeGateway({
      bootstrap: vi.fn<BootGateway["bootstrap"]>(async () => ({
        ok: true,
        data: payload({ ticketsByProject: { p1: [ticket] }, labelsByProject: { p1: [label] } }),
      })),
    });

    await boot(gateway, fakeStorage());

    expect(useBoardStore.getState().ticketsByProject.p1).toEqual([ticket]);
    expect(useBoardStore.getState().labelsByProject.p1).toEqual([label]);
  });

  it("rehydrates the ui/workspace stores from the seeded app_state cache", async () => {
    const gateway = fakeGateway({
      bootstrap: vi.fn<BootGateway["bootstrap"]>(async () => ({
        ok: true,
        data: payload({
          appState: {
            "volli:ui": JSON.stringify({ state: { sidebarWidth: 500, uiScale: 1.25 }, version: 1 }),
            "volli:workspace": JSON.stringify({
              state: {
                byProject: {
                  p1: { boardView: "list", boardSort: { key: "title", direction: "asc" } },
                },
              },
              version: 1,
            }),
          },
        }),
      })),
    });

    await boot(gateway, fakeStorage());

    expect(useUiStore.getState().sidebarWidth).toBe(500);
    expect(useUiStore.getState().uiScale).toBe(1.25);
    expect(useWorkspaceStore.getState().byProject.p1?.boardView).toBe("list");
  });
});

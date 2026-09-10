import type { BootstrapPayload } from "../../../ipc/contract";
import type { VenueSnapshot } from "@volli/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { useBoardStore } from "@renderer/stores/board";
import { useProjectsStore } from "@renderer/stores/projects";
import { useUiStore } from "@renderer/stores/ui";
import { useVenueStore, venueKey } from "@renderer/stores/venue";
import { useWorkspaceStore } from "@renderer/stores/workspace";

import { boot, refreshPlanningData, type BootGateway, type BootStorage } from "./boot";
import { takeBootNotice } from "./boot-notice";

/** A full BootstrapPayload, defaulting to the "nothing here yet" shape. */
function payload(overrides: Partial<BootstrapPayload> = {}): BootstrapPayload {
  return {
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
    imported: 0,
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

/** One measured venue, as main answers `venue.snapshot`. */
function venue(over: Partial<VenueSnapshot> = {}): VenueSnapshot {
  return {
    kind: "worktree",
    path: "/worktrees/VC-286",
    branch: "volli/VC-286-stale-checkout",
    files: { committed: 1, modified: 0, added: 0, untracked: 0 },
    diff: { added: 3, removed: 1, base: "main" },
    ...over,
  };
}

/** Stubs the venue door so the singleton store can be driven from these tests. */
function stubVenueSnapshot(reading: unknown) {
  const snapshot = vi.fn().mockResolvedValue({ ok: true, reading });
  Object.assign(globalThis, { window: { api: { venue: { snapshot } } } });
  return snapshot;
}

/** One ticket venue and one project venue, both already read — the state a materialization walks into. */
async function seedVenues() {
  await useVenueStore.getState().refresh("p1", "t1");
  await useVenueStore.getState().refresh("p1", null);
}

describe("boot", () => {
  // The boot notice is a module-global stash (boot runs before the Toaster
  // mounts); drain any residual so a notice set by one test can't leak into
  // the next's `takeBootNotice()` assertion.
  beforeEach(() => {
    takeBootNotice();
  });

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

  it("skips the legacy import when the projects table is non-empty, but still clears stray volli:* keys and hydrates stores", async () => {
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
        data: payload({ projects: [project] }),
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

  it("does not attempt an import when the DB is empty but no legacy keys are present", async () => {
    const gateway = fakeGateway({
      bootstrap: vi.fn<BootGateway["bootstrap"]>(async () => ({
        ok: true,
        data: payload(),
      })),
    });

    await boot(gateway, fakeStorage());

    expect(gateway.importLegacy).not.toHaveBeenCalled();
  });

  it("retries the import when the DB is still empty even though app_state is not (the post-failure regression)", async () => {
    // A prior boot's import failed, then the user resized the sidebar — writing
    // an app_state row. The DB still has no projects, so the import MUST run
    // again; the old firstRun gate (projects AND app_state empty) skipped it
    // here and then destroyed the source.
    const gateway = fakeGateway({
      bootstrap: vi.fn<BootGateway["bootstrap"]>(async () => ({
        ok: true,
        data: payload({ appState: { "volli:ui": "{}" } }),
      })),
    });
    const storage = fakeStorage({
      "volli:projects": JSON.stringify({ state: { projects: [], selectedProjectId: null } }),
    });

    await boot(gateway, storage);

    expect(gateway.importLegacy).toHaveBeenCalledTimes(1);
  });

  it("migrates ui/workspace prefs even when volli:projects is absent (prefs-only user)", async () => {
    const uiJson = JSON.stringify({ state: { sidebarWidth: 480 }, version: 1 });
    const importLegacy = vi.fn<BootGateway["importLegacy"]>(async () => ({
      ok: true,
      data: payload(),
      imported: 0,
    }));
    const gateway = fakeGateway({ importLegacy });
    const storage = fakeStorage({ "volli:ui": uiJson });

    await boot(gateway, storage);

    expect(importLegacy).toHaveBeenCalledTimes(1);
    const request = importLegacy.mock.calls[0]![0];
    expect(request.projects).toEqual([]);
    expect(request.appState["volli:ui"]).toBe(uiJson);
    expect(request.rawBackup["volli:ui"]).toBe(uiJson);
    // A prefs-only migration is clean — no "couldn't read" notice.
    expect(takeBootNotice()).toBeNull();
    expect(storage.getItem("volli:ui")).toBeNull();
  });

  it("backs up and surfaces (never silently wipes) an unreadable volli:projects blob", async () => {
    const corrupt = '{"state":{"projects":'; // truncated JSON — unwraps to nothing
    const importLegacy = vi.fn<BootGateway["importLegacy"]>(async () => ({
      ok: true,
      data: payload(),
      imported: 0,
    }));
    const gateway = fakeGateway({ importLegacy });
    const storage = fakeStorage({ "volli:projects": corrupt });

    await boot(gateway, storage);

    // The raw source is handed to the import for backup into SQLite...
    const request = importLegacy.mock.calls[0]![0];
    expect(request.projects).toEqual([]);
    expect(request.rawBackup["volli:projects"]).toBe(corrupt);
    // ...and the user is told it couldn't be read, rather than it vanishing.
    expect(takeBootNotice()).toContain("couldn't read");
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
      imported: 1,
    }));
    const gateway = fakeGateway({
      bootstrap: vi.fn<BootGateway["bootstrap"]>(async () => ({
        ok: true,
        data: payload(),
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
    const originalPayload = payload({ projects: [] });
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
      preferredHarnessId: "claude-code" as const,
      order: 0,
      worktreePath: null,
      branch: null,
      baseBranch: null,
      prUrl: null,
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

describe("refreshPlanningData", () => {
  it("replaces planning stores from a fresh bootstrap while preserving the live selection", async () => {
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
    const ticket = {
      id: "t1",
      projectId: "p1",
      ticketNumber: 1,
      title: "Moved by CLI",
      body: "",
      status: "doing" as const,
      priority: "medium" as const,
      labels: [],
      usesWorktree: true,
      preferredHarnessId: "claude-code" as const,
      order: 0,
      worktreePath: null,
      branch: null,
      baseBranch: null,
      prUrl: null,
      createdAt: 0,
      updatedAt: 1,
    };
    useProjectsStore.getState().hydrate([project], "p1");
    useBoardStore.getState().hydrate({ p1: [] }, { p1: [] });
    const gateway = fakeGateway({
      bootstrap: vi.fn<BootGateway["bootstrap"]>(async () => ({
        ok: true,
        data: payload({ projects: [project], ticketsByProject: { p1: [ticket] } }),
      })),
    });

    expect(await refreshPlanningData({}, gateway)).toEqual({ ok: true });
    expect(useProjectsStore.getState().selectedProjectId).toBe("p1");
    expect(useBoardStore.getState().ticketsByProject.p1).toEqual([ticket]);
  });

  it("publishes lastPlanningChange so per-ticket surfaces refetch, but only on a successful refresh", async () => {
    useProjectsStore.getState().hydrate([], null);
    useBoardStore.getState().hydrate({}, {});
    const before = useBoardStore.getState().lastPlanningChange.version;

    const okGateway = fakeGateway({
      bootstrap: vi.fn<BootGateway["bootstrap"]>(async () => ({ ok: true, data: payload({}) })),
    });
    expect(await refreshPlanningData({}, okGateway)).toEqual({ ok: true });
    expect(useBoardStore.getState().lastPlanningChange.version).toBe(before + 1);

    const failGateway = fakeGateway({
      bootstrap: vi.fn<BootGateway["bootstrap"]>(async () => ({ ok: false, error: "db gone" })),
    });
    expect(await refreshPlanningData({}, failGateway)).toEqual({ ok: false, error: "db gone" });
    // A failed refresh hydrates nothing, so it must not bump the version either.
    expect(useBoardStore.getState().lastPlanningChange.version).toBe(before + 1);
  });

  /**
   * VC-286. The empty chat used to caption a ticket `Main checkout` because
   * nothing re-read its venue when the worktree it was waiting for arrived.
   * This is the boundary that fixes it: one door, so every ticket venue reader
   * updates at the same moment the board does.
   */
  describe("a worktree change", () => {
    afterEach(() => {
      useVenueStore.setState({ byScope: {} });
      Reflect.deleteProperty(globalThis, "window");
    });

    it("discards the ticket's venue before the re-hydrate and re-reads it after", async () => {
      const snapshot = stubVenueSnapshot({ state: "measured", venue: venue() });
      await seedVenues();
      const seen: unknown[] = [];
      const gateway = fakeGateway({
        bootstrap: vi.fn<BootGateway["bootstrap"]>(async () => {
          // Mid-refresh: the old reading is already gone, and the new one has
          // not been asked for — asking before the board is current would read
          // the checkout the ticket is leaving.
          seen.push(useVenueStore.getState().byScope[venueKey("p1", "t1")]);
          seen.push(snapshot.mock.calls.length);
          return { ok: true, data: payload({}) };
        }),
      });

      await refreshPlanningData({ ticketId: "t1", projectId: "p1", kind: "worktree" }, gateway);

      expect(seen).toEqual([{ status: "loading" }, 2]);
      // The re-read is not awaited by the refresh — a git status has no business
      // delaying the board's own answer — so it lands a tick later.
      await vi.waitFor(() => {
        expect(useVenueStore.getState().byScope[venueKey("p1", "t1")]).toEqual({
          status: "ready",
          venue: venue(),
        });
      });
      expect(snapshot).toHaveBeenLastCalledWith("p1", "t1");
    });

    it("leaves Home's project venue card measuring the main checkout", async () => {
      stubVenueSnapshot({ state: "measured", venue: venue() });
      await seedVenues();
      const gateway = fakeGateway();

      await refreshPlanningData({ ticketId: "t1", projectId: "p1", kind: "worktree" }, gateway);

      expect(useVenueStore.getState().byScope[venueKey("p1", null)]).toEqual({
        status: "ready",
        venue: venue(),
      });
    });

    it("holds the ticket at resolving while the worktree is still being made", async () => {
      stubVenueSnapshot({ state: "pending" });
      await seedVenues();

      await refreshPlanningData(
        { ticketId: "t1", projectId: "p1", kind: "worktree" },
        fakeGateway(),
      );

      await vi.waitFor(() => {
        expect(useVenueStore.getState().byScope[venueKey("p1", "t1")]).toEqual({
          status: "resolving",
        });
      });
    });

    it("discards every ticket's venue when the change names none", async () => {
      stubVenueSnapshot({ state: "measured", venue: venue() });
      await seedVenues();
      const gateway = fakeGateway({
        bootstrap: vi.fn<BootGateway["bootstrap"]>(async () => {
          expect(useVenueStore.getState().byScope[venueKey("p1", "t1")]).toEqual({
            status: "loading",
          });
          return { ok: true, data: payload({}) };
        }),
      });

      await refreshPlanningData({ kind: "worktree" }, gateway);

      expect(gateway.bootstrap).toHaveBeenCalledTimes(1);
      await vi.waitFor(() => {
        expect(useVenueStore.getState().byScope[venueKey("p1", "t1")]).toMatchObject({
          status: "ready",
        });
      });
    });

    it("leaves every venue alone for a change that is not about a checkout", async () => {
      const snapshot = stubVenueSnapshot({ state: "measured", venue: venue() });
      await seedVenues();
      snapshot.mockClear();

      await refreshPlanningData(
        { ticketId: "t1", projectId: "p1", kind: "comment" },
        fakeGateway(),
      );

      // A comment does not move a checkout, and blanking the caption to redraw
      // the identical venue is a flicker with nothing behind it.
      expect(snapshot).not.toHaveBeenCalled();
      expect(useVenueStore.getState().byScope[venueKey("p1", "t1")]).toMatchObject({
        status: "ready",
      });
    });

    it("still re-reads the discarded venue when the re-hydrate itself fails", async () => {
      const snapshot = stubVenueSnapshot({ state: "measured", venue: venue() });
      await seedVenues();
      snapshot.mockClear();
      const gateway = fakeGateway({
        bootstrap: vi.fn<BootGateway["bootstrap"]>(async () => ({ ok: false, error: "db gone" })),
      });

      const result = await refreshPlanningData(
        { ticketId: "t1", projectId: "p1", kind: "worktree" },
        gateway,
      );

      // The failure is still the caller's answer, but the venue may not be left
      // waiting on a read nobody will make.
      expect(result).toEqual({ ok: false, error: "db gone" });
      await vi.waitFor(() => {
        expect(snapshot).toHaveBeenCalledWith("p1", "t1");
      });
    });
  });

  it("forwards the change scope (ticket/project) into lastPlanningChange, defaulting to untargeted", async () => {
    useProjectsStore.getState().hydrate([], null);
    useBoardStore.getState().hydrate({}, {});
    const gateway = fakeGateway({
      bootstrap: vi.fn<BootGateway["bootstrap"]>(async () => ({ ok: true, data: payload({}) })),
    });

    // A targeted refresh carries the affected ticket/project through to the signal.
    await refreshPlanningData({ ticketId: "t-9", projectId: "p-9" }, gateway);
    expect(useBoardStore.getState().lastPlanningChange).toMatchObject({
      ticketId: "t-9",
      projectId: "p-9",
    });

    // An untargeted refresh (no scope) resets both to null — "anything may have changed".
    await refreshPlanningData({}, gateway);
    expect(useBoardStore.getState().lastPlanningChange).toMatchObject({
      ticketId: null,
      projectId: null,
    });
  });
});

import type { IpcEvent, IpcRequest, IpcResponse } from "@volli/host-protocol/ipc";
import type { BootstrapPayload } from "../../../ipc/contract";
import {
  CHAT_DRAFTS_APP_STATE_KEY,
  type Project,
  type Ticket,
  type VenueSnapshot,
} from "@volli/shared";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { useBoardStore } from "@renderer/stores/board";
import { useChatDraftsStore } from "@renderer/stores/chat-drafts";
import { useChatSessionsStore } from "@renderer/stores/chat-sessions";
import { useHostConnectionStore } from "@renderer/stores/host-connection";
import { useProjectsStore } from "@renderer/stores/projects";
import { useUiStore } from "@renderer/stores/ui";
import { useVenueStore, venueKey } from "@renderer/stores/venue";
import { useWorkspaceStore } from "@renderer/stores/workspace";

import { BoardSync, type BoardSyncTransport } from "@renderer/stores/board-sync";

import { boardProtocol, startBoardProtocol, stopBoardProtocol } from "./board-protocol";
import { remoteSessionListingRegistrations } from "./session-listing-reader";
import { sessionRpcClient } from "./session-rpc-ipc-link";
import {
  boot,
  followRemoteProjects,
  refreshPlanningData,
  startBoardProtocolIfEnabled,
  type BootGateway,
  type BootStorage,
} from "./boot";
import { takeBootNotice } from "./boot-notice";

// The real client unless a test says otherwise: only the `cloud` flag read is stubbed.
vi.mock("./session-rpc-ipc-link", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./session-rpc-ipc-link")>();
  // A fresh client over whatever bridge the case stubbed: the app's one
  // client is a singleton, which would carry one case's bridge into the next.
  return {
    ...actual,
    sessionRpcClient: vi.fn(() => actual.createSessionRpcClient(window.api.sessionRpc)),
  };
});

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
  const projectRoster = vi.fn<BootGateway["projectRoster"]>(async () => ({
    ok: true,
    tickets: [],
    labels: [],
  }));
  const importLegacy = vi.fn<BootGateway["importLegacy"]>(async () => ({
    ok: true,
    data: payload(),
    imported: 0,
  }));
  return { bootstrap, projectRoster, importLegacy, ...overrides };
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

  it("reopens a persisted unsent chat Draft without creating a resident Session", async () => {
    const draftId = "550e8400-e29b-41d4-a716-446655440000";
    const chatDrafts = JSON.stringify({
      state: {
        drafts: {
          [draftId]: {
            text: "survive a relaunch",
            attachments: [],
            held: [],
            touchedAt: 10,
            provisional: {
              projectId: "p1",
              ticketId: "t1",
              operationId: "stable-create-operation",
              title: null,
              phase: "draft",
            },
          },
        },
      },
      version: 1,
    });
    const gateway = fakeGateway({
      bootstrap: vi.fn<BootGateway["bootstrap"]>(async () => ({
        ok: true,
        data: payload({
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
          ticketsByProject: {
            p1: [
              {
                id: "t1",
                projectId: "p1",
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
              },
            ],
          },
          appState: { [CHAT_DRAFTS_APP_STATE_KEY]: chatDrafts },
        }),
      })),
    });
    useChatDraftsStore.setState({ drafts: {} });
    useChatSessionsStore.setState({ sessions: {}, openTabs: {}, provisionalActive: {} });

    try {
      await boot(gateway, fakeStorage());

      expect(useChatDraftsStore.getState().drafts[draftId]).toMatchObject({
        text: "survive a relaunch",
        provisional: { operationId: "stable-create-operation", phase: "draft" },
      });
      expect(useChatSessionsStore.getState().openTabs).toEqual({ t1: [draftId] });
      expect(useChatSessionsStore.getState().sessions).toEqual({});
      // Reachable, not forced in front. A typed Draft's `chat:<uuid>` is
      // already in the persisted workspace layout, so claiming the
      // renderer-only focus overlay here would make the surface's commit
      // effect overwrite the tab the person actually quit on.
      expect(useChatSessionsStore.getState().provisionalActive).toEqual({});
      expect(useWorkspaceStore.getState().byProject.p1?.ticketTabs?.t1?.active).toBeUndefined();
    } finally {
      useChatDraftsStore.setState({ drafts: {} });
      useChatSessionsStore.setState({ sessions: {}, openTabs: {}, provisionalActive: {} });
    }
  });
});

describe("refreshPlanningData", () => {
  // The "a read failed, heal wholesale next time" bit is board state now, so a
  // wholesale hydrate is what drains it — the same door the app uses, rather
  // than a test-only reset. A failing-read test therefore cannot decide how the
  // NEXT test's targeted change is read.
  beforeEach(() => {
    useBoardStore.getState().hydrate({}, {});
  });

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

  it("refreshes only a known project's roster", async () => {
    const existingTicket = {
      id: "t1",
      projectId: "p1",
      ticketNumber: 1,
      title: "Before",
      body: "Keep this body",
      status: "backlog" as const,
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
      updatedAt: 0,
    };
    const refreshedTicket = {
      id: "t1",
      projectId: "p1",
      ticketNumber: 1,
      title: "After",
      status: "doing" as const,
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
      updatedAt: 1,
    };
    const label = { id: "l1", projectId: "p1", name: "bug", color: null };
    useBoardStore.getState().hydrate({ p1: [existingTicket], p2: [] }, { p1: [], p2: [] });
    const untouchedTickets = useBoardStore.getState().ticketsByProject.p2;
    const beforeChange = useBoardStore.getState().lastPlanningChange.version;
    const projectRoster = vi.fn<BootGateway["projectRoster"]>(async () => ({
      ok: true,
      tickets: [refreshedTicket],
      labels: [label],
    }));
    const gateway = fakeGateway({ projectRoster });

    expect(await refreshPlanningData({ projectId: "p1", kind: "ticket" }, gateway)).toEqual({
      ok: true,
    });

    expect(projectRoster).toHaveBeenCalledWith({ projectId: "p1" });
    expect(gateway.bootstrap).not.toHaveBeenCalled();
    expect(useBoardStore.getState().ticketsByProject.p1).toEqual([
      { ...refreshedTicket, body: "Keep this body" },
    ]);
    expect(useBoardStore.getState().labelsByProject.p1).toEqual([label]);
    expect(useBoardStore.getState().ticketsByProject.p2).toBe(untouchedTickets);
    expect(useBoardStore.getState().lastPlanningChange).toEqual({
      version: beforeChange + 1,
      ticketId: null,
      projectId: "p1",
    });
  });

  it("refreshes wholesale when the change names a project the board does not hold", async () => {
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
    useProjectsStore.getState().hydrate([project], "p1");
    useBoardStore.getState().hydrate({ p1: [] }, { p1: [] });
    const gateway = fakeGateway();

    expect(await refreshPlanningData({ projectId: "p-new", kind: "ticket" }, gateway)).toEqual({
      ok: true,
    });

    expect(gateway.bootstrap).toHaveBeenCalledTimes(1);
    expect(gateway.projectRoster).not.toHaveBeenCalled();
    expect(useProjectsStore.getState().projects).toEqual([]);
    expect(useBoardStore.getState().ticketsByProject).toEqual({});
  });

  it("forces the next refresh wholesale after a scoped failure", async () => {
    useBoardStore.getState().hydrate({ p1: [] }, { p1: [] });
    const projectRoster = vi.fn<BootGateway["projectRoster"]>(async () => ({
      ok: false,
      error: "db gone",
    }));
    const gateway = fakeGateway({ projectRoster });

    expect(await refreshPlanningData({ projectId: "p1", kind: "ticket" }, gateway)).toEqual({
      ok: false,
      error: "db gone",
    });
    projectRoster.mockClear();

    expect(await refreshPlanningData({ projectId: "p1", kind: "ticket" }, gateway)).toEqual({
      ok: true,
    });
    expect(gateway.bootstrap).toHaveBeenCalledTimes(1);
    expect(projectRoster).not.toHaveBeenCalled();
  });

  it("forces the next refresh wholesale after a wholesale failure, then clears recovery", async () => {
    useBoardStore.getState().hydrate({ p1: [] }, { p1: [] });
    let firstCall = true;
    const bootstrap = vi.fn<BootGateway["bootstrap"]>(async () => {
      if (firstCall) {
        firstCall = false;
        return { ok: false, error: "db gone" };
      }
      return {
        ok: true,
        data: payload({ ticketsByProject: { p1: [] }, labelsByProject: { p1: [] } }),
      };
    });
    const gateway = fakeGateway({ bootstrap });

    expect(await refreshPlanningData({}, gateway)).toEqual({ ok: false, error: "db gone" });
    expect(await refreshPlanningData({ projectId: "p1", kind: "ticket" }, gateway)).toEqual({
      ok: true,
    });
    expect(bootstrap).toHaveBeenCalledTimes(2);
    expect(gateway.projectRoster).not.toHaveBeenCalled();

    bootstrap.mockClear();
    expect(await refreshPlanningData({ projectId: "p1", kind: "ticket" }, gateway)).toEqual({
      ok: true,
    });
    expect(bootstrap).not.toHaveBeenCalled();
    expect(gateway.projectRoster).toHaveBeenCalledWith({ projectId: "p1" });
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

    it("keeps the venue boundary around a scoped roster refresh", async () => {
      const snapshot = stubVenueSnapshot({ state: "measured", venue: venue() });
      await seedVenues();
      useBoardStore.getState().hydrate({ p1: [] }, { p1: [] });
      const seen: unknown[] = [];
      const projectRoster = vi.fn<BootGateway["projectRoster"]>(async () => {
        seen.push(useVenueStore.getState().byScope[venueKey("p1", "t1")]);
        seen.push(snapshot.mock.calls.length);
        return { ok: true, tickets: [], labels: [] };
      });
      const gateway = fakeGateway({ projectRoster });

      await refreshPlanningData({ ticketId: "t1", projectId: "p1", kind: "worktree" }, gateway);

      expect(seen).toEqual([{ status: "loading" }, 2]);
      expect(gateway.bootstrap).not.toHaveBeenCalled();
      expect(projectRoster).toHaveBeenCalledWith({ projectId: "p1" });
      await vi.waitFor(() => {
        expect(useVenueStore.getState().byScope[venueKey("p1", "t1")]).toMatchObject({
          status: "ready",
        });
      });
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

  describe("a comment", () => {
    it("re-reads nothing: no row the board holds can have moved", async () => {
      // The board HOLDS p1 — the normal case, and the one that matters. With an
      // empty board the scoped arm is unreachable, so a regression that made a
      // comment read again would still be caught by the bootstrap assertion
      // alone and the scoped assertion below would prove nothing.
      useBoardStore.getState().hydrate({ p1: [] }, { p1: [] });
      const gateway = fakeGateway();
      const before = useBoardStore.getState().lastPlanningChange.version;

      const result = await refreshPlanningData(
        { ticketId: "t1", projectId: "p1", kind: "comment" },
        gateway,
      );

      expect(result).toEqual({ ok: true });
      // BOTH reads, because a comment must make no read at all — not merely a
      // narrower one.
      expect(gateway.bootstrap).not.toHaveBeenCalled();
      expect(gateway.projectRoster).not.toHaveBeenCalled();
      // The per-ticket surfaces still hear about it — the Activity feed IS how
      // a comment reaches the screen.
      expect(useBoardStore.getState().lastPlanningChange).toEqual({
        version: before + 1,
        ticketId: "t1",
        projectId: "p1",
      });
    });

    it("leaves a pending recovery armed, so the next board-moving change still heals", async () => {
      useBoardStore.getState().hydrate({ p1: [] }, { p1: [] });
      const failing = fakeGateway({
        projectRoster: vi.fn<BootGateway["projectRoster"]>(async () => ({
          ok: false,
          error: "db gone",
        })),
      });
      await refreshPlanningData({ projectId: "p1", kind: "ticket" }, failing);
      expect(useBoardStore.getState().planningRecoveryNeeded).toBe(true);

      // A comment returns before the recovery arm is even consulted. It must
      // not be mistaken for the healthy read that clears it.
      const gateway = fakeGateway();
      await refreshPlanningData({ projectId: "p1", kind: "comment" }, gateway);
      expect(useBoardStore.getState().planningRecoveryNeeded).toBe(true);

      await refreshPlanningData({ projectId: "p1", kind: "ticket" }, gateway);
      expect(gateway.bootstrap).toHaveBeenCalledTimes(1);
      expect(gateway.projectRoster).not.toHaveBeenCalled();
    });
  });

  describe("a refresh that throws", () => {
    it("arms recovery, so the next board-moving change is wholesale", async () => {
      useBoardStore.getState().hydrate({ p1: [] }, { p1: [] });
      const gateway = fakeGateway({
        projectRoster: vi.fn<BootGateway["projectRoster"]>(async () => {
          throw new Error("transport died");
        }),
      });

      await expect(
        refreshPlanningData({ projectId: "p1", kind: "ticket" }, gateway),
      ).rejects.toThrow("transport died");
      expect(useBoardStore.getState().planningRecoveryNeeded).toBe(true);

      const healthy = fakeGateway();
      expect(await refreshPlanningData({ projectId: "p1", kind: "ticket" }, healthy)).toEqual({
        ok: true,
      });
      expect(healthy.bootstrap).toHaveBeenCalledTimes(1);
      expect(healthy.projectRoster).not.toHaveBeenCalled();
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

// ---- VC-565: the board on the host protocol (`cloud` on) ------------------------------------

function workspace(id: string): Project {
  return {
    id,
    name: id.toUpperCase(),
    path: `/${id}`,
    ticketPrefix: id.toUpperCase(),
    colorIndex: 0,
    sortOrder: 0,
    createdAt: 1,
    updatedAt: 1,
  };
}

function boardTicket(id: string, projectId: string): Ticket {
  return {
    id,
    projectId,
    ticketNumber: 1,
    title: `Ticket ${id}`,
    body: `# ${id}`,
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
    createdAt: 0,
    updatedAt: 0,
  };
}

/**
 * The desktop's generic IPC bridge (`window.api.sessionRpc`, which serves the
 * board router), answering each project's
 * snapshot from `boards`, acknowledging each feed, and letting the test push
 * feed frames. A path in `refuse` answers the router's refusal.
 */
function stubBoardBridge(
  boards: Record<string, Ticket[]>,
  refuse: Record<string, { code: string; message: string }> = {},
) {
  let listener: ((event: IpcEvent) => void) | undefined;
  let feeds = 0;
  const request = vi.fn(async (call: IpcRequest): Promise<IpcResponse> => {
    const refusal = refuse[call.path];
    if (refusal !== undefined) return { ok: false, error: refusal };
    const { projectId } = call.input as { projectId: string };
    if (call.path === "board.changes") return { ok: true, subscriptionId: `feed-${++feeds}` };
    if (call.path === "board.snapshot") {
      const tickets = boards[projectId];
      if (tickets === undefined) throw new Error(`no board for ${projectId}`);
      return {
        ok: true,
        data: { project: workspace(projectId), tickets, labels: [], cursor: `${projectId}:0` },
      };
    }
    throw new Error(`unexpected ${call.path}`);
  });
  vi.stubGlobal("window", {
    api: {
      sessionRpc: {
        request,
        onEvent: (next: (event: IpcEvent) => void) => {
          listener = next;
          return () => {};
        },
        cancel: vi.fn(),
      },
    },
  });
  const push = (event: IpcEvent) => listener!(event);
  return { request, push };
}

describe("startBoardProtocolIfEnabled", () => {
  beforeEach(() => {
    useBoardStore.getState().hydrate({}, {});
    useProjectsStore.getState().hydrate([workspace("p1"), workspace("p2")], "p1");
  });

  afterEach(() => {
    stopBoardProtocol();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("reads the flag from the host's experiments by default", async () => {
    const query = vi.fn(async () => ({ cloud: { enabled: false } }));
    vi.mocked(sessionRpcClient).mockReturnValueOnce({
      settings: { experiments: { query } },
    } as never);

    expect(await startBoardProtocolIfEnabled()).toBe(false);
    expect(query).toHaveBeenCalledOnce();
    expect(boardProtocol()).toBeNull();
  });

  it("leaves the board on the legacy IPC with the flag off", async () => {
    expect(await startBoardProtocolIfEnabled(async () => false)).toBe(false);
    expect(boardProtocol()).toBeNull();
  });

  it("leaves the board on the legacy IPC when the flag cannot be read", async () => {
    expect(
      await startBoardProtocolIfEnabled(async () => {
        throw new Error("no host");
      }),
    ).toBe(false);
    expect(boardProtocol()).toBeNull();
  });

  it("with the flag on, opens every Workspace from its snapshot and paints the board store", async () => {
    const { request } = stubBoardBridge({
      p1: [boardTicket("a", "p1")],
      p2: [boardTicket("b", "p2")],
    });

    expect(await startBoardProtocolIfEnabled(async () => true)).toBe(true);

    expect(boardProtocol()?.sync.follows("p1")).toBe(true);
    expect(boardProtocol()?.sync.follows("p2")).toBe(true);
    expect(request.mock.calls.map(([call]) => [call.path, call.input])).toEqual(
      expect.arrayContaining([
        ["board.snapshot", { projectId: "p1" }],
        ["board.snapshot", { projectId: "p2" }],
        ["board.changes", { projectId: "p1", lastEventId: "p1:0" }],
        ["board.changes", { projectId: "p2", lastEventId: "p2:0" }],
      ]),
    );
    expect(useBoardStore.getState().ticketsByProject).toEqual({
      p1: [boardTicket("a", "p1")],
      p2: [boardTicket("b", "p2")],
    });
  });

  // VC-713: the remote-Sessions binding is the one owner of the remote listing.
  it("registers no remote Session listing of its own", async () => {
    stubBoardBridge({ p1: [], p2: [] });
    expect(await startBoardProtocolIfEnabled(async () => true)).toBe(true);
    expect(remoteSessionListingRegistrations()).toBe(0);
  });

  it("says which Workspace it could not open, and opens the rest", async () => {
    stubBoardBridge({ p1: [boardTicket("a", "p1")] });
    const error = vi.spyOn(toast, "error");

    expect(await startBoardProtocolIfEnabled(async () => true)).toBe(true);

    expect(useBoardStore.getState().ticketsByProject.p1).toEqual([boardTicket("a", "p1")]);
    expect(error).toHaveBeenCalledWith("Couldn't open the board: no board for p2", {
      duration: 8000,
      closeButton: true,
    });
  });

  it("says what a failed open threw when it is not an Error", async () => {
    stubBoardBridge({});
    vi.spyOn(BoardSync.prototype, "open").mockRejectedValue("refused");
    const error = vi.spyOn(toast, "error");

    await startBoardProtocolIfEnabled(async () => true);

    expect(error).toHaveBeenCalledWith("Couldn't open the board: refused", expect.anything());
  });

  it("routes the feed's project rows, ticket changes and moved checkouts to their stores", async () => {
    const { push } = stubBoardBridge({ p1: [boardTicket("a", "p1")], p2: [] });
    const invalidate = vi.spyOn(useVenueStore.getState(), "invalidateTickets");
    await startBoardProtocolIfEnabled(async () => true);
    const renamed = { ...workspace("p1"), name: "Renamed" };
    const version = useBoardStore.getState().lastPlanningChange.version;

    push({
      kind: "data",
      subscriptionId: "feed-1",
      eventId: "p1:1",
      data: {
        cursor: "p1:1",
        changes: [
          { kind: "project", op: "upsert", id: "p1", projectId: "p1", project: renamed },
          { kind: "comment", op: "upsert", id: "c1", projectId: "p1", ticketId: "a" },
          { kind: "ticket", op: "delete", id: "a", projectId: "p1", checkoutMoved: true },
        ],
      },
    });

    expect(useProjectsStore.getState().projects[0]?.name).toBe("Renamed");
    expect(useBoardStore.getState().lastPlanningChange).toMatchObject({
      version: version + 2,
      ticketId: "a",
      projectId: "p1",
    });
    expect(invalidate).toHaveBeenCalledWith("a");
    expect(useBoardStore.getState().ticketsByProject.p1).toEqual([]);
  });

  it("says when a board write fails", async () => {
    stubBoardBridge(
      { p1: [boardTicket("a", "p1")], p2: [] },
      { "board.moveTickets": { code: "CONFLICT", message: "stale board" } },
    );
    const error = vi.spyOn(toast, "error");
    await startBoardProtocolIfEnabled(async () => true);

    await useBoardStore.getState().moveTicket("p1", "a", "doing", 0);

    expect(error).toHaveBeenCalledWith("Couldn't move ticket: stale board", expect.anything());
    expect(useBoardStore.getState().ticketsByProject.p1?.[0]?.status).toBe("todo");
  });

  it("warns once that a write is still unconfirmed, and keeps it on the board", async () => {
    vi.useFakeTimers();
    try {
      stubBoardBridge(
        { p1: [boardTicket("a", "p1")], p2: [] },
        { "board.moveTickets": { code: "SERVICE_UNAVAILABLE", message: "host-unreachable" } },
      );
      const error = vi.spyOn(toast, "error");
      const warning = vi.spyOn(toast, "warning");
      await startBoardProtocolIfEnabled(async () => true);

      void useBoardStore.getState().moveTicket("p1", "a", "doing", 0);
      await vi.advanceTimersByTimeAsync(60_000);

      expect(warning).toHaveBeenCalledExactlyOnceWith(
        "Still trying to move ticket: host-unreachable",
      );
      expect(error).not.toHaveBeenCalled();
      expect(useBoardStore.getState().ticketsByProject.p1?.[0]?.status).toBe("doing");
    } finally {
      stopBoardProtocol();
      vi.useRealTimers();
    }
  });
});

const unused = () => Promise.reject(new Error("not expected"));

/** A transport nothing should reach: these tests spy on the engine itself. */
function unusedTransport(): BoardSyncTransport {
  return {
    snapshot: vi.fn(unused),
    roster: vi.fn(unused),
    changes: vi.fn(() => () => {}),
    createTicket: vi.fn(unused),
    moveTickets: vi.fn(unused),
    setPriority: vi.fn(unused),
    updateTicket: vi.fn(unused),
    setLabels: vi.fn(unused),
    setLabelColor: vi.fn(unused),
    archiveTicket: vi.fn(unused),
    unarchiveTicket: vi.fn(unused),
    deleteTicket: vi.fn(unused),
    archivedTickets: vi.fn(unused),
  };
}

describe("refreshPlanningData with the protocol on", () => {
  function startProtocol(followed: string[]) {
    const { sync } = startBoardProtocol({
      view: {
        paint: vi.fn(),
        adoptProject: vi.fn(),
        notePlanningChange: vi.fn(),
        checkoutMoved: vi.fn(),
        failed: vi.fn(),
      },
      client: {} as never,
      sync: { transport: unusedTransport() },
    });
    return {
      sync,
      follows: vi.spyOn(sync, "follows").mockImplementation((id) => followed.includes(id)),
      open: vi.spyOn(sync, "open").mockResolvedValue(),
      close: vi.spyOn(sync, "close"),
    };
  }

  beforeEach(() => {
    useBoardStore.getState().hydrate({}, {});
  });

  afterEach(() => {
    stopBoardProtocol();
    vi.restoreAllMocks();
  });

  it("reads nothing for a change to a Workspace the board follows: its feed carries it", async () => {
    startProtocol(["p1"]);
    const gateway = fakeGateway();

    expect(await refreshPlanningData({ projectId: "p1", ticketId: "t1" }, gateway)).toEqual({
      ok: true,
    });

    expect(gateway.bootstrap).not.toHaveBeenCalled();
    expect(gateway.projectRoster).not.toHaveBeenCalled();
  });

  it("re-reads only the Workspace list for an untargeted change: forgets the removed, opens the new", async () => {
    const { open, close } = startProtocol(["p1", "p2"]);
    useProjectsStore.getState().hydrate([workspace("p1"), workspace("p2")], "p2");
    const held = [boardTicket("a", "p1")];
    useBoardStore
      .getState()
      .hydrate({ p1: held, p2: [boardTicket("b", "p2")] }, { p1: [], p2: [] });
    const version = useBoardStore.getState().lastPlanningChange.version;
    const gateway = fakeGateway({
      bootstrap: vi.fn<BootGateway["bootstrap"]>(async () => ({
        ok: true,
        data: payload({
          projects: [workspace("p1"), workspace("p3")],
          // The bootstrap's board slices are the feed's business now.
          ticketsByProject: { p1: [], p3: [] },
        }),
      })),
    });

    expect(await refreshPlanningData({}, gateway)).toEqual({ ok: true });

    expect(gateway.projectRoster).not.toHaveBeenCalled();
    expect(useProjectsStore.getState().projects.map(({ id }) => id)).toEqual(["p1", "p3"]);
    // The selected Workspace was removed: the first one is selected.
    expect(useProjectsStore.getState().selectedProjectId).toBe("p1");
    expect(close).toHaveBeenCalledWith("p2");
    expect(useBoardStore.getState().ticketsByProject.p2).toBeUndefined();
    expect(useBoardStore.getState().ticketsByProject.p1).toBe(held);
    expect(useBoardStore.getState().ticketsByProject.p3).toEqual([]);
    expect(open.mock.calls).toEqual([["p3"]]);
    expect(useBoardStore.getState().lastPlanningChange).toMatchObject({
      version: version + 1,
      ticketId: null,
      projectId: null,
    });
  });

  it("re-reads the list for a change naming a Workspace it does not follow, keeping the selection", async () => {
    startProtocol(["p1"]);
    useProjectsStore.getState().hydrate([workspace("p1")], "p1");
    useBoardStore.getState().hydrate({ p1: [] }, { p1: [] });
    const gateway = fakeGateway({
      bootstrap: vi.fn<BootGateway["bootstrap"]>(async () => ({
        ok: true,
        data: payload({ projects: [workspace("p1"), workspace("p9")] }),
      })),
    });

    expect(await refreshPlanningData({ projectId: "p9" }, gateway)).toEqual({ ok: true });

    expect(gateway.bootstrap).toHaveBeenCalledOnce();
    expect(useProjectsStore.getState().selectedProjectId).toBe("p1");
    expect(useBoardStore.getState().lastPlanningChange).toMatchObject({ projectId: "p9" });
  });

  it("selects nothing when no Workspace is left", async () => {
    startProtocol([]);
    useProjectsStore.getState().hydrate([workspace("p1")], "p1");
    const gateway = fakeGateway();

    expect(await refreshPlanningData({}, gateway)).toEqual({ ok: true });

    expect(useProjectsStore.getState().selectedProjectId).toBeNull();
  });

  it("answers a failed list read untouched, changing nothing", async () => {
    startProtocol([]);
    useProjectsStore.getState().hydrate([workspace("p1")], "p1");
    const gateway = fakeGateway({
      bootstrap: vi.fn<BootGateway["bootstrap"]>(async () => ({ ok: false, error: "db locked" })),
    });

    expect(await refreshPlanningData({}, gateway)).toEqual({ ok: false, error: "db locked" });

    expect(useProjectsStore.getState().projects.map(({ id }) => id)).toEqual(["p1"]);
  });
});

// ---- remote projects (VC-711) --------------------------------------------------------------

/** Claims these projects for a remote host, and only these. */
const claim = (...ids: string[]) =>
  useHostConnectionStore.setState({
    projects: Object.fromEntries(
      ids.map((id) => [id, { hostId: "box", link: { status: "open" } }]),
    ),
  });

describe("remote projects", () => {
  beforeEach(() => {
    // The selection is persisted, and a forgotten board tears down its terminals.
    vi.stubGlobal("window", {
      api: {
        appState: { set: vi.fn(async () => ({ ok: true })) },
        terminal: { kill: vi.fn(async () => ({ ok: true })) },
      },
    });
    useBoardStore.getState().hydrate({}, {});
    useProjectsStore.getState().hydrate([workspace("p1")], "p1");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    useHostConnectionStore.setState({ hosts: [], projects: {} });
    useProjectsStore.getState().hydrate([], null);
    stopBoardProtocol();
    vi.restoreAllMocks();
  });

  it("follows each remote claim: opens its board, and drops its board and row when it goes", async () => {
    const opened: string[] = [];
    const closed: string[] = [];
    const sync = {
      open: vi.fn(async (projectId: string) => {
        opened.push(projectId);
        // Its snapshot's project is its row.
        useProjectsStore.getState().adoptProject(workspace(projectId));
        useBoardStore.getState().paintProtocolBoard(projectId, [], [], new Set());
        if (projectId === "r2") throw new Error("the box is away");
      }),
      close: vi.fn((projectId: string) => void closed.push(projectId)),
    };
    claim("r1");
    const stop = followRemoteProjects(sync);
    await vi.waitFor(() => expect(opened).toEqual(["r1"]));
    expect(useProjectsStore.getState().projects.map(({ id }) => id)).toEqual(["p1", "r1"]);
    // Another claim, whose open fails: the board retries it itself, quietly.
    claim("r1", "r2");
    await vi.waitFor(() => expect(opened).toEqual(["r1", "r2"]));
    // An unrelated change opens nothing twice.
    claim("r1", "r2");
    expect(opened).toEqual(["r1", "r2"]);
    useProjectsStore.getState().select("r1");
    claim("r2");
    expect(closed).toEqual(["r1"]);
    expect(useBoardStore.getState().ticketsByProject.r1).toBeUndefined();
    expect(useProjectsStore.getState().projects.map(({ id }) => id)).toEqual(["p1", "r2"]);
    // The selection falls to the neighbour that took its place.
    expect(useProjectsStore.getState().selectedProjectId).toBe("r2");
    stop();
    claim();
    expect(closed).toEqual(["r1"]);
  });

  it("lets go of the store once the protocol path it served is gone", () => {
    const sync = { open: vi.fn(async () => {}), close: vi.fn() };
    let alive = true;
    followRemoteProjects(sync, useHostConnectionStore, () => alive);
    claim("r1");
    expect(sync.open).toHaveBeenCalledTimes(1);
    alive = false;
    claim();
    claim("r1");
    expect(sync.close).not.toHaveBeenCalled();
    expect(sync.open).toHaveBeenCalledTimes(1);
  });

  it("keeps a remote project's board and row when this Mac's Workspace list is re-read", async () => {
    startBoardProtocol({
      view: {
        paint: vi.fn(),
        adoptProject: vi.fn(),
        notePlanningChange: vi.fn(),
        checkoutMoved: vi.fn(),
        failed: vi.fn(),
      },
      client: {} as never,
      sync: { transport: unusedTransport() },
    });
    vi.spyOn(boardProtocol()!.sync, "open").mockResolvedValue();
    claim("r1");
    useProjectsStore.getState().adoptProject(workspace("r1"));
    const remoteBoard = [boardTicket("rt", "r1")];
    useBoardStore.getState().paintProtocolBoard("r1", remoteBoard, [], new Set());
    useProjectsStore.getState().select("r1");
    const gateway = fakeGateway({
      bootstrap: vi.fn<BootGateway["bootstrap"]>(async () => ({
        ok: true,
        data: payload({ projects: [workspace("p1")], ticketsByProject: { p1: [] } }),
      })),
    });

    expect(await refreshPlanningData({}, gateway)).toEqual({ ok: true });

    expect(useProjectsStore.getState().projects.map(({ id }) => id)).toEqual(["p1", "r1"]);
    expect(useProjectsStore.getState().selectedProjectId).toBe("r1");
    expect(useBoardStore.getState().ticketsByProject.r1).toEqual(remoteBoard);
  });
});

describe("boot remote selection", () => {
  const remote = { hostId: "box-id", projectId: "remote", hostName: "box" };
  const saved = {
    "volli:projects-ui": JSON.stringify({ selectedProjectId: "local", remoteSelection: remote }),
  };
  const local = workspace("local");
  let save: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    vi.useFakeTimers();
    save = vi.fn(async () => ({ ok: true }));
    vi.stubGlobal("window", {
      api: {
        appState: { set: save },
        worktree: { orphans: vi.fn(async () => ({ ok: true, dirty: [] })) },
      },
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    });
    useHostConnectionStore.setState({ hosts: [], projects: {} });
    useProjectsStore.setState({
      projects: [],
      selectedProjectId: null,
      pendingRemoteSelection: null,
    });
  });
  afterEach(async () => {
    // A second, flag-off boot retires the first boot owner and every listener.
    await boot(fakeGateway(), fakeStorage(), async () => false);
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });
  const gateway = () =>
    fakeGateway({
      bootstrap: vi.fn(async () => ({
        ok: true as const,
        data: payload({ projects: [local], appState: saved }),
      })),
    });

  it("boot restores remote intent, waits without selecting a remote id, then selects its authoritative row", async () => {
    await boot(gateway(), fakeStorage(), async () => true);
    const pending = useProjectsStore.getState().pendingRemoteSelection;
    expect(pending).toEqual(remote);
    expect(useProjectsStore.getState().selectedProjectId).toBeNull();
    useHostConnectionStore.setState({
      projects: { remote: { hostId: "box-id", link: { status: "open" } } },
    });
    expect(useProjectsStore.getState().selectedProjectId).toBeNull();
    useProjectsStore.getState().adoptProject(workspace("remote"));
    expect(useProjectsStore.getState().selectedProjectId).toBe("remote");
    expect(useProjectsStore.getState().pendingRemoteSelection).toBeNull();
    expect(save).not.toHaveBeenCalledWith("volli:projects-ui", expect.anything());
    expect(vi.getTimerCount()).toBe(0);
  });

  it("flag off reads the old selectedProjectId and never restores the additive remote value", async () => {
    await boot(gateway(), fakeStorage(), async () => false);
    expect(useProjectsStore.getState().selectedProjectId).toBe("local");
    expect(useProjectsStore.getState().pendingRemoteSelection).toBeNull();
    useProjectsStore.getState().select("local");
    expect(save).toHaveBeenCalledWith(
      "volli:projects-ui",
      JSON.stringify({ selectedProjectId: "local" }),
    );
  });

  it("unreadable flag stays on today's local path", async () => {
    await boot(gateway(), fakeStorage(), async () => {
      throw new Error("unreadable");
    });
    expect(useProjectsStore.getState().selectedProjectId).toBe("local");
    expect(useProjectsStore.getState().pendingRemoteSelection).toBeNull();
  });

  it("absent or unreachable host falls back within one deadline and retires persisted intent", async () => {
    await boot(gateway(), fakeStorage(), async () => true);
    vi.advanceTimersByTime(15_000);
    expect(useProjectsStore.getState().selectedProjectId).toBe("local");
    expect(useProjectsStore.getState().pendingRemoteSelection).toBeNull();
    expect(save).toHaveBeenCalledWith(
      "volli:projects-ui",
      JSON.stringify({ selectedProjectId: "local" }),
    );
    expect(vi.getTimerCount()).toBe(0);
  });

  it("the person's pick wins over boot restore and late remote row", async () => {
    await boot(gateway(), fakeStorage(), async () => true);
    useProjectsStore.getState().select("local");
    useHostConnectionStore.setState({
      projects: { remote: { hostId: "box-id", link: { status: "open" } } },
    });
    useProjectsStore.getState().adoptProject(workspace("remote"));
    expect(useProjectsStore.getState().selectedProjectId).toBe("local");
    expect(useProjectsStore.getState().pendingRemoteSelection).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });
});

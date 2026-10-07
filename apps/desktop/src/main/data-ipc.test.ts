import { DATA_CHANNELS } from "./ipc-descriptors";
import type { SessionListingRow, Ticket } from "@volli/shared";
import type {
  AppStateSetResult,
  BootstrapResult,
  DatabaseResult,
  ProjectAuthorityPolicyResult,
  ProjectCreateResult,
  ProjectFolderResult,
  ProjectMutationResult,
  ProjectRelinkResult,
  ProjectRosterResult,
  ProjectUpdateResult,
  Result,
  RetentionArchiveCleanResult,
  RetentionKeepResult,
  RetentionTtlResult,
  SessionActivityNotice,
  SessionPeekContentResult,
  SessionReadSetResult,
  SessionRenameResult,
  SessionsResult,
  TicketBodyResult,
  TicketCommentResult,
  TicketCommentsResult,
  TicketEventsResult,
  TicketLatestSignalsResult,
  TicketResult,
  TicketStatusEntriesResult,
  TicketsResult,
  VolliIpcChannel,
  WorktreeBranchesResult,
  WorktreeBaseReadResult,
  WorktreeChangeSetResult,
  WorktreeCommitResult,
  WorktreeOrphanCleanupResult,
  WorktreeOrphanDeleteResult,
  WorktreePushPrResult,
  WorktreeRecreateResult,
  WorktreeOrphansResult,
  WorktreeDiffResult,
  WorktreeRemoveResult,
  WorktreeStatusResult,
  WorktreeTrimResult,
  WorktreeTrimScanResult,
  WorktreeTrimSettingsResult,
} from "../ipc/contract";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  MIN_READER_VERSION_KEY,
  recordAutomationRun,
  recordSessionStartedOnce,
  readSessionProvenance,
  readSessionUnread,
  recordMcpOperation,
  insertProject,
  getProjectById,
} from "@volli/host-core/db";

// Keep the production detector entrypoints observable. Project-create tests
// usually inject a detector; this seam also verifies the uninjected default.
const { detectAsync, detectSync } = vi.hoisted(() => ({
  detectAsync: vi.fn<(path: string) => Promise<string | null>>(),
  detectSync: vi.fn<(path: string) => string | null>(),
}));

vi.mock("../../../../packages/host-core/src/project-base-branch", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../../../packages/host-core/src/project-base-branch")
  >()),
  detectProjectBaseBranchAsync: detectAsync,
  detectProjectBaseBranch: detectSync,
}));

// Hoisted above module evaluation, like ipc.test.ts, so the electron mock
// factory can capture into them. `dataChangedSends` collects every
// volli:data-changed fan-out so the broadcast-on-mutation assertions can see it.
const { handlers, dataChangedSends, showItemInFolder, showSaveDialog, worktreeWatch, appMode } =
  vi.hoisted(() => ({
    appMode: { isPackaged: false },
    handlers: new Map<string, (...args: never[]) => unknown>(),
    dataChangedSends: [] as Array<{ channel: string; payload: unknown }>,
    showItemInFolder: vi.fn(),
    showSaveDialog: vi.fn(),
    /**
     * The VC-372 observer hooks of the most recently constructed watch manager.
     * The stand-in below carries them so the snapshot cache sees the same
     * coverage and change reports the real manager sends.
     */
    worktreeWatch: {
      options: undefined as
        | {
            onCoverageChange?: (ticketId: string, covered: boolean) => void;
            onRelevantChange?: (ticketIds: readonly string[]) => void;
          }
        | undefined,
    },
  }));

vi.mock("electron", () => ({
  ipcMain: {
    handle(channel: string, handler: (...args: never[]) => unknown) {
      handlers.set(channel, handler);
    },
  },
  // `worktree-runtime`'s real `worktreeDeps` resolves `blobsRoot` off
  // this — a stable stand-in path is enough since none of the mocked worktree
  // functions below actually read it.
  app: {
    get isPackaged() {
      return appMode.isPackaged;
    },
    getPath: () => "/volli-test-userdata",
  },
  // The worktree remove/orphan-delete broadcasts fan out over BrowserWindow;
  // one fake window records each send so tests can assert the re-hydrate fired.
  BrowserWindow: {
    getAllWindows: () => [
      {
        webContents: {
          isDestroyed: () => false,
          send: (channel: string, payload: unknown) => {
            dataChangedSends.push({ channel, payload });
          },
        },
      },
    ],
    getFocusedWindow: () => undefined,
  },
  dialog: { showSaveDialog },
  shell: { showItemInFolder },
}));

// The worktree module runs real git — mocked so these handler tests never
// shell out; `worktree-runtime`'s `worktreeDeps` stays real (it just builds a
// plain deps object and never touches BrowserWindow unless `onPhase` fires,
// which the mocked functions below never call).
vi.mock("../../../../packages/host-core/src/worktree/index", async () => ({
  remove: vi.fn(),
  listBranches: vi.fn(),
  // The rail reads. Mocked so the coalescing/dedup assertions below can count
  // calls on the seam itself; `worktree/read.test.ts` drives the real verbs.
  readWorktreeStatus: vi.fn(),
  readWorktreeDiff: vi.fn(),
  readWorktreeChangeSet: vi.fn(),
  readWorktreeBaseFile: vi.fn(),
  resolveWorktreeTarget: vi.fn(),
  // The two Done-flow writes the rail's own doors drive (VC-372's invalidation
  // assertions call them); mocked so no real git runs here.
  commitTicketRemaining: vi.fn(),
  publishTicketBranch: vi.fn(),
  // The retention archive-and-clean path — the other door that deletes a
  // checkout the snapshot cache may be holding an answer for.
  archiveAndClean: vi.fn(),
  // The read-only scan and the confirmed cleanup are two verbs now (VC-284);
  // both are mocked here, and both have their own suites under worktree/.
  scanOrphans: vi.fn(),
  cleanupOrphans: vi.fn(),
  // NOT mocked: the cleanup command core and its SQLite ledger are what the
  // channel's receipts and durable history come from, and a stand-in would
  // answer a different question than the one production asks (VC-284 S1).
  ...(await vi.importActual<
    typeof import("../../../../packages/host-core/src/worktree/cleanup-engine")
  >("../../../../packages/host-core/src/worktree/cleanup-engine")),
  ...(await vi.importActual<
    typeof import("../../../../packages/host-core/src/worktree/cleanup-ledger")
  >("../../../../packages/host-core/src/worktree/cleanup-ledger")),
  // NOT mocked: the activity guard is what these handler tests are asserting
  // about, and a hand-rolled stand-in would answer a different question than
  // the one production asks (it canonicalizes both paths).
  ...(await vi.importActual<typeof import("../../../../packages/host-core/src/worktree/activity")>(
    "../../../../packages/host-core/src/worktree/activity",
  )),
  // NOT mocked either: the deletion lease is the serialization the manual
  // delete and the cleanup share (VC-284 review C4), and a stand-in would let
  // this channel claim a lease discipline it does not have.
  ...(await vi.importActual<
    typeof import("../../../../packages/host-core/src/worktree/deletion-lease")
  >("../../../../packages/host-core/src/worktree/deletion-lease")),
  // The scope-switch materialize path (VC-98). Mocked like every other git
  // verb here; the ensure pipeline itself is covered by `worktree/ensure.test.ts`.
  ensure: vi.fn(),
  // Referenced (not called) by `worktree-runtime`'s `worktreeDeps` and by the
  // commit/push handlers' deps — needs a stub export so that value import
  // doesn't throw under strict ESM mocking.
  runGitCapturing: vi.fn(),
  runGitCapturingAsync: vi.fn(),
  runNet: vi.fn(),
  // The trim-on-finish door (VC-340): fired beside the reply on a Done move and
  // on an archive. Mocked because it walks a real filesystem; the composition
  // itself is covered by `worktree/retention.test.ts`.
  trimFinishedWorktree: vi.fn(async () => ({ kind: "skipped" as const, reason: "mocked" })),
  // The manual pass over every owned worktree (VC-340). Mocked for the same
  // reason: it walks real trees. `worktree/trim-sweep.test.ts` drives the real
  // thing against real `git worktree add` checkouts.
  scanTrimTargets: vi.fn(async () => ({ worktrees: [] })),
  trimAllWorktrees: vi.fn(),
  setTrimSettings: vi.fn(() => ({ keepPatterns: [".env"], trimOnFinish: false })),
  // Constructed at registration time; these tests exercise no watch channel, so
  // a no-op stand-in keeps real `fs.watch` handles out of the suite. It does
  // carry the VC-372 observer contract, and its timing matches the real
  // manager's: a subscription reports coverage, an UNWATCH only releases the
  // subscriber (the real root lingers for the rewatch grace), and a ticket-wide
  // teardown reports that coverage ended.
  WorktreeChangeWatchManager: class {
    constructor(options: (typeof worktreeWatch)["options"] = undefined) {
      worktreeWatch.options = options;
    }
    watch = vi.fn((_sender: unknown, ticketId: string) => {
      worktreeWatch.options?.onCoverageChange?.(ticketId, true);
      return { ok: true as const };
    });
    pause = vi.fn(() => ({ ok: true as const }));
    resume = vi.fn(() => ({ ok: true as const }));
    unwatch = vi.fn();
    unwatchTicket = vi.fn((ticketId: string) => {
      worktreeWatch.options?.onCoverageChange?.(ticketId, false);
    });
  },
}));

import { flushDataChangedForTest } from "./broadcast";
import { registerDataIpcHandlers } from "./data-ipc.test-support";
import { watchSessionActivity } from "@volli/host-core/sessions";
import {
  createTestSessionEngine,
  insertSession,
  openTestDb,
  testProject,
  testSession,
  type TestDb,
  resetOrphanScanForTest,
  resetWorktreeSnapshotsForTest,
  resetDeletionLeasesForTest,
} from "@volli/host-core/testing";
import type { AutoTitleRequest } from "@volli/host-core/session-runtime";
import {
  worktreesHome,
  projectContainerName,
  archiveAndClean,
  cleanupOrphans,
  commitTicketRemaining,
  ensure,
  listBranches,
  readWorktreeBaseFile,
  readWorktreeChangeSet,
  readWorktreeDiff,
  readWorktreeStatus,
  publishTicketBranch,
  resolveWorktreeTarget,
  remove as removeWorktree,
  scanOrphans,
  scanTrimTargets,
  setTrimSettings,
  trimAllWorktrees,
  trimFinishedWorktree,
  orphanCleanupEngine,
  acquireDeletionLease,
} from "@volli/host-core/worktree";
import {
  updateTicketFieldsCommand,
  subscribeTicketWake,
  type TicketWake,
} from "@volli/host-core/board";
import {
  EMPTY_SESSION_USAGE_SUMMARY,
  MAX_INLINE_IMAGE_BYTES,
  PERSON_STARTED,
  roleImpliedByTicket,
} from "@volli/shared";
import type { BlobAttachResult, BlobLinksResult } from "../ipc/contract";

/** No executor binding is open: these rows rest at not-live. */
const noOpenBindings = () => [];

/** Fake IPC event; unused by any data-ipc handler, but every handler signature expects one. */
const fakeEvent = { sender: {} };

/** Invokes a captured handler the way `ipcMain.handle` dispatch would. */
function invoke<T>(channel: VolliIpcChannel, ...args: unknown[]): T {
  const handler = handlers.get(channel);
  if (handler === undefined) throw new Error(`no handler registered for ${channel}`);
  return (handler as (...callArgs: unknown[]) => T)(fakeEvent, ...args);
}

/** The production invalidation is frame-window coalesced; handler tests await its delivery. */
async function expectDataChanged(payload: unknown): Promise<void> {
  await vi.waitFor(() => {
    expect(dataChangedSends).toContainEqual({ channel: "volli:data-changed", payload });
  });
}

/**
 * Assert this handler queued NOTHING. The flush is what makes the claim mean
 * anything: the invalidation is coalesced into a frame window, so an unflushed
 * `toEqual([])` inside a synchronous test body is true whether the handler
 * queued an invalidation or not.
 */
function expectNoDataChange(): void {
  flushDataChangedForTest();
  expect(dataChangedSends).toEqual([]);
}

let ctx: TestDb;
let fixtureSessionEngine: ReturnType<typeof createTestSessionEngine>;

// `volli:project-create` now requires an existing directory (main-side path
// validation, see data-ipc.ts) — every fixture project needs a real temp dir
// rather than a fabricated path like the old "/repo/proj". Tracked here so
// `afterEach` can remove them all regardless of which test created them.
const createdProjectDirs: string[] = [];

/** A fresh, real, empty directory for a `volli:project-create` fixture path. */
function freshProjectDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "volli-project-"));
  createdProjectDirs.push(dir);
  return dir;
}

beforeEach(() => {
  appMode.isPackaged = false;
  handlers.clear();
  vi.resetAllMocks();
  dataChangedSends.length = 0;
  // The rail's last-known snapshot is process-wide (VC-372): each test starts
  // from a clean launch, and from no prior test's watch manager hooks.
  resetWorktreeSnapshotsForTest();
  worktreeWatch.options = undefined;
  // The orphan sweep is cached once per launch (module state) — drop it so each
  // test starts from a clean launch and its own mocked sweep runs.
  resetOrphanScanForTest();
  // Same reason: the deletion lease is process-wide, so one test's leak must
  // not refuse the next test's destructive path.
  resetDeletionLeasesForTest();
  ctx = openTestDb();
  fixtureSessionEngine = createTestSessionEngine(ctx.db);
  registerDataIpcHandlers(
    { ok: true, db: ctx.db },
    {
      sessionEngine: fixtureSessionEngine,
      detectBaseBranch: async () => null,
      busyWorktreeSites: async () => [],
    },
  );
});

afterEach(() => {
  // A mutation this test did not inspect is DISCARDED, not delivered, by
  // `src/main/test-setup.ts` — delivering it would put ids this test created
  // into the next test's send log.
  ctx.cleanup();
  for (const dir of createdProjectDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function createProject(): string {
  return createProjectWithPath().id;
}

/** A project plus the directory it tracks — both needed to name the container it owns. */
function createProjectWithPath(): { id: string; path: string } {
  // Most tests exercise other channels and need a synchronous project fixture;
  // project-create itself is exercised through the async IPC handler below.
  const path = freshProjectDir();
  const project = testProject({ name: "Proj", path, ticketPrefix: "PR" });
  insertProject(ctx.db, project);
  return { id: project.id, path };
}

function createTicket(projectId: string): Ticket {
  const result = invoke<TicketResult>("volli:ticket-create", {
    projectId,
    status: "backlog",
    title: "A ticket",
  });
  if (!result.ok) throw new Error(result.error);
  return result.ticket;
}

function archiveTicket(ticketId: string): void {
  const result = invoke<Result>("volli:ticket-archive", { ticketId });
  if (!result.ok) throw new Error(result.error);
}

describe("volli:database", () => {
  it("reads and reveals the actual database file without taking a renderer path", async () => {
    const expectedSize = statSync(ctx.dbPath).size;

    await expect(invoke<Promise<DatabaseResult>>("volli:database")).resolves.toEqual({
      ok: true,
      sizeBytes: expectedSize,
    });
    expect(showItemInFolder).not.toHaveBeenCalled();

    await expect(invoke<Promise<DatabaseResult>>("volli:database", "reveal")).resolves.toEqual({
      ok: true,
      sizeBytes: expectedSize,
    });
    expect(showItemInFolder).toHaveBeenCalledWith(ctx.dbPath);
  });

  it("counts live WAL companion files in the database size", async () => {
    expect(ctx.db.pragma("journal_mode = WAL", { simple: true })).toBe("wal");
    ctx.db
      .prepare("INSERT INTO app_state (key, value, updated_at) VALUES (?, ?, ?)")
      .run("database-size-test", "x".repeat(1024 * 1024), 0);

    const mainBytes = statSync(ctx.dbPath).size;
    const walBytes = statSync(`${ctx.dbPath}-wal`).size;
    const shmBytes = statSync(`${ctx.dbPath}-shm`).size;
    expect(walBytes).toBeGreaterThan(0);

    await expect(invoke<Promise<DatabaseResult>>("volli:database")).resolves.toEqual({
      ok: true,
      sizeBytes: mainBytes + walBytes + shmBytes,
    });
  });

  it("opens a save dialog before exporting", async () => {
    showSaveDialog.mockResolvedValueOnce({ canceled: true });

    await expect(
      invoke<Promise<DatabaseResult>>("volli:database", "export"),
    ).resolves.toMatchObject({
      ok: true,
    });
    expect(showSaveDialog).toHaveBeenCalledWith(
      expect.objectContaining({ filters: [{ name: "JSON", extensions: ["json"] }] }),
    );
  });
});

/**
 * The door the product was missing (VC-172). The handler is where a policy
 * document is JUDGED — `resolveAuthorityPolicy` degrades a bad one on the attach
 * path, and that bargain is only honest if something refuses it earlier, where a
 * person is present to be told.
 */
describe("project removal", () => {
  it("tells the host after the project is gone, so it releases the board feed it held", () => {
    const removed = vi.fn<(projectId: string) => void>();
    registerDataIpcHandlers(
      { ok: true, db: ctx.db },
      { sessionEngine: fixtureSessionEngine, onProjectRemoved: removed },
    );
    const projectId = createProject();
    removed.mockImplementation(() => {
      expect(getProjectById(ctx.db, projectId)).toBeUndefined();
    });
    expect(invoke<ProjectMutationResult>("volli:project-remove", projectId)).toEqual({ ok: true });
    expect(removed).toHaveBeenCalledExactlyOnceWith(projectId);
  });
});

describe("MCP settings IPC", () => {
  it("routes typed project-scoped settings operations through the main-owned service", async () => {
    const list = vi.fn(() => [{ id: "server-1" }]);
    const save = vi.fn(async () => ({ ok: true, server: { id: "server-1" } }));
    const accessFor = vi.fn(() => ({ "server-1": { signIn: "signed-in", missingSecrets: [] } }));
    registerDataIpcHandlers(
      { ok: true, db: ctx.db },
      { sessionEngine: fixtureSessionEngine, mcpSettings: { list, save, accessFor } as never },
    );

    // One read carries what the pane shows: the servers, the management
    // history beside them (VC-380), and where each stands on credentials
    // (VC-470). History is empty here because no operation was recorded.
    expect(invoke("volli:mcp-list" as never, { projectId: "project-1" })).toEqual({
      ok: true,
      servers: [{ id: "server-1" }],
      operations: [],
      access: { "server-1": { signIn: "signed-in", missingSecrets: [] } },
    });
    await expect(
      invoke<Promise<unknown>>("volli:mcp-save" as never, {
        projectId: "project-1",
        server: { id: "server-1" },
        enabledTools: ["echo"],
      }),
    ).resolves.toEqual({ ok: true, server: { id: "server-1" } });
    expect(list).toHaveBeenCalledWith("project-1");
    expect(save).toHaveBeenCalledWith({
      projectId: "project-1",
      server: { id: "server-1" },
      enabledTools: ["echo"],
    });
  });

  it("carries this project's management history on the same read, scoped to it", () => {
    insertProject(ctx.db, testProject({ id: "project-1", name: "One", path: "/repo/one" }));
    insertProject(ctx.db, testProject({ id: "project-2", name: "Two", path: "/repo/two" }));
    const entry = {
      serverId: "server-1",
      serverName: "Fixture",
      operation: "install" as const,
      outcome: "applied" as const,
      detail: null,
      provenance: { source: null, registryType: null, version: null, digest: null },
      sessionId: "session-1",
      ticketId: null,
    };
    recordMcpOperation(
      ctx.db,
      { ...entry, id: "session-1:a", projectId: "project-1", summary: "Installed Fixture." },
      100,
    );
    recordMcpOperation(
      ctx.db,
      { ...entry, id: "session-1:b", projectId: "project-2", summary: "Elsewhere." },
      200,
    );
    registerDataIpcHandlers(
      { ok: true, db: ctx.db },
      {
        sessionEngine: fixtureSessionEngine,
        mcpSettings: { list: () => [], accessFor: () => ({}) } as never,
      },
    );

    const result = invoke<{ operations: { summary: string }[] }>("volli:mcp-list" as never, {
      projectId: "project-1",
    });

    // The pane reads one project. Another project's history appearing here
    // would be a leak between projects, not merely untidy.
    expect(result.operations.map((row) => row.summary)).toEqual(["Installed Fixture."]);
  });
});

describe("MCP sign-in IPC (VC-470)", () => {
  it("routes sign-in, cancel, sign-out and draft disposal to the service", async () => {
    const finish = Promise.withResolvers<unknown>();
    const signIn = vi.fn(() => finish.promise);
    const cancelSignIn = vi.fn(() => {
      finish.resolve({ ok: false, cancelled: true, message: "The sign-in to X was cancelled." });
      return { ok: true };
    });
    const signOut = vi.fn(() => ({ ok: true }));
    const discardDraft = vi.fn(() => ({ ok: true }));
    registerDataIpcHandlers(
      { ok: true, db: ctx.db },
      {
        sessionEngine: fixtureSessionEngine,
        mcpSettings: { signIn, cancelSignIn, signOut, discardDraft } as never,
      },
    );

    const waiting = invoke<Promise<unknown>>("volli:mcp-sign-in" as never, {
      projectId: "project-1",
      serverId: "server-1",
    });
    expect(signIn).toHaveBeenCalledWith({ projectId: "project-1", serverId: "server-1" });
    expect(
      invoke("volli:mcp-cancel-sign-in" as never, { projectId: "project-1", serverId: "server-1" }),
    ).toEqual({ ok: true });
    expect(cancelSignIn).toHaveBeenCalledWith({ projectId: "project-1", serverId: "server-1" });
    await expect(waiting).resolves.toEqual({
      ok: false,
      cancelled: true,
      error: "The sign-in to X was cancelled.",
    });

    expect(
      invoke("volli:mcp-sign-out" as never, { projectId: "project-1", serverId: "server-1" }),
    ).toEqual({ ok: true });
    expect(signOut).toHaveBeenCalledWith({ projectId: "project-1", serverId: "server-1" });
    expect(
      invoke("volli:mcp-discard-draft" as never, { projectId: "project-1", serverId: "draft-1" }),
    ).toEqual({ ok: true });
    expect(discardDraft).toHaveBeenCalledWith({ projectId: "project-1", serverId: "draft-1" });
  });

  it("answers a completed sign-in with its message, keyed by the draft's own id", async () => {
    const signIn = vi.fn(async () => ({ ok: true, message: "Signed in to Draft." }));
    registerDataIpcHandlers(
      { ok: true, db: ctx.db },
      { sessionEngine: fixtureSessionEngine, mcpSettings: { signIn } as never },
    );

    await expect(
      invoke<Promise<unknown>>("volli:mcp-sign-in" as never, {
        projectId: "project-1",
        server: { id: "draft-1" },
        secrets: { "header:authorization": "typed" },
      }),
    ).resolves.toEqual({ ok: true, message: "Signed in to Draft." });
  });
});

describe("volli:project-authority-policy", () => {
  it("records a departure and answers with the project carrying it", () => {
    const id = createProject();

    const result = invoke<ProjectAuthorityPolicyResult>("volli:project-authority-policy", {
      id,
      override: { budgets: { delegationExceeded: "refuse" } },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The DEPARTURES ride back, not the resolved document — the pane needs to
    // tell a chosen value from an inherited one.
    expect(result.project.authorityPolicy).toEqual({ budgets: { delegationExceeded: "refuse" } });
  });

  it("REFUSES an unknown field, naming it, rather than storing a document that governs nothing", () => {
    const id = createProject();

    const result = invoke<ProjectAuthorityPolicyResult>("volli:project-authority-policy", {
      id,
      override: { enforcment: "enforce" },
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toEqual(["Unknown field: enforcment."]);
    // And nothing was written: a refused write leaves the project inheriting.
    expect(getProjectById(ctx.db, id)?.authorityPolicy).toBeNull();
  });

  it("reports every reason at once, so one fix does not surface the next", () => {
    const id = createProject();

    const result = invoke<ProjectAuthorityPolicyResult>("volli:project-authority-policy", {
      id,
      override: {
        budgets: { delegationExceeded: "sideways" },
        actors: { session: { nope: true } },
      },
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toHaveLength(2);
  });

  it("clears every departure on null", () => {
    const id = createProject();
    invoke("volli:project-authority-policy", {
      id,
      override: { budgets: { delegationExceeded: "refuse" } },
    });

    const result = invoke<ProjectAuthorityPolicyResult>("volli:project-authority-policy", {
      id,
      override: null,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.project.authorityPolicy).toBeNull();
  });

  it("refuses a project it does not know", () => {
    const result = invoke<ProjectAuthorityPolicyResult>("volli:project-authority-policy", {
      id: "missing",
      override: {},
    });

    expect(result).toEqual({ ok: false, error: "Unknown project" });
  });
});

function deferredBranch(): {
  promise: Promise<string | null>;
  resolve: (branch: string | null) => void;
} {
  let resolve!: (branch: string | null) => void;
  const promise = new Promise<string | null>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("volli:project-create — workspace-unique ticket prefixes", () => {
  it("uses the async detector by default without a test override", async () => {
    handlers.clear();
    const path = freshProjectDir();
    const branch = deferredBranch();
    detectAsync.mockReturnValue(branch.promise);
    detectSync.mockReturnValue("sync-default");
    registerDataIpcHandlers({ ok: true, db: ctx.db }, { sessionEngine: fixtureSessionEngine });

    const pending = invoke<Promise<ProjectCreateResult>>("volli:project-create", {
      path,
      name: "Volli Code",
    });
    await vi.waitFor(() => expect(detectAsync).toHaveBeenCalledExactlyOnceWith(path));
    expect(detectSync).not.toHaveBeenCalled();
    expect(invoke<BootstrapResult>("volli:data-bootstrap")).toMatchObject({
      ok: true,
      data: { projects: [] },
    });

    branch.resolve("trunk");
    await expect(pending).resolves.toMatchObject({
      ok: true,
      created: true,
      project: { baseBranch: "trunk" },
    });
  });

  it("pins the repository's detected base branch when a project is added", async () => {
    handlers.clear();
    const volliPath = freshProjectDir();
    const detectBaseBranch = vi.fn(async (path: string) => (path === volliPath ? "trunk" : null));
    registerDataIpcHandlers(
      { ok: true, db: ctx.db },
      { sessionEngine: fixtureSessionEngine, detectBaseBranch },
    );

    const result = await invoke<Promise<ProjectCreateResult>>("volli:project-create", {
      path: volliPath,
      name: "Volli Code",
    });

    expect(detectBaseBranch).toHaveBeenCalledWith(volliPath);
    expect(result).toMatchObject({ ok: true, project: { baseBranch: "trunk" } });
  });

  it("keeps other IPC available while detection is pending", async () => {
    handlers.clear();
    const path = freshProjectDir();
    const branch = deferredBranch();
    const detectBaseBranch = vi.fn(() => branch.promise);
    registerDataIpcHandlers(
      { ok: true, db: ctx.db },
      { sessionEngine: fixtureSessionEngine, detectBaseBranch },
    );

    const pending = invoke<Promise<ProjectCreateResult>>("volli:project-create", {
      path,
      name: "Volli Code",
    });
    await vi.waitFor(() => expect(detectBaseBranch).toHaveBeenCalledWith(path));
    expect(invoke<BootstrapResult>("volli:data-bootstrap")).toMatchObject({
      ok: true,
      data: { projects: [] },
    });

    branch.resolve("trunk");
    await expect(pending).resolves.toMatchObject({
      ok: true,
      created: true,
      project: { baseBranch: "trunk" },
    });
  });

  it("returns one project for concurrent creates of the same path", async () => {
    handlers.clear();
    const path = freshProjectDir();
    const branch = deferredBranch();
    const detectBaseBranch = vi.fn(() => branch.promise);
    registerDataIpcHandlers(
      { ok: true, db: ctx.db },
      { sessionEngine: fixtureSessionEngine, detectBaseBranch },
    );

    const first = invoke<Promise<ProjectCreateResult>>("volli:project-create", {
      path,
      name: "Volli Code",
    });
    await vi.waitFor(() => expect(detectBaseBranch).toHaveBeenCalledTimes(1));
    const second = invoke<Promise<ProjectCreateResult>>("volli:project-create", {
      path,
      name: "Different Name",
    });
    await vi.waitFor(() => expect(detectBaseBranch).toHaveBeenCalledTimes(2));
    branch.resolve("main");
    const [a, b] = await Promise.all([first, second]);

    expect(a).toMatchObject({ ok: true, created: true });
    expect(b).toMatchObject({ ok: true, created: false });
    if (!a.ok || !b.ok) return;
    expect(b.project).toMatchObject(a.project);
    expect(invoke<BootstrapResult>("volli:data-bootstrap")).toMatchObject({
      ok: true,
      data: { projects: [a.project] },
    });
    await expect(
      invoke<Promise<ProjectCreateResult>>("volli:project-create", {
        path,
        name: "Another Name",
      }),
    ).resolves.toMatchObject({ ok: true, created: false, project: a.project });
    expect(detectBaseBranch).toHaveBeenCalledTimes(2);
  });

  it("allocates prefix, color and order from committed state after concurrent detection", async () => {
    handlers.clear();
    const [firstPath, secondPath, collisionPath] = [
      freshProjectDir(),
      freshProjectDir(),
      freshProjectDir(),
    ];
    const firstBranch = deferredBranch();
    const secondBranch = deferredBranch();
    const collisionBranch = deferredBranch();
    const branches = new Map([
      [firstPath, firstBranch],
      [secondPath, secondBranch],
      [collisionPath, collisionBranch],
    ]);
    const detectBaseBranch = vi.fn((path: string) => {
      const branch = branches.get(path);
      if (!branch) throw new Error("Unexpected path");
      return branch.promise;
    });
    registerDataIpcHandlers(
      { ok: true, db: ctx.db },
      { sessionEngine: fixtureSessionEngine, detectBaseBranch },
    );

    const first = invoke<Promise<ProjectCreateResult>>("volli:project-create", {
      path: firstPath,
      name: "Volli Code",
    });
    const second = invoke<Promise<ProjectCreateResult>>("volli:project-create", {
      path: secondPath,
      name: "Other Project",
    });
    const collision = invoke<Promise<ProjectCreateResult>>("volli:project-create", {
      path: collisionPath,
      name: "Visual Compiler",
    });
    await vi.waitFor(() => expect(detectBaseBranch).toHaveBeenCalledTimes(3));
    firstBranch.resolve("trunk");
    const a = await first;
    expect(a).toMatchObject({ ok: true, created: true, project: { colorIndex: 0, sortOrder: 0 } });
    collisionBranch.resolve(null);
    await expect(collision).resolves.toEqual({
      ok: false,
      error: 'Ticket prefix "VC" is already used by Volli Code.',
    });
    secondBranch.resolve("main");
    await expect(second).resolves.toMatchObject({
      ok: true,
      created: true,
      project: { colorIndex: 1, sortOrder: 1, baseBranch: "main" },
    });
    expect(invoke<BootstrapResult>("volli:data-bootstrap")).toMatchObject({
      ok: true,
      data: { projects: [{ path: firstPath }, { path: secondPath }] },
    });
  });

  it("refuses missing paths and files without running detection", async () => {
    handlers.clear();
    const directory = freshProjectDir();
    const file = join(directory, "file");
    writeFileSync(file, "not a directory");
    const detectBaseBranch = vi.fn(async () => "main");
    registerDataIpcHandlers(
      { ok: true, db: ctx.db },
      { sessionEngine: fixtureSessionEngine, detectBaseBranch },
    );

    await expect(
      invoke<Promise<ProjectCreateResult>>("volli:project-create", {
        path: join(directory, "missing"),
        name: "Missing",
      }),
    ).resolves.toEqual({ ok: false, error: "Project path does not exist" });
    await expect(
      invoke<Promise<ProjectCreateResult>>("volli:project-create", {
        path: file,
        name: "File",
      }),
    ).resolves.toEqual({ ok: false, error: "Project path is not a directory" });
    expect(detectBaseBranch).not.toHaveBeenCalled();
  });

  it("surfaces the colliding project instead of creating an ambiguous display-id namespace", async () => {
    const first = await invoke<Promise<ProjectCreateResult>>("volli:project-create", {
      path: freshProjectDir(),
      name: "Volli Code",
    });
    const second = await invoke<Promise<ProjectCreateResult>>("volli:project-create", {
      path: freshProjectDir(),
      name: "Visual Compiler",
    });

    expect(first.ok).toBe(true);
    expect(second).toEqual({
      ok: false,
      error: 'Ticket prefix "VC" is already used by Volli Code.',
    });
  });
});

describe("volli:project-relink — a folder that was renamed or moved", () => {
  /**
   * Renames `from` to a fresh sibling, and tracks the result for cleanup.
   *
   * The target name is MADE rather than fixed: the temp root is shared with
   * every other test process on the machine, and a `rename` onto a name a
   * previous run left behind fails with ENOTEMPTY rather than saying so.
   */
  function renameProjectDir(from: string, hint: string): string {
    const to = `${mkdtempSync(join(tmpdir(), `volli-${hint}-`))}/moved`;
    createdProjectDirs.push(dirname(to));
    renameSync(from, to);
    return to;
  }

  it("reports the registered folder as missing once it has been renamed", async () => {
    const project = createProjectWithPath();
    renameProjectDir(project.path, "renamed");

    await expect(
      invoke<Promise<ProjectFolderResult>>("volli:project-folder-check", {
        projectId: project.id,
      }),
    ).resolves.toEqual({ ok: true, path: project.path, state: "missing" });
  });

  // The ticket's headline: the SAME project, its tickets still on it, now
  // pointing at where the folder actually is. Nothing here creates a project.
  it("reconnects the existing project, keeping its id and its tickets", async () => {
    const project = createProjectWithPath();
    const ticket = createTicket(project.id);
    const moved = renameProjectDir(project.path, "moved");

    const result = await invoke<Promise<ProjectRelinkResult>>("volli:project-relink", {
      id: project.id,
      path: moved,
    });

    expect(result.ok && result.project.id).toBe(project.id);
    expect(result.ok && result.project.path).toBe(moved);
    const bootstrap = invoke<BootstrapResult>("volli:data-bootstrap");
    expect(bootstrap.ok && bootstrap.data.projects).toHaveLength(1);
    expect(bootstrap.ok && bootstrap.data.projects[0]?.path).toBe(moved);
    expect(
      invoke<TicketsResult>("volli:data-project-roster", { projectId: project.id }),
    ).toMatchObject({ ok: true, tickets: [{ id: ticket.id }] });
    await expect(
      invoke<Promise<ProjectFolderResult>>("volli:project-folder-check", {
        projectId: project.id,
      }),
    ).resolves.toEqual({ ok: true, path: moved, state: "present" });
  });

  // Every surface that reads a project path has to re-read: the rail, the file
  // browsers, Configure, and the renderer's own root allowlist mirror. Without
  // the invalidation the relink is committed and invisible.
  it("announces the change so every surface re-reads the path", async () => {
    const project = createProjectWithPath();
    const moved = renameProjectDir(project.path, "announced");

    await invoke<Promise<ProjectRelinkResult>>("volli:project-relink", {
      id: project.id,
      path: moved,
    });

    // UNTARGETED on purpose (no `ticketId`): the path this relink rewrote is
    // read by the rail, both file browsers, Configure and the renderer's root
    // allowlist mirror, and the container move rewrote ticket rows as well. The
    // conservative arm of the contract is the correct one here.
    await expectDataChanged({ entity: "tickets", projectId: project.id });
  });

  it("announces nothing when the relink was refused", async () => {
    const project = createProjectWithPath();

    await invoke<Promise<ProjectRelinkResult>>("volli:project-relink", {
      id: project.id,
      path: join(project.path, "nowhere-at-all"),
    });

    expectNoDataChange();
  });

  it("refuses a folder another project already tracks rather than duplicating it", async () => {
    const project = createProjectWithPath();
    // AWAITED: `volli:project-create` detects the base branch off the main
    // thread, so the handler is async and a synchronous read of it would test a
    // Promise's absent `ok` field rather than the answer.
    const other = await invoke<Promise<ProjectCreateResult>>("volli:project-create", {
      path: freshProjectDir(),
      name: "Atlas",
    });
    if (!other.ok) throw new Error(other.error);

    const result = await invoke<Promise<ProjectRelinkResult>>("volli:project-relink", {
      id: project.id,
      path: other.project.path,
    });

    expect(result).toEqual({
      ok: false,
      refusal: "claimed",
      error: "Atlas already tracks that folder.",
    });
    const bootstrap = invoke<BootstrapResult>("volli:data-bootstrap");
    expect(bootstrap.ok && bootstrap.data.projects).toHaveLength(2);
  });

  // Against the REAL disk, and through a symlink rather than a case difference,
  // because the two platforms this suite runs on disagree about case and agree
  // about links. A path that reaches a folder another project tracks is that
  // folder, however it is spelled — and taking it would leave two rows on one
  // checkout, which is the duplicate this channel exists to refuse.
  it("refuses a path that reaches a tracked folder by another route", async () => {
    const project = createProjectWithPath();
    const other = await invoke<Promise<ProjectCreateResult>>("volli:project-create", {
      path: freshProjectDir(),
      name: "Atlas",
    });
    if (!other.ok) throw new Error(other.error);
    const link = join(mkdtempSync(join(tmpdir(), "volli-link-")), "atlas");
    createdProjectDirs.push(dirname(link));
    symlinkSync(other.project.path, link);

    await expect(
      invoke<Promise<ProjectRelinkResult>>("volli:project-relink", {
        id: project.id,
        path: link,
      }),
    ).resolves.toEqual({
      ok: false,
      refusal: "claimed",
      error: "Atlas already tracks that folder.",
    });
  });

  it("refuses a replacement folder that is not on disk", async () => {
    const project = createProjectWithPath();

    await expect(
      invoke<Promise<ProjectRelinkResult>>("volli:project-relink", {
        id: project.id,
        path: join(project.path, "nowhere-at-all"),
      }),
    ).resolves.toEqual({ ok: false, refusal: "missing", error: "That folder doesn't exist." });
  });

  // A project can be any folder, so a path that turns out to be a file is a
  // refusal with its own sentence rather than a crash.
  it("refuses a replacement that is a file rather than a folder", async () => {
    const project = createProjectWithPath();
    const file = join(freshProjectDir(), "not-a-folder.txt");
    writeFileSync(file, "");

    await expect(
      invoke<Promise<ProjectRelinkResult>>("volli:project-relink", {
        id: project.id,
        path: file,
      }),
    ).resolves.toEqual({
      ok: false,
      refusal: "not-a-directory",
      error: "That's a file, not a folder.",
    });
  });

  it("refuses an unknown project", async () => {
    await expect(
      invoke<Promise<ProjectRelinkResult>>("volli:project-relink", {
        id: "ghost",
        path: freshProjectDir(),
      }),
    ).resolves.toEqual({ ok: false, error: "Unknown project" });
    await expect(
      invoke<Promise<ProjectFolderResult>>("volli:project-folder-check", { projectId: "ghost" }),
    ).resolves.toEqual({ ok: false, error: "Unknown project" });
  });
});

describe("volli:project-update — pinned base branch", () => {
  it("persists an editable base branch and returns the updated project", () => {
    const projectId = createProject();

    const result = invoke<{ ok: boolean; project?: { baseBranch: string | null } }>(
      "volli:project-update",
      { id: projectId, baseBranch: "release/next" },
    );

    expect(result).toEqual(
      expect.objectContaining({
        ok: true,
        project: expect.objectContaining({ baseBranch: "release/next" }),
      }),
    );
    const bootstrap = invoke<BootstrapResult>("volli:data-bootstrap");
    expect(bootstrap).toMatchObject({
      ok: true,
      data: { projects: [{ id: projectId, baseBranch: "release/next" }] },
    });
  });

  it("trims a setup command and clears it to null on an empty string, leaving it untouched when omitted", () => {
    const projectId = createProject();

    const set = invoke<{ ok: boolean; project?: { setupCommand: string | null } }>(
      "volli:project-update",
      { id: projectId, baseBranch: null, setupCommand: "  pnpm install  " },
    );
    expect(set).toEqual(
      expect.objectContaining({
        ok: true,
        project: expect.objectContaining({ setupCommand: "pnpm install" }),
      }),
    );

    const untouched = invoke<{ ok: boolean; project?: { setupCommand: string | null } }>(
      "volli:project-update",
      { id: projectId, baseBranch: "main" },
    );
    expect(untouched.project?.setupCommand).toBe("pnpm install");

    const cleared = invoke<{ ok: boolean; project?: { setupCommand: string | null } }>(
      "volli:project-update",
      { id: projectId, baseBranch: "main", setupCommand: "   " },
    );
    expect(cleared).toEqual(
      expect.objectContaining({
        ok: true,
        project: expect.objectContaining({ setupCommand: null }),
      }),
    );
  });
});

describe("volli:project-session-defaults — Chat model", () => {
  it("updates the Chat model without changing the retired harness column", () => {
    const projectId = createProject();
    ctx.db.prepare("UPDATE projects SET session_harness = 'codex' WHERE id = ?").run(projectId);
    const model = {
      providerId: "anthropic",
      modelId: "claude-opus-4-6",
      reasoningLevel: "high" as const,
    };

    const result = invoke<ProjectUpdateResult>("volli:project-session-defaults", {
      id: projectId,
      model,
    });

    expect(result).toMatchObject({ ok: true, project: { id: projectId, sessionModel: model } });
    expect(
      ctx.db.prepare("SELECT session_harness FROM projects WHERE id = ?").get(projectId),
    ).toEqual({ session_harness: "codex" });
  });
});

describe("ticket-scoped invalidations carry their project (VC-387)", () => {
  it("names the project on a retention pin, so windows re-read one board not all of them", async () => {
    const projectId = createProject();
    const ticket = createTicket(projectId);
    dataChangedSends.length = 0;

    const kept = invoke<RetentionKeepResult>("volli:retention-keep", {
      ticketId: ticket.id,
      keep: true,
    });

    expect(kept.ok).toBe(true);
    // Without the projectId the renderer cannot scope its refresh and falls
    // back to a whole-board bootstrap — the exact read this ticket removes.
    await expectDataChanged({
      entity: "tickets",
      ticketId: ticket.id,
      projectId,
      kind: "retention",
    });
  });

  // `volli:retention-dismiss` and the two worktree publish paths take the same
  // `ticketScope` helper this pins; they are not asserted separately because the
  // retention watcher is a process-wide singleton that broadcasts on its own
  // schedule, and a second assertion here would be pinning the coalescer's merge
  // rather than the scope.
});

describe("volli:data-project-roster — the steady-state refresh read (VC-387)", () => {
  it("answers one project's live board, carrying no ticket bodies", async () => {
    const projectId = createProject();
    const other = await invoke<Promise<ProjectCreateResult>>("volli:project-create", {
      path: freshProjectDir(),
      name: "Other",
    });
    if (!other.ok) throw new Error(other.error);
    const mine = invoke<TicketResult>("volli:ticket-create", {
      projectId,
      status: "todo",
      title: "Mine",
      body: "# A body long enough to be worth not re-reading",
      labels: ["perf"],
    });
    if (!mine.ok) throw new Error(mine.error);
    createTicket(other.project.id);

    const roster = invoke<ProjectRosterResult>("volli:data-project-roster", { projectId });

    if (!roster.ok) throw new Error(roster.error);
    expect(roster.tickets).toEqual([
      expect.objectContaining({ id: mine.ticket.id, title: "Mine", labels: ["perf"] }),
    ]);
    // The point of the read: the column the whole-board re-read spends its
    // bytes on never crosses.
    expect(roster.tickets[0]).not.toHaveProperty("body");
    expect(roster.labels).toEqual([expect.objectContaining({ name: "perf", projectId })]);
  });

  it("names the same live tickets, in the same order, as the boot payload it replaces", () => {
    const projectId = createProject();
    const first = createTicket(projectId);
    const second = createTicket(projectId);
    archiveTicket(second.id);

    const boot = invoke<BootstrapResult>("volli:data-bootstrap");
    if (!boot.ok) throw new Error(boot.error);
    const roster = invoke<ProjectRosterResult>("volli:data-project-roster", { projectId });
    if (!roster.ok) throw new Error(roster.error);

    expect(roster.tickets.map(({ id }) => id)).toEqual(
      boot.data.ticketsByProject[projectId]?.map(({ id }) => id),
    );
    expect(roster.tickets.map(({ id }) => id)).toEqual([first.id]);
  });

  it("refuses an unknown project rather than answering an empty board for it", () => {
    const roster = invoke<ProjectRosterResult>("volli:data-project-roster", {
      projectId: "no-such-project",
    });

    expect(roster).toEqual({ ok: false, error: "Unknown project" });
  });
});

describe("volli:ticket-body — the per-ticket body read (VC-387)", () => {
  it("answers the body the roster no longer carries", () => {
    const projectId = createProject();
    const created = invoke<TicketResult>("volli:ticket-create", {
      projectId,
      status: "todo",
      title: "With a body",
      body: "# Scope\n\nDo the thing.",
    });
    if (!created.ok) throw new Error(created.error);

    const read = invoke<TicketBodyResult>("volli:ticket-body", { ticketId: created.ticket.id });

    expect(read).toEqual({ ok: true, body: "# Scope\n\nDo the thing." });
  });

  it("refuses a ticket that is gone rather than answering an empty body", () => {
    const read = invoke<TicketBodyResult>("volli:ticket-body", { ticketId: "no-such-ticket" });

    expect(read).toEqual({ ok: false, error: "Unknown ticket" });
  });
});

describe("volli:ticket-create — ticket numbers never recycle across a hard delete (#35)", () => {
  it("skips a hard-deleted ticket's number instead of reusing it", () => {
    const projectId = createProject();

    const one = createTicket(projectId);
    const two = createTicket(projectId);
    const three = createTicket(projectId);
    expect([one.ticketNumber, two.ticketNumber, three.ticketNumber]).toEqual([1, 2, 3]);

    // Archive then hard-delete the highest-numbered ticket — the real
    // delete-from-archive path (`volli:ticket-delete` only permits deleting an
    // already-archived ticket).
    const archived = invoke<Result>("volli:ticket-archive", { ticketId: three.id });
    expect(archived.ok).toBe(true);
    const deleted = invoke<Result>("volli:ticket-delete", { ticketId: three.id });
    expect(deleted.ok).toBe(true);

    // Before the fix, MAX(ticket_number)+1 over the remaining rows would
    // reissue 3 here, colliding with the deleted ticket's retained worktree
    // branch. The counter must instead keep moving forward.
    const four = createTicket(projectId);
    expect(four.ticketNumber).toBe(4);
  });
});

describe("archiving or deleting a ticket drops its Sessions' saved tool output (VC-469)", () => {
  function piToolOutput(sessionsRoot: string, ticketId: string, name: string): string {
    const directory = join(sessionsRoot, "--Users-test-project--");
    mkdirSync(directory, { recursive: true });
    const sidecar = join(directory, `${name}.jsonl`);
    writeFileSync(sidecar, "{}\n");
    const output = join(directory, `${name}.tool-output`);
    mkdirSync(output, { recursive: true });
    writeFileSync(join(output, "tc-1.txt"), "saved");
    const session = testSession(
      ctx.db.prepare("SELECT project_id FROM tickets WHERE id = ?").pluck().get(ticketId) as string,
      ticketId,
    );
    insertSession(ctx.db, session);
    ctx.db
      .prepare(
        `UPDATE session_attachments SET adapter_id = 'pi', native_detail = ? WHERE session_id = ?`,
      )
      .run(
        JSON.stringify({
          kind: "volli.native-binding.v1",
          locator: { runtime: "pi", sessionId: name, sessionFilePath: sidecar },
        }),
        session.id,
      );
    return output;
  }

  it("removes it on archive, and on deleting a ticket archived before this existed", () => {
    const sessionsRoot = mkdtempSync(join(tmpdir(), "volli-pi-sessions-"));
    createdProjectDirs.push(sessionsRoot);
    registerDataIpcHandlers(
      { ok: true, db: ctx.db },
      {
        sessionEngine: fixtureSessionEngine,
        detectBaseBranch: async () => null,
        piSessionsDirectory: sessionsRoot,
      },
    );
    const projectId = createProject();
    const archived = createTicket(projectId);
    const archivedOutput = piToolOutput(sessionsRoot, archived.id, "archived");
    archiveTicket(archived.id);
    expect(existsSync(archivedOutput)).toBe(false);

    // A live ticket keeps it, even when a delete is wrongly asked for.
    const live = createTicket(projectId);
    const liveOutput = piToolOutput(sessionsRoot, live.id, "live");
    expect(invoke<Result>("volli:ticket-delete", { ticketId: live.id }).ok).toBe(false);
    expect(existsSync(liveOutput)).toBe(true);

    // Saved again after the archive (an older build, say), then deleted.
    const again = piToolOutput(sessionsRoot, archived.id, "again");
    expect(invoke<Result>("volli:ticket-delete", { ticketId: archived.id }).ok).toBe(true);
    expect(existsSync(again)).toBe(false);
  });
});

describe("volli:ticket-create — body, labels, usesWorktree", () => {
  it("persists and hydrates body, labels, and usesWorktree", () => {
    const projectId = createProject();
    const result = invoke<TicketResult>("volli:ticket-create", {
      projectId,
      status: "todo",
      title: "With extras",
      body: "# Heading\n\nDo the thing.",
      labels: ["bug", "ui"],
      usesWorktree: false,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.ticket.body).toBe("# Heading\n\nDo the thing.");
    expect(result.ticket.labels).toEqual(["bug", "ui"]);
    expect(result.ticket.usesWorktree).toBe(false);

    // Hydrates identically through the boot bootstrap snapshot.
    const boot = invoke<BootstrapResult>("volli:data-bootstrap");
    if (!boot.ok) throw new Error(boot.error);
    const hydrated = boot.data.ticketsByProject[projectId]?.find((t) => t.id === result.ticket.id);
    expect(hydrated?.body).toBe("# Heading\n\nDo the thing.");
    expect(hydrated?.labels).toEqual(["bug", "ui"]);
    expect(hydrated?.usesWorktree).toBe(false);
  });

  it("persists the composer's chosen baseBranch, and rejects a name git could not take", () => {
    const projectId = createProject();
    const result = invoke<TicketResult>("volli:ticket-create", {
      projectId,
      status: "todo",
      title: "Based on a release branch",
      baseBranch: "release/1.4",
    });
    if (!result.ok) throw new Error(result.error);
    expect(result.ticket.baseBranch).toBe("release/1.4");

    // The command layer's branch-name validation is the shared gate; a throw
    // there reaches the renderer as a failed Result, never as a silent create.
    const bad = invoke<TicketResult>("volli:ticket-create", {
      projectId,
      status: "todo",
      title: "Based on nonsense",
      baseBranch: "..",
    });
    expect(bad).toEqual({ ok: false, error: "Invalid base branch name" });
  });

  it("defaults body/labels/usesWorktree when omitted (backward-compatible)", () => {
    const projectId = createProject();
    const result = invoke<TicketResult>("volli:ticket-create", {
      projectId,
      status: "backlog",
      title: "Minimal",
    });
    if (!result.ok) throw new Error(result.error);
    expect(result.ticket.body).toBe("");
    expect(result.ticket.labels).toEqual([]);
    expect(result.ticket.usesWorktree).toBe(true);
    // No labels ⇒ no labels_changed event, only `created`.
    const events = invoke<TicketEventsResult>("volli:ticket-events", {
      ticketId: result.ticket.id,
    });
    if (!events.ok) throw new Error(events.error);
    expect(events.events.map((e) => e.payload.kind)).toEqual(["created"]);
  });

  it("persists and hydrates a kickoff-chosen preferredHarnessId, defaulting to claude-code when omitted", () => {
    const projectId = createProject();
    const chosen = invoke<TicketResult>("volli:ticket-create", {
      projectId,
      status: "doing",
      title: "Kicked off with codex",
      preferredHarnessId: "codex",
    });
    if (!chosen.ok) throw new Error(chosen.error);
    expect(chosen.ticket.preferredHarnessId).toBe("codex");

    const defaulted = invoke<TicketResult>("volli:ticket-create", {
      projectId,
      status: "backlog",
      title: "No kickoff",
    });
    if (!defaulted.ok) throw new Error(defaulted.error);
    expect(defaulted.ticket.preferredHarnessId).toBe("claude-code");

    // Both survive the boot bootstrap snapshot identically.
    const boot = invoke<BootstrapResult>("volli:data-bootstrap");
    if (!boot.ok) throw new Error(boot.error);
    const tickets = boot.data.ticketsByProject[projectId] ?? [];
    expect(tickets.find((t) => t.id === chosen.ticket.id)?.preferredHarnessId).toBe("codex");
    expect(tickets.find((t) => t.id === defaulted.ticket.id)?.preferredHarnessId).toBe(
      "claude-code",
    );
  });

  it("produces the same shared, name-deduped label rows the setLabels path would", () => {
    const projectId = createProject();
    // One ticket gets labels at creation; another gets the same labels via setLabels.
    invoke<TicketResult>("volli:ticket-create", {
      projectId,
      status: "todo",
      title: "Created with labels",
      labels: ["bug", "ui"],
    });
    const other = createTicket(projectId);
    invoke<TicketResult>("volli:ticket-set-labels", { ticketId: other.id, labels: ["bug", "ui"] });

    const boot = invoke<BootstrapResult>("volli:data-bootstrap");
    if (!boot.ok) throw new Error(boot.error);
    const labels = boot.data.labelsByProject[projectId] ?? [];
    // Exactly two rows (bug, ui), color null, shared across both tickets — no dupes.
    expect(labels.map((l) => l.name).toSorted()).toEqual(["bug", "ui"]);
    expect(labels.every((l) => l.color === null)).toBe(true);
  });

  it("records a labels_changed event after created when labels are supplied", () => {
    const projectId = createProject();
    const result = invoke<TicketResult>("volli:ticket-create", {
      projectId,
      status: "todo",
      title: "A",
      labels: ["bug"],
    });
    if (!result.ok) throw new Error(result.error);
    const events = invoke<TicketEventsResult>("volli:ticket-events", {
      ticketId: result.ticket.id,
    });
    if (!events.ok) throw new Error(events.error);
    expect(events.events.map((e) => e.payload.kind)).toEqual(["created", "labels_changed"]);
    expect(events.events[1]?.payload).toEqual({
      kind: "labels_changed",
      added: ["bug"],
      removed: [],
    });
  });

  it("dedupes repeated label names into a single junction row like setLabels", () => {
    const projectId = createProject();
    const result = invoke<TicketResult>("volli:ticket-create", {
      projectId,
      status: "todo",
      title: "A",
      labels: ["bug", "bug"],
    });
    if (!result.ok) throw new Error(result.error);
    expect(result.ticket.labels).toEqual(["bug"]);
    const boot = invoke<BootstrapResult>("volli:data-bootstrap");
    if (!boot.ok) throw new Error(boot.error);
    const labels = boot.data.labelsByProject[projectId] ?? [];
    expect(labels.map((l) => l.name)).toEqual(["bug"]);
  });

  it.each([
    ["a non-string body", { body: 5 }],
    ["a labels array with a non-string element", { labels: ["ok", 3] }],
    ["a non-array labels", { labels: "bug" }],
    ["a non-boolean usesWorktree", { usesWorktree: "yes" }],
    // A slug no manifest could be registered under. A well-formed one is
    // accepted here on purpose — whether the user actually trusted it is
    // main's question, asked at the launch door where it can be answered.
    ["a preferredHarnessId no harness could be filed under", { preferredHarnessId: "../etc" }],
  ])("rejects %s", (_label, extra) => {
    const projectId = createProject();
    const result = invoke<TicketResult>("volli:ticket-create", {
      projectId,
      status: "todo",
      title: "A",
      ...extra,
    });
    expect(result).toEqual({ ok: false, error: "Invalid ticket" });
  });
});

describe("volli:ticket-update — worktree identity", () => {
  it("records one worktree_changed event when all three fields change together", () => {
    const projectId = createProject();
    const ticket = createTicket(projectId);

    const result = invoke<TicketResult>("volli:ticket-update", {
      ticketId: ticket.id,
      worktreePath: "/repo/.worktrees/VC-1",
      branch: "volli/VC-1-x",
      baseBranch: "main",
    });
    expect(result.ok).toBe(true);

    const events = invoke<TicketEventsResult>("volli:ticket-events", { ticketId: ticket.id });
    expect(events.ok).toBe(true);
    if (!events.ok) return;
    const worktreeEvents = events.events.filter((e) => e.payload.kind === "worktree_changed");
    expect(worktreeEvents).toHaveLength(1);
    expect(worktreeEvents[0]?.payload).toEqual({
      kind: "worktree_changed",
      from: { worktreePath: null, branch: null, baseBranch: null },
      to: {
        worktreePath: "/repo/.worktrees/VC-1",
        branch: "volli/VC-1-x",
        baseBranch: "main",
      },
    });
  });

  it("records a second worktree_changed event chaining from the prior identity", () => {
    const projectId = createProject();
    const ticket = createTicket(projectId);

    invoke<TicketResult>("volli:ticket-update", {
      ticketId: ticket.id,
      worktreePath: "/repo/.worktrees/VC-1",
      branch: "volli/VC-1-x",
      baseBranch: "main",
    });
    invoke<TicketResult>("volli:ticket-update", { ticketId: ticket.id, branch: "volli/VC-1-y" });

    const events = invoke<TicketEventsResult>("volli:ticket-events", { ticketId: ticket.id });
    if (!events.ok) throw new Error(events.error);
    const worktreeEvents = events.events.filter((e) => e.payload.kind === "worktree_changed");
    expect(worktreeEvents).toHaveLength(2);
    expect(worktreeEvents[1]?.payload).toEqual({
      kind: "worktree_changed",
      from: { worktreePath: "/repo/.worktrees/VC-1", branch: "volli/VC-1-x", baseBranch: "main" },
      to: { worktreePath: "/repo/.worktrees/VC-1", branch: "volli/VC-1-y", baseBranch: "main" },
    });
  });

  it("an explicit null clears a previously-set worktree field, recorded in the event", () => {
    const projectId = createProject();
    const ticket = createTicket(projectId);
    invoke<TicketResult>("volli:ticket-update", { ticketId: ticket.id, worktreePath: "/repo/wt" });

    invoke<TicketResult>("volli:ticket-update", { ticketId: ticket.id, worktreePath: null });

    const result = invoke<TicketResult>("volli:ticket-update", {
      ticketId: ticket.id,
      title: "noop-touch",
    });
    expect(result.ok && result.ticket.worktreePath).toBeNull();

    const events = invoke<TicketEventsResult>("volli:ticket-events", { ticketId: ticket.id });
    if (!events.ok) throw new Error(events.error);
    const worktreeEvents = events.events.filter((e) => e.payload.kind === "worktree_changed");
    expect(worktreeEvents[1]?.payload).toMatchObject({
      from: { worktreePath: "/repo/wt" },
      to: { worktreePath: null },
    });
  });

  it("keeps title/body behavior intact and does not fire worktree_changed for a plain title/body update", () => {
    const projectId = createProject();
    const ticket = createTicket(projectId);

    const result = invoke<TicketResult>("volli:ticket-update", {
      ticketId: ticket.id,
      title: "New title",
      body: "New body",
    });
    expect(result.ok && result.ticket.title).toBe("New title");
    expect(result.ok && result.ticket.body).toBe("New body");

    const events = invoke<TicketEventsResult>("volli:ticket-events", { ticketId: ticket.id });
    if (!events.ok) throw new Error(events.error);
    expect(events.events.map((e) => e.payload.kind)).toEqual(
      expect.arrayContaining(["retitled", "body_edited"]),
    );
    expect(events.events.some((e) => e.payload.kind === "worktree_changed")).toBe(false);
  });

  it("rejects an invalid worktree field type", () => {
    const projectId = createProject();
    const ticket = createTicket(projectId);
    const result = invoke<TicketResult>("volli:ticket-update", { ticketId: ticket.id, branch: 42 });
    expect(result).toEqual({ ok: false, error: "Invalid ticket update" });
  });

  it("rejects a syntactically-invalid branch name without persisting it", () => {
    const projectId = createProject();
    const ticket = createTicket(projectId);
    const result = invoke<TicketResult>("volli:ticket-update", {
      ticketId: ticket.id,
      branch: "bad..branch",
    });
    expect(result).toEqual({ ok: false, error: "Invalid branch name" });
    const after = invoke<TicketResult>("volli:ticket-update", { ticketId: ticket.id, title: "t" });
    expect(after.ok && after.ticket.branch).toBeNull();
  });

  it("rejects a syntactically-invalid base branch name", () => {
    const projectId = createProject();
    const ticket = createTicket(projectId);
    const result = invoke<TicketResult>("volli:ticket-update", {
      ticketId: ticket.id,
      baseBranch: "-nope",
    });
    expect(result).toEqual({ ok: false, error: "Invalid base branch name" });
  });

  it("allows clearing the branch fields with an explicit null", () => {
    const projectId = createProject();
    const ticket = createTicket(projectId);
    const result = invoke<TicketResult>("volli:ticket-update", {
      ticketId: ticket.id,
      branch: null,
      baseBranch: null,
    });
    expect(result.ok).toBe(true);
  });
});

describe("volli:ticket-update — switching worktree scope on (VC-98)", () => {
  /** A ticket that starts out running in the project's main checkout. */
  function mainCheckoutTicket(projectId: string): Ticket {
    const result = invoke<TicketResult>("volli:ticket-create", {
      projectId,
      status: "todo",
      title: "A ticket",
      usesWorktree: false,
    });
    if (!result.ok) throw new Error(result.error);
    return result.ticket;
  }

  /** Stands in for the real pipeline: stamps identity the way `ensure` does on success. */
  function ensureStamps(worktreePath: string): void {
    vi.mocked(ensure).mockImplementation(async (_deps, ticketId: string) => {
      updateTicketFieldsCommand(
        ctx.db,
        { ticketId, worktreePath, branch: "volli/VC-1-a-ticket", baseBranch: "main" },
        { now: Date.now(), actor: { kind: "automation" } },
      );
      return {
        ok: true as const,
        value: {
          identity: { worktreePath, branch: "volli/VC-1-a-ticket", baseBranch: "main" },
          created: true,
          restamped: true,
        },
      };
    });
  }

  it("materializes the worktree and answers with the stamped identity", async () => {
    const projectId = createProject();
    const ticket = mainCheckoutTicket(projectId);
    ensureStamps("/wt/VC-1-a-ticket");

    const result = await invoke<Promise<TicketResult>>("volli:ticket-update", {
      ticketId: ticket.id,
      usesWorktree: true,
    });

    expect(ensure).toHaveBeenCalledTimes(1);
    // The whole point of the ticket: scope is no longer an intention nothing
    // acts on, and the answer carries the identity `ensure` stamped AFTER the
    // scope write committed — so the caller never sees the stale null.
    expect(result).toMatchObject({
      ok: true,
      ticket: {
        usesWorktree: true,
        worktreePath: "/wt/VC-1-a-ticket",
        branch: "volli/VC-1-a-ticket",
        baseBranch: "main",
      },
    });
  });

  it("re-hydrates every window so the rail stops showing a worktree-less ticket", async () => {
    const projectId = createProject();
    const ticket = mainCheckoutTicket(projectId);
    ensureStamps("/wt/VC-1-a-ticket");
    dataChangedSends.length = 0;

    await invoke<Promise<TicketResult>>("volli:ticket-update", {
      ticketId: ticket.id,
      usesWorktree: true,
    });

    await expectDataChanged({
      entity: "tickets",
      ticketId: ticket.id,
      projectId,
      kind: "worktree",
    });
  });

  it("leaves scope on and surfaces the git reason when the worktree can't be created", async () => {
    const projectId = createProject();
    const ticket = mainCheckoutTicket(projectId);
    vi.mocked(ensure).mockResolvedValue({
      ok: false as const,
      error: "fatal: not a git repository",
    });

    const result = await invoke<Promise<TicketResult>>("volli:ticket-update", {
      ticketId: ticket.id,
      usesWorktree: true,
    });

    // Reported as a failed mutation so it reaches a toast rather than dying in
    // the phase stream. The scope flag still stands: it is the user's recorded
    // intent, and a worktree-scoped ticket with no worktree refuses to bind a
    // Session to the main checkout instead of quietly falling back to it.
    expect(result).toEqual({
      ok: false,
      error: "worktree scope is on, but fatal: not a git repository",
    });
    const after = invoke<TicketResult>("volli:ticket-update", { ticketId: ticket.id, title: "t" });
    expect(after.ok && after.ticket.usesWorktree).toBe(true);
    expect(after.ok && after.ticket.worktreePath).toBeNull();
  });

  it("does not touch git for an update that leaves worktree scope alone", () => {
    const projectId = createProject();
    const ticket = mainCheckoutTicket(projectId);

    const result = invoke<TicketResult>("volli:ticket-update", {
      ticketId: ticket.id,
      title: "New title",
    });

    // Still the synchronous write it has always been — a title edit must not
    // become a promise, nor drag a worktree into being.
    expect(result).toMatchObject({ ok: true });
    expect(ensure).not.toHaveBeenCalled();
  });

  it("does not materialize when scope is switched OFF", () => {
    const projectId = createProject();
    const ticket = createTicket(projectId); // worktree-scoped by default

    invoke<TicketResult>("volli:ticket-update", { ticketId: ticket.id, usesWorktree: false });

    expect(ensure).not.toHaveBeenCalled();
  });

  it("broadcasts a worktree change when scope is switched OFF, so a venue reader stops waiting (VC-286)", async () => {
    const projectId = createProject();
    const ticket = createTicket(projectId); // worktree-scoped, no worktree yet
    dataChangedSends.length = 0;

    invoke<TicketResult>("volli:ticket-update", { ticketId: ticket.id, usesWorktree: false });

    // The ticket's Session now binds the main checkout; a venue cached as
    // `resolving` for the worktree it will never get must be read again.
    await expectDataChanged({
      entity: "tickets",
      ticketId: ticket.id,
      projectId,
      kind: "worktree",
    });
  });

  it("does not broadcast when scope is re-asserted as already off", () => {
    const projectId = createProject();
    const ticket = mainCheckoutTicket(projectId);
    dataChangedSends.length = 0;

    invoke<TicketResult>("volli:ticket-update", { ticketId: ticket.id, usesWorktree: false });

    // No transition, no checkout moved, nothing for a venue reader to re-read.
    expectNoDataChange();
  });

  it("does not re-materialize when scope is re-asserted as already on", () => {
    const projectId = createProject();
    const ticket = createTicket(projectId); // already worktree-scoped

    invoke<TicketResult>("volli:ticket-update", { ticketId: ticket.id, usesWorktree: true });

    // No transition, no git: `ensure` is idempotent but not free, and a ticket
    // whose scope never moved has not asked for anything.
    expect(ensure).not.toHaveBeenCalled();
  });

  it("refuses a scope switch-off while the worktree is still being created", async () => {
    const projectId = createProject();
    const ticket = mainCheckoutTicket(projectId);
    // `ensure` parked mid-flight, exactly where the real pipeline spends its
    // seconds: after the scope write committed, before the identity stamp.
    let release!: () => void;
    const parked = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.mocked(ensure).mockImplementation(async (_deps, ticketId: string) => {
      await parked;
      updateTicketFieldsCommand(
        ctx.db,
        { ticketId, worktreePath: "/wt/VC-1-a-ticket", branch: "volli/VC-1", baseBranch: "main" },
        { now: Date.now(), actor: { kind: "automation" } },
      );
      return {
        ok: true as const,
        value: {
          identity: {
            worktreePath: "/wt/VC-1-a-ticket",
            branch: "volli/VC-1",
            baseBranch: "main",
          },
          created: true,
          restamped: true,
        },
      };
    });

    const inFlight = invoke<Promise<TicketResult>>("volli:ticket-update", {
      ticketId: ticket.id,
      usesWorktree: true,
    });

    // The mis-click correction: the user reopens the destination picker and
    // switches back before the worktree finishes appearing. Permitting this
    // wrote `uses_worktree: 0` against a still-null path, and `ensure` then
    // stamped a worktree onto it — a contradiction the scope freeze made
    // permanent, leaving the ticket main-checkout-scoped with a worktree on
    // disk and no way back through the UI.
    const refused = invoke<TicketResult>("volli:ticket-update", {
      ticketId: ticket.id,
      usesWorktree: false,
    });
    expect(refused).toEqual({
      ok: false,
      error:
        "The ticket's worktree is still being created, so its worktree scoping can't change yet. Try again once it's ready.",
    });

    release();
    await inFlight;

    // Scope and stamp agree, so the freeze locks in a coherent state.
    const after = invoke<TicketResult>("volli:ticket-update", { ticketId: ticket.id, title: "t" });
    expect(after.ok && after.ticket.usesWorktree).toBe(true);
    expect(after.ok && after.ticket.worktreePath).toBe("/wt/VC-1-a-ticket");
  });

  it("lets scope change again once materialization has finished", async () => {
    const projectId = createProject();
    const ticket = mainCheckoutTicket(projectId);
    // Succeeds without stamping a path, so the scope freeze stays open and this
    // test measures the in-flight hold alone rather than the freeze.
    vi.mocked(ensure).mockResolvedValue({
      ok: true as const,
      value: {
        identity: { worktreePath: null, branch: "volli/VC-1", baseBranch: "main" },
        created: false,
        restamped: false,
      },
    });

    await invoke<Promise<TicketResult>>("volli:ticket-update", {
      ticketId: ticket.id,
      usesWorktree: true,
    });

    // The hold is released in `finally`, so it never outlives the git work.
    const result = invoke<TicketResult>("volli:ticket-update", {
      ticketId: ticket.id,
      usesWorktree: false,
    });
    expect(result.ok && result.ticket.usesWorktree).toBe(false);
  });
});

describe("archived-ticket guards — ticket-update/set-priority/set-labels/move", () => {
  it("volli:ticket-update rejects a mutation against an archived ticket", () => {
    const projectId = createProject();
    const ticket = createTicket(projectId);
    archiveTicket(ticket.id);

    const result = invoke<TicketResult>("volli:ticket-update", {
      ticketId: ticket.id,
      title: "New title",
    });
    expect(result).toEqual({ ok: false, error: "Cannot update an archived ticket" });
  });

  it("volli:ticket-set-priority rejects a mutation against an archived ticket", () => {
    const projectId = createProject();
    const ticket = createTicket(projectId);
    archiveTicket(ticket.id);

    const result = invoke<TicketResult>("volli:ticket-set-priority", {
      ticketId: ticket.id,
      priority: "high",
    });
    expect(result).toEqual({
      ok: false,
      error: "Cannot change the priority of an archived ticket",
    });
  });

  it("volli:ticket-set-labels rejects a mutation against an archived ticket", () => {
    const projectId = createProject();
    const ticket = createTicket(projectId);
    archiveTicket(ticket.id);

    const result = invoke<TicketResult>("volli:ticket-set-labels", {
      ticketId: ticket.id,
      labels: ["bug"],
    });
    expect(result).toEqual({
      ok: false,
      error: "Cannot change the labels of an archived ticket",
    });
  });

  it("volli:ticket-move now errors instead of silently no-opping against an archived ticket", () => {
    const projectId = createProject();
    const ticket = createTicket(projectId);
    archiveTicket(ticket.id);

    const result = invoke<TicketsResult>("volli:ticket-move", {
      projectId,
      ticketId: ticket.id,
      toStatus: "todo",
      toIndex: 0,
    });
    expect(result).toEqual({ ok: false, error: "Cannot move an archived ticket" });
  });
});

describe("volli:ticket-move — multi-card drops", () => {
  it("persists a selected group contiguously and wakes every ticket that changed status", () => {
    const projectId = createProject();
    const first = createTicket(projectId);
    const second = createTicket(projectId);
    const target = createTicket(projectId);
    invoke<TicketsResult>("volli:ticket-move", {
      projectId,
      ticketId: target.id,
      toStatus: "doing",
      toIndex: 0,
    });

    const result = invoke<TicketsResult>("volli:ticket-move", {
      projectId,
      // Reverse payload order must not reverse board order.
      ticketIds: [second.id, first.id],
      toStatus: "doing",
      toIndex: 0,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(
      result.tickets
        .filter((ticket) => ticket.status === "doing")
        .toSorted((a, b) => a.order - b.order)
        .map((ticket) => ticket.id),
    ).toEqual([first.id, second.id, target.id]);
    for (const ticket of [first, second]) {
      const events = invoke<TicketEventsResult>("volli:ticket-events", { ticketId: ticket.id });
      expect(events.ok && events.events.at(-1)?.payload.kind).toBe("status_changed");
    }
  });

  it("reports every committed group arrival with the shared Option-drag choice", () => {
    const arrivals: unknown[] = [];
    handlers.clear();
    registerDataIpcHandlers(
      { ok: true, db: ctx.db },
      { sessionEngine: fixtureSessionEngine, onDeliberateMove: (notice) => arrivals.push(notice) },
    );
    const projectId = createProject();
    const first = createTicket(projectId);
    const second = createTicket(projectId);

    const result = invoke<TicketsResult>("volli:ticket-move", {
      projectId,
      ticketIds: [first.id, second.id],
      toStatus: "doing",
      toIndex: 0,
      choice: { kind: "automation", automationId: "automation-2" },
    });

    expect(result.ok).toBe(true);
    expect(arrivals).toEqual([
      {
        projectId,
        ticketId: first.id,
        from: "backlog",
        to: "doing",
        choice: { kind: "automation", automationId: "automation-2" },
      },
      {
        projectId,
        ticketId: second.id,
        from: "backlog",
        to: "doing",
        choice: { kind: "automation", automationId: "automation-2" },
      },
    ]);
  });

  it("starts backward-move interrupts for every selected ticket before awaiting either", async () => {
    const started: string[] = [];
    const resolvers: Array<() => void> = [];
    const interruptTicketSessions = vi.fn(
      (ticketId: string) =>
        new Promise<string[]>((resolve) => {
          started.push(ticketId);
          resolvers.push(() => resolve([]));
        }),
    );
    handlers.clear();
    registerDataIpcHandlers(
      { ok: true, db: ctx.db },
      { sessionEngine: fixtureSessionEngine, interruptTicketSessions },
    );
    const projectId = createProject();
    const first = createTicket(projectId);
    const second = createTicket(projectId);
    for (const ticket of [first, second]) {
      await invoke<Promise<TicketsResult>>("volli:ticket-move", {
        projectId,
        ticketId: ticket.id,
        toStatus: "doing",
        toIndex: 0,
      });
    }
    started.length = 0;
    resolvers.length = 0;

    const pending = invoke<Promise<TicketsResult>>("volli:ticket-move", {
      projectId,
      ticketIds: [first.id, second.id],
      toStatus: "todo",
      toIndex: 0,
    });

    expect(started).toEqual([first.id, second.id]);
    for (const resolve of resolvers) resolve();
    await expect(pending).resolves.toMatchObject({ ok: true });
  });
});

describe("volli:ticket-move — armed-column arrival", () => {
  it("reports one committed renderer arrival to main, including its Option-drag choice", () => {
    const arrivals: unknown[] = [];
    handlers.clear();
    registerDataIpcHandlers(
      { ok: true, db: ctx.db },
      { sessionEngine: fixtureSessionEngine, onDeliberateMove: (notice) => arrivals.push(notice) },
    );
    const projectId = createProject();
    const ticket = createTicket(projectId);

    const result = invoke<TicketsResult>("volli:ticket-move", {
      projectId,
      ticketId: ticket.id,
      toStatus: "doing",
      toIndex: 0,
      choice: { kind: "automation", automationId: "automation-2" },
    });

    expect(result.ok).toBe(true);
    expect(arrivals).toEqual([
      {
        projectId,
        ticketId: ticket.id,
        from: "backlog",
        to: "doing",
        choice: { kind: "automation", automationId: "automation-2" },
      },
    ]);
  });

  it("does not report a same-column reorder as an arrival", () => {
    const onDeliberateMove = vi.fn();
    handlers.clear();
    registerDataIpcHandlers(
      { ok: true, db: ctx.db },
      { sessionEngine: fixtureSessionEngine, onDeliberateMove },
    );
    const projectId = createProject();
    const ticket = createTicket(projectId);

    invoke<TicketsResult>("volli:ticket-move", {
      projectId,
      ticketId: ticket.id,
      toStatus: "backlog",
      toIndex: 0,
    });

    expect(onDeliberateMove).not.toHaveBeenCalled();
  });
});

describe("volli:ticket-move — backward-move interrupt (issue #78)", () => {
  /** Re-registers the data handlers with a stubbed interrupt seam returning `ids`. */
  function withInterrupt(ids: string[]) {
    const interruptTicketSessions = vi.fn((_ticketId: string) => ids);
    handlers.clear();
    registerDataIpcHandlers(
      { ok: true, db: ctx.db },
      { sessionEngine: fixtureSessionEngine, interruptTicketSessions },
    );
    return interruptTicketSessions;
  }

  function move(projectId: string, ticketId: string, toStatus: string): TicketsResult {
    return invoke<TicketsResult>("volli:ticket-move", {
      projectId,
      ticketId,
      toStatus,
      toIndex: 0,
    });
  }

  it("interrupts the ticket's agent attachments on a doing→todo move without planner history", () => {
    const interrupt = withInterrupt(["s1", "s2"]);
    const projectId = createProject();
    const ticket = createTicket(projectId);
    move(projectId, ticket.id, "doing");
    interrupt.mockClear();
    const before = invoke<TicketEventsResult>("volli:ticket-events", { ticketId: ticket.id });
    if (!before.ok) throw new Error("expected events");

    const result = move(projectId, ticket.id, "todo");

    expect(result.ok).toBe(true);
    expect(interrupt).toHaveBeenCalledExactlyOnceWith(ticket.id);
    const events = invoke<TicketEventsResult>("volli:ticket-events", { ticketId: ticket.id });
    if (!events.ok) throw new Error("expected events");
    expect(events.events).toHaveLength(before.events.length + 1); // just the board move
  });

  it("interrupts on a needs_review→done move (completion still exits the active columns)", () => {
    const interrupt = withInterrupt(["s1"]);
    const projectId = createProject();
    const ticket = createTicket(projectId);
    move(projectId, ticket.id, "doing");
    move(projectId, ticket.id, "needs_review");
    interrupt.mockClear();

    move(projectId, ticket.id, "done");

    expect(interrupt).toHaveBeenCalledExactlyOnceWith(ticket.id);
  });

  // VC-340: finishing a ticket is also when its checkout stops needing its
  // dependency tree. The door fires here so the reclaim does not have to wait
  // for the 60s poll; every refusal is the primitive's own.
  it("trims the ticket's worktree on the move into Done, once", () => {
    const trim = vi.mocked(trimFinishedWorktree);
    const projectId = createProject();
    const ticket = createTicket(projectId);
    move(projectId, ticket.id, "needs_review");
    trim.mockClear();

    move(projectId, ticket.id, "done");
    // A second move into the column it is already in is not a finish.
    move(projectId, ticket.id, "done");

    expect(trim).toHaveBeenCalledTimes(1);
    expect(trim.mock.calls[0]?.[1]).toBe(ticket.id);
  });

  it("keeps the IPC reply synchronous while the shared Done trim is pending, with the same busy guard", async () => {
    let settle!: (value: Awaited<ReturnType<typeof trimFinishedWorktree>>) => void;
    vi.mocked(trimFinishedWorktree).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          settle = resolve;
        }),
    );
    const busyWorktreeSites = vi.fn(async () => []);
    handlers.clear();
    registerDataIpcHandlers(
      { ok: true, db: ctx.db },
      {
        sessionEngine: fixtureSessionEngine,
        busyWorktreeSites,
      },
    );
    const projectId = createProject();
    const ticket = createTicket(projectId);
    const reply = move(projectId, ticket.id, "done");
    expect(reply).not.toBeInstanceOf(Promise);
    expect(reply).toMatchObject({
      ok: true,
      tickets: [expect.objectContaining({ id: ticket.id, status: "done" })],
    });
    expect(vi.mocked(trimFinishedWorktree).mock.calls.at(-1)?.[0].busySites).toBe(
      busyWorktreeSites,
    );
    // The board change is delivered by the receipt, not a new IPC push.
    expectNoDataChange();
    settle({
      kind: "trimmed",
      report: { worktreePath: "/mock", dryRun: false, removed: [], kept: [], totalBytes: 0 },
    });
    await expectDataChanged({
      entity: "tickets",
      projectId,
      ticketId: ticket.id,
      kind: "worktree",
    });
  });

  // The other door (review r2): an archive KEEPS the checkout, which makes an
  // archived ticket the longest-lived carrier of a dead dependency tree, so the
  // wiring is held here and not only in the primitive's own suite.
  it("trims the ticket's worktree when the ticket is archived", () => {
    const trim = vi.mocked(trimFinishedWorktree);
    const projectId = createProject();
    const ticket = createTicket(projectId);
    trim.mockClear();

    archiveTicket(ticket.id);

    expect(trim).toHaveBeenCalledTimes(1);
    expect(trim.mock.calls[0]?.[1]).toBe(ticket.id);
  });

  it("does not trim on a move that is not a finish", () => {
    const trim = vi.mocked(trimFinishedWorktree);
    const projectId = createProject();
    const ticket = createTicket(projectId);
    trim.mockClear();

    move(projectId, ticket.id, "doing");

    expect(trim).not.toHaveBeenCalled();
  });

  it("does not interrupt a doing→needs_review move (still an active column)", () => {
    const interrupt = withInterrupt(["s1"]);
    const projectId = createProject();
    const ticket = createTicket(projectId);
    move(projectId, ticket.id, "doing");
    interrupt.mockClear();

    move(projectId, ticket.id, "needs_review");

    expect(interrupt).not.toHaveBeenCalled();
  });

  it("does not interrupt a todo→backlog move (never was an active column)", () => {
    const interrupt = withInterrupt(["s1"]);
    const projectId = createProject();
    const ticket = createTicket(projectId);
    move(projectId, ticket.id, "todo");
    interrupt.mockClear();

    move(projectId, ticket.id, "backlog");

    expect(interrupt).not.toHaveBeenCalled();
  });

  it("does not interrupt when a single-card request names the wrong project", async () => {
    const interrupt = withInterrupt(["s1"]);
    const projectId = createProject();
    const other = await invoke<Promise<ProjectCreateResult>>("volli:project-create", {
      path: freshProjectDir(),
      name: "Other",
    });
    if (!other.ok) throw new Error(other.error);
    const otherProjectId = other.project.id;
    const ticket = createTicket(projectId);
    move(projectId, ticket.id, "doing");
    interrupt.mockClear();

    const result = move(otherProjectId, ticket.id, "todo");

    expect(result.ok).toBe(true);
    expect(interrupt).not.toHaveBeenCalled();
  });

  it("records nothing when the interrupt finds no live agent sessions", () => {
    const interrupt = withInterrupt([]);
    const projectId = createProject();
    const ticket = createTicket(projectId);
    move(projectId, ticket.id, "doing");
    interrupt.mockClear();

    move(projectId, ticket.id, "todo");

    expect(interrupt).toHaveBeenCalledExactlyOnceWith(ticket.id);
  });

  it("keeps the committed move successful when the interrupt throws synchronously", () => {
    const interruptTicketSessions = vi.fn(() => {
      throw new Error("terminal interrupt unavailable");
    });
    const logFailure = vi.spyOn(console, "error").mockImplementation(() => undefined);
    handlers.clear();
    registerDataIpcHandlers(
      { ok: true, db: ctx.db },
      { sessionEngine: fixtureSessionEngine, interruptTicketSessions },
    );
    const projectId = createProject();
    const ticket = createTicket(projectId);
    move(projectId, ticket.id, "doing");

    const result = move(projectId, ticket.id, "todo");

    expect(result.ok && result.tickets[0]?.status).toBe("todo");
    expect(logFailure).toHaveBeenCalledWith(
      "[ticket-move] failed to interrupt ticket sessions after committed move",
      expect.objectContaining({
        error: expect.objectContaining({
          name: "Error",
          message: "terminal interrupt unavailable",
        }),
      }),
    );
  });

  it("keeps the committed move successful when the asynchronous interrupt rejects", async () => {
    const interruptTicketSessions = vi.fn(async () => {
      throw new Error("terminal interrupt unavailable");
    });
    const logFailure = vi.spyOn(console, "error").mockImplementation(() => undefined);
    handlers.clear();
    registerDataIpcHandlers(
      { ok: true, db: ctx.db },
      { sessionEngine: fixtureSessionEngine, interruptTicketSessions },
    );
    const projectId = createProject();
    const ticket = createTicket(projectId);
    move(projectId, ticket.id, "doing");

    const result = await invoke<Promise<TicketsResult>>("volli:ticket-move", {
      projectId,
      ticketId: ticket.id,
      toStatus: "todo",
      toIndex: 0,
    });

    expect(result.ok && result.tickets[0]?.status).toBe("todo");
    expect(logFailure).toHaveBeenCalledWith(
      "[ticket-move] failed to interrupt ticket sessions after committed move",
      expect.objectContaining({
        error: expect.objectContaining({
          name: "Error",
          message: "terminal interrupt unavailable",
        }),
      }),
    );
  });
});

describe("volli:ticket-events", () => {
  it("rejects a non-object payload", () => {
    expect(invoke<TicketEventsResult>("volli:ticket-events", "nope")).toEqual({
      ok: false,
      error: "Invalid ticket",
    });
  });

  it("returns the ticket's chronological event history", () => {
    const projectId = createProject();
    const ticket = createTicket(projectId);
    const events = invoke<TicketEventsResult>("volli:ticket-events", { ticketId: ticket.id });
    expect(events.ok).toBe(true);
    if (!events.ok) return;
    expect(events.events.map((e) => e.payload.kind)).toEqual(["created"]);
  });
});

describe("volli:comment-* channels", () => {
  it("comment-create rejects an empty body", () => {
    const projectId = createProject();
    const ticket = createTicket(projectId);
    const result = invoke<TicketCommentResult>("volli:comment-create", {
      ticketId: ticket.id,
      body: "   ",
    });
    expect(result).toEqual({ ok: false, error: "Invalid comment" });
  });

  it("creates a comment as the user actor, listable, updatable, and removable", () => {
    const projectId = createProject();
    const ticket = createTicket(projectId);

    const created = invoke<TicketCommentResult>("volli:comment-create", {
      ticketId: ticket.id,
      body: "Looks good",
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.comment.actor).toBe("user");

    const listed = invoke<TicketCommentsResult>("volli:comment-list", { ticketId: ticket.id });
    expect(listed.ok && listed.comments.map((c) => c.body)).toEqual(["Looks good"]);

    const updated = invoke<TicketCommentResult>("volli:comment-update", {
      commentId: created.comment.id,
      body: "Looks great",
    });
    expect(updated.ok && updated.comment.body).toBe("Looks great");

    const removed = invoke<Result>("volli:comment-remove", { commentId: created.comment.id });
    expect(removed).toEqual({ ok: true });

    const afterRemove = invoke<TicketCommentsResult>("volli:comment-list", { ticketId: ticket.id });
    expect(afterRemove.ok && afterRemove.comments).toEqual([]);
  });

  it("also records a commented event, discoverable from volli:ticket-events", () => {
    const projectId = createProject();
    const ticket = createTicket(projectId);
    const created = invoke<TicketCommentResult>("volli:comment-create", {
      ticketId: ticket.id,
      body: "Looks good",
    });
    if (!created.ok) throw new Error(created.error);

    const events = invoke<TicketEventsResult>("volli:ticket-events", { ticketId: ticket.id });
    if (!events.ok) throw new Error(events.error);
    expect(events.events.map((e) => e.payload.kind)).toEqual(["created", "commented"]);
    expect(events.events[1]?.payload).toEqual({ kind: "commented", commentId: created.comment.id });
  });

  it("comment-update returns a typed error for an unknown commentId", () => {
    const result = invoke<TicketCommentResult>("volli:comment-update", {
      commentId: "nope",
      body: "x",
    });
    expect(result).toEqual({ ok: false, error: "Unknown comment" });
  });

  it("comment-remove returns a typed error for an unknown commentId", () => {
    const result = invoke<Result>("volli:comment-remove", { commentId: "nope" });
    expect(result).toEqual({ ok: false, error: "Unknown comment" });
  });
});

/** A row's identity, whichever kind it is — `SessionRecord.id` and `ChatSessionRecord.sessionId` are the same session, spelled differently per the DTO. */
function rowId(row: SessionListingRow): string {
  return row.kind === "terminal" ? row.record.id : row.record.sessionId;
}

describe("volli:session-list / volli:session-list-for-ticket", () => {
  it("session-list returns every session in a project, newest first", async () => {
    const projectId = createProject();
    const ticket = createTicket(projectId);
    insertSession(ctx.db, testSession(projectId, null, { id: "s1", createdAt: 100 }));
    insertSession(ctx.db, testSession(projectId, ticket.id, { id: "s2", createdAt: 200 }));

    const result = await invoke<Promise<SessionsResult>>("volli:session-list", { projectId });
    expect(result.ok && result.sessions.map(rowId)).toEqual(["s2", "s1"]);
  });

  it("session-list-for-ticket scopes to just that ticket", async () => {
    const projectId = createProject();
    const ticket = createTicket(projectId);
    insertSession(ctx.db, testSession(projectId, null, { id: "project-session" }));
    insertSession(ctx.db, testSession(projectId, ticket.id, { id: "scoped" }));

    const result = await invoke<Promise<SessionsResult>>("volli:session-list-for-ticket", {
      ticketId: ticket.id,
    });
    expect(result.ok && result.sessions.map(rowId)).toEqual(["scoped"]);
  });

  it("renders a structured-only Session as a chat row instead of dropping it", async () => {
    const projectId = createProject();
    const ticket = createTicket(projectId);
    insertSession(ctx.db, testSession(projectId, ticket.id, { id: "terminal-session" }));
    const sessionEngine = createTestSessionEngine(ctx.db, { now: () => 500 });
    const structured = await sessionEngine.createSession({
      commandId: "structured-create",
      projectId,
      ticketId: ticket.id,
      role: roleImpliedByTicket(ticket.id),
      parentSessionId: null,
      title: "Structured OpenCode Session",
      provenance: {
        source: { kind: "user", id: "test", detail: null },
        venue: { id: "local", kind: "local" },
      },
    });

    handlers.clear();
    registerDataIpcHandlers({ ok: true, db: ctx.db }, { sessionEngine });

    const projectSessions = await invoke<Promise<SessionsResult>>("volli:session-list", {
      projectId,
    });
    const ticketSessions = await invoke<Promise<SessionsResult>>("volli:session-list-for-ticket", {
      ticketId: ticket.id,
    });

    expect(projectSessions.ok && projectSessions.sessions.map(rowId)).toEqual([
      structured.session.id,
      "terminal-session",
    ]);
    expect(ticketSessions.ok && ticketSessions.sessions.map(rowId)).toEqual([
      structured.session.id,
      "terminal-session",
    ]);
    expect(
      projectSessions.ok &&
        projectSessions.sessions.find((row) => rowId(row) === structured.session.id),
    ).toEqual({
      kind: "chat",
      record: {
        sessionId: structured.session.id,
        title: "Structured OpenCode Session",
        projectId,
        ticketId: ticket.id,
        createdAt: 500,
        adapterId: null,
        live: false,
        activity: "idle",
        waitingOn: null,
        outcome: null,
        latestTurnOrigin: null,
        resumedAfterStop: false,
        lastActivityAt: 500,
        bornTicketless: false,
        role: "ticket",
        parentSessionId: null,
        // What this Session is pinned to (VC-416). Null here because it has
        // never recorded a policy — it was minted and never attached, which is
        // exactly the state a row must not dress up as a reading.
        model: null,
      },
      // A Session that has run no model reads as unmeasured, not as free
      // (VC-87). It rides on the ROW rather than inside the record, so both
      // arms of the listing carry the same fact in the same place.
      usage: EMPTY_SESSION_USAGE_SUMMARY,
      // And who started it (VC-131), in the same place for the same reason. A
      // Session nobody automated is the resting case and says so.
      provenance: PERSON_STARTED,
    });
    expect(
      projectSessions.ok &&
        projectSessions.sessions.find((row) => rowId(row) === "terminal-session"),
    ).toMatchObject({ kind: "terminal", usage: EMPTY_SESSION_USAGE_SUMMARY });
  });

  it("projects live from this process's executor bindings, not durable attachment openness", async () => {
    const projectId = createProject();
    const ticket = createTicket(projectId);
    const sessionEngine = createTestSessionEngine(ctx.db, { now: () => 500 });
    const provenance = {
      source: { kind: "user" as const, id: "test", detail: null },
      venue: { id: "local", kind: "local" as const },
    };
    const created = await sessionEngine.createSession({
      commandId: "structured-create",
      projectId,
      ticketId: ticket.id,
      role: roleImpliedByTicket(ticket.id),
      parentSessionId: null,
      title: "Reattachable Run",
      provenance,
    });
    const start = await sessionEngine.submit({
      commandId: "structured-start",
      sessionId: created.session.id,
      intent: { kind: "executor.start", adapterId: "pi", continuity: "fresh" },
      provenance,
    });
    await sessionEngine.observe({
      id: "structured-opened",
      kind: "attachment.opened",
      sessionId: created.session.id,
      commandId: start.command.id,
      occurredAt: 501,
      provenance,
      attachment: {
        id: "attachment-1",
        sessionId: created.session.id,
        adapterId: "pi",
        venue: { id: "local", kind: "local" },
        continuity: "fresh",
        native: null,
        authority: null,
      },
    });

    let openBindings: { attachmentId: string }[] = [];
    handlers.clear();
    registerDataIpcHandlers(
      { ok: true, db: ctx.db },
      { sessionEngine, listOpenNativeBindings: () => openBindings },
    );

    const relaunched = await invoke<Promise<SessionsResult>>("volli:session-list", { projectId });
    expect(
      relaunched.ok && relaunched.sessions.find((row) => rowId(row) === created.session.id)?.record,
    ).toMatchObject({ adapterId: "pi", live: false, activity: "idle" });
    expect(
      (await sessionEngine.getSession({ sessionId: created.session.id }))?.liveExecutor,
    ).toMatchObject({
      id: "attachment-1",
      status: "open",
    });

    openBindings = [{ attachmentId: "attachment-1" }];
    const rebound = await invoke<Promise<SessionsResult>>("volli:session-list", { projectId });
    expect(
      rebound.ok && rebound.sessions.find((row) => rowId(row) === created.session.id)?.record,
    ).toMatchObject({ live: true, activity: "idle" });
  });

  // VC-392: the fetch reads provenance for the whole roster in one batch
  // (`readSessionProvenances`) while the push channel reads one Session at a
  // time (`readSessionProvenance`, exactly as `index.ts` composes it). The two
  // must produce the same row for the same Session: the renderer applies a push
  // as a whole-row upsert, so a disagreement would change a Session's mark the
  // moment it did anything — the flicker the push channel exists to remove.
  it("pushes the same rows the fetch returns, provenance included", async () => {
    const projectId = createProject();
    const ticket = createTicket(projectId);
    const sessionEngine = createTestSessionEngine(ctx.db, { now: () => 500 });
    const pushed = new Map<string, SessionListingRow>();
    const watch = watchSessionActivity(sessionEngine, {
      listOpenNativeBindings: noOpenBindings,
      publish: ({ row }) => pushed.set(rowId(row), row),
      // The expression `index.ts` passes, unchanged.
      provenanceOf: (born) => readSessionProvenance(ctx.db, born),
    });
    // Created THROUGH the watch, because `createSession` is one of the writes
    // that marks a Session dirty. Nothing here retitles anything: a rename is a
    // ledger fact and `sessions.title` is only the minted name, so a test that
    // dirtied Sessions by renaming them would be comparing two readers of a
    // title neither of them should still be showing.
    const start = async (title: string, ticketId: string | null): Promise<string> => {
      const created = await watch.engine.createSession({
        commandId: `create-${title}`,
        projectId,
        ticketId,
        role: roleImpliedByTicket(ticketId),
        parentSessionId: null,
        title,
        provenance: {
          source: { kind: "user", id: "test", detail: null },
          venue: { id: "local", kind: "local" },
        },
      });
      return created.session.id;
    };
    // One Session per source the reader can answer from, so the comparison
    // below covers every arm rather than the resting one.
    const parent = await start("Orchestrator", ticket.id);
    const delegated = await start("Delegated", ticket.id);
    recordSessionStartedOnce(ctx.db, {
      ticketId: ticket.id,
      sessionId: delegated,
      now: 600,
      actor: { kind: "session", sessionId: parent, ticketId: ticket.id },
    });
    const runSession = await start("Nightly sweep", ticket.id);
    recordAutomationRun(
      ctx.db,
      {
        automationId: "automation-1",
        automationName: "Nightly sweep",
        ticketId: ticket.id,
        sessionId: runSession,
        model: { providerId: "anthropic", modelId: "claude-opus", reasoningLevel: "high" },
      },
      700,
    );
    const byHand = await start("Opened by hand", ticket.id);
    recordSessionStartedOnce(ctx.db, {
      ticketId: ticket.id,
      sessionId: byHand,
      now: 800,
      actor: { kind: "user" },
    });
    const board = await start("Board chat", null);

    // The flush builds the pushed row the same way the renderer receives it,
    // and it runs after the provenance records above are in place.
    await watch.flush();
    watch.stop();

    handlers.clear();
    registerDataIpcHandlers({ ok: true, db: ctx.db }, { sessionEngine });
    const fetched = await invoke<Promise<SessionsResult>>("volli:session-list", { projectId });
    const scoped = await invoke<Promise<SessionsResult>>("volli:session-list-for-ticket", {
      ticketId: ticket.id,
    });
    if (!fetched.ok || !scoped.ok) throw new Error("listing failed");

    expect(pushed.size).toBe(5);
    for (const row of [...fetched.sessions, ...scoped.sessions]) {
      expect(row).toEqual(pushed.get(rowId(row)));
    }
    // The marks themselves, so the two channels agreeing on `{ kind: "user" }`
    // for everything could not pass this test.
    const provenanceById = new Map(
      fetched.sessions.map((row) => [rowId(row), row.provenance] as const),
    );
    expect(provenanceById.get(runSession)).toEqual({
      kind: "automation",
      automationRunId: expect.any(String),
      automationName: "Nightly sweep",
    });
    expect(provenanceById.get(delegated)).toEqual({
      kind: "session",
      parentSessionId: parent,
      parentTitle: "Orchestrator",
    });
    expect(provenanceById.get(byHand)).toEqual({ kind: "user" });
    expect(provenanceById.get(board)).toEqual({ kind: "user" });
  });

  // VC-392: the bench that measures this tail cannot call the handler itself
  // (it would have to boot Electron), so it measures
  // `sessionListingRowsForRoster` — the function the handler calls. This test
  // is the other half of that arrangement: it pins, through the REAL handler,
  // that the roster's provenance still costs a bounded number of statements
  // rather than a number that grows per Session. Together they close the gap a
  // hand-assembled bench would leave, which is that the handler drifts away
  // from the thing being measured and nobody notices.
  it("lists a roster without paying a provenance read per Session", async () => {
    const projectId = createProject();
    const ticket = createTicket(projectId);
    const sessionEngine = createTestSessionEngine(ctx.db, { now: () => 500 });
    const roster = 24;
    for (let index = 0; index < roster; index += 1) {
      const created = await sessionEngine.createSession({
        commandId: `create-bulk-${index}`,
        projectId,
        ticketId: ticket.id,
        role: roleImpliedByTicket(ticket.id),
        parentSessionId: null,
        title: `Bulk ${index}`,
        provenance: {
          source: { kind: "user", id: "test", detail: null },
          venue: { id: "local", kind: "local" },
        },
      });
      recordSessionStartedOnce(ctx.db, {
        ticketId: ticket.id,
        sessionId: created.session.id,
        now: 600 + index,
        actor: { kind: "user" },
      });
    }

    // The interceptor goes on BEFORE the first listing, not after it.
    // `prepared` memoizes per handle, so a wrapper installed after a warm-up
    // would decorate nothing and count zero however the handler reads — which
    // is a test that passes because it is blind. `counting` is what switches
    // recording on, so preparation happens under the wrapper and only the
    // second listing's EXECUTIONS are counted.
    let counting: string[] | null = null;
    const prepare = ctx.db.prepare.bind(ctx.db);
    ctx.db.prepare = ((sql: string) => {
      const statement = prepare(sql);
      if (!/FROM\s+(automation_runs|ticket_events|session_event_sequence)\b/.test(sql)) {
        return statement;
      }
      for (const method of ["get", "all", "iterate"] as const) {
        const real = statement[method].bind(statement) as (...args: unknown[]) => unknown;
        Object.defineProperty(statement, method, {
          configurable: true,
          value: (...args: unknown[]) => {
            counting?.push(sql);
            return real(...args);
          },
        });
      }
      return statement;
    }) as typeof ctx.db.prepare;

    handlers.clear();
    registerDataIpcHandlers({ ok: true, db: ctx.db }, { sessionEngine });
    await invoke<Promise<SessionsResult>>("volli:session-list", { projectId });
    const provenanceStatements: string[] = [];
    counting = provenanceStatements;
    const listed = await invoke<Promise<SessionsResult>>("volli:session-list", { projectId });
    counting = null;

    if (!listed.ok) throw new Error("listing failed");
    expect(listed.sessions).toHaveLength(roster);
    // The counter saw the reads at all. Without this the two bounds below are
    // satisfied by a counter that is simply not working.
    expect(provenanceStatements.length).toBeGreaterThan(0);
    // Comfortably under one per Session, and not pinned to an exact number so
    // that adding a durable source stays a one-line change here.
    expect(provenanceStatements.length).toBeLessThanOrEqual(5);
    expect(provenanceStatements.length).toBeLessThan(roster);
  });

  it("rejects invalid input", () => {
    expect(invoke<SessionsResult>("volli:session-list", 42)).toEqual({
      ok: false,
      error: "Invalid project",
    });
    expect(invoke<SessionsResult>("volli:session-list-for-ticket", 42)).toEqual({
      ok: false,
      error: "Invalid ticket",
    });
  });
});

describe("volli:session-read-set (VC-30)", () => {
  /** One chat Session, minted through the engine the handlers are given. */
  async function chatSession(
    sessionEngine: ReturnType<typeof createTestSessionEngine>,
    ticketId: string | null,
  ): Promise<string> {
    const created = await sessionEngine.createSession({
      commandId: "create-read",
      projectId: createProject(),
      ticketId,
      role: roleImpliedByTicket(ticketId),
      parentSessionId: null,
      title: "Plan the migration",
      provenance: {
        source: { kind: "user", id: "test", detail: null },
        venue: { id: "local", kind: "local" },
      },
    });
    return created.session.id;
  }

  it("persists the receipt and re-publishes the row every sidebar holds", async () => {
    const sessionEngine = createTestSessionEngine(ctx.db, { now: () => 500 });
    const sessionId = await chatSession(sessionEngine, null);
    handlers.clear();
    registerDataIpcHandlers({ ok: true, db: ctx.db }, { sessionEngine });
    dataChangedSends.length = 0;

    const marked = await invoke<Promise<SessionReadSetResult>>("volli:session-read-set", {
      sessionId,
      unread: true,
    });

    expect(marked.ok && marked.read.unreadSince).toEqual(expect.any(Number));
    // The durable answer, read back through the same door a listing reads.
    expect(readSessionUnread(ctx.db, sessionId).unreadSince).toBe(
      marked.ok ? marked.read.unreadSince : null,
    );
    // And the row itself, on the push channel: this write moves no ledger fact,
    // so without the re-publish the other sidebar and the second window would
    // keep drawing the old dot.
    const pushed = dataChangedSends.filter((send) => send.channel === "volli:session-activity");
    expect(pushed).toHaveLength(1);
    const notice = pushed[0]!.payload as SessionActivityNotice;
    expect(rowId(notice.row)).toBe(sessionId);
    expect(notice.row.read).toEqual(marked.ok ? marked.read : null);
  });

  it("clears the receipt again, and publishes a row with nothing to say", async () => {
    const sessionEngine = createTestSessionEngine(ctx.db, { now: () => 500 });
    const sessionId = await chatSession(sessionEngine, null);
    handlers.clear();
    registerDataIpcHandlers({ ok: true, db: ctx.db }, { sessionEngine });
    await invoke<Promise<SessionReadSetResult>>("volli:session-read-set", {
      sessionId,
      unread: true,
    });
    dataChangedSends.length = 0;

    const read = await invoke<Promise<SessionReadSetResult>>("volli:session-read-set", {
      sessionId,
      unread: false,
    });

    expect(read).toEqual({ ok: true, read: { unreadSince: null } });
    const notice = dataChangedSends.find((send) => send.channel === "volli:session-activity")
      ?.payload as SessionActivityNotice;
    // The resting state is the field's absence — the same row the fetch returns.
    expect(notice.row).not.toHaveProperty("read");
  });

  it("refuses a Session the ledger does not have, and publishes nothing", async () => {
    const sessionEngine = createTestSessionEngine(ctx.db, { now: () => 500 });
    handlers.clear();
    registerDataIpcHandlers({ ok: true, db: ctx.db }, { sessionEngine });
    dataChangedSends.length = 0;

    const result = await invoke<Promise<SessionReadSetResult>>("volli:session-read-set", {
      sessionId: "never-minted",
      unread: true,
    });

    expect(result).toEqual({ ok: false, error: "Unknown session" });
    expect(dataChangedSends.filter((send) => send.channel === "volli:session-activity")).toEqual(
      [],
    );
  });

  it("rejects invalid input", () => {
    expect(invoke<SessionReadSetResult>("volli:session-read-set", { sessionId: "s1" })).toEqual({
      ok: false,
      error: "Invalid session read state",
    });
    expect(
      invoke<SessionReadSetResult>("volli:session-read-set", { sessionId: "", unread: true }),
    ).toEqual({ ok: false, error: "Invalid session read state" });
  });
});

describe("volli:session-peek-content (VC-30)", () => {
  it("reads local content without utility work, then refines only on explicit demand", async () => {
    const sessionEngine = createTestSessionEngine(ctx.db, { now: () => 500 });
    const created = await sessionEngine.createSession({
      commandId: "create-summary-peek",
      projectId: createProject(),
      ticketId: null,
      role: "project",
      parentSessionId: null,
      title: "Plan the migration",
      provenance: {
        source: { kind: "user", id: "test", detail: null },
        venue: { id: "local", kind: "local" },
      },
    });
    const summarizePeek = vi.fn(async () => "Combined summary");
    handlers.clear();
    registerDataIpcHandlers({ ok: true, db: ctx.db }, { sessionEngine, summarizePeek });
    expect(summarizePeek).not.toHaveBeenCalled();
    const local = await invoke<Promise<SessionPeekContentResult>>("volli:session-peek-content", {
      sessionId: created.session.id,
    });
    expect(local).toMatchObject({ ok: true, content: { entries: [], question: null } });
    expect(summarizePeek).not.toHaveBeenCalled();
    const result = await invoke<Promise<SessionPeekContentResult>>("volli:session-peek-content", {
      sessionId: created.session.id,
      refine: true,
    });
    expect(summarizePeek).toHaveBeenCalledExactlyOnceWith(created.session.id, []);
    expect(result).toMatchObject({ ok: true, content: { summary: "Combined summary" } });
  });

  it("answers the Session's tail and the question it is asking", async () => {
    const sessionEngine = createTestSessionEngine(ctx.db, { now: () => 500 });
    const created = await sessionEngine.createSession({
      commandId: "create-peek",
      projectId: createProject(),
      ticketId: null,
      role: "project",
      parentSessionId: null,
      title: "Plan the migration",
      provenance: {
        source: { kind: "user", id: "test", detail: null },
        venue: { id: "local", kind: "local" },
      },
    });
    handlers.clear();
    registerDataIpcHandlers({ ok: true, db: ctx.db }, { sessionEngine });

    const result = await invoke<Promise<SessionPeekContentResult>>("volli:session-peek-content", {
      sessionId: created.session.id,
    });

    expect(result).toEqual({
      ok: true,
      content: {
        sessionId: created.session.id,
        // No artifact store in this composition: counts, and no invented
        // entries (and `unreadable` stays 0 — nothing looked).
        entries: [],
        question: null,
        turns: 0,
        turnDepth: 0,
        unreadable: 0,
        lastActivityAt: expect.any(Number),
      },
    });
  });

  it("answers null content for a Session the ledger does not have", async () => {
    const sessionEngine = createTestSessionEngine(ctx.db, { now: () => 500 });
    handlers.clear();
    registerDataIpcHandlers({ ok: true, db: ctx.db }, { sessionEngine });

    const result = await invoke<Promise<SessionPeekContentResult>>("volli:session-peek-content", {
      sessionId: "never-minted",
    });

    expect(result).toEqual({ ok: true, content: null });
  });

  it("rejects invalid input", () => {
    expect(
      invoke<SessionPeekContentResult>("volli:session-peek-content", { sessionId: 7 }),
    ).toEqual({ ok: false, error: "Invalid session peek" });
    expect(
      invoke<SessionPeekContentResult>("volli:session-peek-content", { sessionId: "" }),
    ).toEqual({ ok: false, error: "Invalid session peek" });
  });
});

describe("volli:ticket-latest-signals", () => {
  it("uses the SessionEngine's bounded latest-signal query with a deterministic session-id tie-break", async () => {
    const projectId = createProject();
    const ticket = createTicket(projectId);
    const sessionEngine = createTestSessionEngine(ctx.db, { now: () => 500 });
    insertSession(ctx.db, testSession(projectId, ticket.id, { id: "session-a" }));
    insertSession(ctx.db, testSession(projectId, ticket.id, { id: "session-z" }));
    await sessionEngine.submit({
      commandId: "signal-a",
      sessionId: "session-a",
      intent: { kind: "session.signal", signal: "done", reason: "Earlier id" },
      provenance: {
        source: { kind: "user", id: "test", detail: null },
        venue: { id: "local", kind: "local" },
      },
    });
    await sessionEngine.submit({
      commandId: "signal-z",
      sessionId: "session-z",
      intent: { kind: "session.signal", signal: "blocked", reason: "Later id" },
      provenance: {
        source: { kind: "user", id: "test", detail: null },
        venue: { id: "local", kind: "local" },
      },
    });
    const listSessions = vi
      .spyOn(sessionEngine, "listSessions")
      .mockRejectedValue(new Error("should not project every session"));
    handlers.clear();
    registerDataIpcHandlers({ ok: true, db: ctx.db }, { sessionEngine });

    const result = await invoke<Promise<TicketLatestSignalsResult>>("volli:ticket-latest-signals", {
      projectId,
    });

    expect(result).toEqual({
      ok: true,
      signals: [
        {
          ticketId: ticket.id,
          sessionId: "session-z",
          signal: "blocked",
          reason: "Later id",
          createdAt: 500,
        },
      ],
    });
    expect(listSessions).not.toHaveBeenCalled();
  });
});

describe("volli:ticket-status-entries", () => {
  it("dates a moved ticket by its latest status_changed event and a never-moved ticket by its own createdAt", () => {
    const projectId = createProject();
    const moved = createTicket(projectId);
    const neverMoved = createTicket(projectId);

    const before = Date.now();
    const moveResult = invoke<TicketsResult>("volli:ticket-move", {
      projectId,
      ticketId: moved.id,
      toStatus: "doing",
      toIndex: 0,
    });
    const after = Date.now();
    expect(moveResult.ok).toBe(true);

    const result = invoke<TicketStatusEntriesResult>("volli:ticket-status-entries", { projectId });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);

    const movedEntry = result.entries.find((e) => e.ticketId === moved.id);
    expect(movedEntry?.status).toBe("doing");
    expect(movedEntry?.enteredAt).toBeGreaterThanOrEqual(before);
    expect(movedEntry?.enteredAt).toBeLessThanOrEqual(after);

    const neverMovedEntry = result.entries.find((e) => e.ticketId === neverMoved.id);
    expect(neverMovedEntry).toEqual({
      ticketId: neverMoved.id,
      status: "backlog",
      enteredAt: neverMoved.createdAt,
    });
  });

  it("excludes archived tickets", () => {
    const projectId = createProject();
    const live = createTicket(projectId);
    const archived = createTicket(projectId);
    archiveTicket(archived.id);

    const result = invoke<TicketStatusEntriesResult>("volli:ticket-status-entries", { projectId });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    expect(result.entries.map((e) => e.ticketId)).toEqual([live.id]);
  });
});

describe("volli:session-rename", () => {
  it("renames a session and persists the trimmed title", async () => {
    const projectId = createProject();
    insertSession(ctx.db, testSession(projectId, null, { id: "s1", title: "Session 1" }));

    const result = await invoke<Promise<SessionRenameResult>>("volli:session-rename", {
      sessionId: "s1",
      title: "  Renamed  ",
    });
    expect(result).toEqual({ ok: true });

    const list = await invoke<Promise<SessionsResult>>("volli:session-list", { projectId });
    expect(list.ok && list.sessions[0]?.record.title).toBe("Renamed");
  });

  it("rejects a blank title", () => {
    expect(
      invoke<SessionRenameResult>("volli:session-rename", { sessionId: "s1", title: "   " }),
    ).toEqual({ ok: false, error: "Invalid session title" });
  });

  it("reports an unknown session", async () => {
    createProject();
    expect(
      await invoke<Promise<SessionRenameResult>>("volli:session-rename", {
        sessionId: "ghost",
        title: "X",
      }),
    ).toEqual({ ok: false, error: "Unknown session" });
  });

  it("reports a durable rejection instead of acknowledging an archived session rename", async () => {
    const projectId = createProject();
    insertSession(ctx.db, testSession(projectId, null, { id: "s1", title: "Session 1" }));
    await createTestSessionEngine(ctx.db).submit({
      commandId: "archive-s1",
      sessionId: "s1",
      intent: { kind: "session.archive" },
      provenance: {
        source: { kind: "user", id: "test", detail: null },
        venue: { id: "local", kind: "local" },
      },
    });

    expect(
      await invoke<Promise<SessionRenameResult>>("volli:session-rename", {
        sessionId: "s1",
        title: "Renamed",
      }),
    ).toEqual({ ok: false, error: "Session rename was not completed" });
  });
});

describe("volli:session-rename auto-title rider", () => {
  /** A renameable session plus a recorder for whatever titling it asks for. */
  function renameHarness(): AutoTitleRequest[] {
    const projectId = createProject();
    insertSession(ctx.db, testSession(projectId, null, { id: "s1", title: "Session 1" }));
    const requests: AutoTitleRequest[] = [];
    registerDataIpcHandlers(
      { ok: true, db: ctx.db },
      { sessionEngine: fixtureSessionEngine, autoTitle: (input) => requests.push(input) },
    );
    return requests;
  }

  it("hands the refinement to the titling seam once the rename has stuck", async () => {
    const requests = renameHarness();

    const result = await invoke<Promise<SessionRenameResult>>("volli:session-rename", {
      sessionId: "s1",
      title: "  Fix the parser  ",
      refineFrom: "Fix the parser, it crashes on empty input",
    });
    expect(result).toEqual({ ok: true });
    // The baseline the async-gap guard compares against is the TRIMMED title
    // actually persisted, not the raw string the renderer sent.
    expect(requests).toEqual([
      {
        sessionId: "s1",
        firstMessage: "Fix the parser, it crashes on empty input",
        heuristicTitle: "Fix the parser",
      },
    ]);
  });

  it("refines a seeded fallback that already matches the requested title", async () => {
    const requests = renameHarness();

    const result = await invoke<Promise<SessionRenameResult>>("volli:session-rename", {
      sessionId: "s1",
      title: "Session 1",
      refineFrom: "Begin work on this ticket. Your assignment is the Ticket Brief above.",
    });

    expect(result).toEqual({ ok: true });
    expect(requests).toEqual([
      {
        sessionId: "s1",
        firstMessage: "Begin work on this ticket. Your assignment is the Ticket Brief above.",
        heuristicTitle: "Session 1",
      },
    ]);
  });

  it("refines nothing for a rename with no rider — a person naming their own chat", async () => {
    const requests = renameHarness();

    await invoke<Promise<SessionRenameResult>>("volli:session-rename", {
      sessionId: "s1",
      title: "My own name",
    });
    expect(requests).toEqual([]);
  });

  it("refines nothing when the rename itself was refused", async () => {
    const requests = renameHarness();

    expect(
      await invoke<Promise<SessionRenameResult>>("volli:session-rename", {
        sessionId: "ghost",
        title: "Fix the parser",
        refineFrom: "Fix the parser",
      }),
    ).toEqual({ ok: false, error: "Unknown session" });
    expect(requests).toEqual([]);
  });

  it("renames without a titling seam — a degraded boot refines nothing", async () => {
    const projectId = createProject();
    insertSession(ctx.db, testSession(projectId, null, { id: "s1", title: "Session 1" }));

    const result = await invoke<Promise<SessionRenameResult>>("volli:session-rename", {
      sessionId: "s1",
      title: "Fix the parser",
      refineFrom: "Fix the parser",
    });
    expect(result).toEqual({ ok: true });
  });

  it("refuses a blank rider before any rename happens", () => {
    expect(
      invoke<SessionRenameResult>("volli:session-rename", {
        sessionId: "s1",
        title: "Fix the parser",
        refineFrom: "   ",
      }),
    ).toEqual({ ok: false, error: "Invalid session title" });
  });
});

describe("volli:worktree-remove", () => {
  it("acks on success and broadcasts data-changed", async () => {
    vi.mocked(removeWorktree).mockResolvedValue({ ok: true, value: undefined });

    const result = await invoke<Promise<WorktreeRemoveResult>>("volli:worktree-remove", {
      ticketId: "ticket-1",
      force: false,
    });

    expect(result).toEqual({ ok: true });
    expect(vi.mocked(removeWorktree)).toHaveBeenCalledWith(expect.anything(), "ticket-1", {
      force: false,
    });
    // Targeted at the ticket whose worktree path was cleared (projectId is
    // undefined here — no ticket row was seeded — and undefined keys are ignored).
    await expectDataChanged({ entity: "tickets", ticketId: "ticket-1", kind: "worktree" });
  });

  it("refuses (main-side) when a terminal runs in the ticket's worktree, never calling remove", async () => {
    const projectId = createProject();
    const ticket = createTicket(projectId);
    const worktreePath = `${worktreesHome()}/VC-9-live`;
    invoke<TicketResult>("volli:ticket-update", { ticketId: ticket.id, worktreePath });

    handlers.clear();
    // A session whose cwd is INSIDE the worktree must block the removal.
    registerDataIpcHandlers(
      { ok: true, db: ctx.db },
      {
        sessionEngine: fixtureSessionEngine,
        busyWorktreeSites: async () => [
          { directory: `${worktreePath}/packages`, surface: "terminal" },
        ],
      },
    );

    const result = await invoke<Promise<WorktreeRemoveResult>>("volli:worktree-remove", {
      ticketId: ticket.id,
      force: false,
    });

    expect(result).toEqual({
      ok: false,
      error: "A terminal is still running in this worktree. Close it first.",
    });
    expect(vi.mocked(removeWorktree)).not.toHaveBeenCalled();
  });

  // The defect this guard used to have: an attached chat reported its worktree
  // busy for as long as the app ran, whether or not anything was in flight and
  // long after its tab was closed, and nothing the user could do cleared it.
  // A worktree nothing is working in is removed without a fight.
  it("removes a worktree no busy site names", async () => {
    const projectId = createProject();
    const ticket = createTicket(projectId);
    const worktreePath = `${worktreesHome()}/VC-9-quiet`;
    invoke<TicketResult>("volli:ticket-update", { ticketId: ticket.id, worktreePath });
    vi.mocked(removeWorktree).mockResolvedValue({ ok: true, value: undefined });

    handlers.clear();
    registerDataIpcHandlers(
      { ok: true, db: ctx.db },
      { sessionEngine: fixtureSessionEngine, busyWorktreeSites: async () => [] },
    );

    const result = await invoke<Promise<WorktreeRemoveResult>>("volli:worktree-remove", {
      ticketId: ticket.id,
      force: false,
    });

    expect(result).toEqual({ ok: true });
    expect(vi.mocked(removeWorktree)).toHaveBeenCalledWith(expect.anything(), ticket.id, {
      force: false,
    });
  });

  it("names stopping the agent when the busy surface is one, not closing a terminal", async () => {
    const projectId = createProject();
    const ticket = createTicket(projectId);
    const worktreePath = `${worktreesHome()}/VC-9-agent`;
    invoke<TicketResult>("volli:ticket-update", { ticketId: ticket.id, worktreePath });

    handlers.clear();
    registerDataIpcHandlers(
      { ok: true, db: ctx.db },
      {
        sessionEngine: fixtureSessionEngine,
        busyWorktreeSites: async () => [{ directory: worktreePath, surface: "agent" }],
      },
    );

    const result = await invoke<Promise<WorktreeRemoveResult>>("volli:worktree-remove", {
      ticketId: ticket.id,
      force: false,
    });

    expect(result).toEqual({
      ok: false,
      error: "An agent is still running in this worktree. Stop it first.",
    });
    expect(vi.mocked(removeWorktree)).not.toHaveBeenCalled();
  });

  it("surfaces a dirty-worktree refusal as a typed error", async () => {
    vi.mocked(removeWorktree).mockResolvedValue({
      ok: false,
      error: "Worktree has uncommitted work (dirty). Confirm removal to discard it.",
    });

    const result = await invoke<Promise<WorktreeRemoveResult>>("volli:worktree-remove", {
      ticketId: "ticket-1",
      force: false,
    });

    expect(result).toEqual({
      ok: false,
      error: "Worktree has uncommitted work (dirty). Confirm removal to discard it.",
    });
  });

  it("rejects a missing force flag", async () => {
    const result = await invoke<Promise<WorktreeRemoveResult>>("volli:worktree-remove", {
      ticketId: "ticket-1",
    });
    expect(result).toEqual({ ok: false, error: "Invalid worktree removal" });
    expect(vi.mocked(removeWorktree)).not.toHaveBeenCalled();
  });

  // The busy read costs one durable projection per binding under the target, so
  // it is asked about ONE directory: whole-list answers made every destructive
  // action replay the ledger of every chat the launch had opened.
  it("asks the busy supplier about the ticket's own worktree, not the whole app", async () => {
    const projectId = createProject();
    const ticket = createTicket(projectId);
    const worktreePath = `${worktreesHome()}/VC-9-scoped`;
    invoke<TicketResult>("volli:ticket-update", { ticketId: ticket.id, worktreePath });
    vi.mocked(removeWorktree).mockResolvedValue({ ok: true, value: undefined });
    const asked: string[] = [];

    handlers.clear();
    registerDataIpcHandlers(
      { ok: true, db: ctx.db },
      {
        sessionEngine: fixtureSessionEngine,
        busyWorktreeSites: async (target) => {
          asked.push(target);
          return [];
        },
      },
    );

    await invoke<Promise<WorktreeRemoveResult>>("volli:worktree-remove", {
      ticketId: ticket.id,
      force: false,
    });

    expect(asked).toEqual([worktreePath]);
  });

  // `remove` owns the ordering (after its dirty gate, before the delete); this
  // handler's job is only to hand it the seam.
  it("hands the release seam to remove so no Session is left pointed at the deleted path", async () => {
    const projectId = createProject();
    const ticket = createTicket(projectId);
    invoke<TicketResult>("volli:ticket-update", {
      ticketId: ticket.id,
      worktreePath: `${worktreesHome()}/VC-9-release`,
    });
    vi.mocked(removeWorktree).mockResolvedValue({ ok: true, value: undefined });
    const releaseAgentSites = vi.fn(async () => ({ released: [], stillOpen: [] }));

    handlers.clear();
    registerDataIpcHandlers(
      { ok: true, db: ctx.db },
      { sessionEngine: fixtureSessionEngine, releaseAgentSites },
    );

    await invoke<Promise<WorktreeRemoveResult>>("volli:worktree-remove", {
      ticketId: ticket.id,
      force: false,
    });

    expect(vi.mocked(removeWorktree)).toHaveBeenCalledWith(expect.anything(), ticket.id, {
      force: false,
      releaseAgentSites,
    });
  });
});

/**
 * VC-369. The rail's status read is five git children on the Electron main
 * process, and the Details rail asks for it from TWO surfaces that mount
 * together (`ticket-repository-summary` and `ticket-changes-panel`, both live at
 * once in split view) plus on every watch event. These assert the two defences
 * by call count on the seam: coalescing per ticket, and a share window so one
 * mount burst is one read.
 */
/** A promise the test releases by hand, so reads can be held mid-flight. */
function deferredGate(): { gate: Promise<void>; release: () => void } {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { gate, release };
}

/** Holds `readWorktreeStatus` open until the returned `release` is called. */
function deferredRead(): { release: () => void } {
  const { gate, release } = deferredGate();
  vi.mocked(readWorktreeStatus).mockImplementation(async () => {
    await gate;
    return { kind: "ok", status: { uncommitted: true } } as never;
  });
  return { release };
}

describe("volli:worktree-status coalescing (VC-369)", () => {
  it("serves both rail surfaces from ONE read when they mount together", async () => {
    const { release } = deferredRead();

    // Both surfaces ask before the first read has finished — the mount burst.
    const first = invoke<Promise<WorktreeStatusResult>>("volli:worktree-status", {
      ticketId: "t1",
    });
    const second = invoke<Promise<WorktreeStatusResult>>("volli:worktree-status", {
      ticketId: "t1",
    });
    release();

    expect(await first).toEqual({ ok: true, status: { uncommitted: true } });
    expect(await second).toEqual({ ok: true, status: { uncommitted: true } });
    // Five git children, not ten.
    expect(vi.mocked(readWorktreeStatus)).toHaveBeenCalledTimes(1);
  });

  it("keeps tickets independent — one ticket's burst never answers another's", async () => {
    const { release } = deferredRead();

    const a = invoke<Promise<WorktreeStatusResult>>("volli:worktree-status", { ticketId: "t1" });
    const b = invoke<Promise<WorktreeStatusResult>>("volli:worktree-status", { ticketId: "t2" });
    release();
    await Promise.all([a, b]);

    expect(vi.mocked(readWorktreeStatus)).toHaveBeenCalledTimes(2);
  });

  it("keeps the discriminated failure arms identical through the coalescer", async () => {
    vi.mocked(readWorktreeStatus).mockResolvedValue({ kind: "missing-ticket" } as never);
    expect(
      await invoke<Promise<WorktreeStatusResult>>("volli:worktree-status", { ticketId: "t1" }),
    ).toEqual({ ok: false, error: "Unknown ticket" });

    vi.mocked(readWorktreeStatus).mockResolvedValue({
      kind: "no-worktree",
      displayId: "VC-1",
      usesWorktree: true,
    } as never);
    expect(
      await invoke<Promise<WorktreeStatusResult>>("volli:worktree-status", { ticketId: "t2" }),
    ).toEqual({ ok: false, error: "This ticket has no worktree." });

    vi.mocked(readWorktreeStatus).mockResolvedValue({
      kind: "missing-on-disk",
      displayId: "VC-1",
      worktreePath: "/gone",
    } as never);
    expect(
      await invoke<Promise<WorktreeStatusResult>>("volli:worktree-status", { ticketId: "t3" }),
    ).toMatchObject({ ok: false });
  });
});

describe("volli:worktree-diff coalescing (VC-369)", () => {
  it("coalesces one ticket+mode, and never shares an answer across modes", async () => {
    const { gate, release } = deferredGate();
    vi.mocked(readWorktreeDiff).mockImplementation(async (_deps, _id, mode) => {
      await gate;
      return {
        kind: "ok",
        diff: { files: [], insertions: mode === "merge-base" ? 1 : 2 },
      } as never;
    });

    const a = invoke<Promise<WorktreeDiffResult>>("volli:worktree-diff", {
      ticketId: "t1",
      mode: "merge-base",
    });
    const sameAgain = invoke<Promise<WorktreeDiffResult>>("volli:worktree-diff", {
      ticketId: "t1",
      mode: "merge-base",
    });
    const otherMode = invoke<Promise<WorktreeDiffResult>>("volli:worktree-diff", {
      ticketId: "t1",
      mode: "working-tree",
    });
    release();

    // The two modes are different questions; only the identical pair shares.
    expect(await a).toMatchObject({ ok: true, diff: { insertions: 1 } });
    expect(await sameAgain).toMatchObject({ ok: true, diff: { insertions: 1 } });
    expect(await otherMode).toMatchObject({ ok: true, diff: { insertions: 2 } });
    expect(vi.mocked(readWorktreeDiff)).toHaveBeenCalledTimes(2);
  });
});

describe("volli:worktree-change-watch (VC-369)", () => {
  it("resolves the path without running the five-child status read", async () => {
    vi.mocked(resolveWorktreeTarget).mockReturnValue({
      kind: "ok",
      target: {
        displayId: "VC-1",
        worktreePath: "/wt/VC-1",
        branch: "b",
        baseBranch: "main",
      },
    } as never);

    expect(
      await invoke<Promise<Result>>("volli:worktree-change-watch", { ticketId: "t1" }),
    ).toMatchObject({ ok: true });
    // The whole saving: this handler only ever wanted the path.
    expect(vi.mocked(readWorktreeStatus)).not.toHaveBeenCalled();
  });

  it("keeps the same failure arms it reported from the status read", async () => {
    vi.mocked(resolveWorktreeTarget).mockReturnValue({ kind: "missing-ticket" } as never);
    expect(
      await invoke<Promise<Result>>("volli:worktree-change-watch", { ticketId: "t1" }),
    ).toEqual({ ok: false, error: "Unknown ticket" });

    vi.mocked(resolveWorktreeTarget).mockReturnValue({
      kind: "no-worktree",
      displayId: "VC-1",
      usesWorktree: true,
    } as never);
    expect(
      await invoke<Promise<Result>>("volli:worktree-change-watch", { ticketId: "t1" }),
    ).toEqual({ ok: false, error: "This ticket has no worktree." });
  });
});

/**
 * VC-372. Now↔Diffs unmounts one rail panel and mounts the other — both asking
 * for the same status + Change Set pair — and a diff tab asks for the Change Set
 * a third time just to find its own row. These assert the last-known snapshot by
 * call count on the read seam: served while a watch covers the ticket, retired
 * by a watcher change, by a mutating verb, or by the loss of coverage.
 */
describe("the rail's last-known worktree snapshot (VC-372)", () => {
  const okStatus = {
    kind: "ok",
    displayId: "VC-1",
    worktreePath: "/wt/VC-1",
    branch: "b",
    baseBranch: "main",
    status: {
      uncommitted: false,
      sequencerActive: false,
      aheadOfBase: 0,
      behindBase: 0,
      unpushed: null,
    },
  };
  const okChangeSet = {
    kind: "ok",
    displayId: "VC-1",
    changeSet: {
      baseRevision: "base",
      headRevision: "head",
      files: [],
      insertions: 0,
      deletions: 0,
      revision: "rev",
      truncated: false,
      totalCount: 0,
    },
  };

  /** Both rail surfaces read the same pair; stub it as an ok answer. */
  function stubReads(): void {
    vi.mocked(readWorktreeStatus).mockResolvedValue(okStatus as never);
    vi.mocked(readWorktreeChangeSet).mockResolvedValue(okChangeSet as never);
  }

  async function readPair(ticketId = "t1"): Promise<void> {
    await invoke<Promise<WorktreeStatusResult>>("volli:worktree-status", { ticketId });
    await invoke<Promise<WorktreeChangeSetResult>>("volli:worktree-change-set", { ticketId });
  }

  async function subscribe(ticketId = "t1"): Promise<void> {
    vi.mocked(resolveWorktreeTarget).mockReturnValue({
      kind: "ok",
      target: { displayId: "VC-1", worktreePath: "/wt/VC-1", branch: "b", baseBranch: "main" },
    } as never);
    await invoke<Promise<Result>>("volli:worktree-change-watch", { ticketId });
  }

  /** Everything one panel's mount does: read the pair, then subscribe. */
  async function mountPanel(ticketId = "t1"): Promise<void> {
    await readPair(ticketId);
    await subscribe(ticketId);
  }

  /** The unwatch → read → watch beat of a rail page flip. */
  async function flipPanel(ticketId = "t1"): Promise<void> {
    invoke<Result>("volli:worktree-change-unwatch", { ticketId });
    await readPair(ticketId);
    await subscribe(ticketId);
  }

  /** The watcher's eager change report, as the real manager sends it. */
  function fireWorktreeChange(...ticketIds: string[]): void {
    worktreeWatch.options?.onRelevantChange?.(ticketIds);
  }

  /**
   * The real manager reports this once a released root's rewatch grace expires
   * (or its handle faults). The read-level suite drives the real timing; here it
   * is the door into the same observer call.
   */
  function endCoverage(ticketId: string): void {
    worktreeWatch.options?.onCoverageChange?.(ticketId, false);
  }

  it("serves the Now↔Diffs↔Now flips from the panel's first read", async () => {
    stubReads();
    await mountPanel();
    expect(vi.mocked(readWorktreeStatus)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(readWorktreeChangeSet)).toHaveBeenCalledTimes(1);

    await flipPanel();
    await flipPanel();

    expect(vi.mocked(readWorktreeStatus)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(readWorktreeChangeSet)).toHaveBeenCalledTimes(1);
  });

  it("re-reads exactly one status and one Change Set when the watcher reports a change", async () => {
    stubReads();
    await mountPanel();

    fireWorktreeChange("t1");
    await readPair();

    expect(vi.mocked(readWorktreeStatus)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(readWorktreeChangeSet)).toHaveBeenCalledTimes(2);
  });

  it("keeps tickets independent — one ticket's change never answers another's", async () => {
    stubReads();
    await mountPanel("t1");
    await mountPanel("t2");

    fireWorktreeChange("t1");
    await readPair("t2");

    // t2's answer was not invalidated; t1's was.
    expect(vi.mocked(readWorktreeStatus)).toHaveBeenCalledTimes(2);
  });

  it("ends coverage when the watch really tears down, so the next mount reads fresh", async () => {
    stubReads();
    await mountPanel();

    endCoverage("t1");
    await readPair();

    expect(vi.mocked(readWorktreeStatus)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(readWorktreeChangeSet)).toHaveBeenCalledTimes(2);
  });

  it("retires the answer on a rail commit", async () => {
    stubReads();
    await mountPanel();
    vi.mocked(commitTicketRemaining).mockResolvedValue({
      ok: true,
      value: { committed: true, message: "feat: x" },
    } as never);

    await invoke<Promise<WorktreeCommitResult>>("volli:worktree-commit", {
      ticketId: "t1",
      message: "feat: x",
      includeUnstaged: false,
    });
    await readPair();

    expect(vi.mocked(readWorktreeStatus)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(readWorktreeChangeSet)).toHaveBeenCalledTimes(2);
  });

  it("retires the answer on a rail push-pr", async () => {
    stubReads();
    await mountPanel();
    vi.mocked(publishTicketBranch).mockResolvedValue({
      ok: true,
      value: { url: "https://example.test/pr/1", existing: false },
    } as never);

    await invoke<Promise<WorktreePushPrResult>>("volli:worktree-push-pr", { ticketId: "t1" });
    await readPair();

    expect(vi.mocked(readWorktreeStatus)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(readWorktreeChangeSet)).toHaveBeenCalledTimes(2);
  });

  it("retires the answer when the worktree is removed", async () => {
    stubReads();
    await mountPanel();
    vi.mocked(removeWorktree).mockResolvedValue({ ok: true, value: undefined } as never);

    await invoke<Promise<WorktreeRemoveResult>>("volli:worktree-remove", {
      ticketId: "t1",
      force: false,
    });
    await readPair();

    expect(vi.mocked(readWorktreeStatus)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(readWorktreeChangeSet)).toHaveBeenCalledTimes(2);
  });

  it("retires the answer when the worktree is recreated", async () => {
    stubReads();
    const projectId = createProject();
    const ticket = createTicket(projectId);
    await mountPanel(ticket.id);
    vi.mocked(ensure).mockResolvedValue({
      ok: true,
      value: { identity: { worktreePath: "/wt/VC-1" } },
    } as never);

    await invoke<Promise<WorktreeRecreateResult>>("volli:worktree-recreate", {
      ticketId: ticket.id,
    });
    await readPair(ticket.id);

    expect(vi.mocked(readWorktreeStatus)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(readWorktreeChangeSet)).toHaveBeenCalledTimes(2);
  });

  it("retires the answer when retention archives and cleans the checkout", async () => {
    stubReads();
    await mountPanel();
    vi.mocked(archiveAndClean).mockResolvedValue({ ok: true, value: undefined } as never);

    await invoke<Promise<RetentionArchiveCleanResult>>("volli:retention-archive-clean", {
      ticketId: "t1",
    });
    await readPair();

    expect(vi.mocked(readWorktreeStatus)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(readWorktreeChangeSet)).toHaveBeenCalledTimes(2);
  });

  it("retires every ticket's answer on an untargeted trim sweep", async () => {
    stubReads();
    await mountPanel("t1");
    await mountPanel("t2");
    vi.mocked(trimAllWorktrees).mockResolvedValue({
      dryRun: false,
      removedCount: 1,
    } as never);

    await invoke<Promise<WorktreeTrimResult>>("volli:worktree-trim");
    await readPair("t1");
    await readPair("t2");

    expect(vi.mocked(readWorktreeStatus)).toHaveBeenCalledTimes(4);
    expect(vi.mocked(readWorktreeChangeSet)).toHaveBeenCalledTimes(4);
  });

  it("asks only for the base read when a diff tab opens over the Diffs page's snapshot", async () => {
    stubReads();
    await mountPanel();
    // The Diffs page holds this pair; opening one of its rows asks for the
    // Change Set again only to find the row and its `baseRevision`.
    vi.mocked(readWorktreeBaseFile).mockResolvedValue({
      kind: "ok",
      displayId: "VC-1",
      baseRevision: "base",
      file: { content: "hello\n", truncated: false },
    } as never);

    await invoke<Promise<WorktreeChangeSetResult>>("volli:worktree-change-set", {
      ticketId: "t1",
    });
    const base = await invoke<Promise<WorktreeBaseReadResult>>("volli:worktree-base-read", {
      ticketId: "t1",
      path: "src/a.ts",
      baseRevision: "base",
    });

    expect(base).toMatchObject({ ok: true, content: "hello\n" });
    // The Change Set was served, not re-read; the base read is the only worktree
    // read this tab needed.
    expect(vi.mocked(readWorktreeChangeSet)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(readWorktreeBaseFile)).toHaveBeenCalledTimes(1);
  });
});

describe("volli:worktree-branches", () => {
  it("flattens the listing onto the result envelope", async () => {
    vi.mocked(listBranches).mockResolvedValue({
      ok: true,
      value: {
        branches: ["main", "dev"],
        current: "dev",
        remotes: ["origin/main"],
        fetchedAt: 1_700_000_000_000,
      },
    });

    const result = await invoke<Promise<WorktreeBranchesResult>>("volli:worktree-branches", {
      projectId: "project-1",
    });

    expect(result).toEqual({
      ok: true,
      branches: ["main", "dev"],
      current: "dev",
      remotes: ["origin/main"],
      fetchedAt: 1_700_000_000_000,
    });
  });

  it("rejects a non-string projectId", () => {
    const result = invoke<WorktreeBranchesResult>("volli:worktree-branches", 42);
    expect(result).toEqual({ ok: false, error: "Invalid project" });
    expect(vi.mocked(listBranches)).not.toHaveBeenCalled();
  });
});

// VC-113: the way back from a worktree something outside the app deleted. The
// branch survives every route that takes the directory (a second install's
// sweep, `git worktree remove`, a manual rm -rf), so the checkout can always be
// put back on it — before this channel the only unwritten route was to start a
// whole Session, and the rail could offer nothing but a Retry that always
// failed.
describe("volli:worktree-recreate", () => {
  function worktreeTicket(projectId: string): Ticket {
    const result = invoke<TicketResult>("volli:ticket-create", {
      projectId,
      status: "doing",
      title: "A ticket",
    });
    if (!result.ok) throw new Error(result.error);
    return result.ticket;
  }

  it("re-materializes on the existing branch and broadcasts the new identity", async () => {
    const projectId = createProject();
    const ticket = worktreeTicket(projectId);
    vi.mocked(ensure).mockResolvedValue({
      ok: true as const,
      value: {
        identity: {
          worktreePath: "/wt/VC-1-a-ticket",
          branch: "volli/VC-1-a-ticket",
          baseBranch: "main",
        },
        created: true,
        restamped: true,
      },
    });

    const result = await invoke<Promise<WorktreeRecreateResult>>("volli:worktree-recreate", {
      ticketId: ticket.id,
    });

    expect(result).toEqual({ ok: true, worktreePath: "/wt/VC-1-a-ticket" });
    await expectDataChanged({
      entity: "tickets",
      ticketId: ticket.id,
      projectId,
      kind: "worktree",
    });
  });

  it("surfaces the git reason when the checkout can't be put back", async () => {
    const projectId = createProject();
    const ticket = worktreeTicket(projectId);
    vi.mocked(ensure).mockResolvedValue({
      ok: false as const,
      error: "Branch volli/VC-1 is already checked out at /elsewhere",
    });

    const result = await invoke<Promise<WorktreeRecreateResult>>("volli:worktree-recreate", {
      ticketId: ticket.id,
    });

    expect(result).toEqual({
      ok: false,
      error: "Branch volli/VC-1 is already checked out at /elsewhere",
    });
  });

  it("refuses a ticket that runs in the main checkout rather than inventing a worktree for it", async () => {
    const projectId = createProject();
    const result = invoke<TicketResult>("volli:ticket-create", {
      projectId,
      status: "doing",
      title: "Main checkout ticket",
      usesWorktree: false,
    });
    if (!result.ok) throw new Error(result.error);

    const recreated = await invoke<Promise<WorktreeRecreateResult>>("volli:worktree-recreate", {
      ticketId: result.ticket.id,
    });

    expect(recreated).toEqual({ ok: false, error: "This ticket runs in the main checkout." });
    expect(vi.mocked(ensure)).not.toHaveBeenCalled();
  });

  it("answers Unknown ticket rather than reaching for git", async () => {
    const result = await invoke<Promise<WorktreeRecreateResult>>("volli:worktree-recreate", {
      ticketId: "nope",
    });

    expect(result).toEqual({ ok: false, error: "Unknown ticket" });
    expect(vi.mocked(ensure)).not.toHaveBeenCalled();
  });
});

/** The two seams the manual Delete is given; both destructive paths must get them. */
const noBusySites = async () => [];
const noAgentSites = async () => ({ released: [], stillOpen: [] });

describe("volli:worktree-orphans", () => {
  const report = {
    revision: "rev-1",
    scannedAt: 1_000,
    retentionDays: 14,
    prunable: [
      {
        id: "rev-1:metadata:0",
        projectId: "project-1",
        projectName: "Volli",
        projectPath: "/repo",
        path: "/wt/gone",
        reason: "gitdir file points to non-existent location",
      },
    ],
    keptMetadata: [],
    removable: [
      {
        id: "rev-1:worktree:0",
        path: "/wt/orphan",
        projectId: "project-1",
        projectName: "Volli",
        branch: "volli/VC-1-x",
        lastTouchedAt: 1,
        ageBasis: "directory" as const,
        removableAt: 2,
      },
    ],
    keptRecent: [
      {
        path: "/wt/fresh",
        projectId: "project-1",
        projectName: "Volli",
        branch: "volli/VC-2-y",
        lastTouchedAt: 2,
        ageBasis: "commit" as const,
        removableAt: 3,
        reason: "recently-used" as const,
        detail: null,
      },
    ],
    unreadableProjects: [],
    dirty: [
      {
        path: "/wt/dirty",
        projectId: "project-1",
        projectName: "Volli",
        reason: "uncommitted work",
      },
    ],
    plan: [
      {
        id: "rev-1:metadata:0",
        kind: "metadata" as const,
        path: "/wt/gone",
        projectId: "project-1",
        projectName: "Volli",
        projectPath: "/repo",
        branch: null,
        gitReason: "gitdir file points to non-existent location",
      },
      {
        id: "rev-1:worktree:0",
        kind: "worktree" as const,
        path: "/wt/orphan",
        projectId: "project-1",
        projectName: "Volli",
        projectPath: "/repo",
        branch: "volli/VC-1-x",
        gitReason: null,
      },
    ],
  };

  /** The wire shape: the scan minus the plan, which never leaves main. */
  const wire = (() => {
    const { plan: _plan, ...rest } = report;
    return rest;
  })();

  it("wraps the scan report, with the durable cleanup history beside it", async () => {
    vi.mocked(scanOrphans).mockResolvedValue(report);
    // A real recorded run, through the real command core.
    const engine = orphanCleanupEngine(ctx.db);
    await engine.accept({
      commandId: "cmd-history",
      source: "settings",
      scanRevision: "rev-0",
      requestedItemIds: [],
      retentionDays: 14,
      preservation: ["branches"],
      items: [],
    });
    await engine.finish({ commandId: "cmd-history" });

    const result = await invoke<Promise<WorktreeOrphansResult>>("volli:worktree-orphans");

    expect(result).toEqual({
      ok: true,
      ...wire,
      runs: [expect.objectContaining({ id: "cmd-history", source: "settings" })],
    });
  });

  it("fails loudly when the cleanup history cannot be read, rather than reporting none", async () => {
    vi.mocked(scanOrphans).mockResolvedValue(report);
    const engine = orphanCleanupEngine(ctx.db);
    await engine.accept({
      commandId: "cmd-damaged",
      source: "settings",
      scanRevision: "rev-0",
      requestedItemIds: [],
      retentionDays: 14,
      preservation: [],
      items: [],
    });
    // Past the column's json_valid CHECK: damage of this kind comes from
    // outside SQLite, not from a write this app could make.
    ctx.db.pragma("ignore_check_constraints = ON");
    ctx.db
      .prepare("UPDATE worktree_cleanup_facts SET payload = ? WHERE command_id = ?")
      .run("{not json", "cmd-damaged");
    ctx.db.pragma("ignore_check_constraints = OFF");

    const result = await invoke<Promise<WorktreeOrphansResult>>("volli:worktree-orphans");

    // An empty history and an unreadable one are different statements, and a
    // deletion log that confuses them is the failure VC-284 exists to end.
    expect(result).toEqual({
      ok: false,
      error: expect.stringContaining("Couldn't read the cleanup history"),
    });
  });

  it("never removes anything: the channel only ever runs the read-only scan", async () => {
    vi.mocked(scanOrphans).mockResolvedValue(report);

    await invoke<Promise<WorktreeOrphansResult>>("volli:worktree-orphans");
    await invoke<Promise<WorktreeOrphansResult>>("volli:worktree-orphans", { refresh: true });

    expect(vi.mocked(cleanupOrphans)).not.toHaveBeenCalled();
  });

  it("gives the scan the activity supplier, so an occupied checkout is never proposed", async () => {
    vi.mocked(scanOrphans).mockResolvedValue(report);
    handlers.clear();
    registerDataIpcHandlers(
      { ok: true, db: ctx.db },
      {
        sessionEngine: fixtureSessionEngine,
        busyWorktreeSites: noBusySites,
        releaseAgentSites: noAgentSites,
      },
    );

    await invoke<Promise<WorktreeOrphansResult>>("volli:worktree-orphans");

    expect(vi.mocked(scanOrphans)).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ busyWorktreeSites: noBusySites }),
    );
  });

  it("returns the cached scan without re-walking on a second call within a launch", async () => {
    vi.mocked(scanOrphans).mockResolvedValue(report);

    await invoke<Promise<WorktreeOrphansResult>>("volli:worktree-orphans");
    await invoke<Promise<WorktreeOrphansResult>>("volli:worktree-orphans");

    // Cheap, not safe: a second scan would change nothing, it would just cost
    // several git children per project on every pane mount.
    expect(vi.mocked(scanOrphans)).toHaveBeenCalledTimes(1);
  });

  it("re-scans on an explicit refresh", async () => {
    vi.mocked(scanOrphans).mockResolvedValue(report);

    await invoke<Promise<WorktreeOrphansResult>>("volli:worktree-orphans");
    await invoke<Promise<WorktreeOrphansResult>>("volli:worktree-orphans", { refresh: true });

    expect(vi.mocked(scanOrphans)).toHaveBeenCalledTimes(2);
  });

  /** The plan a scan minted, as the cleanup channel must resolve it. */
  async function scanOnce(): Promise<void> {
    vi.mocked(scanOrphans).mockResolvedValue(report);
    await invoke<Promise<WorktreeOrphansResult>>("volli:worktree-orphans");
  }

  describe("volli:worktree-orphan-cleanup", () => {
    // Command ids are UUIDs on this door (docs/BOUNDARIES.md rule 1): the id a
    // DELETION is replayed under must not be one two callers could both mint.
    const CLEANUP_COMMAND_ID = "6f1a2b3c-4d5e-4f60-8a91-2b3c4d5e6f70";
    const SECOND_COMMAND_ID = "7a2b3c4d-5e6f-4071-9b02-3c4d5e6f7081";
    const THIRD_COMMAND_ID = "8b3c4d5e-6f70-4182-ac13-4d5e6f708192";
    const FOURTH_COMMAND_ID = "9c4d5e6f-7081-4293-bd24-5e6f708192a3";
    const FIFTH_COMMAND_ID = "ad5e6f70-8192-43a4-8e35-6f708192a3b4";

    const run = {
      id: CLEANUP_COMMAND_ID,
      source: "settings" as const,
      scanRevision: "rev-1",
      startedAt: 1,
      finishedAt: 2,
      interruptedAt: null,
      preservation: ["branches"],
      retentionDays: 14,
      items: [
        {
          id: "rev-1:worktree:0",
          kind: "worktree" as const,
          path: "/wt/orphan",
          projectId: "project-1",
          projectName: "Volli",
          projectPath: "/repo",
          branch: "volli/VC-1-x",
          state: "completed" as const,
          detail: "Removed the folder.",
          startedAt: 1,
          settledAt: 2,
          reconciledAt: null,
        },
      ],
    };
    const receipt = {
      id: "receipt-1",
      commandId: CLEANUP_COMMAND_ID,
      status: "completed" as const,
      code: null,
      detail: null,
      recordedAt: 2,
    };

    it("resolves the confirmed item ids into main's own plan, with the activity guard attached", async () => {
      vi.mocked(cleanupOrphans).mockResolvedValue({ run, receipt });
      // The same two seams the manual Delete is given: a cleanup that could not
      // see live work would be exactly the sweep VC-284 is replacing.
      handlers.clear();
      registerDataIpcHandlers(
        { ok: true, db: ctx.db },
        {
          sessionEngine: fixtureSessionEngine,
          busyWorktreeSites: noBusySites,
          releaseAgentSites: noAgentSites,
        },
      );
      await scanOnce();

      const result = await invoke<Promise<WorktreeOrphanCleanupResult>>(
        "volli:worktree-orphan-cleanup",
        {
          commandId: CLEANUP_COMMAND_ID,
          scanRevision: "rev-1",
          itemIds: ["rev-1:worktree:0", "rev-1:metadata:0"],
        },
      );

      expect(result).toEqual({ ok: true, run, receipt });
      expect(vi.mocked(cleanupOrphans)).toHaveBeenCalledWith(
        expect.objectContaining({
          busyWorktreeSites: noBusySites,
          releaseAgentSites: noAgentSites,
          engine: expect.anything(),
        }),
        {
          commandId: CLEANUP_COMMAND_ID,
          scanRevision: "rev-1",
          // The ids as the caller sent them, kept so a retry is decidable from
          // the durable record alone, and the window the proposal was measured
          // against (re-review S1/C1).
          requestedItemIds: ["rev-1:worktree:0", "rev-1:metadata:0"],
          retentionDays: 14,
          source: "settings",
          // Main's own plan items — paths the renderer never supplied, in the
          // order the proposal listed them.
          items: report.plan,
        },
      );
    });

    it("refuses a revision it no longer holds, and says how to recover", async () => {
      await scanOnce();

      const result = await invoke<Promise<WorktreeOrphanCleanupResult>>(
        "volli:worktree-orphan-cleanup",
        {
          commandId: SECOND_COMMAND_ID,
          scanRevision: "some-older-scan",
          itemIds: ["rev-1:worktree:0"],
        },
      );

      expect(result).toEqual({
        ok: false,
        code: "scan-superseded",
        error: expect.stringContaining("Scan again"),
      });
      expect(vi.mocked(cleanupOrphans)).not.toHaveBeenCalled();
      // The refusal is durable: a request to delete against a scan we no longer
      // hold is exactly what an audit wants to find.
      const rejected = ctx.db
        .prepare("SELECT status, code FROM worktree_cleanup_receipts WHERE command_id = ?")
        .get(SECOND_COMMAND_ID);
      expect(rejected).toEqual({ status: "rejected", code: "scan-superseded" });
    });

    it("refuses an item id the scan never proposed", async () => {
      await scanOnce();

      const result = await invoke<Promise<WorktreeOrphanCleanupResult>>(
        "volli:worktree-orphan-cleanup",
        { commandId: THIRD_COMMAND_ID, scanRevision: "rev-1", itemIds: ["rev-1:worktree:99"] },
      );

      expect(result).toEqual({
        ok: false,
        code: "unknown-items",
        error: expect.stringContaining("Scan again"),
      });
      expect(vi.mocked(cleanupOrphans)).not.toHaveBeenCalled();
    });

    it("refuses any cleanup before a scan has ever run", async () => {
      const result = await invoke<Promise<WorktreeOrphanCleanupResult>>(
        "volli:worktree-orphan-cleanup",
        { commandId: FOURTH_COMMAND_ID, scanRevision: "rev-1", itemIds: ["rev-1:worktree:0"] },
      );

      expect(result).toEqual({ ok: false, code: "scan-superseded", error: expect.any(String) });
      expect(vi.mocked(cleanupOrphans)).not.toHaveBeenCalled();
    });

    it("drops the cached scan so the next read cannot list a directory that is gone", async () => {
      vi.mocked(cleanupOrphans).mockResolvedValue({ run, receipt });
      await scanOnce();

      await invoke<Promise<WorktreeOrphanCleanupResult>>("volli:worktree-orphan-cleanup", {
        commandId: CLEANUP_COMMAND_ID,
        scanRevision: "rev-1",
        itemIds: ["rev-1:worktree:0"],
      });
      await invoke<Promise<WorktreeOrphansResult>>("volli:worktree-orphans");

      expect(vi.mocked(scanOrphans)).toHaveBeenCalledTimes(2);
    });

    it("rejects a request that names no items at all", async () => {
      const result = await invoke<Promise<WorktreeOrphanCleanupResult>>(
        "volli:worktree-orphan-cleanup",
        { commandId: FIFTH_COMMAND_ID, scanRevision: "rev-1", itemIds: [] },
      );

      expect(result).toEqual({ ok: false, error: "Invalid cleanup request" });
      expect(vi.mocked(cleanupOrphans)).not.toHaveBeenCalled();
    });

    it("rejects a command id that is not a UUID", async () => {
      // The id a DELETION is replayed under. `"cmd-1"` is an id a second writer
      // could mint too, and being answered with somebody else's deletion is
      // exactly what docs/BOUNDARIES.md rule 1 exists to prevent.
      const result = await invoke<Promise<WorktreeOrphanCleanupResult>>(
        "volli:worktree-orphan-cleanup",
        { commandId: "cmd-1", scanRevision: "rev-1", itemIds: ["rev-1:worktree:0"] },
      );

      expect(result).toEqual({ ok: false, error: "Invalid cleanup request" });
      expect(vi.mocked(cleanupOrphans)).not.toHaveBeenCalled();
    });

    // The gateway rule (re-review S1). A cleanup invalidates the scan it ran
    // against, so a retry validated against the CURRENT scan is told its
    // command was superseded — a completed deletion reported as a failure, with
    // a second deletion the obvious next step. The durable record answers
    // first, and it needs no scan to do it.
    it("replays a completed command instead of re-validating it against the scan it consumed", async () => {
      const engine = orphanCleanupEngine(ctx.db);
      // A real accepted+completed command under this id, as the first call left
      // behind. The executor is mocked here, so it is recorded directly.
      vi.mocked(cleanupOrphans).mockImplementation(async () => {
        await engine.accept({
          commandId: CLEANUP_COMMAND_ID,
          source: "settings",
          scanRevision: "rev-1",
          requestedItemIds: ["rev-1:worktree:0"],
          retentionDays: 14,
          preservation: ["branches"],
          items: [report.plan[1]!],
        });
        await engine.settleItem({
          commandId: CLEANUP_COMMAND_ID,
          itemId: "rev-1:worktree:0",
          state: "completed",
          detail: "Removed the folder.",
        });
        return engine.finish({ commandId: CLEANUP_COMMAND_ID });
      });
      await scanOnce();
      const first = await invoke<Promise<WorktreeOrphanCleanupResult>>(
        "volli:worktree-orphan-cleanup",
        {
          commandId: CLEANUP_COMMAND_ID,
          scanRevision: "rev-1",
          itemIds: ["rev-1:worktree:0"],
        },
      );
      expect(first.ok).toBe(true);
      // The first run dropped the cached scan, so nothing live can vouch for
      // this revision any more.
      vi.mocked(cleanupOrphans).mockClear();

      const retry = await invoke<Promise<WorktreeOrphanCleanupResult>>(
        "volli:worktree-orphan-cleanup",
        {
          commandId: CLEANUP_COMMAND_ID,
          scanRevision: "rev-1",
          itemIds: ["rev-1:worktree:0"],
        },
      );

      expect(retry).toEqual({
        ok: true,
        run: expect.objectContaining({ id: CLEANUP_COMMAND_ID }),
        receipt: expect.objectContaining({ status: "completed" }),
      });
      // Nothing ran a second time, and no scan was consulted to decide that.
      expect(vi.mocked(cleanupOrphans)).not.toHaveBeenCalled();
      const receipts = ctx.db
        .prepare("SELECT status FROM worktree_cleanup_receipts WHERE command_id = ? ORDER BY rowid")
        .all(CLEANUP_COMMAND_ID) as { status: string }[];
      // And no `rejected` receipt was stacked on top of the completion.
      expect(receipts.map((row) => row.status)).toEqual(["accepted", "completed"]);
    });

    it("calls a used command id carrying a different request a conflict", async () => {
      await scanOnce();
      const engine = orphanCleanupEngine(ctx.db);
      await engine.accept({
        commandId: CLEANUP_COMMAND_ID,
        source: "settings",
        scanRevision: "rev-1",
        requestedItemIds: ["rev-1:worktree:0"],
        retentionDays: 14,
        preservation: [],
        items: [report.plan[1]!],
      });

      const result = await invoke<Promise<WorktreeOrphanCleanupResult>>(
        "volli:worktree-orphan-cleanup",
        {
          commandId: CLEANUP_COMMAND_ID,
          scanRevision: "rev-1",
          itemIds: ["rev-1:worktree:0", "rev-1:metadata:0"],
        },
      );

      expect(result).toEqual({ ok: false, code: "conflict", error: expect.any(String) });
      expect(vi.mocked(cleanupOrphans)).not.toHaveBeenCalled();
    });

    it("repeats one refusal for a retried superseded request, never a second receipt", async () => {
      await scanOnce();
      const request = {
        commandId: SECOND_COMMAND_ID,
        scanRevision: "some-older-scan",
        itemIds: ["rev-1:worktree:0"],
      };

      const first = await invoke<Promise<WorktreeOrphanCleanupResult>>(
        "volli:worktree-orphan-cleanup",
        request,
      );
      const again = await invoke<Promise<WorktreeOrphanCleanupResult>>(
        "volli:worktree-orphan-cleanup",
        request,
      );

      expect(again).toEqual(first);
      const receipts = ctx.db
        .prepare("SELECT status FROM worktree_cleanup_receipts WHERE command_id = ?")
        .all(SECOND_COMMAND_ID);
      expect(receipts).toHaveLength(1);
    });
  });
});

// VC-340. The channels themselves: what they hand back, and the one rule that
// is theirs rather than the sweep's — a trim that removed something makes every
// surface reading worktree state stale, and a preview makes nothing stale.
describe("the build-artifact channels", () => {
  const report = {
    worktrees: [
      {
        worktreePath: "/wt/one",
        removed: [{ path: "node_modules/", bytes: 4096 }],
        kept: [{ path: ".env", reason: "it matches .env" }],
        totalBytes: 4096,
        dryRun: false,
      },
    ],
    skipped: [{ path: "/wt/two", reason: "An agent is still running in this worktree." }],
    totalBytes: 4096,
    removedCount: 1,
    dryRun: false,
  };

  it("hands back the scan as the table reads it", async () => {
    const worktrees = [
      {
        path: "/wt/one",
        projectId: "project-1",
        ticketId: "t1",
        branch: "volli/VC-1-x",
        artifactCount: 2,
        activeReason: null,
      },
    ];
    vi.mocked(scanTrimTargets).mockResolvedValue({ worktrees });

    const result = await invoke<Promise<WorktreeTrimScanResult>>("volli:worktree-trim-scan");

    expect(result).toEqual({ ok: true, worktrees });
  });

  it("hands back the sweep report and re-hydrates every window", async () => {
    vi.mocked(trimAllWorktrees).mockResolvedValue(report);
    dataChangedSends.length = 0;

    const result = await invoke<Promise<WorktreeTrimResult>>("volli:worktree-trim");

    expect(result).toEqual({ ok: true, report });
    await expectDataChanged(expect.objectContaining({ kind: "worktree" }));
  });

  it("broadcasts nothing when a real pass removed nothing", async () => {
    vi.mocked(trimAllWorktrees).mockResolvedValue({
      ...report,
      worktrees: [],
      removedCount: 0,
      totalBytes: 0,
    });
    dataChangedSends.length = 0;

    await invoke<Promise<WorktreeTrimResult>>("volli:worktree-trim");

    expectNoDataChange();
  });

  // The read is `worktree.trimSettings` on the bridge (VC-608).
  it("writes the trim settings", async () => {
    const written = await invoke<WorktreeTrimSettingsResult>("volli:worktree-trim-settings-set", {
      trimOnFinish: false,
    });
    expect(written).toEqual({
      ok: true,
      settings: { keepPatterns: [".env"], trimOnFinish: false },
    });
    expect(vi.mocked(setTrimSettings).mock.calls.at(-1)?.[1]).toEqual({ trimOnFinish: false });
  });
});

describe("volli:worktree-orphan-delete", () => {
  let home: string;
  let project: { id: string; path: string };

  /** A leaf inside the container the test's project owns — the only place this channel may delete. */
  function ownedPath(leaf: string): string {
    return join(worktreesHome(), projectContainerName(project.path, project.id), leaf);
  }

  beforeEach(() => {
    // A throwaway worktree home so the sanctioned rm -rf never touches the real
    // ~/.volli/worktrees. Read fresh per call by resolveHome, so setting it here
    // is enough; handlers registered in the outer beforeEach see it too.
    home = mkdtempSync(join(tmpdir(), "volli-orphan-home-"));
    process.env["VOLLI_WORKTREE_HOME_DIR"] = home;
    project = createProjectWithPath();
  });

  afterEach(() => {
    delete process.env["VOLLI_WORKTREE_HOME_DIR"];
    rmSync(home, { recursive: true, force: true });
  });

  it("rejects a path outside the worktree home without deleting", async () => {
    const result = await invoke<Promise<WorktreeOrphanDeleteResult>>(
      "volli:worktree-orphan-delete",
      { path: join(tmpdir(), "somewhere-else") },
    );
    expect(result).toEqual({
      ok: false,
      error: "That path is outside this project's worktree folder.",
    });
  });

  // VC-113: another install of Volli owns a DIFFERENT container under the same
  // shared root. Its worktrees are not this app's to delete, however dirty the
  // Settings list thinks they are.
  it("rejects a path in ANOTHER INSTALL's container under the same worktree home", async () => {
    const theirs = join(
      worktreesHome(),
      projectContainerName(project.path, "f8e04558-dev"),
      "VC-9-theirs",
    );
    mkdirSync(theirs, { recursive: true });

    const result = await invoke<Promise<WorktreeOrphanDeleteResult>>(
      "volli:worktree-orphan-delete",
      { path: theirs },
    );

    expect(result).toEqual({
      ok: false,
      error: "That path is outside this project's worktree folder.",
    });
    expect(existsSync(theirs)).toBe(true);
  });

  it("rejects the container itself, which would take every ticket's checkout at once", async () => {
    const container = join(worktreesHome(), projectContainerName(project.path, project.id));
    mkdirSync(container, { recursive: true });

    const result = await invoke<Promise<WorktreeOrphanDeleteResult>>(
      "volli:worktree-orphan-delete",
      { path: container },
    );

    expect(result).toEqual({
      ok: false,
      error: "That path is outside this project's worktree folder.",
    });
    expect(existsSync(container)).toBe(true);
  });

  it("refuses to delete a worktree the DB still tracks (linked to a ticket)", async () => {
    const target = ownedPath("VC-1-tracked");
    mkdirSync(target, { recursive: true });
    // A ticket still points at this path — listWorktreePaths must veto the delete.
    const ticket = createTicket(project.id);
    invoke<TicketResult>("volli:ticket-update", { ticketId: ticket.id, worktreePath: target });

    const result = await invoke<Promise<WorktreeOrphanDeleteResult>>(
      "volli:worktree-orphan-delete",
      { path: target },
    );

    expect(result).toEqual({
      ok: false,
      error: "This worktree is still linked to a ticket and can't be deleted here.",
    });
    expect(existsSync(target)).toBe(true);
  });

  it("refuses when something is still working at or under the target", async () => {
    const target = ownedPath("VC-2-live");
    mkdirSync(target, { recursive: true });

    handlers.clear();
    registerDataIpcHandlers(
      { ok: true, db: ctx.db },
      {
        sessionEngine: fixtureSessionEngine,
        busyWorktreeSites: async () => [{ directory: join(target, "src"), surface: "terminal" }],
      },
    );

    const result = await invoke<Promise<WorktreeOrphanDeleteResult>>(
      "volli:worktree-orphan-delete",
      { path: target },
    );

    expect(result).toEqual({
      ok: false,
      error: "A terminal is still running in this worktree. Close it first.",
    });
    expect(existsSync(target)).toBe(true);
  });

  it("deletes an untracked, session-free orphan and broadcasts data-changed", async () => {
    const target = ownedPath("VC-3-orphan");
    mkdirSync(target, { recursive: true });

    const result = await invoke<Promise<WorktreeOrphanDeleteResult>>(
      "volli:worktree-orphan-delete",
      { path: target },
    );

    expect(result).toEqual({ ok: true });
    expect(existsSync(target)).toBe(false);
    // An orphan is unlinked from any live ticket, so this broadcast is untargeted.
    await expectDataChanged({ entity: "tickets", kind: "worktree" });
  });

  // Deleting a ticket only nulls `sessions.ticket_id`, so a Session can still be
  // bound to what became an orphan. Without this it kept dispatching into a path
  // the rm had already taken away.
  it("ends the bindings rooted in the orphan before the rm, and asks the busy read about it", async () => {
    const target = ownedPath("VC-4-bound");
    mkdirSync(target, { recursive: true });
    // Both seams see the canonicalized target — the same path the containment
    // guard and the rm run on, `/private` aliasing already resolved.
    const canonical = realpathSync.native(target);
    const order: string[] = [];
    const asked: string[] = [];

    handlers.clear();
    registerDataIpcHandlers(
      { ok: true, db: ctx.db },
      {
        sessionEngine: fixtureSessionEngine,
        busyWorktreeSites: async (probed) => {
          asked.push(probed);
          return [];
        },
        releaseAgentSites: async (directory) => {
          order.push(`release:${directory}`);
          order.push(existsSync(target) ? "dir:present" : "dir:gone");
          return { released: ["chat-1"], stillOpen: [] };
        },
      },
    );

    const result = await invoke<Promise<WorktreeOrphanDeleteResult>>(
      "volli:worktree-orphan-delete",
      { path: target },
    );

    expect(result).toEqual({ ok: true });
    // Asked TWICE, and the second time is the point (VC-284 re-review C4):
    // releasing the bindings takes time, and the answer from before that await
    // is not an answer about the instant of the delete.
    expect(asked).toEqual([canonical, canonical]);
    // Released while the directory still exists, so the executor stops in a cwd
    // that is still there.
    expect(order).toEqual([`release:${canonical}`, "dir:present"]);
    expect(existsSync(target)).toBe(false);
  });

  it("refuses when work appears in the target DURING the binding release", async () => {
    const target = ownedPath("VC-6-late-arrival");
    mkdirSync(target, { recursive: true });
    let released = false;

    handlers.clear();
    registerDataIpcHandlers(
      { ok: true, db: ctx.db },
      {
        sessionEngine: fixtureSessionEngine,
        busyWorktreeSites: async (probed) =>
          released ? [{ directory: probed, surface: "terminal" as const }] : [],
        releaseAgentSites: async () => {
          released = true;
          return { released: [], stillOpen: [] };
        },
      },
    );

    const result = await invoke<Promise<WorktreeOrphanDeleteResult>>(
      "volli:worktree-orphan-delete",
      { path: target },
    );

    expect(result).toEqual({ ok: false, error: expect.stringMatching(/terminal/i) });
    expect(existsSync(target)).toBe(true);
  });

  it("refuses a path another destructive act is already holding", async () => {
    const target = ownedPath("VC-7-contended");
    mkdirSync(target, { recursive: true });
    // A cleanup is mid-removal on this exact directory; the manual delete takes
    // the same lease, so it skips rather than racing it (VC-284 re-review C4).
    const held = acquireDeletionLease(realpathSync.native(target));

    const result = await invoke<Promise<WorktreeOrphanDeleteResult>>(
      "volli:worktree-orphan-delete",
      { path: target },
    );

    expect(result).toEqual({ ok: false, error: "Something else is already changing this folder." });
    expect(existsSync(target)).toBe(true);
    held?.release();
  });

  it("still deletes the orphan when a binding refuses to close", async () => {
    // The always-confirmed path: the Settings row printed the dirtiness reason
    // and the user said yes, and this is the only way to clear a dirty orphan.
    const target = ownedPath("VC-5-stubborn");
    mkdirSync(target, { recursive: true });

    handlers.clear();
    registerDataIpcHandlers(
      { ok: true, db: ctx.db },
      {
        sessionEngine: fixtureSessionEngine,
        releaseAgentSites: async () => ({ released: [], stillOpen: ["chat-1"] }),
      },
    );

    const result = await invoke<Promise<WorktreeOrphanDeleteResult>>(
      "volli:worktree-orphan-delete",
      { path: target },
    );

    expect(result).toEqual({ ok: true });
    expect(existsSync(target)).toBe(false);
  });
});

describe("degraded db handle", () => {
  it("every new channel resolves with the degraded error instead of throwing", async () => {
    handlers.clear();
    registerDataIpcHandlers({ ok: false, error: "db is down" }, { sessionEngine: null });

    expect(invoke<TicketEventsResult>("volli:ticket-events", { ticketId: "x" })).toEqual({
      ok: false,
      error: "db is down",
    });
    expect(invoke<TicketCommentsResult>("volli:comment-list", { ticketId: "x" })).toEqual({
      ok: false,
      error: "db is down",
    });
    expect(invoke<SessionsResult>("volli:session-list", { projectId: "x" })).toEqual({
      ok: false,
      error: "db is down",
    });
    expect(
      invoke<SessionRenameResult>("volli:session-rename", { sessionId: "x", title: "Y" }),
    ).toEqual({
      ok: false,
      error: "db is down",
    });
    expect(
      invoke<WorktreeRemoveResult>("volli:worktree-remove", { ticketId: "x", force: false }),
    ).toEqual({
      ok: false,
      error: "db is down",
    });
    expect(invoke<WorktreeBranchesResult>("volli:worktree-branches", { projectId: "x" })).toEqual({
      ok: false,
      error: "db is down",
    });
    expect(invoke<WorktreeOrphansResult>("volli:worktree-orphans")).toEqual({
      ok: false,
      error: "db is down",
    });
  });

  it("answers EVERY DATA_CHANNELS member with the degraded error — the omitted-channel defect (issue #98)", () => {
    handlers.clear();
    registerDataIpcHandlers({ ok: false, error: "db is down" }, { sessionEngine: null });

    for (const channel of DATA_CHANNELS) {
      expect(invoke(channel)).toEqual({ ok: false, error: "db is down" });
    }
  });
});

describe("registerDataIpcHandlers — registration completeness", () => {
  it("registers a handler for every DATA_CHANNELS member when the db opened successfully", () => {
    // `ctx`'s outer beforeEach already registered a healthy handle — assert
    // the resulting table (not a hand-picked subset) covers the whole contract.
    for (const channel of DATA_CHANNELS) {
      expect(handlers.has(channel)).toBe(true);
    }
  });
});

describe("descriptor guard rejections reach the caller through the envelope, one per argument shape", () => {
  it("zero-arg shape: rejects a stray argument", () => {
    expect(invoke<RetentionTtlResult>("volli:retention-ttl-get", "unexpected")).toEqual({
      ok: false,
      error: "Invalid request",
    });
  });

  it("single string-arg shape: rejects a non-string", () => {
    expect(invoke<ProjectMutationResult>("volli:project-remove", { not: "a string" })).toEqual({
      ok: false,
      error: "Invalid project id",
    });
  });

  it("single object-arg shape: rejects garbage — e.g. ticket-move", () => {
    expect(invoke<TicketsResult>("volli:ticket-move", "nope")).toEqual({
      ok: false,
      error: "Invalid ticket move",
    });
  });

  it("two-positional-string-arg shape: rejects the wrong types", () => {
    expect(invoke<AppStateSetResult>("volli:app-state-set", 1, 2)).toEqual({
      ok: false,
      error: "Invalid app state",
    });
  });

  it("refuses a renderer write to the database's schema floor (VC-602)", () => {
    expect(invoke<AppStateSetResult>("volli:app-state-set", MIN_READER_VERSION_KEY, "999")).toEqual(
      { ok: false, error: "This app state key is owned by the database." },
    );
    expect(
      ctx.db.prepare("SELECT 1 FROM app_state WHERE key = ?").get(MIN_READER_VERSION_KEY),
    ).toBeUndefined();
    expect(invoke<AppStateSetResult>("volli:app-state-set", "volli:ui", "1")).toEqual({
      ok: true,
    });
  });

  it("refuses an unclassified renderer key (VC-574)", () => {
    expect(invoke<AppStateSetResult>("volli:app-state-set", "volli:unclassified", "1")).toEqual({
      ok: false,
      error: "[volli] Unregistered or retired app_state write: volli:unclassified",
    });
    expect(
      ctx.db.prepare("SELECT 1 FROM app_state WHERE key = ?").get("volli:unclassified"),
    ).toBeUndefined();
  });

  it("preserves unregistered renderer and legacy writes byte-for-byte when packaged (VC-574)", () => {
    appMode.isPackaged = true;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(invoke("volli:app-state-set", "volli:unclassified", "raw renderer value")).toEqual({
        ok: true,
      });
      ctx.db.exec("DELETE FROM projects");
      expect(
        invoke("volli:legacy-import", {
          projects: [],
          appState: { "volli:unclassified-legacy": "raw legacy value" },
          rawBackup: {},
        }),
      ).toMatchObject({ ok: true });
      expect(
        ctx.db
          .prepare(
            "SELECT key, value FROM app_state WHERE key LIKE 'volli:unclassified%' ORDER BY key",
          )
          .all(),
      ).toEqual([
        { key: "volli:unclassified", value: "raw renderer value" },
        { key: "volli:unclassified-legacy", value: "raw legacy value" },
      ]);
      expect(warn).toHaveBeenCalledTimes(2);
    } finally {
      warn.mockRestore();
    }
  });

  it("refuses an unclassified legacy key and rolls back the import (VC-574)", () => {
    ctx.db.exec("DELETE FROM projects");
    expect(
      invoke("volli:legacy-import", {
        projects: [],
        appState: { "volli:ui": "registered", "volli:unclassified": "1" },
        rawBackup: { "volli:ui": "source" },
      }),
    ).toEqual({
      ok: false,
      error: "[volli] Unregistered or retired app_state write: volli:unclassified",
    });
    expect(
      ctx.db
        .prepare("SELECT key FROM app_state WHERE key IN (?, ?, ?)")
        .all("volli:ui", "volli:unclassified", "volli:legacy-backup"),
    ).toEqual([]);
  });

  it("drops the schema floor from a legacy import and keeps the rest (VC-602)", () => {
    ctx.db.exec("DELETE FROM projects");
    const result = invoke<{ ok: boolean }>("volli:legacy-import", {
      projects: [],
      appState: { [MIN_READER_VERSION_KEY]: "58", "volli:ui": "1" },
      rawBackup: {},
    });
    expect(result.ok).toBe(true);
    expect(
      ctx.db.prepare("SELECT 1 FROM app_state WHERE key = ?").get(MIN_READER_VERSION_KEY),
    ).toBeUndefined();
    expect(ctx.db.prepare("SELECT value FROM app_state WHERE key = 'volli:ui'").get()).toEqual({
      value: "1",
    });
  });

  it("optional-object-arg shape: rejects a non-object argument", () => {
    expect(invoke<WorktreeOrphansResult>("volli:worktree-orphans", "nope")).toEqual({
      ok: false,
      error: "Invalid request",
    });
  });

  it("object-with-optional-fields shape: a commit message carrying a control character never reaches git", () => {
    expect(
      invoke<WorktreeCommitResult>("volli:worktree-commit", {
        ticketId: "t1",
        message: "subject\u0000--amend",
      }),
    ).toEqual({ ok: false, error: "Invalid commit request" });
    expect(
      invoke<WorktreeCommitResult>("volli:worktree-commit", {
        ticketId: "t1",
        includeUnstaged: "yes",
      }),
    ).toEqual({ ok: false, error: "Invalid commit request" });
  });
});

describe("attachments (VC-50)", () => {
  let blobsDir: string;
  let workspace: string;
  let projectId: string;
  let ticket: Ticket;

  const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);

  beforeEach(() => {
    blobsDir = mkdtempSync(join(tmpdir(), "volli-blobs-"));
    workspace = mkdtempSync(join(tmpdir(), "volli-ws-"));
    // Re-register so the attach handler has somewhere to put bytes; the shared
    // beforeEach registers without a blob root.
    handlers.clear();
    registerDataIpcHandlers(
      { ok: true, db: ctx.db },
      { sessionEngine: fixtureSessionEngine, blobsRoot: blobsDir },
    );
    projectId = createProject();
    ticket = createTicket(projectId);
  });

  afterEach(() => {
    rmSync(blobsDir, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  });

  it("snapshots a pasted image and lists it back", async () => {
    const attached = await invoke<Promise<BlobAttachResult>>("volli:blob-attach", {
      fileName: "pasted.png",
      bytes: PNG,
      owner: { ticketId: ticket.id },
    });
    if (!attached.ok) throw new Error(attached.error);
    expect(attached.relPath).toBeNull();
    expect(attached.blob?.mime).toBe("image/png");

    const listed = invoke<BlobLinksResult>("volli:blob-list", { ticketId: ticket.id });
    if (!listed.ok) throw new Error(listed.error);
    expect(listed.blobs).toHaveLength(1);
    expect(listed.blobs[0]?.originalName).toBe("pasted.png");
  });

  it("names a repo document live instead of copying it", async () => {
    const sourcePath = join(workspace, "spec.pdf");
    writeFileSync(sourcePath, PNG);
    const attached = await invoke<Promise<BlobAttachResult>>("volli:blob-attach", {
      fileName: "spec.pdf",
      sourcePath,
      refRoot: workspace,
      owner: { ticketId: ticket.id },
    });
    if (!attached.ok) throw new Error(attached.error);
    expect(attached.relPath).toBe("spec.pdf");
    expect(attached.blob).toBeNull();
    expect(invoke<BlobLinksResult>("volli:blob-list", { ticketId: ticket.id })).toMatchObject({
      blobs: [],
    });
  });

  it("surfaces an oversized image as a sentence the user can act on", async () => {
    const huge = new Uint8Array(MAX_INLINE_IMAGE_BYTES + 1);
    const attached = await invoke<Promise<BlobAttachResult>>("volli:blob-attach", {
      fileName: "huge.png",
      bytes: huge,
      owner: { ticketId: ticket.id },
    });
    expect(attached).toMatchObject({ ok: false });
    if (attached.ok) throw new Error("expected refusal");
    expect(attached.error).toMatch(/under 5 MB/);
  });

  it("detaches an attachment, and refuses one it does not know", async () => {
    const attached = await invoke<Promise<BlobAttachResult>>("volli:blob-attach", {
      fileName: "a.png",
      bytes: PNG,
      owner: { ticketId: ticket.id },
    });
    if (!attached.ok || !attached.blob?.linkId) throw new Error("expected a link");
    expect(invoke<Result>("volli:blob-remove", { linkId: attached.blob.linkId })).toEqual({
      ok: true,
    });
    expect(invoke<BlobLinksResult>("volli:blob-list", { ticketId: ticket.id })).toMatchObject({
      blobs: [],
    });
    expect(invoke<Result>("volli:blob-remove", { linkId: "nope" })).toEqual({
      ok: false,
      error: "Unknown attachment",
    });
  });

  it("links composer drafts once the ticket they belong to exists", async () => {
    const draft = await invoke<Promise<BlobAttachResult>>("volli:blob-attach", {
      fileName: "mock.png",
      bytes: PNG,
      owner: { unowned: true },
    });
    if (!draft.ok || !draft.blob) throw new Error("expected a blob");
    // Imported, previewable, and owned by nothing yet.
    expect(draft.blob.linkId).toBeNull();

    const linked = invoke<BlobLinksResult>("volli:blob-link-drafts", {
      ticketId: ticket.id,
      blobs: [{ blobHash: draft.blob.blobHash, label: "Mock" }],
    });
    if (!linked.ok) throw new Error(linked.error);
    expect(linked.blobs).toHaveLength(1);
    expect(linked.blobs[0]?.label).toBe("Mock");
  });

  it("links no drafts at all when one of them names an unknown blob", async () => {
    const draft = await invoke<Promise<BlobAttachResult>>("volli:blob-attach", {
      fileName: "mock.png",
      bytes: PNG,
      owner: { unowned: true },
    });
    if (!draft.ok || !draft.blob) throw new Error("expected a blob");
    const linked = invoke<BlobLinksResult>("volli:blob-link-drafts", {
      ticketId: ticket.id,
      blobs: [{ blobHash: draft.blob.blobHash }, { blobHash: "a".repeat(64) }],
    });
    expect(linked.ok).toBe(false);
    // The good one did not survive on its own — a half-attached ticket would be
    // worse than an honest refusal.
    expect(invoke<BlobLinksResult>("volli:blob-list", { ticketId: ticket.id })).toMatchObject({
      blobs: [],
    });
  });

  it("links a promoted Draft's staged blobs to its new session (VC-358)", async () => {
    // The durable Session a promotion minted — its id was fixed before the
    // staged blobs ever had an owner to hang off.
    insertSession(ctx.db, testSession(projectId, null, { id: "promoted-1" }));
    const draft = await invoke<Promise<BlobAttachResult>>("volli:blob-attach", {
      fileName: "staged.png",
      bytes: PNG,
      owner: { unowned: true },
    });
    if (!draft.ok || !draft.blob) throw new Error("expected a blob");
    expect(draft.blob.linkId).toBeNull();

    const linked = invoke<BlobLinksResult>("volli:blob-link-drafts", {
      sessionId: "promoted-1",
      blobs: [{ blobHash: draft.blob.blobHash, label: "Staged" }],
    });
    if (!linked.ok) throw new Error(linked.error);
    expect(linked.blobs).toHaveLength(1);
    expect(linked.blobs[0]).toMatchObject({ label: "Staged", originalName: "staged.png" });

    // The Session's own list reads them back; the Ticket's does not, and the
    // adoption left no ticket event — a session link is recorded by the
    // transcript turn that carries the file, never by the ledger here.
    expect(invoke<BlobLinksResult>("volli:blob-list", { sessionId: "promoted-1" })).toMatchObject({
      blobs: [{ label: "Staged" }],
    });
    expect(invoke<BlobLinksResult>("volli:blob-list", { ticketId: ticket.id })).toMatchObject({
      blobs: [],
    });
    const events = invoke<TicketEventsResult>("volli:ticket-events", { ticketId: ticket.id });
    if (!events.ok) throw new Error(events.error);
    expect(events.events.filter((one) => one.payload.kind === "attachment_added")).toHaveLength(0);
  });

  it("re-links a promoted Draft idempotently — a retry after a lost reply adds nothing", async () => {
    insertSession(ctx.db, testSession(projectId, null, { id: "promoted-1" }));
    const draft = await invoke<Promise<BlobAttachResult>>("volli:blob-attach", {
      fileName: "staged.png",
      bytes: PNG,
      owner: { unowned: true },
    });
    if (!draft.ok || !draft.blob) throw new Error("expected a blob");
    const first = invoke<BlobLinksResult>("volli:blob-link-drafts", {
      sessionId: "promoted-1",
      blobs: [{ blobHash: draft.blob.blobHash }],
    });
    if (!first.ok) throw new Error(first.error);

    // Promotion replays its one command after a lost reply; the same blobs
    // against the same Session are the SAME links, in the same order.
    const retry = invoke<BlobLinksResult>("volli:blob-link-drafts", {
      sessionId: "promoted-1",
      blobs: [{ blobHash: draft.blob.blobHash }],
    });
    if (!retry.ok) throw new Error(retry.error);
    expect(retry.blobs).toEqual(first.blobs);
    expect(invoke<BlobLinksResult>("volli:blob-list", { sessionId: "promoted-1" })).toMatchObject({
      blobs: [{ label: "staged.png" }],
    });
  });

  it("refuses a promoted Draft whose staged images exceed what one chat can carry (VC-358)", async () => {
    insertSession(ctx.db, testSession(projectId, null, { id: "promoted-1" }));
    // Nothing here was refusable at import: a Draft has no Session, so the
    // cumulative check had nothing to measure against. Promotion is where
    // these bytes would become a conversation's, and so where the ceiling
    // finally applies.
    const blobs: { blobHash: string }[] = [];
    for (let i = 0; i < 4; i += 1) {
      const image = new Uint8Array(MAX_INLINE_IMAGE_BYTES);
      image[0] = i;
      const staged = await invoke<Promise<BlobAttachResult>>("volli:blob-attach", {
        fileName: `shot-${i}.png`,
        bytes: image,
        owner: { unowned: true },
      });
      if (!staged.ok || !staged.blob) throw new Error("expected a staged blob");
      blobs.push({ blobHash: staged.blob.blobHash });
    }
    const overflow = new Uint8Array(1024);
    overflow[0] = 99;
    const last = await invoke<Promise<BlobAttachResult>>("volli:blob-attach", {
      fileName: "one-more.png",
      bytes: overflow,
      owner: { unowned: true },
    });
    if (!last.ok || !last.blob) throw new Error("expected a staged blob");
    blobs.push({ blobHash: last.blob.blobHash });

    const linked = invoke<BlobLinksResult>("volli:blob-link-drafts", {
      sessionId: "promoted-1",
      blobs,
    });
    expect(linked).toMatchObject({ ok: false });
    if (linked.ok) throw new Error("expected refusal");
    expect(linked.error).toMatch(/Remove one and send again/);
    // All or nothing, as with an unknown hash: a chat holding four of five
    // images nobody chose to drop would be worse than an honest refusal.
    expect(invoke<BlobLinksResult>("volli:blob-list", { sessionId: "promoted-1" })).toMatchObject({
      blobs: [],
    });
  });

  it("refuses a draft link that names no owner or both owners", () => {
    expect(invoke<BlobLinksResult>("volli:blob-link-drafts", { blobs: [] })).toEqual({
      ok: false,
      error: "Invalid attachment drafts",
    });
    expect(
      invoke<BlobLinksResult>("volli:blob-link-drafts", {
        ticketId: ticket.id,
        sessionId: "promoted-1",
        blobs: [],
      }),
    ).toEqual({ ok: false, error: "Invalid attachment drafts" });
  });

  it("refuses a list that names no owner", async () => {
    expect(invoke<BlobLinksResult>("volli:blob-list", {})).toEqual({
      ok: false,
      error: "Attachments belong to a ticket or a session",
    });
  });
});

/**
 * The renderer door feeds the ticket wake bus (VC-85 slice C).
 *
 * A waiter cares that a ticket moved, not who moved it — a person dragging a
 * card is as legitimate a wake as an agent signalling one. Without this door
 * feeding the bus, an orchestrator parked on a ticket would sleep through
 * every change a human made.
 */
describe("the ticket wake bus (VC-85)", () => {
  const unsubscribes: Array<() => void> = [];

  afterEach(() => {
    for (const off of unsubscribes.splice(0)) off();
  });

  function watch(): TicketWake[] {
    const seen: TicketWake[] = [];
    unsubscribes.push(subscribeTicketWake((wake) => seen.push(wake)));
    return seen;
  }

  it("wakes on a create, a move, and a comment made from the app", () => {
    const projectId = createProject();
    const seen = watch();

    const created = invoke<TicketResult>("volli:ticket-create", {
      projectId,
      title: "Ship it",
      status: "todo",
      priority: "medium",
      labels: [],
    });
    if (!created.ok) throw new Error(created.error);
    invoke<TicketsResult>("volli:ticket-move", {
      projectId,
      ticketId: created.ticket.id,
      toStatus: "doing",
      toIndex: 0,
    });
    invoke<TicketCommentResult>("volli:comment-create", {
      ticketId: created.ticket.id,
      body: "On it",
    });

    expect(seen.map((wake) => wake.event.payload.kind)).toEqual([
      "created",
      "status_changed",
      "commented",
    ]);
    expect(seen.every((wake) => wake.projectId === projectId)).toBe(true);
  });

  it("stays silent for a same-column move, which writes no fact to wake on", () => {
    const projectId = createProject();
    const ticket = createTicket(projectId);
    const seen = watch();

    invoke<TicketsResult>("volli:ticket-move", {
      projectId,
      ticketId: ticket.id,
      toStatus: ticket.status,
      toIndex: 0,
    });

    expect(seen).toEqual([]);
  });

  it("leaves the renderer's own fan-out exactly where it was", () => {
    // The bus is additive (VC-85): `volli:data-changed` is what re-hydrates a
    // window, and nothing here was rewired through the wake path.
    const projectId = createProject();
    const ticket = createTicket(projectId);
    const seen = watch();
    dataChangedSends.length = 0;

    invoke<TicketResult>("volli:ticket-set-priority", { ticketId: ticket.id, priority: "high" });

    expect(seen.map((wake) => wake.event.payload.kind)).toEqual(["priority_changed"]);
    expectNoDataChange();
  });
});

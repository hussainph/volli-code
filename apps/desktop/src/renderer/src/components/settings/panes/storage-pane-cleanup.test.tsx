// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type {
  OrphanCleanupRun,
  WorktreeOrphanCleanupInput,
  WorktreeOrphanCleanupResult,
  WorktreeOrphansInput,
  WorktreeOrphansResult,
} from "../../../../../ipc/contract";
import { TooltipProvider } from "@renderer/components/ui/tooltip";
import { StoragePane } from "./storage-pane";

vi.mock("@renderer/lib/toast", () => ({ toastError: vi.fn() }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), warning: vi.fn() } }));

import { toastError } from "@renderer/lib/toast";
import { toast } from "sonner";

let container: HTMLDivElement | null = null;
let root: Root | null = null;

const scanned: WorktreeOrphansResult = {
  ok: true,
  revision: "rev-42",
  scannedAt: Date.UTC(2026, 7, 19),
  retentionDays: 14,
  prunable: [
    {
      id: "rev-42:metadata:0",
      projectId: "p1",
      projectName: "Volli Code",
      projectPath: "/repo",
      path: "/wt/forgotten",
      reason: "gitdir file points to non-existent location",
    },
  ],
  removable: [
    {
      id: "rev-42:worktree:0",
      path: "/wt/stale-one",
      projectId: "p1",
      projectName: "Volli Code",
      branch: "volli/VC-1-x",
      lastTouchedAt: Date.UTC(2026, 6, 1),
      ageBasis: "directory",
      removableAt: Date.UTC(2026, 6, 15),
    },
    {
      id: "rev-42:worktree:1",
      path: "/wt/stale-two",
      projectId: "p1",
      projectName: "Volli Code",
      branch: null,
      lastTouchedAt: Date.UTC(2026, 6, 2),
      ageBasis: "commit",
      removableAt: Date.UTC(2026, 6, 16),
    },
  ],
  keptRecent: [
    {
      path: "/wt/fresh",
      projectId: "p1",
      projectName: "Volli Code",
      branch: "volli/VC-2-y",
      lastTouchedAt: Date.UTC(2026, 7, 18),
      ageBasis: "directory",
      removableAt: Date.UTC(2026, 8, 1),
      reason: "recently-used",
      detail: null,
    },
  ],
  keptMetadata: [
    {
      projectId: "p1",
      projectName: "Volli Code",
      projectPath: "/repo",
      path: "/elsewhere/theirs",
      gitReason: "gitdir file points to non-existent location",
      reason: "not-owned",
    },
  ],
  unreadableProjects: [
    {
      projectId: "p2",
      projectName: "Second Project",
      projectPath: "/repo-two",
      error: "index.lock exists",
    },
  ],
  dirty: [
    {
      path: "/wt/dirty",
      projectId: "p1",
      projectName: "Volli Code",
      reason: "uncommitted or untracked changes",
    },
  ],
  runs: [],
};

const cleanupResult: WorktreeOrphanCleanupResult = {
  ok: true,
  receipt: {
    id: "receipt-1",
    commandId: "cmd-1",
    status: "completed",
    code: null,
    detail: null,
    recordedAt: 2,
  },
  run: {
    id: "cmd-1",
    source: "settings",
    scanRevision: "rev-42",
    startedAt: 1,
    finishedAt: 2,
    interruptedAt: null,
    preservation: ["branches"],
    retentionDays: 14,
    items: [
      {
        id: "rev-42:worktree:0",
        kind: "worktree",
        path: "/wt/stale-one",
        projectId: "p1",
        projectName: "Volli Code",
        branch: "volli/VC-1-x",
        state: "completed",
        detail: "Removed the folder.",
        startedAt: 1,
        settledAt: 2,
      },
    ],
  },
};

const orphans = vi.fn(
  async (_opts?: WorktreeOrphansInput): Promise<WorktreeOrphansResult> => scanned,
);
const cleanupOrphans = vi.fn(
  async (_input: WorktreeOrphanCleanupInput): Promise<WorktreeOrphanCleanupResult> => cleanupResult,
);

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  orphans.mockClear();
  cleanupOrphans.mockClear();
  vi.mocked(toastError).mockClear();
  vi.mocked(toast.success).mockClear();
  vi.mocked(toast.warning).mockClear();
  // Only what this pane reaches for; the rest of `window.api` is out of scope.
  Object.defineProperty(window, "api", {
    configurable: true,
    value: {
      worktree: { orphans, cleanupOrphans, deleteOrphan: vi.fn() },
      retention: { getTtlDays: async () => ({ ok: true, days: 14 }) },
      database: async () => ({ ok: true, sizeBytes: 1 }),
      fs: { revealInFinder: vi.fn() },
    },
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.unstubAllGlobals();
});

async function mountPane(): Promise<void> {
  await act(async () => {
    // The provider the app shell supplies: the row actions are tooltip buttons.
    root?.render(
      <TooltipProvider>
        <StoragePane />
      </TooltipProvider>,
    );
  });
}

function findByText(text: string, scope: ParentNode = document.body): HTMLElement {
  const match = [...scope.querySelectorAll("button")].find((node) =>
    node.textContent?.includes(text),
  );
  if (!match) throw new Error(`no button containing ${text}`);
  return match;
}

/** The confirmation's own action — not the row button that opened it. */
function confirmButton(): HTMLElement {
  const dialog = document.querySelector('[role="alertdialog"]');
  if (!dialog) throw new Error("no confirmation open");
  return findByText("Clean up", dialog);
}

/** One interrupted run, as the durable projection delivers it. */
function interruptedRun(overrides: Partial<OrphanCleanupRun> = {}): OrphanCleanupRun {
  const removedAt = Date.UTC(2026, 7, 18, 9, 30);
  return {
    id: "run-9",
    source: "settings",
    scanRevision: "rev-1",
    startedAt: removedAt,
    finishedAt: null,
    interruptedAt: Date.UTC(2026, 7, 18, 9, 45),
    preservation: ["branches", "active"],
    retentionDays: 14,
    items: [
      {
        id: "i1",
        kind: "worktree",
        path: "/wt/already-gone",
        projectId: "p1",
        projectName: "Volli Code",
        branch: "volli/VC-3-z",
        state: "completed",
        detail: "Removed the folder.",
        startedAt: removedAt,
        settledAt: removedAt,
      },
      {
        id: "i2",
        kind: "worktree",
        path: "/wt/never-reached",
        projectId: "p1",
        projectName: "Volli Code",
        branch: null,
        state: "pending",
        detail: null,
        startedAt: null,
        settledAt: null,
      },
    ],
    ...overrides,
  };
}

describe("Storage → Orphaned worktrees", () => {
  it("asks for a read-only scan on mount, never a cleanup", async () => {
    await mountPane();

    expect(orphans).toHaveBeenCalledWith({});
    expect(cleanupOrphans).not.toHaveBeenCalled();
  });

  it("lists candidates as proposals, keeps as keeps, and stale records as records", async () => {
    await mountPane();
    const text = container?.textContent ?? "";

    expect(text).toContain("eligible for cleanup since");
    expect(text).toContain("Branch volli/VC-1-x would stay in git");
    expect(text).toContain("used recently");
    expect(text).toContain("uncommitted or untracked changes");
    expect(text).toContain("stale git record");
    // Every row names its project, and every deadline names its basis (C6).
    expect(text).toContain("Volli Code");
    expect(text).toContain("the folder's last modification");
    expect(text).toContain("its branch's last commit");
    // A stale record cleanup will NOT prune, and a project it could not read.
    expect(text).toContain("not owned by this database");
    expect(text).toContain("worktrees couldn't be listed: index.lock exists");
    // The retention window and the archive policy are both stated.
    expect(text).toContain("Unused folders become eligible after 14 day(s)");
    expect(text).toContain("An orphan has no ticket to archive");
    // Nothing has happened, so nothing may read as having happened.
    expect(text).not.toContain("Removed");
  });

  // The acceptance: the confirmation names every affected path and metadata
  // change, and states what is preserved.
  it("names every path and record in the confirmation, with what survives", async () => {
    await mountPane();
    await act(async () => findByText("Clean up…").click());

    const dialog = document.body.textContent ?? "";
    expect(dialog).toContain("/wt/stale-one");
    expect(dialog).toContain("keeps branch volli/VC-1-x");
    expect(dialog).toContain("/wt/stale-two");
    expect(dialog).toContain("/wt/forgotten");
    expect(dialog).toContain("Branches, their commits, and pull-request links stay in git");
    expect(dialog).toContain("live terminal or agent");
    expect(dialog).toContain("checked again immediately before it is removed");
    // S3: the whole shared policy, including the three the old hand-written
    // list had quietly dropped.
    expect(dialog).toContain("not pushed anywhere");
    expect(dialog).toContain("rebase");
    expect(dialog).toContain("submodules have drifted");
    // Still nothing done: opening a confirmation is not confirming it.
    expect(cleanupOrphans).not.toHaveBeenCalled();
  });

  it("sends the scan revision and the confirmed item ids — never a path — then re-scans", async () => {
    await mountPane();
    await act(async () => findByText("Clean up…").click());
    await act(async () => confirmButton().click());

    expect(cleanupOrphans).toHaveBeenCalledWith({
      commandId: expect.any(String),
      scanRevision: "rev-42",
      itemIds: ["rev-42:worktree:0", "rev-42:worktree:1", "rev-42:metadata:0"],
    });
    const sent = cleanupOrphans.mock.calls[0]?.[0] as unknown as Record<string, unknown>;

    expect(sent["paths"]).toBeUndefined();
    expect(sent["projectIds"]).toBeUndefined();
    // The report on screen describes a world the cleanup just changed.
    expect(orphans).toHaveBeenLastCalledWith({ refresh: true });
    expect(toast.success).toHaveBeenCalledWith(expect.stringContaining("Cleanup finished"));
  });

  it("mints a fresh command id per confirmation, so one press is one run", async () => {
    await mountPane();
    await act(async () => findByText("Clean up…").click());
    await act(async () => confirmButton().click());
    await act(async () => findByText("Clean up…").click());
    await act(async () => confirmButton().click());

    const [first, second] = cleanupOrphans.mock.calls.map((call) => call[0].commandId);
    expect(first).not.toBe(second);
  });

  // C1 on the surface: a plan the host no longer holds is refused, and the
  // person is told the one thing that fixes it.
  it("tells the person to scan again when the scan it confirmed has been superseded", async () => {
    cleanupOrphans.mockResolvedValueOnce({
      ok: false,
      code: "scan-superseded",
      error: "That scan has been superseded.",
    });

    await mountPane();
    await act(async () => findByText("Clean up…").click());
    await act(async () => confirmButton().click());

    expect(toastError).toHaveBeenCalledWith(expect.stringContaining("Scan again"));
    expect(toast.success).not.toHaveBeenCalled();
  });

  // S2: a run with a failed item in it is not a success, and the reason and
  // the recovery both have to be reachable.
  it("warns rather than celebrates when an item failed, and names the reason", async () => {
    const failedRun: OrphanCleanupRun = {
      ...(cleanupResult.ok ? cleanupResult.run : interruptedRun()),
      finishedAt: 2,
      items: [
        {
          id: "rev-42:worktree:0",
          kind: "worktree",
          path: "/wt/stale-one",
          projectId: "p1",
          projectName: "Volli Code",
          branch: "volli/VC-1-x",
          state: "failed",
          detail: "git refused: worktree is locked",
          startedAt: 1,
          settledAt: 2,
        },
      ],
    };
    cleanupOrphans.mockResolvedValueOnce({
      ok: true,
      receipt: {
        id: "r",
        commandId: "cmd-1",
        status: "completed",
        code: null,
        detail: null,
        recordedAt: 2,
      },
      run: failedRun,
    });
    orphans.mockResolvedValueOnce(scanned).mockResolvedValueOnce({ ...scanned, runs: [failedRun] });

    await mountPane();
    await act(async () => findByText("Clean up…").click());
    await act(async () => confirmButton().click());

    expect(toast.warning).toHaveBeenCalledWith(expect.stringContaining("finished with problems"));
    expect(toast.success).not.toHaveBeenCalled();
    // The failed path, its reason, and a way back are all on the surface.
    const text = container?.textContent ?? "";
    expect(text).toContain("Cleanup finished with problems");
    expect(text).toContain("git refused: worktree is locked");
    expect(findByText("Scan again")).toBeTruthy();
  });

  // The recovery acceptance, on the surface a person actually looks at: a run
  // the app never finished is shown as one, with its completed items labelled
  // by their real source and time — never as "Removed at launch".
  it("shows an interrupted run and the truthful history beside the current scan", async () => {
    orphans.mockResolvedValueOnce({ ...scanned, runs: [interruptedRun()] });

    await mountPane();
    const text = container?.textContent ?? "";

    expect(text).toContain("Interrupted cleanup");
    expect(text).toContain("1 completed, 1 never attempted");
    expect(text).toContain("/wt/already-gone");
    expect(text).toContain("Removed by cleanup at");
    expect(text).not.toContain("Removed at launch");
    expect(text).not.toContain("during startup");
    // And the way back is a button, not only a sentence.
    expect(findByText("Scan again")).toBeTruthy();
  });

  it("says a run whose effect is unknown may or may not have taken, not that it never ran", async () => {
    orphans.mockResolvedValueOnce({
      ...scanned,
      runs: [
        interruptedRun({
          items: [
            {
              id: "i1",
              kind: "worktree",
              path: "/wt/uncertain",
              projectId: "p1",
              projectName: "Volli Code",
              branch: null,
              state: "indeterminate",
              detail: "Volli stopped while removing this folder. Scan again.",
              startedAt: 1,
              settledAt: 2,
            },
          ],
        }),
      ],
    });

    await mountPane();
    const text = container?.textContent ?? "";

    expect(text).toContain("may or may not have taken effect");
  });

  it("labels a startup cleanup as startup, and a person's as a cleanup", async () => {
    const at = Date.UTC(2026, 7, 18, 9, 30);
    orphans.mockResolvedValueOnce({
      ...scanned,
      runs: [
        {
          id: "run-startup",
          source: "startup",
          scanRevision: "rev-0",
          startedAt: at,
          finishedAt: at,
          interruptedAt: null,
          preservation: [],
          retentionDays: 14,
          items: [
            {
              id: "m1",
              kind: "metadata",
              path: "/wt/record",
              projectId: "p1",
              projectName: "Volli Code",
              branch: null,
              state: "completed",
              detail: "Pruned this stale git record.",
              startedAt: at,
              settledAt: at,
            },
          ],
        },
      ],
    });

    await mountPane();
    const text = container?.textContent ?? "";

    // Metadata items are history too — a pruned record is a completed act.
    expect(text).toContain("/wt/record");
    expect(text).toContain("pruned during startup at");
  });
});

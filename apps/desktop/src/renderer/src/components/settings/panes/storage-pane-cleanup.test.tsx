// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type {
  WorktreeOrphanCleanupResult,
  WorktreeOrphansResult,
} from "../../../../../ipc/contract";
import { TooltipProvider } from "@renderer/components/ui/tooltip";
import { StoragePane } from "./storage-pane";

vi.mock("@renderer/lib/toast", () => ({ toastError: vi.fn() }));
vi.mock("sonner", () => ({ toast: { success: vi.fn() } }));

let container: HTMLDivElement | null = null;
let root: Root | null = null;

const scanned: WorktreeOrphansResult = {
  ok: true,
  scannedAt: Date.UTC(2026, 7, 19),
  retentionDays: 14,
  prunable: [
    {
      projectId: "p1",
      projectPath: "/repo",
      entries: [{ path: "/wt/forgotten", reason: "gitdir file points to non-existent location" }],
    },
  ],
  removable: [
    {
      path: "/wt/stale-one",
      projectId: "p1",
      branch: "volli/VC-1-x",
      lastTouchedAt: Date.UTC(2026, 6, 1),
      removableAt: Date.UTC(2026, 6, 15),
    },
    {
      path: "/wt/stale-two",
      projectId: "p1",
      branch: null,
      lastTouchedAt: Date.UTC(2026, 6, 2),
      removableAt: Date.UTC(2026, 6, 16),
    },
  ],
  keptRecent: [
    {
      path: "/wt/fresh",
      projectId: "p1",
      branch: "volli/VC-2-y",
      lastTouchedAt: Date.UTC(2026, 7, 18),
      removableAt: Date.UTC(2026, 8, 1),
      reason: "recently used",
    },
  ],
  dirty: [{ path: "/wt/dirty", projectId: "p1", reason: "uncommitted or untracked changes" }],
  runs: [],
};

const cleanupResult: WorktreeOrphanCleanupResult = {
  ok: true,
  run: {
    id: "run-1",
    source: "settings",
    startedAt: 1,
    finishedAt: 2,
    interruptedAt: null,
    preservation: [],
    items: [
      {
        kind: "worktree",
        path: "/wt/stale-one",
        projectId: "p1",
        branch: "volli/VC-1-x",
        status: "completed",
        detail: "Removed the folder.",
        finishedAt: 2,
      },
    ],
  },
};

const orphans = vi.fn(async (): Promise<WorktreeOrphansResult> => scanned);
const cleanupOrphans = vi.fn(async (): Promise<WorktreeOrphanCleanupResult> => cleanupResult);

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  orphans.mockClear();
  cleanupOrphans.mockClear();
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

describe("Storage → Orphaned worktrees", () => {
  it("asks for a read-only scan on mount, never a cleanup", async () => {
    await mountPane();

    expect(orphans).toHaveBeenCalledWith({});
    expect(cleanupOrphans).not.toHaveBeenCalled();
  });

  it("lists candidates as proposals, keeps as keeps, and stale records as records", async () => {
    await mountPane();
    const text = container?.textContent ?? "";

    expect(text).toContain("Eligible for cleanup since");
    expect(text).toContain("Branch volli/VC-1-x would stay in git");
    expect(text).toContain("used recently");
    expect(text).toContain("uncommitted or untracked changes");
    expect(text).toContain("Stale git record");
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
    expect(dialog).toContain("live terminal or agent is left in place");
    expect(dialog).toContain("checked again immediately before it is removed");
    // Still nothing done: opening a confirmation is not confirming it.
    expect(cleanupOrphans).not.toHaveBeenCalled();
  });

  // The recovery acceptance, on the surface a person actually looks at: a run
  // the app never finished is shown as one, with its completed items labelled
  // by their real source and time — never as "Removed at launch".
  it("shows an interrupted run and the truthful history beside the current scan", async () => {
    const removedAt = Date.UTC(2026, 7, 18, 9, 30);
    orphans.mockResolvedValueOnce({
      ...scanned,
      runs: [
        {
          id: "run-9",
          source: "settings",
          startedAt: removedAt,
          finishedAt: null,
          interruptedAt: Date.UTC(2026, 7, 18, 9, 45),
          preservation: [],
          items: [
            {
              kind: "worktree",
              path: "/wt/already-gone",
              projectId: "p1",
              branch: "volli/VC-3-z",
              status: "completed",
              detail: "Removed the folder.",
              finishedAt: removedAt,
            },
            {
              kind: "worktree",
              path: "/wt/never-reached",
              projectId: "p1",
              branch: null,
              status: "pending",
              detail: null,
              finishedAt: null,
            },
          ],
        },
      ],
    });

    await mountPane();
    const text = container?.textContent ?? "";

    expect(text).toContain("Interrupted cleanup");
    expect(text).toContain("1 completed, 1 not attempted");
    expect(text).toContain("/wt/already-gone");
    expect(text).toContain("Removed by cleanup at");
    expect(text).not.toContain("Removed at launch");
  });

  it("sends exactly the confirmed paths and projects, then re-scans", async () => {
    await mountPane();
    await act(async () => findByText("Clean up…").click());
    await act(async () => confirmButton().click());

    expect(cleanupOrphans).toHaveBeenCalledWith({
      paths: ["/wt/stale-one", "/wt/stale-two"],
      projectIds: ["p1"],
    });
    // The report on screen describes a world the cleanup just changed.
    expect(orphans).toHaveBeenLastCalledWith({ refresh: true });
  });
});

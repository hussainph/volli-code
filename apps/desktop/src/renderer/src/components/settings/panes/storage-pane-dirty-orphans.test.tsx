// @vitest-environment jsdom
/**
 * The dirty-orphan rows of Settings → Storage (VC-292): each leads with the
 * ticket that still claims it, offers that ticket's repair, names every state
 * it cannot act on, keeps the irreversible Delete apart, and holds a failed act
 * on screen with a retry.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type {
  DirtyWorktreeOrphan,
  WorktreeOrphanDeleteResult,
  WorktreeOrphansResult,
} from "../../../../../ipc/contract";
import { TooltipProvider } from "@renderer/components/ui/tooltip";
import { useUiStore } from "@renderer/stores/ui";
import { StoragePane } from "./storage-pane";

vi.mock("@renderer/lib/session-rpc-ipc-link", () => ({
  sessionRpcClient: () => ({
    worktree: {
      trimSettings: {
        query: async () => ({ keepPatterns: [".env"], trimOnFinish: true }),
      },
    },
  }),
}));
vi.mock("@renderer/lib/toast", () => ({ toastError: vi.fn() }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), warning: vi.fn() } }));

// Only the two calls the row's Open ticket makes; the stores themselves are
// covered by their own suites.
const navigation = vi.hoisted(() => ({
  projects: [{ id: "p1" }] as { id: string }[],
  select: vi.fn(),
  openTicketWorkspace: vi.fn(),
}));
vi.mock("@renderer/stores/projects", () => ({
  useProjectsStore: {
    getState: () => ({ projects: navigation.projects, select: navigation.select }),
  },
}));
vi.mock("@renderer/stores/workspace", () => ({
  useWorkspaceStore: {
    getState: () => ({ openTicketWorkspace: navigation.openTicketWorkspace }),
  },
}));

const CLAIMED: DirtyWorktreeOrphan = {
  path: "/Users/someone/.volli/worktrees/volli-code-f3732f45/VC-82-a-very-long-ticket-slug-that-clips",
  projectId: "p1",
  projectName: "Volli Code",
  reason:
    "A ticket still points here, but git no longer tracks it. Use Remove worktree on that ticket, then recreate it.",
  ticket: { id: "t82", displayId: "VC-82", title: "Strand the checkout", archived: false },
};
const ARCHIVED: DirtyWorktreeOrphan = {
  ...CLAIMED,
  path: "/wt/VC-83-archived",
  ticket: { id: "t83", displayId: "VC-83", title: "Old work", archived: true },
};
const UNCLAIMED: DirtyWorktreeOrphan = {
  path: "/wt/leftover",
  projectId: "p1",
  projectName: "Volli Code",
  reason: "Not registered with git, so it isn't safe to remove automatically.",
};
const UNREADABLE: DirtyWorktreeOrphan = {
  path: "/wt/locked",
  reason: "could not read git status",
  pathReadable: false,
};

function scan(dirty: DirtyWorktreeOrphan[]): WorktreeOrphansResult {
  return {
    ok: true,
    revision: "rev-1",
    scannedAt: 1,
    retentionDays: 14,
    prunable: [],
    removable: [],
    keptRecent: [],
    keptMetadata: [],
    unreadableProjects: [],
    dirty,
    runs: [],
  };
}

const orphans = vi.fn(async (): Promise<WorktreeOrphansResult> => scan([CLAIMED]));
const deleteOrphan = vi.fn(async (_path: string): Promise<WorktreeOrphanDeleteResult> => ({
  ok: true,
}));
const revealInFinder = vi.fn(
  async (_path: string): Promise<{ ok: true } | { ok: false; error: string }> => ({ ok: true }),
);
const writeText = vi.fn(async (_text: string): Promise<void> => undefined);

let container: HTMLDivElement | null = null;
let root: Root | null = null;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  orphans.mockReset().mockResolvedValue(scan([CLAIMED]));
  deleteOrphan.mockReset().mockResolvedValue({ ok: true });
  revealInFinder.mockReset().mockResolvedValue({ ok: true });
  writeText.mockReset().mockResolvedValue(undefined);
  navigation.projects = [{ id: "p1" }];
  navigation.select.mockReset();
  navigation.openTicketWorkspace.mockReset();
  useUiStore.getState().setSettingsOpen(true, "storage");
  Object.defineProperty(window, "api", {
    configurable: true,
    value: {
      worktree: {
        orphans,
        cleanupOrphans: vi.fn(),
        deleteOrphan,
        trimScan: async () => ({ ok: true, worktrees: [] }),
        trim: vi.fn(),
        setTrimSettings: vi.fn(),
      },
      retention: {
        getTtlDays: async () => ({ ok: true, days: 14 }),
        setTtlDays: async (days: number) => ({ ok: true, days }),
      },
      database: async () => ({ ok: true, sizeBytes: 1 }),
      fs: { revealInFinder },
    },
  });
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function mountPane(): Promise<void> {
  await act(async () => {
    root?.render(
      <TooltipProvider>
        <StoragePane />
      </TooltipProvider>,
    );
  });
}

/**
 * Each row's whole shell. The test id sits on the row's text target, and its
 * actions are that target's siblings (`ui/list-row.tsx`), so the shell is the
 * target's parent.
 */
function rows(testId = "orphan-row"): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>(`[data-testid="${testId}"]`)].map(
    (target) => target.parentElement as HTMLElement,
  );
}

function button(name: string, scope: ParentNode = document): HTMLButtonElement {
  const match = [...scope.querySelectorAll("button")].find(
    (candidate) =>
      candidate.textContent?.trim() === name || candidate.getAttribute("aria-label") === name,
  );
  if (!match) throw new Error(`no button named ${name}`);
  return match;
}

function hasButton(name: string, scope: ParentNode = document): boolean {
  return [...scope.querySelectorAll("button")].some(
    (candidate) =>
      candidate.textContent?.trim() === name || candidate.getAttribute("aria-label") === name,
  );
}

async function click(target: HTMLElement): Promise<void> {
  await act(async () => target.click());
}

describe("Storage → dirty orphan rows (VC-292)", () => {
  it("leads with the ticket, keeps the whole path on hover, and offers the ticket instead of Delete", async () => {
    await mountPane();
    const [row] = rows();

    expect(row?.textContent).toContain("VC-82");
    expect(row?.textContent).toContain("Strand the checkout");
    // The clipped path is no longer the name — the full one is a hover away.
    expect(row?.querySelector(`[title="${CLAIMED.path}"]`)).not.toBeNull();
    expect(hasButton("Open ticket", row)).toBe(true);
    // Main refuses to delete a folder a ticket claims, so no button promises it.
    expect(hasButton(`Delete ${CLAIMED.path}`, row)).toBe(false);
  });

  it("opens the ticket in its project and leaves Settings", async () => {
    await mountPane();

    await click(button("Open ticket"));

    expect(navigation.select).toHaveBeenCalledWith("p1");
    expect(navigation.openTicketWorkspace).toHaveBeenCalledWith("p1", "t82", { tabId: "doc" });
    expect(useUiStore.getState().settingsOpen).toBe(false);
  });

  it("keeps a failed Open ticket on the row, and its retry opens once the project is there", async () => {
    navigation.projects = [];
    await mountPane();

    await click(button("Open ticket"));

    const [failure] = rows("orphan-failure");
    expect(failure?.textContent).toContain("Couldn't open the ticket");
    expect(failure?.textContent).toContain("Its project isn't open in Volli.");
    expect(navigation.openTicketWorkspace).not.toHaveBeenCalled();

    navigation.projects = [{ id: "p1" }];
    await click(button("Retry", failure));

    expect(navigation.openTicketWorkspace).toHaveBeenCalledWith("p1", "t82", { tabId: "doc" });
    expect(rows("orphan-failure")).toEqual([]);
  });

  it("names an archived ticket, a ticketless folder, and an unreadable one", async () => {
    orphans.mockResolvedValue(scan([ARCHIVED, UNCLAIMED, UNREADABLE]));
    await mountPane();
    const [archived, unclaimed, unreadable] = rows();

    expect(archived?.textContent).toContain("VC-83");
    expect(archived?.textContent).toContain("Archived ticket");
    expect(archived?.textContent).toContain("Restore VC-83 from the Archive to open it.");
    expect(hasButton("Open ticket", archived)).toBe(false);

    expect(unclaimed?.textContent).toContain("leftover");
    expect(unclaimed?.textContent).toContain("No ticket");
    expect(hasButton(`Delete ${UNCLAIMED.path}`, unclaimed)).toBe(true);

    expect(unreadable?.textContent).toContain("Can't read folder");
  });

  it("copies the full path and flashes a check", async () => {
    vi.useFakeTimers();
    await mountPane();

    await click(button(`Copy ${CLAIMED.path}`));

    expect(writeText).toHaveBeenCalledWith(CLAIMED.path);
    expect(rows("orphan-failure")).toEqual([]);
    await act(async () => vi.advanceTimersByTime(900));
  });

  it("keeps a failed copy on the row, and a successful retry clears it", async () => {
    writeText.mockRejectedValueOnce(new Error("clipboard blocked"));
    await mountPane();

    await click(button(`Copy ${CLAIMED.path}`));
    const [failure] = rows("orphan-failure");
    expect(failure?.textContent).toContain("Couldn't copy the path");
    expect(failure?.textContent).toContain("clipboard blocked");

    await click(button("Retry", failure));
    expect(writeText).toHaveBeenCalledTimes(2);
    expect(rows("orphan-failure")).toEqual([]);
  });

  it("keeps a failed reveal on the row until it is retried or dismissed", async () => {
    revealInFinder.mockResolvedValue({ ok: false, error: "no such folder" });
    await mountPane();

    await click(button(`Reveal ${CLAIMED.path} in Finder`));
    expect(rows("orphan-failure")[0]?.textContent).toContain("Couldn't reveal the folder");

    // A retry that fails again stays; a thrown failure reads the same way.
    revealInFinder.mockRejectedValueOnce(new Error("bridge gone"));
    await click(button("Retry", rows("orphan-failure")[0]));
    expect(rows("orphan-failure")[0]?.textContent).toContain("bridge gone");

    await click(button("Dismiss: Couldn't reveal the folder"));
    expect(rows("orphan-failure")).toEqual([]);

    revealInFinder.mockResolvedValue({ ok: true });
    await click(button(`Reveal ${CLAIMED.path} in Finder`));
    expect(rows("orphan-failure")).toEqual([]);
  });

  it("keeps a refused delete on the row, and its retry asks for confirmation again", async () => {
    orphans.mockResolvedValue(scan([UNCLAIMED]));
    deleteOrphan.mockResolvedValueOnce({
      ok: false,
      error: "Something else is already changing this folder.",
    });
    await mountPane();

    await click(button(`Delete ${UNCLAIMED.path}`));
    await click(button("Delete"));

    // The confirmation closed, and the reason is on the row it was about.
    expect(document.querySelector('[role="alertdialog"]')).toBeNull();
    const [failure] = rows("orphan-failure");
    expect(failure?.textContent).toContain("Couldn't delete this worktree");
    expect(failure?.textContent).toContain("Something else is already changing this folder.");

    // Delete is irreversible: Retry reopens the confirmation, it never acts alone.
    await click(button("Retry", failure));
    expect(deleteOrphan).toHaveBeenCalledTimes(1);
    expect(document.querySelector('[role="alertdialog"]')).not.toBeNull();

    // A thrown failure is held the same way.
    deleteOrphan.mockRejectedValueOnce(new Error("bridge gone"));
    await click(button("Delete"));
    expect(rows("orphan-failure")[0]?.textContent).toContain("bridge gone");

    // And a delete that lands clears it and rescans.
    orphans.mockResolvedValue(scan([]));
    await click(button("Retry", rows("orphan-failure")[0]));
    await click(button("Delete"));
    expect(deleteOrphan).toHaveBeenLastCalledWith(UNCLAIMED.path);
    expect(orphans).toHaveBeenLastCalledWith({ refresh: true });
    expect(rows("orphan-failure")).toEqual([]);
  });
});

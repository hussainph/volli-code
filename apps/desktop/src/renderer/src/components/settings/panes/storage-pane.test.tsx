// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { DATA_EXPORT_LIMITS } from "../../../../../data-export-copy";
import type {
  PiSessionOrphanInventory,
  PiSessionOrphanScanResult,
  WorktreeTrimScanEntry,
  WorktreeTrimSweepReport,
} from "../../../../../ipc/contract";
import { TooltipProvider } from "@renderer/components/ui/tooltip";
import { formatFileSize } from "@renderer/components/attachments/attachment-model";
import { DatabaseSection, DataExportConfirmBody, StorageOverviewPane } from "./storage-pane";
import { useRetentionTtlStore } from "@renderer/stores/retention-ttl";

// The build-artifact section reads its setting on mount over the Session RPC
// client (`worktree.trimSettings`, VC-608); the backups section reads the
// backup and restore projections over the same client.
vi.mock("@renderer/lib/session-rpc-ipc-link", () => ({
  sessionRpcClient: () => ({
    worktree: {
      trimSettings: {
        query: async () => ({ keepPatterns: [".env"], trimOnFinish: true }),
      },
    },
    backups: {
      status: {
        query: async () => ({
          revision: "backup-revision-1",
          running: false,
          lastBackup: null,
          notice: null,
        }),
      },
      restoreStatus: {
        query: async () => ({
          revision: "restore-revision-1",
          phase: "idle",
          bundles: [],
          selectedFile: null,
          projects: [],
          checkpoints: 0,
          paused: false,
          problems: [],
          credentialsMessage: null,
          previousProfile: null,
        }),
      },
    },
  }),
}));

const INVENTORY: PiSessionOrphanInventory = {
  revision: "scan-revision-7",
  scannedAt: 1_700_000_000_000,
  candidates: [
    {
      itemId: "pi-orphan:item-1",
      path: "/tmp/pi-sessions/--project--/session-one.jsonl",
      sessionId: "session-one",
      sizeBytes: 1_024,
    },
  ],
  candidateCount: 1,
  candidateBytes: 1_024,
  skipped: [],
  toolOutput: { files: 3, bytes: 3 * 1_024 * 1_024, limitBytes: 1_024 * 1_024 * 1_024 },
};

/** One worktree carrying artifacts and one that is off limits — the two rows the table has. */
const TRIM_SCAN: WorktreeTrimScanEntry[] = [
  {
    path: "/wt/volli-code/VC-1-alpha",
    projectId: "project-1",
    ticketId: "t1",
    branch: "volli/VC-1-alpha",
    artifactCount: 3,
    activeReason: null,
  },
  {
    path: "/wt/volli-code/VC-2-beta",
    projectId: "project-1",
    ticketId: "t2",
    branch: "volli/VC-2-beta",
    artifactCount: 2,
    activeReason: "An agent is still running in this worktree. Stop it first.",
  },
];

const TRIM_REPORT: WorktreeTrimSweepReport = {
  worktrees: [
    {
      worktreePath: "/wt/volli-code/VC-1-alpha",
      removed: [{ path: "node_modules/", bytes: 2_048 }],
      kept: [{ path: ".env", reason: "it matches .env" }],
      totalBytes: 2_048,
      dryRun: false,
    },
  ],
  skipped: [
    {
      path: "/wt/volli-code/VC-2-beta",
      reason: "An agent is still running in this worktree. Stop it first.",
    },
  ],
  totalBytes: 2_048,
  removedCount: 1,
  dryRun: false,
};

let root: Root | null = null;
let container: HTMLElement | null = null;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  useRetentionTtlStore.setState({ ttlDays: null });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function bridge(
  initialScan: PiSessionOrphanScanResult | Error = { ok: true, inventory: INVENTORY },
) {
  const current: { scan: PiSessionOrphanScanResult | Error } = { scan: initialScan };
  const scanOrphans = vi.fn(async (): Promise<PiSessionOrphanScanResult> => {
    if (current.scan instanceof Error) throw current.scan;
    return current.scan;
  });
  const trimScan = vi.fn(async () => ({ ok: true as const, worktrees: TRIM_SCAN }));
  const trim = vi.fn(async () => ({ ok: true as const, report: TRIM_REPORT }));
  const setTrimSettings = vi.fn(async (input: { trimOnFinish?: boolean }) => ({
    ok: true as const,
    settings: { keepPatterns: [".env"], trimOnFinish: input.trimOnFinish ?? true },
  }));
  const reclaimOrphans = vi.fn(async () => ({
    ok: true as const,
    report: {
      removed: INVENTORY.candidates,
      kept: [],
      removedCount: 1,
      removedBytes: INVENTORY.candidateBytes,
    },
  }));
  vi.stubGlobal("api", {
    retention: {
      getTtlDays: vi.fn(async () => ({ ok: true as const, days: 30 })),
      setTtlDays: vi.fn(async (days: number) => ({ ok: true as const, days })),
    },
    piSessions: { scanOrphans, reclaimOrphans },
    database: vi.fn(async () => ({ ok: true as const, sizeBytes: 4_096 })),
    worktree: {
      orphans: vi.fn(async () => ({
        ok: true as const,
        revision: "worktree-scan-revision-1",
        scannedAt: 1_700_000_000_000,
        retentionDays: 30,
        prunable: [],
        removable: [],
        keptRecent: [],
        keptMetadata: [],
        unreadableProjects: [],
        dirty: [],
        runs: [],
      })),
      deleteOrphan: vi.fn(async () => ({ ok: true as const })),
      trimScan,
      trim,
      setTrimSettings,
    },
  });
  return {
    scanOrphans,
    reclaimOrphans,
    trimScan,
    trim,
    setTrimSettings,
    answerScan: (answer: PiSessionOrphanScanResult | Error) => {
      current.scan = answer;
    },
  };
}

async function open(): Promise<void> {
  // The provider the app shell supplies: a list row's action is a tooltip
  // trigger, and this pane's rows only mount one once a scan returns something.
  await act(async () =>
    root?.render(
      <TooltipProvider>
        <StorageOverviewPane />
      </TooltipProvider>,
    ),
  );
}

/** The page, then its Review cleanup sheet, where the cleanup sections live. */
async function openReview(): Promise<HTMLElement> {
  await open();
  await act(async () => buttonNamed("Review cleanup").click());
  const sheet = document.querySelector<HTMLElement>('[role="dialog"]');
  if (!sheet) throw new Error("Review cleanup did not open");
  return sheet;
}

function buttonNamed(name: string): HTMLButtonElement {
  const button = [...document.querySelectorAll("button")].find(
    (candidate) =>
      candidate.textContent?.trim() === name || candidate.getAttribute("aria-label") === name,
  );
  if (button === undefined)
    throw new Error(`No button named ${name}: ${document.body.textContent}`);
  return button;
}

/** The text of the row that reports saved tool output. */
function savedOutputRow(): string {
  return (
    [...document.querySelectorAll("*")].find((node) =>
      node.textContent?.startsWith("Saved tool output"),
    )?.textContent ?? ""
  );
}

async function commitRetention(text: string): Promise<HTMLInputElement> {
  const input = document.querySelector<HTMLInputElement>("#done-ttl-days");
  if (!input) throw new Error("No retention field");
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    setter?.call(input, text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => {
    input.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
  });
  return input;
}

describe("Settings → Storage retention", () => {
  it.each(["2.5", "1e3", "7.9", "0"])("refuses %j without confirming or saving", async (text) => {
    bridge();
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    await open();

    const input = await commitRetention(text);

    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(document.querySelector("[role='alert']")?.textContent).toBe(
      "Enter a whole number of days, at least 1.",
    );
    expect(confirm).not.toHaveBeenCalled();
    expect(window.api.retention.setTtlDays).not.toHaveBeenCalled();
  });

  it.each(["3", "003"])("confirms and saves the parsed number for %j", async (text) => {
    bridge();
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    await open();

    const input = await commitRetention(text);

    expect(confirm).toHaveBeenCalledExactlyOnceWith(
      "Keep Done worktrees for only 3 day(s)? Folders will be removed sooner.",
    );
    expect(window.api.retention.setTtlDays).toHaveBeenCalledExactlyOnceWith(3);
    expect(input.value).toBe("3");
  });

  it("does not save when confirmation is declined", async () => {
    bridge();
    vi.spyOn(window, "confirm").mockReturnValue(false);
    await open();

    const input = await commitRetention("3");

    expect(window.api.retention.setTtlDays).not.toHaveBeenCalled();
    expect(input.value).toBe("30");
  });

  it("saves a whole number at the confirmation threshold without prompting", async () => {
    bridge();
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    await open();

    await commitRetention("7");

    expect(confirm).not.toHaveBeenCalled();
    expect(window.api.retention.setTtlDays).toHaveBeenCalledExactlyOnceWith(7);
  });
});

describe("Settings → Storage Pi session logs", () => {
  it("keeps cleanup disabled until scan, confirms exact paths, and returns the revision", async () => {
    const main = bridge();
    await openReview();

    expect(buttonNamed("Clean up…").disabled).toBe(true);
    await act(async () => buttonNamed("Scan for orphaned Pi logs").click());
    expect(buttonNamed("Clean up…").disabled).toBe(false);

    await act(async () => buttonNamed("Clean up…").click());
    expect(document.body.textContent).toContain("Clean up orphaned Pi session logs?");
    expect(document.body.textContent).toContain(INVENTORY.candidates[0]!.path);

    await act(async () => buttonNamed("Delete orphaned logs").click());
    expect(main.reclaimOrphans).toHaveBeenCalledWith({
      scanRevision: INVENTORY.revision,
      itemIds: [INVENTORY.candidates[0]!.itemId],
    });
  });

  it("shows how much tool output is saved, against its bound, once scanned (VC-469)", async () => {
    bridge();
    await openReview();

    expect(savedOutputRow()).toContain("Not scanned");
    await act(async () => buttonNamed("Scan for orphaned Pi logs").click());
    expect(savedOutputRow()).toContain(
      `${formatFileSize(3 * 1_024 * 1_024)} of ${formatFileSize(1_024 ** 3)}`,
    );
  });

  it("renders scan failure with an in-place retry", async () => {
    const main = bridge({ ok: false, error: "fixture scan failed" });
    await openReview();

    await act(async () => buttonNamed("Scan for orphaned Pi logs").click());
    expect(document.querySelector('[data-status="failed"]')?.textContent).toContain(
      "Couldn't load pi session logs",
    );
    await act(async () => document.querySelector<HTMLElement>("details summary")?.click());
    expect(document.querySelector("details")?.open).toBe(true);
    expect(document.querySelector("details")?.textContent).toContain("fixture scan failed");
    expect(buttonNamed("Try again")).not.toBeNull();

    main.answerScan({ ok: true, inventory: INVENTORY });
    await act(async () => buttonNamed("Try again").click());
    expect(main.scanOrphans).toHaveBeenCalledTimes(2);
    expect(document.body.textContent).toContain("session-one");
  });

  it("labels the orphaned-log row with no guidance prose or information trigger", async () => {
    bridge();
    const sheet = await openReview();

    expect(sheet.textContent).toContain("Orphaned logs");
    expect(sheet.textContent).not.toContain("Only logs not referenced");
    expect(sheet.textContent).not.toContain("Scanning never deletes files");
    expect(sheet.querySelector('[aria-label="About Orphaned logs"]')).toBeNull();
  });
});

// VC-340. The action removes files, so what the surface says before and after it
// runs is the feature: which worktrees are in scope, which are refused and why,
// and what a finished pass actually took.
describe("Settings → Storage build artifacts", () => {
  it("keeps the trim disabled until a scan, then names only the worktrees in scope", async () => {
    const main = bridge();
    await openReview();

    expect(buttonNamed("Trim…").disabled).toBe(true);
    await act(async () => buttonNamed("Scan for build artifacts").click());
    expect(main.trimScan).toHaveBeenCalledTimes(1);

    // Both rows are listed; the busy one says why rather than disappearing.
    expect(document.body.textContent).toContain("VC-1-alpha");
    expect(document.body.textContent).toContain("3 ignored path(s)");
    expect(document.body.textContent).toContain("An agent is still running in this worktree");

    await act(async () => buttonNamed("Trim…").click());
    expect(document.body.textContent).toContain("Trim build artifacts?");
    // The confirm lists the trimmable worktree only — never the refused one.
    const dialog = document.querySelector("[role='alertdialog']")?.textContent ?? "";
    expect(dialog).toContain("/wt/volli-code/VC-1-alpha");
    expect(dialog).not.toContain("/wt/volli-code/VC-2-beta");
    expect(dialog).toContain("1 worktree(s)");
  });

  it("reports what a finished trim took, kept, and refused", async () => {
    const main = bridge();
    await openReview();
    await act(async () => buttonNamed("Scan for build artifacts").click());
    await act(async () => buttonNamed("Trim…").click());

    await act(async () => buttonNamed("Trim").click());

    expect(main.trim).toHaveBeenCalledTimes(1);
    const text = document.body.textContent ?? "";
    expect(text).toContain("Freed");
    expect(text).toContain("2.0 KB");
    expect(text).toContain("kept 1");
    // Named, not just counted: a person reading "kept 1" cannot tell
    // whether their .env is the one.
    expect(text).toContain(".env");
    expect(text).toContain("Kept — it matches .env");
    expect(text).toContain("node_modules/");
    expect(text).toContain("Skipped — An agent is still running in this worktree. Stop it first.");
    // The table it was based on is re-read, since every trimmed row changed.
    expect(main.trimScan).toHaveBeenCalledTimes(2);
  });

  it("persists the automatic-trim opt-out", async () => {
    const main = bridge();
    await openReview();

    const toggle = document.querySelector("#trim-on-finish");
    if (!(toggle instanceof HTMLElement)) throw new Error("no trim-on-finish switch");
    await act(async () => toggle.click());

    expect(main.setTrimSettings).toHaveBeenCalledWith({ trimOnFinish: false });
  });
});
async function mountDatabase() {
  await act(async () =>
    root?.render(
      <TooltipProvider>
        <DatabaseSection />
      </TooltipProvider>,
    ),
  );
}

describe("Settings → Database section", () => {
  it("names the action as a data export rather than a database export", () => {
    const html = renderToStaticMarkup(
      <TooltipProvider>
        <DatabaseSection />
      </TooltipProvider>,
    );

    expect(html).toContain("Export data as JSON");
    expect(html).not.toContain("Database export");
    // The first paint is a read in flight, drawn with its mark, not an ellipsis.
    expect(html).toContain("Loading");
    expect(html).not.toContain("Loading…");
  });

  it("shows the size it read", async () => {
    bridge();
    await mountDatabase();
    expect(container?.textContent).toContain(formatFileSize(4_096));
  });

  it("keeps a failed size read on the section with a retry, not an empty value", async () => {
    bridge();
    const database = vi
      .fn()
      .mockResolvedValueOnce({ ok: false as const, error: "database locked" })
      .mockResolvedValue({ ok: true as const, sizeBytes: 4_096 });
    window.api.database = database as unknown as typeof window.api.database;
    await mountDatabase();

    const announced = container?.querySelector('[role="status"][aria-live="polite"]');
    expect(announced?.textContent).toContain("Couldn't read the database size");
    expect(announced?.textContent).not.toContain("database locked");
    await act(async () => container?.querySelector<HTMLElement>("details summary")?.click());
    expect(container?.querySelector("details")?.open).toBe(true);
    expect(container?.querySelector("details")?.textContent).toContain("database locked");
    expect(container?.textContent).toContain("Unavailable");

    await act(async () => buttonNamed("Try again").click());
    expect(database).toHaveBeenCalledTimes(2);
    expect(container?.textContent).toContain(formatFileSize(4_096));
    expect(container?.textContent).not.toContain("Couldn't read the database size");
  });

  it("states the limits before the export runs, naming attachments and transcripts", () => {
    const html = renderToStaticMarkup(<DataExportConfirmBody />);

    expect(html).toContain(DATA_EXPORT_LIMITS);
    expect(html).toContain("cannot be restored");
    expect(html).toContain("attachments or transcript files");
    // The old copy promised "every project, ticket, comment, session, label,
    // and setting", which is what made it read as a backup.
    expect(html).not.toContain("every project");
    expect(html).not.toContain("readable copy");
    expect(html.toLowerCase()).not.toContain("backup");
  });
});

describe("Storage page", () => {
  // A02: the one button on this pane said "Rescan orphaned worktrees" and sent
  // a request that pruned git metadata and deleted directories. The label a
  // person reads before pressing it is part of the fix, so it is asserted.
  it("offers a scan, never a rescan, before anything has loaded", async () => {
    bridge();
    // The orphan scan the sheet starts never answers, so this is the sheet
    // before anything has loaded.
    window.api.worktree.orphans = vi.fn(
      () => new Promise<never>(() => {}),
    ) as unknown as typeof window.api.worktree.orphans;
    const sheet = await openReview();
    const worktrees = [...sheet.querySelectorAll("section")].find(
      (section) => section.querySelector("h2")?.textContent === "Orphaned worktrees",
    );

    expect(worktrees).toBeDefined();
    expect(sheet.querySelector('[aria-label="Scan for orphaned worktrees"]')).not.toBeNull();
    expect(document.body.textContent).not.toContain("Rescan");
    expect(
      [...document.querySelectorAll("[aria-label]")].some((node) =>
        node.getAttribute("aria-label")?.includes("Rescan"),
      ),
    ).toBe(false);
    // The worktree cleanup action is not reachable until a scan has produced one.
    expect(worktrees?.textContent).not.toContain("Clean up…");
  });

  it("says what retention takes and what it keeps, in one line", () => {
    const html = renderToStaticMarkup(
      <TooltipProvider>
        <StorageOverviewPane />
      </TooltipProvider>,
    );

    expect(html).toContain("Removes the folder; keeps the branch, commits, PR link and ticket.");
  });
});
async function overview() {
  await act(async () =>
    root?.render(
      <TooltipProvider>
        <StorageOverviewPane />
      </TooltipProvider>,
    ),
  );
}

describe("Storage overview", () => {
  it("scans all file families into one summary without deleting anything", async () => {
    const api = bridge();
    await overview();
    expect(api.trimScan).not.toHaveBeenCalled();
    await act(async () => buttonNamed("Scan unused files").click());
    expect(api.trimScan).toHaveBeenCalledOnce();
    expect(api.scanOrphans).toHaveBeenCalledOnce();
    expect(container?.textContent).toContain(
      "0 unused worktrees · 1 log file · build output in 1 checkout",
    );
    expect(api.trim).not.toHaveBeenCalled();
    expect(api.reclaimOrphans).not.toHaveBeenCalled();
    // The database and its export live under Privacy & data.
    expect(container?.textContent).not.toContain("Database");
  });
  it("keeps a failed scan distinct from an empty cleanup proposal", async () => {
    bridge(new Error("Log scan unavailable"));
    await overview();
    await act(async () => buttonNamed("Scan unused files").click());
    expect(container?.textContent).toContain("Couldn't scan unused files");
    expect(container?.textContent).toContain("Log scan unavailable");
    expect(container?.textContent).not.toContain("0 unused worktrees");
  });
  it("keeps local profile backups and restore on the page", async () => {
    bridge();
    await overview();
    expect(container?.textContent).toContain("Backups");
    expect(container?.textContent).toContain("No backup yet");
    expect(buttonNamed("Back up now").disabled).toBe(false);
    expect(buttonNamed("Restore…").disabled).toBe(false);
    expect(buttonNamed("Show in Finder")).toBeTruthy();
  });
  it("opens the existing maintenance controls behind review without starting a sweep", async () => {
    const api = bridge();
    await overview();
    await act(async () => buttonNamed("Review cleanup").click());
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain("Build artifacts");
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain("Orphaned worktrees");
    expect(api.trim).not.toHaveBeenCalled();
    expect(api.reclaimOrphans).not.toHaveBeenCalled();
  });
});

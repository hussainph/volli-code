// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { DATA_EXPORT_LIMITS } from "../../../../../data-export-copy";
import type {
  PiSessionOrphanInventory,
  PiSessionOrphanScanResult,
} from "../../../../../ipc/contract";
import { DataExportConfirmBody, StoragePane } from "./storage-pane";

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
};

let root: Root | null = null;
let container: HTMLElement | null = null;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
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
});

function bridge(
  initialScan: PiSessionOrphanScanResult | Error = { ok: true, inventory: INVENTORY },
) {
  const current: { scan: PiSessionOrphanScanResult | Error } = { scan: initialScan };
  const scanOrphans = vi.fn(async (): Promise<PiSessionOrphanScanResult> => {
    if (current.scan instanceof Error) throw current.scan;
    return current.scan;
  });
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
        scannedAt: 1_700_000_000_000,
        retentionDays: 30,
        prunable: [],
        removable: [],
        keptRecent: [],
        dirty: [],
        runs: [],
      })),
      deleteOrphan: vi.fn(async () => ({ ok: true as const })),
    },
  });
  return {
    scanOrphans,
    reclaimOrphans,
    answerScan: (answer: PiSessionOrphanScanResult | Error) => {
      current.scan = answer;
    },
  };
}

async function open(): Promise<void> {
  await act(async () => root?.render(<StoragePane />));
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

describe("Settings → Storage Pi session logs", () => {
  it("keeps cleanup disabled until scan, confirms exact paths, and returns the revision", async () => {
    const main = bridge();
    await open();

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

  it("renders scan failure with an in-place retry", async () => {
    const main = bridge({ ok: false, error: "fixture scan failed" });
    await open();

    await act(async () => buttonNamed("Scan for orphaned Pi logs").click());
    expect(document.querySelector("[role='alert']")?.textContent).toContain("fixture scan failed");
    expect(buttonNamed("Try again")).not.toBeNull();

    main.answerScan({ ok: true, inventory: INVENTORY });
    await act(async () => buttonNamed("Try again").click());
    expect(main.scanOrphans).toHaveBeenCalledTimes(2);
    expect(document.body.textContent).toContain("session-one");
  });

  it("puts ordinary scan guidance in a hint rather than trust-boundary prose", () => {
    const html = renderToStaticMarkup(<StoragePane />);

    expect(html).toContain('aria-label="About Orphaned logs"');
  });
});

describe("Settings → Storage database section", () => {
  it("names the action as a data export rather than a database export", () => {
    const html = renderToStaticMarkup(<StoragePane />);

    expect(html).toContain("Export data as JSON");
    expect(html).not.toContain("Database export");
  });

  it("states the limits before the export runs, naming attachments and transcripts", () => {
    const html = renderToStaticMarkup(<DataExportConfirmBody />);

    expect(html).toContain(DATA_EXPORT_LIMITS);
    expect(html).toContain("cannot be restored");
    expect(html).toContain("attachments or transcript files");
    // The old copy promised "every project, ticket, comment, session, label,
    // and setting", which is what made it read as a backup.
    expect(html).not.toContain("every project");
    expect(html.toLowerCase()).not.toContain("backup");
  });
});

describe("StoragePane", () => {
  // A02: the one button on this pane said "Rescan orphaned worktrees" and sent
  // a request that pruned git metadata and deleted directories. The label a
  // person reads before pressing it is part of the fix, so it is asserted.
  it("offers a scan, never a rescan, before anything has loaded", () => {
    const html = renderToStaticMarkup(<StoragePane />);

    expect(html).toContain("Scan for orphaned worktrees");
    expect(html).not.toContain("Rescan");
    // The destructive action is not reachable until a scan has produced one.
    expect(html).not.toContain("Clean up…");
  });

  it("says what retention takes and what it keeps, including the Keep exemption", () => {
    const html = renderToStaticMarkup(<StoragePane />);

    expect(html).toContain("keeps the branch, its commits, the pull-request link, and the ticket");
    expect(html).toContain("Keep on a ticket holds its folder");
  });
});

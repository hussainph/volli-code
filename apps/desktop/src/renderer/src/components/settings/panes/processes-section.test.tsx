// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { OrphanProcessCandidate } from "@volli/shared";

import type { OrphanProcessInventory, OrphanProcessScanResult } from "../../../../../ipc/contract";
import { TooltipProvider } from "@renderer/components/ui/tooltip";
import { RunningProcessesSection } from "./processes-section";

const HOUR = 3_600_000;

const LEAKED: OrphanProcessCandidate = {
  itemId: "ledger:4242:1",
  source: "ledger",
  stance: "reapable",
  pid: 4242,
  pgid: 4242,
  startedAt: 1,
  ageMs: 18 * 24 * HOUR,
  rssBytes: 2_900_000_000,
  command: "next dev",
  cwd: "/w/VC-341",
  tty: null,
  sessionId: "session-that-ended",
  ticketId: "ticket-341",
  ticketDisplayId: "VC-341",
  worktreePath: "/w/VC-341",
  reason: "Volli started this for a Session that has ended (shell).",
};

const THEIRS: OrphanProcessCandidate = {
  ...LEAKED,
  itemId: "cwd:900:2",
  source: "cwd",
  stance: "not-volli",
  pid: 900,
  pgid: 900,
  tty: "s004",
  command: "-zsh",
  sessionId: null,
  reason: "Not Volli's — a terminal of your own is standing in this worktree.",
};

const INVENTORY: OrphanProcessInventory = {
  revision: "rev-7",
  scannedAt: 1_700_000_000_000,
  candidates: [LEAKED, THEIRS],
  reapableCount: 1,
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
  scanResult: OrphanProcessScanResult = {
    ok: true,
    inventory: INVENTORY,
    policy: { enabled: false, minimumAgeHours: 24 },
  },
) {
  const scan = vi.fn(async () => scanResult);
  const reap = vi.fn(async () => ({
    ok: true as const,
    report: { reaped: [LEAKED], kept: [], reapedCount: 1 },
  }));
  const setPolicy = vi.fn(async (policy: { enabled: boolean; minimumAgeHours: number }) => ({
    ok: true as const,
    policy,
  }));
  vi.stubGlobal("api", { orphanProcesses: { scan, reap, setPolicy } });
  return { scan, reap, setPolicy };
}

async function open(): Promise<void> {
  // The app mounts one provider at its root; a row's Reap tooltip needs it.
  await act(async () =>
    root?.render(
      <TooltipProvider>
        <RunningProcessesSection />
      </TooltipProvider>,
    ),
  );
}

function buttonNamed(name: string): HTMLButtonElement {
  const button = [...document.querySelectorAll("button")].find(
    (candidate) =>
      candidate.textContent?.trim() === name || candidate.getAttribute("aria-label") === name,
  );
  if (button === undefined) {
    throw new Error(`No button named ${name}: ${document.body.textContent}`);
  }
  return button;
}

describe("Settings → Storage → Running processes", () => {
  it("scans only when asked, then lists each process with its ticket, age and memory", async () => {
    const main = bridge();
    await open();

    // A pane a person opened to change a theme must not spawn `ps` and `lsof`.
    expect(main.scan).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("Not scanned");
    expect(buttonNamed("Reap all").disabled).toBe(true);

    await act(async () => buttonNamed("Look for processes no Session owns").click());

    expect(document.body.textContent).toContain("VC-341 · next dev");
    expect(document.body.textContent).toContain("pid 4242");
    expect(document.body.textContent).toContain("18d 0h");
    expect(document.body.textContent).toContain("1 to reap, 1 not Volli's");
  });

  it("offers a Reap on Volli's own process and none on the person's own shell", async () => {
    const main = bridge();
    await open();
    await act(async () => buttonNamed("Look for processes no Session owns").click());

    expect(() => buttonNamed("Reap pid 900")).toThrow();
    await act(async () => buttonNamed("Reap pid 4242").click());

    expect(main.reap).toHaveBeenCalledWith({
      scanRevision: "rev-7",
      itemIds: ["ledger:4242:1"],
    });
    // And the list is re-scanned, because a reap consumed the revision it named.
    expect(main.scan).toHaveBeenCalledTimes(2);
  });

  it("reaps every reapable row at once, and never the ones it may not touch", async () => {
    const main = bridge();
    await open();
    await act(async () => buttonNamed("Look for processes no Session owns").click());

    await act(async () => buttonNamed("Reap all").click());

    expect(main.reap).toHaveBeenCalledWith({ scanRevision: "rev-7", itemIds: ["ledger:4242:1"] });
  });

  it("reports a failed scan in place, with a retry", async () => {
    bridge({ ok: false, error: "lsof refused" });
    await open();

    await act(async () => buttonNamed("Look for processes no Session owns").click());

    expect(document.querySelector("[role='alert']")?.textContent).toContain("lsof refused");
    expect(buttonNamed("Try again")).not.toBeNull();
  });

  it("saves the automatic-reaping switch through main", async () => {
    const main = bridge();
    await open();
    await act(async () => buttonNamed("Look for processes no Session owns").click());

    const toggle = document.querySelector<HTMLButtonElement>("#auto-reap");
    expect(toggle?.getAttribute("aria-checked")).toBe("false");
    await act(async () => toggle?.click());

    expect(main.setPolicy).toHaveBeenCalledWith({ enabled: true, minimumAgeHours: 24 });
  });
});

import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type {
  AutoReapPolicy,
  MemoryPressureReading,
  ProcessFact,
  SpawnLedgerEntry,
  WorktreeRef,
} from "@volli/shared";

import { OrphanProcessService, type OrphanProcessDeps } from "./orphan-processes";

const NOW = 1_800_000_000_000;
const HOUR = 3_600_000;

const worktree: WorktreeRef = {
  path: "/home/.volli/worktrees/volli-code-f373/VC-341-orphan-sweep",
  ticketId: "ticket-341",
  ticketDisplayId: "VC-341",
  projectId: "project-1",
};

function fact(overrides: Partial<ProcessFact> = {}): ProcessFact {
  return {
    pid: 4242,
    ppid: 1,
    pgid: 4242,
    startedAt: NOW - 30 * HOUR,
    rssBytes: 2_900_000_000,
    tty: null,
    command: "next dev",
    cwd: worktree.path,
    ...overrides,
  };
}

function row(overrides: Partial<SpawnLedgerEntry> = {}): SpawnLedgerEntry {
  return {
    id: "row-1",
    sessionId: "session-ended",
    ticketId: "ticket-341",
    projectId: "project-1",
    kind: "shell",
    pid: 4242,
    pgid: 4242,
    startedAt: NOW - 30 * HOUR,
    cwd: worktree.path,
    command: "pnpm dev",
    ...overrides,
  };
}

interface Harness {
  service: OrphanProcessService;
  signals: Array<[number, string | 0]>;
  exited: string[];
  notices: Array<[string, string]>;
  /** Mutable, so a test can change what the machine looks like BETWEEN the scan
   * and the reap — which is the whole hazard the identity re-check exists for. */
  inventory: { facts: ProcessFact[] };
}

interface HarnessOptions extends Partial<OrphanProcessDeps> {
  /** The ledger rows this launch believes are still open. */
  rows?: SpawnLedgerEntry[];
}

/** What the kernel throws when there is no such process — the code, not the words. */
function noSuchProcess(): Error {
  return Object.assign(new Error("kill ESRCH"), { code: "ESRCH" });
}

/** What it throws when the process exists and this app may not touch it. */
function notPermitted(): Error {
  return Object.assign(new Error("kill EPERM"), { code: "EPERM" });
}

function harness(options: HarnessOptions = {}, facts: ProcessFact[] = []): Harness {
  const { rows = [], ...overrides } = options;
  const signals: Array<[number, string | 0]> = [];
  const exited: string[] = [];
  const notices: Array<[string, string]> = [];
  const inventory = { facts };
  let ids = 0;
  const service = new OrphanProcessService({
    ledger: {
      listOpen: () => rows.filter((entry) => !exited.includes(entry.id)),
      markExited: (id) => exited.push(id),
      prune: () => 0,
    },
    worktrees: () => [worktree],
    liveSessionIds: () => [],
    liveWorktrees: () => [],
    openTerminalCwds: () => [],
    inventory: async () => inventory.facts,
    memoryPressure: async () => ({ underPressure: true, detail: "free 8%" }),
    now: () => NOW,
    nextId: () => `rev-${++ids}`,
    signal: (target, sig) => {
      signals.push([target, sig]);
      // Anything the test does not script is gone after the TERM.
      if (sig === 0) throw noSuchProcess();
    },
    killGraceMs: 0,
    ...overrides,
  });
  return { service, signals, exited, notices, inventory };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("OrphanProcessService.scan", () => {
  it("lists a ledger-owned process whose Session has ended, with its Ticket and age", async () => {
    const { service } = harness({ rows: [row()] }, [fact()]);

    const inventory = await service.scan();

    expect(inventory.revision).toBe("rev-1");
    expect(inventory.reapableCount).toBe(1);
    expect(inventory.candidates).toHaveLength(1);
    expect(inventory.candidates[0]).toMatchObject({
      source: "ledger",
      stance: "reapable",
      ticketDisplayId: "VC-341",
      ageMs: 30 * HOUR,
      rssBytes: 2_900_000_000,
    });
  });

  it("never lists a process in a worktree a live Session is attached to", async () => {
    const { service } = harness(
      { liveWorktrees: () => [{ path: worktree.path, sessionId: "session-now" }] },
      [fact()],
    );
    expect((await service.scan()).candidates).toEqual([]);
  });

  it("closes the ledger rows whose processes are no longer running", async () => {
    const { service, exited } = harness({ rows: [row(), row({ id: "row-2", pid: 7 })] }, [fact()]);
    await service.scan();
    expect(exited).toEqual(["row-2"]);
  });

  it("reuses a fresh scan for the doctor count and rescans a stale one", async () => {
    const { service } = harness({}, [fact()]);
    const first = await service.freshInventory();
    expect((await service.freshInventory()).revision).toBe(first.revision);
    expect((await service.freshInventory(-1)).revision).not.toBe(first.revision);
  });
});

describe("OrphanProcessService.reap", () => {
  it("signals the group with TERM then KILL, and closes the ledger row", async () => {
    // Alive through the first probe, gone by the one after the KILL.
    let probes = 0;
    const { service, signals, exited } = harness(
      {
        rows: [row()],
        signal: (target, sig) => {
          signals.push([target, sig]);
          if (sig === 0 && ++probes > 1) throw noSuchProcess();
        },
      },
      [fact()],
    );
    const inventory = await service.scan();

    const report = await service.reap({
      scanRevision: inventory.revision,
      itemIds: [inventory.candidates[0]!.itemId],
    });

    expect(report.reapedCount).toBe(1);
    expect(report.kept).toEqual([]);
    // The group, because this candidate leads it: `-pid` is what reaches the
    // children a dev server forked.
    expect(signals).toEqual([
      [-4242, "SIGTERM"],
      [4242, 0],
      [-4242, "SIGKILL"],
      [4242, 0],
    ]);
    expect(exited).toEqual(["row-1"]);
  });

  it("sends no KILL when the TERM was enough", async () => {
    const { service, signals } = harness({}, [fact()]);
    const inventory = await service.scan();
    await service.reap({
      scanRevision: inventory.revision,
      itemIds: [inventory.candidates[0]!.itemId],
    });
    expect(signals).toEqual([
      [-4242, "SIGTERM"],
      [4242, 0],
    ]);
  });

  it("signals a process alone when its group is somebody else's", async () => {
    const { service, signals } = harness({}, [fact({ pgid: 900 })]);
    const inventory = await service.scan();
    await service.reap({
      scanRevision: inventory.revision,
      itemIds: [inventory.candidates[0]!.itemId],
    });
    expect(signals[0]).toEqual([4242, "SIGTERM"]);
  });

  it("does not signal a pid that has been recycled onto a different process", async () => {
    // The acceptance case: the scan saw one process, and by the time the person
    // clicked, that number belonged to something else entirely.
    const { service, signals, inventory } = harness({ rows: [row()] }, [fact()]);
    const scanned = await service.scan();
    const candidate = scanned.candidates[0]!;

    inventory.facts = [fact({ startedAt: NOW - 60_000, command: "someone-elses-build" })];

    const report = await service.reap({
      scanRevision: scanned.revision,
      itemIds: [candidate.itemId],
    });

    expect(signals).toEqual([]);
    expect(report.reapedCount).toBe(0);
    expect(report.kept[0]?.reason).toContain("different process");
  });

  it("keeps a candidate that had already exited, and one that is not Volli's to kill", async () => {
    const { service, signals, inventory } = harness({}, [
      fact(),
      fact({ pid: 900, tty: "s004", pgid: 900, command: "-zsh" }),
    ]);
    const scanned = await service.scan();
    const itemIds = scanned.candidates.map((candidate) => candidate.itemId);
    inventory.facts = [];

    const report = await service.reap({ scanRevision: scanned.revision, itemIds });

    expect(signals).toEqual([]);
    expect(report.kept.map((kept) => kept.reason)).toEqual([
      "It had already exited.",
      "Not Volli's to kill — it has a terminal of its own.",
    ]);
  });

  it("reaps a held process on an explicit per-row word", async () => {
    // `held` is Volli's own process in a checkout somebody has taken over. It
    // is off "Reap all" and off the background policy, but a person who looked
    // at the row and pressed Reap gets what they asked for.
    const { service, signals } = harness(
      {
        rows: [row()],
        liveWorktrees: () => [{ path: worktree.path, sessionId: "session-now" }],
      },
      [fact()],
    );
    const inventory = await service.scan();
    expect(inventory.candidates[0]).toMatchObject({ stance: "held" });
    expect(inventory.reapableCount).toBe(0);

    const report = await service.reap({
      scanRevision: inventory.revision,
      itemIds: [inventory.candidates[0]!.itemId],
    });

    expect(report.reapedCount).toBe(1);
    expect(signals[0]).toEqual([-4242, "SIGTERM"]);
  });

  it("keeps a process it was not allowed to signal, and leaves its ledger row open", async () => {
    const { service, exited } = harness(
      {
        rows: [row()],
        signal: () => {
          throw notPermitted();
        },
      },
      [fact()],
    );
    const inventory = await service.scan();

    const report = await service.reap({
      scanRevision: inventory.revision,
      itemIds: [inventory.candidates[0]!.itemId],
    });

    expect(report.reapedCount).toBe(0);
    expect(report.kept[0]?.reason).toContain("would not let Volli signal it");
    // The row stays open because the process it names is still running.
    expect(exited).toEqual([]);
  });

  it("keeps a process that outlived its own SIGKILL", async () => {
    const sent: Array<string | 0> = [];
    const { service } = harness({ rows: [row()], signal: (_target, sig) => sent.push(sig) }, [
      fact(),
    ]);
    const inventory = await service.scan();

    const report = await service.reap({
      scanRevision: inventory.revision,
      itemIds: [inventory.candidates[0]!.itemId],
    });

    expect(report.reapedCount).toBe(0);
    expect(report.kept[0]?.reason).toBe("It was still running after SIGTERM and SIGKILL.");
    expect(sent).toEqual(["SIGTERM", 0, "SIGKILL", 0, 0]);
  });

  it("keeps a process it could not SIGKILL, having managed the SIGTERM", async () => {
    let sent = 0;
    const { service } = harness(
      {
        rows: [row()],
        signal: (_target, sig) => {
          // TERM lands, the process is still there, and the KILL is refused.
          if (sig === "SIGKILL") throw notPermitted();
          sent += 1;
        },
      },
      [fact()],
    );
    const inventory = await service.scan();

    const report = await service.reap({
      scanRevision: inventory.revision,
      itemIds: [inventory.candidates[0]!.itemId],
    });

    expect(report.reapedCount).toBe(0);
    // The probe still answers, so this is reported as what it is — a process
    // that outlived the sequence — rather than as a permission problem.
    expect(report.kept[0]?.reason).toBe("It was still running after SIGTERM and SIGKILL.");
    expect(sent).toBeGreaterThan(0);
  });

  it("refuses to signal a pid that became protected after the scan", async () => {
    // The second gate. The classifier drops Volli's own pid, so this can only
    // be reached by the guard being re-read at the moment of the signal —
    // which is exactly why it is re-read.
    let scanned = false;
    const { service, signals } = harness(
      { rows: [row()], protectedPids: () => (scanned ? [4242] : []) },
      [fact()],
    );
    const inventory = await service.scan();
    scanned = true;

    const report = await service.reap({
      scanRevision: inventory.revision,
      itemIds: [inventory.candidates[0]!.itemId],
    });

    expect(signals).toEqual([]);
    expect(report.kept[0]?.reason).toBe("This is Volli's own process.");
  });

  it("closes no ledger row for a process the ledger never knew about", async () => {
    const { service, exited } = harness({}, [fact()]);
    const inventory = await service.scan();
    await service.reap({
      scanRevision: inventory.revision,
      itemIds: [inventory.candidates[0]!.itemId],
    });
    expect(exited).toEqual([]);
  });

  it("refuses a superseded revision and an item no scan proposed", async () => {
    const { service } = harness({}, [fact()]);
    const inventory = await service.scan();
    await expect(service.reap({ scanRevision: "rev-old", itemIds: ["x"] })).rejects.toThrow(
      "out of date",
    );
    await expect(
      service.reap({ scanRevision: inventory.revision, itemIds: ["never-proposed"] }),
    ).rejects.toThrow("not in the reviewed scan");
  });

  it("requires a fresh scan after a reap, so a second click cannot act on a used list", async () => {
    const { service } = harness({}, [fact()]);
    const inventory = await service.scan();
    const itemIds = [inventory.candidates[0]!.itemId];
    await service.reap({ scanRevision: inventory.revision, itemIds });
    await expect(service.reap({ scanRevision: inventory.revision, itemIds })).rejects.toThrow(
      "out of date",
    );
  });

  it("refuses to signal Volli's own process even if one were proposed", async () => {
    const { service, signals } = harness({}, [fact({ pid: process.pid, pgid: process.pid })]);
    const inventory = await service.scan();
    // The classifier already keeps Volli's own pid out; this is the second gate,
    // which is the one that matters if a future scan ever loses the first.
    expect(inventory.candidates).toEqual([]);
    expect(signals).toEqual([]);
  });
});

const ON: AutoReapPolicy = { enabled: true, minimumAgeHours: 24 };
const OFF: AutoReapPolicy = { enabled: false, minimumAgeHours: 24 };

/** Everything a caller must supply; every seam left on its real default. */
function bare(policy: AutoReapPolicy): OrphanProcessService {
  return new OrphanProcessService({
    ledger: { listOpen: () => [], markExited: () => {}, prune: () => 0 },
    // No worktrees, so a real scan of this machine can propose nothing and
    // the real `process.kill` behind the signal seam is never reached.
    worktrees: () => [],
    liveSessionIds: () => [],
    liveWorktrees: () => [],
    openTerminalCwds: () => [],
    ...(policy.enabled ? { policy: () => policy } : {}),
  });
}

describe("OrphanProcessService with nothing injected", () => {
  it("is off by default, and answers so without walking the process table", async () => {
    await expect(bare(OFF).autoReap()).resolves.toEqual({
      reaped: [],
      declined: "Automatic reaping is off.",
    });
  });

  it("reads this machine with the real tools when nothing is scripted", async () => {
    // Read-only: `ps`, `lsof`, `memory_pressure` and `sysctl`, against no
    // worktrees at all, so there is nothing to propose and nothing to signal.
    const result = await bare(ON).autoReap();

    expect(result.reaped).toEqual([]);
    expect(result.declined).toBeTypeOf("string");
  }, 30_000);
});

describe("OrphanProcessService.autoReap", () => {
  it("does nothing at all when the setting is off — not even a process walk", async () => {
    const inventory = vi.fn(async () => [fact()]);
    const { service } = harness({ policy: () => OFF, inventory });
    await expect(service.autoReap()).resolves.toEqual({
      reaped: [],
      declined: "Automatic reaping is off.",
    });
    expect(inventory).not.toHaveBeenCalled();
  });

  it("declines while the machine has memory to spare", async () => {
    const comfortable: MemoryPressureReading = { underPressure: false, detail: "free 62%" };
    const { service, signals } = harness(
      { policy: () => ON, memoryPressure: async () => comfortable },
      [fact()],
    );
    const result = await service.autoReap();
    expect(result.reaped).toEqual([]);
    expect(result.declined).toContain("free 62%");
    expect(signals).toEqual([]);
  });

  it("reaps an old candidate under real pressure and names what it killed", async () => {
    const notices: Array<[string, string]> = [];
    const { service, signals } = harness(
      { policy: () => ON, notify: (title, message) => notices.push([title, message]) },
      [fact()],
    );

    const result = await service.autoReap();

    expect(result.reaped).toHaveLength(1);
    expect(signals[0]).toEqual([-4242, "SIGTERM"]);
    expect(notices[0]?.[0]).toBe("Reaped 1 orphaned process");
    expect(notices[0]?.[1]).toContain("VC-341 · next dev");
    expect(notices[0]?.[1]).toContain("free 8%");
  });

  it("counts what it killed in the plural when there was more than one", async () => {
    const notices: Array<[string, string]> = [];
    const { service } = harness(
      { policy: () => ON, notify: (title, message) => notices.push([title, message]) },
      [fact(), fact({ pid: 99, pgid: 99, command: "vite" })],
    );

    const result = await service.autoReap();

    expect(result.reaped).toHaveLength(2);
    expect(notices[0]?.[0]).toBe("Reaped 2 orphaned processes");
  });

  it("says nothing to anyone when every candidate turned out to be gone", async () => {
    const notices: Array<[string, string]> = [];
    let calls = 0;
    const { service } = harness({
      policy: () => ON,
      notify: (title, message) => notices.push([title, message]),
      // Present for the scan, gone by the reap's re-check.
      inventory: async () => (++calls === 1 ? [fact()] : []),
    });

    const result = await service.autoReap();

    expect(result.reaped).toEqual([]);
    expect(notices).toEqual([]);
  });
});

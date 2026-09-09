import { describe, expect, it } from "vite-plus/test";

import {
  classifyOrphanProcesses,
  DEFAULT_AUTO_REAP_POLICY,
  describeReapedProcesses,
  formatProcessAge,
  isSpawnLedgerKind,
  isUnderPath,
  ledgerEntryMatches,
  selectAutoReapable,
  START_TIME_TOLERANCE_MS,
  worktreeForPath,
  type MemoryPressureReading,
  type OrphanProcessCandidate,
  type OrphanProcessScanInput,
  type ProcessFact,
  type SpawnLedgerEntry,
  type WorktreeRef,
} from "./process-orphans";

const NOW = 1_800_000_000_000;
const HOUR = 3_600_000;

const worktree: WorktreeRef = {
  path: "/home/.volli/worktrees/volli-code-f373/VC-341-orphan-sweep",
  ticketId: "ticket-341",
  ticketDisplayId: "VC-341",
  projectId: "project-1",
};

function processFact(overrides: Partial<ProcessFact> = {}): ProcessFact {
  return {
    pid: 4242,
    ppid: 1,
    pgid: 4242,
    startedAt: NOW - 3 * HOUR,
    rssBytes: 512 * 1024,
    tty: null,
    command: "node dev-server.js",
    cwd: worktree.path,
    ...overrides,
  };
}

function ledgerEntry(overrides: Partial<SpawnLedgerEntry> = {}): SpawnLedgerEntry {
  return {
    id: "row-1",
    sessionId: "session-ended",
    ticketId: "ticket-341",
    projectId: "project-1",
    kind: "shell",
    pid: 4242,
    pgid: 4242,
    startedAt: NOW - 3 * HOUR,
    cwd: worktree.path,
    command: "pnpm dev",
    ...overrides,
  };
}

function scanInput(overrides: Partial<OrphanProcessScanInput> = {}): OrphanProcessScanInput {
  return {
    now: NOW,
    processes: [],
    ledger: [],
    worktrees: [worktree],
    liveSessionIds: [],
    liveWorktreePaths: [],
    openTerminalCwds: [],
    protectedPids: [],
    ...overrides,
  };
}

describe("isSpawnLedgerKind", () => {
  it("accepts every door Volli spawns through and nothing else", () => {
    expect(["execute", "shell", "terminal", "browser"].every(isSpawnLedgerKind)).toBe(true);
    expect(isSpawnLedgerKind("daemon")).toBe(false);
    expect(isSpawnLedgerKind(undefined)).toBe(false);
  });
});

describe("isUnderPath", () => {
  it("counts the root itself and anything inside it", () => {
    expect(isUnderPath("/a/b", "/a/b")).toBe(true);
    expect(isUnderPath("/a/b", "/a/b/c")).toBe(true);
    expect(isUnderPath("/a/b/", "/a/b/c")).toBe(true);
  });

  it("refuses a sibling that merely shares a prefix, and an empty root", () => {
    expect(isUnderPath("/a/b", "/a/bc")).toBe(false);
    expect(isUnderPath("", "/a/b")).toBe(false);
  });
});

describe("worktreeForPath", () => {
  const nested: WorktreeRef = { ...worktree, path: `${worktree.path}/packages/inner` };

  it("takes the deepest match", () => {
    expect(worktreeForPath(`${nested.path}/src`, [worktree, nested])?.path).toBe(nested.path);
    expect(worktreeForPath(`${nested.path}/src`, [nested, worktree])?.path).toBe(nested.path);
  });

  it("answers null for no path and for a path in no worktree", () => {
    expect(worktreeForPath(null, [worktree])).toBeNull();
    expect(worktreeForPath("/tmp/elsewhere", [worktree])).toBeNull();
  });
});

describe("ledgerEntryMatches", () => {
  it("matches on pid and a start time within the tolerance", () => {
    expect(ledgerEntryMatches({ pid: 10, startedAt: NOW }, { pid: 10, startedAt: NOW })).toBe(true);
    expect(
      ledgerEntryMatches(
        { pid: 10, startedAt: NOW },
        { pid: 10, startedAt: NOW - START_TIME_TOLERANCE_MS },
      ),
    ).toBe(true);
  });

  it("refuses a different pid and a recycled one", () => {
    expect(ledgerEntryMatches({ pid: 10, startedAt: NOW }, { pid: 11, startedAt: NOW })).toBe(
      false,
    );
    expect(
      ledgerEntryMatches({ pid: 10, startedAt: NOW }, { pid: 10, startedAt: NOW + 6_000 }),
    ).toBe(false);
    expect(
      ledgerEntryMatches({ pid: 10, startedAt: NOW }, { pid: 10, startedAt: NOW + 6_000 }, 10_000),
    ).toBe(true);
  });
});

describe("classifyOrphanProcesses — the ledger", () => {
  it("lists a Volli-started process whose Session has ended", () => {
    const [candidate, ...rest] = classifyOrphanProcesses(
      scanInput({ processes: [processFact()], ledger: [ledgerEntry()] }),
    );
    expect(rest).toEqual([]);
    expect(candidate).toMatchObject({
      source: "ledger",
      stance: "reapable",
      pid: 4242,
      pgid: 4242,
      sessionId: "session-ended",
      ticketId: "ticket-341",
      ticketDisplayId: "VC-341",
      worktreePath: worktree.path,
      command: "pnpm dev",
      ageMs: 3 * HOUR,
    });
    expect(candidate?.reason).toContain("has ended");
  });

  it("never lists a process whose Session still holds an executor", () => {
    expect(
      classifyOrphanProcesses(
        scanInput({
          processes: [processFact()],
          ledger: [ledgerEntry()],
          liveSessionIds: ["session-ended"],
        }),
      ),
    ).toEqual([]);
  });

  it("does not list a row whose pid was recycled onto a stranger", () => {
    const recycled = processFact({ startedAt: NOW - 60_000, command: "vim notes.md", tty: "s003" });
    const candidates = classifyOrphanProcesses(
      scanInput({ processes: [recycled], ledger: [ledgerEntry()] }),
    );
    // The cwd pass still reports it, but as the person's own terminal — never
    // as the Session's process the recycled row claimed it was.
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      source: "cwd",
      stance: "not-volli",
      command: "vim notes.md",
    });
  });

  it("drops a row with no live process at all", () => {
    expect(classifyOrphanProcesses(scanInput({ processes: [], ledger: [ledgerEntry()] }))).toEqual(
      [],
    );
  });

  it("skips a protected pid before it can become a candidate", () => {
    expect(
      classifyOrphanProcesses(
        scanInput({ processes: [processFact()], ledger: [ledgerEntry()], protectedPids: [4242] }),
      ),
    ).toEqual([]);
  });

  it("falls back to the observed group and the recorded cwd, and attributes an unknown worktree as null", () => {
    const [candidate] = classifyOrphanProcesses(
      scanInput({
        processes: [processFact({ pgid: 99, cwd: null })],
        ledger: [ledgerEntry({ pgid: null, ticketId: null, cwd: "/tmp/board-session" })],
      }),
    );
    expect(candidate).toMatchObject({
      pgid: 99,
      cwd: "/tmp/board-session",
      ticketId: null,
      ticketDisplayId: null,
      worktreePath: null,
    });
  });

  it("uses a caller's own start-time tolerance", () => {
    const drifted = processFact({ startedAt: NOW - 3 * HOUR - 8_000 });
    expect(
      classifyOrphanProcesses(
        scanInput({ processes: [drifted], ledger: [ledgerEntry()], startToleranceMs: 10_000 }),
      ),
    ).toHaveLength(1);
  });
});

describe("classifyOrphanProcesses — the cwd sweep", () => {
  it("finds a double-forker with no ledger row and no terminal", () => {
    const [candidate] = classifyOrphanProcesses(
      scanInput({ processes: [processFact({ pid: 777, command: "sleep 9999" })] }),
    );
    expect(candidate).toMatchObject({
      source: "cwd",
      stance: "reapable",
      pid: 777,
      ticketDisplayId: "VC-341",
      worktreePath: worktree.path,
    });
    expect(candidate?.reason).toContain("no ledger row");
  });

  it("lists a person's own shell as not Volli's", () => {
    const [candidate] = classifyOrphanProcesses(
      scanInput({ processes: [processFact({ pid: 900, tty: "s004", command: "-zsh" })] }),
    );
    expect(candidate).toMatchObject({ stance: "not-volli", tty: "s004" });
    expect(candidate?.reason).toContain("Not Volli's");
  });

  it("says nothing about a worktree a live Session is attached to", () => {
    expect(
      classifyOrphanProcesses(
        scanInput({ processes: [processFact()], liveWorktreePaths: [worktree.path] }),
      ),
    ).toEqual([]);
  });

  it("says nothing about a worktree with an open terminal tab", () => {
    expect(
      classifyOrphanProcesses(
        scanInput({
          processes: [processFact()],
          openTerminalCwds: [`${worktree.path}/packages/shared`],
        }),
      ),
    ).toEqual([]);
  });

  it("ignores a process standing outside every worktree, and one with no cwd", () => {
    expect(
      classifyOrphanProcesses(
        scanInput({
          processes: [processFact({ pid: 1, cwd: "/" }), processFact({ pid: 2, cwd: null })],
        }),
      ),
    ).toEqual([]);
  });

  it("does not repeat a pid the ledger already claimed, or signal a protected one", () => {
    const candidates = classifyOrphanProcesses(
      scanInput({
        processes: [processFact(), processFact({ pid: 5, command: "guard" })],
        ledger: [ledgerEntry()],
        protectedPids: [5],
      }),
    );
    expect(candidates.map((candidate) => candidate.pid)).toEqual([4242]);
  });

  it("orders every candidate oldest first", () => {
    const candidates = classifyOrphanProcesses(
      scanInput({
        processes: [
          processFact({ pid: 1, startedAt: NOW - HOUR }),
          processFact({ pid: 2, startedAt: NOW - 10 * HOUR }),
        ],
      }),
    );
    expect(candidates.map((candidate) => candidate.pid)).toEqual([2, 1]);
  });
});

describe("formatProcessAge", () => {
  it("reads at a glance at every scale", () => {
    expect(formatProcessAge(18 * 24 * HOUR + 4 * HOUR)).toBe("18d 4h");
    expect(formatProcessAge(4 * HOUR + 12 * 60_000)).toBe("4h 12m");
    expect(formatProcessAge(12 * 60_000)).toBe("12m");
    expect(formatProcessAge(40_000)).toBe("40s");
    expect(formatProcessAge(-5)).toBe("0s");
  });
});

describe("selectAutoReapable", () => {
  const pressure: MemoryPressureReading = { underPressure: true, detail: "free 8%" };
  const candidate = (overrides: Partial<OrphanProcessCandidate> = {}): OrphanProcessCandidate => ({
    itemId: "ledger:1:2",
    source: "ledger",
    stance: "reapable",
    pid: 1,
    pgid: 1,
    startedAt: NOW - 30 * HOUR,
    ageMs: 30 * HOUR,
    rssBytes: 1024,
    command: "next dev",
    cwd: worktree.path,
    tty: null,
    sessionId: "session-ended",
    ticketId: "ticket-341",
    ticketDisplayId: "VC-341",
    worktreePath: worktree.path,
    reason: "",
    ...overrides,
  });

  it("is off until a person turns it on", () => {
    expect(selectAutoReapable([candidate()], DEFAULT_AUTO_REAP_POLICY, pressure)).toEqual({
      reap: [],
      declined: "Automatic reaping is off.",
    });
  });

  it("declines while the machine has memory to spare", () => {
    const result = selectAutoReapable(
      [candidate()],
      { enabled: true, minimumAgeHours: 24 },
      {
        underPressure: false,
        detail: "free 62%",
      },
    );
    expect(result.reap).toEqual([]);
    expect(result.declined).toContain("free 62%");
  });

  it("declines when nothing is old enough, and never takes a process it may not kill", () => {
    const young = selectAutoReapable(
      [candidate({ ageMs: 2 * HOUR })],
      { enabled: true, minimumAgeHours: 24 },
      pressure,
    );
    expect(young.reap).toEqual([]);
    expect(young.declined).toContain("24h");

    const theirs = selectAutoReapable(
      [candidate({ stance: "not-volli" })],
      { enabled: true, minimumAgeHours: 24 },
      pressure,
    );
    expect(theirs.reap).toEqual([]);
  });

  it("takes an old reapable candidate under real pressure", () => {
    const result = selectAutoReapable(
      [candidate(), candidate({ itemId: "cwd:2:3", ageMs: HOUR })],
      { enabled: true, minimumAgeHours: -1 },
      pressure,
    );
    expect(result.declined).toBeNull();
    expect(result.reap).toHaveLength(2);
  });
});

const named = (id: string | null, command: string): OrphanProcessCandidate =>
  ({ ticketDisplayId: id, command }) as OrphanProcessCandidate;

describe("describeReapedProcesses", () => {
  it("names what was killed and counts the rest", () => {
    expect(describeReapedProcesses([named("VC-341", "next dev")])).toBe("VC-341 · next dev");
    expect(describeReapedProcesses([named(null, "sleep 9999")])).toBe("no ticket · sleep 9999");
    expect(
      describeReapedProcesses([
        named("VC-1", "a"),
        named("VC-2", "b"),
        named("VC-3", "c"),
        named("VC-4", "d"),
      ]),
    ).toBe("VC-1 · a, VC-2 · b, VC-3 · c and 1 more");
  });
});

import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type { ProcessFact, SpawnLedgerEntry } from "@volli/shared";

import { PS_ARGS, runInventoryTool } from "./inventory";
import { resumeParkedTerminals, type ParkedTerminalLedger } from "./parked-terminals";

// The default process table goes through the inventory's bounded runner; the
// real parser stays, so the ps text below is read exactly as in production.
vi.mock("./inventory", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./inventory")>()),
  runInventoryTool: vi.fn(),
}));

/** Launch N+1's start; every row below was parked by launch N, before it. */
const LAUNCHED_AT = 1_800_000_000_000;
const STARTED_AT = LAUNCHED_AT - 3 * 60 * 60 * 1000;

function row(id: string, pid: number, startedAt = STARTED_AT): SpawnLedgerEntry {
  return {
    id,
    sessionId: `session-${id}`,
    ticketId: null,
    projectId: null,
    kind: "terminal",
    pid,
    pgid: pid,
    startedAt,
    cwd: "/w",
    command: "/bin/zsh",
  };
}

function fact(pid: number, startedAt = STARTED_AT, pgid = pid): ProcessFact {
  return {
    pid,
    ppid: 1,
    pgid,
    startedAt,
    rssBytes: 1024,
    tty: "s001",
    command: "/bin/zsh -il",
    cwd: null,
  };
}

/** A fake ledger: the marked rows launch N left, and every mark change since. */
function fakeLedger(rows: SpawnLedgerEntry[]) {
  const cleared: string[] = [];
  const listParkedTerminals = vi.fn((_parkedBefore: number) => rows);
  const ledger: ParkedTerminalLedger = {
    listParkedTerminals,
    markParked: (id, parkedAt) => {
      expect(parkedAt).toBeNull();
      cleared.push(id);
    },
  };
  return { ledger, cleared, listParkedTerminals };
}

function errno(code: string): Error {
  return Object.assign(new Error(code), { code });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("resumeParkedTerminals (VC-833)", () => {
  it("SIGCONTs the group of a row launch N parked whose process is alive with its start time", async () => {
    const { ledger, cleared, listParkedTerminals } = fakeLedger([row("a", 4100)]);
    const signal = vi.fn();
    const report = await resumeParkedTerminals({
      ledger,
      launchedAt: LAUNCHED_AT,
      // ps's lstart is second-resolution; the ledger's clock is not.
      processes: async () => [fact(4100, STARTED_AT + 800)],
      signal,
    });
    expect(listParkedTerminals).toHaveBeenCalledWith(LAUNCHED_AT);
    expect(signal.mock.calls).toEqual([[-4100, "SIGCONT"]]);
    expect(report).toEqual({ resumed: ["a"], stale: [], refused: [] });
    expect(cleared).toEqual(["a"]);
  });

  it("sends nothing to a pid whose start time no longer matches, or that is gone", async () => {
    const { ledger, cleared } = fakeLedger([row("recycled", 4100), row("gone", 4200)]);
    const signal = vi.fn();
    const report = await resumeParkedTerminals({
      ledger,
      launchedAt: LAUNCHED_AT,
      // 4100 is alive, but started an hour after the row's shell: a stranger.
      processes: async () => [fact(4100, STARTED_AT + 60 * 60 * 1000)],
      signal,
    });
    expect(signal).not.toHaveBeenCalled();
    expect(report).toEqual({ resumed: [], stale: ["recycled", "gone"], refused: [] });
    // Neither pid can ever be the recorded shell again, so the mark goes.
    expect(cleared).toEqual(["recycled", "gone"]);
  });

  it("continues a shell that no longer leads its group alone, never that group", async () => {
    const { ledger } = fakeLedger([row("a", 4100)]);
    const signal = vi.fn();
    await resumeParkedTerminals({
      ledger,
      launchedAt: LAUNCHED_AT,
      processes: async () => [fact(4100, STARTED_AT, 77)],
      signal,
    });
    expect(signal.mock.calls).toEqual([[4100, "SIGCONT"]]);
  });

  it("never reads the process table when no row is marked — every launch after an orderly quit", async () => {
    const { ledger } = fakeLedger([]);
    const processes = vi.fn(async () => []);
    const report = await resumeParkedTerminals({ ledger, launchedAt: LAUNCHED_AT, processes });
    expect(processes).not.toHaveBeenCalled();
    expect(report).toEqual({ resumed: [], stale: [], refused: [] });
  });

  it.each([
    ["could not be read", async () => null],
    [
      "threw",
      async () => {
        throw new Error("ps unavailable");
      },
    ],
  ])("signals nothing and keeps every mark when the process table %s", async (_label, read) => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { ledger, cleared } = fakeLedger([row("a", 4100)]);
    const signal = vi.fn();
    const report = await resumeParkedTerminals({
      ledger,
      launchedAt: LAUNCHED_AT,
      processes: read,
      signal,
    });
    expect(signal).not.toHaveBeenCalled();
    expect(cleared).toEqual([]);
    expect(report).toEqual({ resumed: [], stale: [], refused: [] });
  });

  it("clears a row that died between the read and the signal, and keeps one it may not signal", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    const { ledger, cleared } = fakeLedger([row("raced", 4100), row("foreign", 4200)]);
    const report = await resumeParkedTerminals({
      ledger,
      launchedAt: LAUNCHED_AT,
      processes: async () => [fact(4100), fact(4200)],
      signal: (target) => {
        throw errno(target === -4100 ? "ESRCH" : "EPERM");
      },
    });
    expect(report).toEqual({ resumed: [], stale: ["raced"], refused: ["foreign"] });
    expect(cleared).toEqual(["raced"]);
  });

  it("defaults to the inventory's ps and the real process.kill", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    const kill = vi.spyOn(process, "kill").mockImplementation(() => true);
    // `lstart` is local time, as BSD and procps both print it.
    // `Date#toString` opens "Fri Jan 15 2027 08:00:00"; lstart puts the year last.
    const [weekday, month, day, year, time] = new Date(STARTED_AT).toString().split(" ");
    vi.mocked(runInventoryTool).mockResolvedValue(
      `4100 1 4100 2048 s001 ${weekday} ${month} ${day} ${time} ${year} /bin/zsh -il\n`,
    );
    const { ledger } = fakeLedger([row("a", 4100)]);
    const report = await resumeParkedTerminals({ ledger, launchedAt: LAUNCHED_AT });
    expect(runInventoryTool).toHaveBeenCalledWith("ps", PS_ARGS);
    expect(report.resumed).toEqual(["a"]);
    expect(kill).toHaveBeenCalledWith(-4100, "SIGCONT");
  });

  it("keeps every mark when the inventory's ps could not run", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.mocked(runInventoryTool).mockResolvedValue(null);
    const { ledger, cleared } = fakeLedger([row("a", 4100)]);
    const report = await resumeParkedTerminals({ ledger, launchedAt: LAUNCHED_AT });
    expect(report).toEqual({ resumed: [], stale: [], refused: [] });
    expect(cleared).toEqual([]);
  });
});

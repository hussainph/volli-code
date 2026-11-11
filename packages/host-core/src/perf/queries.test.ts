import { describe, expect, it } from "vite-plus/test";

import { perfCompare, perfStallLine, perfSummary, perfTop } from "./queries";
import {
  nearestRank,
  observedMs,
  perfGroupKey,
  perfStats,
  perfVersionKey,
  perfVersionMatches,
  perHour,
  type PerfRun,
  type PerfStallRecord,
} from "./report";
import type { PerfStallFilter } from "./store";

const HOUR = 3_600_000;
const T0 = 1_800_000_000_000;
const SESSION = "0123abcd-0000-4000-8000-000000000000";

function stall(overrides: Partial<PerfStallRecord> = {}): PerfStallRecord {
  return {
    at: T0 + 1_000,
    process: "main",
    kind: "door",
    door: "ipc",
    operation: "volli:board-load",
    label: null,
    sessionId: null,
    windowId: null,
    durationMs: 200,
    hint: null,
    version: "0.3.0",
    build: null,
    ...overrides,
  };
}

/** A reader over fixed rows that honours the filter the queries pass (time and process). */
function reader(stalls: readonly PerfStallRecord[], runs: readonly PerfRun[]) {
  return {
    scanStalls: async (
      filter: PerfStallFilter,
      visit: (rows: readonly PerfStallRecord[]) => void,
    ) => {
      // Two chunks, as the store hands them over.
      const matching = stalls.filter(
        (row) =>
          (filter.since === undefined || row.at >= filter.since) &&
          (filter.process === undefined || row.process === filter.process),
      );
      visit(matching.slice(0, 1));
      visit(matching.slice(1));
    },
    runs: () => [...runs],
  };
}

describe("the perf arithmetic", () => {
  it("names a build as version+build, and matches a version, a label or the whole key", () => {
    expect(perfVersionKey("0.3.0", null)).toBe("0.3.0");
    expect(perfVersionKey("0.3.0", "abc")).toBe("0.3.0+abc");
    const run = { version: "0.3.0", build: "abc" };
    expect(["0.3.0", "abc", "0.3.0+abc"].map((s) => perfVersionMatches(s, run))).toEqual([
      true,
      true,
      true,
    ]);
    expect(perfVersionMatches("0.3.1", run)).toBe(false);
    expect(perfVersionMatches("abc", { version: "0.3.0", build: null })).toBe(false);
  });

  it("keys a stall along each dimension", () => {
    const row = stall({ label: "pane-switch", sessionId: SESSION, build: "abc" });
    expect(perfGroupKey(row, "operation")).toBe("ipc/volli:board-load");
    expect(perfGroupKey(row, "door")).toBe("ipc");
    expect(perfGroupKey(row, "label")).toBe("pane-switch");
    expect(perfGroupKey(row, "version")).toBe("0.3.0+abc");
    expect(perfGroupKey(row, "session")).toBe(SESSION);
  });

  it("takes nearest-rank percentiles", () => {
    expect(nearestRank([], 95)).toBe(0);
    expect(nearestRank([10], 95)).toBe(10);
    const hundred = Array.from({ length: 100 }, (_, index) => index + 1);
    expect(nearestRank(hundred, 50)).toBe(50);
    expect(nearestRank(hundred, 95)).toBe(95);
    expect(perfStats([300, 200, 250])).toEqual({
      count: 3,
      totalMs: 750,
      maxMs: 300,
      p50Ms: 250,
      p95Ms: 300,
    });
    expect(perfStats([])).toEqual({ count: 0, totalMs: 0, maxMs: 0, p50Ms: 0, p95Ms: 0 });
  });

  it("counts only the time a run overlapped the window", () => {
    const runs = [
      { startedAt: T0 - HOUR, lastSeenAt: T0 + HOUR, version: "a", build: null },
      { startedAt: T0 + 2 * HOUR, lastSeenAt: T0 + 3 * HOUR, version: "b", build: null },
      { startedAt: T0 - 5 * HOUR, lastSeenAt: T0 - 4 * HOUR, version: "c", build: null },
    ];
    expect(observedMs(runs, T0, T0 + 10 * HOUR)).toBe(2 * HOUR);
    expect(perHour(10, 2 * HOUR)).toBe(5);
    expect(perHour(10, 0)).toBeNull();
  });
});

const frame = (overrides: Partial<PerfStallRecord> = {}) =>
  stall({
    process: "renderer",
    kind: "frame",
    door: "renderer",
    operation: "long-animation-frame",
    ...overrides,
  });

describe("LoAF reporting", () => {
  const runs = [
    { startedAt: T0, lastSeenAt: T0 + HOUR, version: "old", build: null },
    { startedAt: T0 + HOUR, lastSeenAt: T0 + 3 * HOUR, version: "new", build: null },
  ];
  const window = {
    since: T0,
    until: T0 + 3 * HOUR,
    process: null,
    by: "operation",
    limit: 1,
  } as const;

  it("omits the summary for old history, main stalls and input events", async () => {
    const answer = await perfTop(
      reader(
        [
          frame(),
          stall({ scriptTotalMs: 50 }),
          frame({ kind: "input", renderMs: 20 }),
          frame({ operation: "longtask", scriptTotalMs: 50, renderMs: 20 }),
        ],
        runs,
      ),
      window,
    );
    expect(answer).not.toHaveProperty("loaf");
  });

  it("counts independently measured frames, keeping explicit zero and overlapping signals", async () => {
    const answer = await perfTop(
      reader(
        [
          frame(),
          frame({ scriptTotalMs: 0, blockingMs: 0, renderMs: 80, styleLayoutMs: 60 }),
          frame({ scriptTotalMs: 30, renderMs: 100 }),
          frame({ at: T0 + 4 * HOUR, scriptTotalMs: 900 }),
          stall({ scriptTotalMs: 900 }),
        ],
        runs,
      ),
      window,
    );
    expect(answer.loaf).toEqual({
      script: { measuredFrames: 2, totalMs: 30, msPerHour: 10 },
      blocking: { measuredFrames: 1, totalMs: 0, msPerHour: 0 },
      render: { measuredFrames: 2, totalMs: 180, msPerHour: 60 },
      styleLayout: { measuredFrames: 1, totalMs: 60, msPerHour: 20 },
    });
    const main = await perfTop(reader([frame({ renderMs: 80 })], runs), {
      ...window,
      process: "main",
    });
    expect(main).not.toHaveProperty("loaf");
  });

  it("leaves script unknown when packaged Chromium has no attribution", async () => {
    const answer = await perfTop(reader([frame({ renderMs: 0 })], []), window);
    expect(answer.loaf).toEqual({
      script: { measuredFrames: 0, totalMs: null, msPerHour: null },
      blocking: { measuredFrames: 0, totalMs: null, msPerHour: null },
      render: { measuredFrames: 1, totalMs: 0, msPerHour: null },
      styleLayout: { measuredFrames: 0, totalMs: null, msPerHour: null },
    });
  });

  it("compares measured totals using each build's own hours, never converting old history to zero", async () => {
    const store = reader(
      [
        frame({ version: "old" }),
        frame({
          version: "new",
          at: T0 + 2 * HOUR,
          scriptTotalMs: 0,
          blockingMs: 0,
          renderMs: 80,
          styleLayoutMs: 60,
        }),
      ],
      runs,
    );
    const answer = await perfCompare(store, { ...window, versions: ["old", "new"] });
    expect(answer.a).not.toHaveProperty("loaf");
    expect(answer.b.loaf).toEqual({
      script: { measuredFrames: 1, totalMs: 0, msPerHour: 0 },
      blocking: { measuredFrames: 1, totalMs: 0, msPerHour: 0 },
      render: { measuredFrames: 1, totalMs: 80, msPerHour: 40 },
      styleLayout: { measuredFrames: 1, totalMs: 60, msPerHour: 30 },
    });
    const overlap = await perfCompare(store, { ...window, versions: ["new", "new"] });
    expect(overlap.a.loaf).toEqual(overlap.b.loaf);
  });

  it("mirrors only present flat fields into stall JSON, including measured zero", () => {
    const fields = {
      scriptTotalMs: 0,
      blockingMs: 0,
      renderMs: 80,
      styleLayoutMs: 60,
      scriptFile: "index-abc.js",
      scriptFunction: "flushWork",
      scriptInvoker: "user-callback",
      scriptMs: 0,
    };
    expect(perfStallLine(frame(fields))).toMatchObject(fields);
    expect(JSON.parse(JSON.stringify(perfStallLine(frame(fields))))).toMatchObject(fields);
    const old = perfStallLine(frame());
    for (const key of Object.keys(fields)) expect(old).not.toHaveProperty(key);
  });
});

describe("perf top", () => {
  const runs = [{ startedAt: T0, lastSeenAt: T0 + 2 * HOUR, version: "0.3.0", build: null }];

  it("ranks groups by total stalled time and says how long the app was watched", async () => {
    const answer = await perfTop(
      reader(
        [
          stall({ durationMs: 300 }),
          stall({ durationMs: 500 }),
          stall({ door: "socket", operation: "ticket.list", durationMs: 1_000 }),
          stall({ process: "renderer", door: "renderer", operation: "keydown", durationMs: 200 }),
        ],
        runs,
      ),
      { since: T0, until: T0 + 2 * HOUR, process: "main", by: "operation", limit: 1 },
    );
    expect(answer).toEqual({
      since: T0,
      until: T0 + 2 * HOUR,
      process: "main",
      by: "operation",
      observedMs: 2 * HOUR,
      stalls: 3,
      stallMs: 1_800,
      stallsPerHour: 1.5,
      stallMsPerHour: 900,
      groupCount: 2,
      groups: [
        {
          key: "socket/ticket.list",
          count: 1,
          totalMs: 1_000,
          maxMs: 1_000,
          p50Ms: 1_000,
          p95Ms: 1_000,
          share: 0.556,
          stallMsPerHour: 500,
        },
      ],
    });
  });

  it("leaves out stalls after the window's end, and answers an empty window with zeros", async () => {
    const answer = await perfTop(reader([stall({ at: T0 + 3 * HOUR })], []), {
      since: T0,
      until: T0 + HOUR,
      process: null,
      by: "door",
      limit: 10,
    });
    expect(answer).toMatchObject({
      process: null,
      stalls: 0,
      stallMs: 0,
      observedMs: 0,
      stallsPerHour: null,
      groups: [],
    });
  });

  it("weighs each version by its own hours, and prints a Session by its short handle", async () => {
    const twoBuilds = [
      { startedAt: T0, lastSeenAt: T0 + HOUR, version: "0.3.0", build: null },
      { startedAt: T0 + HOUR, lastSeenAt: T0 + 3 * HOUR, version: "0.3.1", build: "abc" },
    ];
    const rows = [
      stall({ durationMs: 600 }),
      stall({ version: "0.3.1", build: "abc", durationMs: 600, sessionId: SESSION }),
    ];
    const window = { since: T0, until: T0 + 3 * HOUR, process: null, limit: 10 } as const;
    const byVersion = await perfTop(reader(rows, twoBuilds), { ...window, by: "version" });
    expect(byVersion.groups.map((group) => [group.key, group.stallMsPerHour])).toEqual([
      ["0.3.0", 600],
      ["0.3.1+abc", 300],
    ]);
    const bySession = await perfTop(reader(rows, twoBuilds), { ...window, by: "session" });
    expect(bySession.groups.map((group) => group.key)).toEqual([null, "0123abcd"]);
    const byLabel = await perfTop(reader(rows, twoBuilds), { ...window, by: "label" });
    expect(byLabel.groups.map((group) => [group.key, group.count])).toEqual([[null, 2]]);
  });
});

describe("perf compare", () => {
  const runs = [
    { startedAt: T0, lastSeenAt: T0 + HOUR, version: "0.3.0", build: null },
    { startedAt: T0 + HOUR, lastSeenAt: T0 + 3 * HOUR, version: "0.3.1", build: "fix" },
  ];
  const rows = [
    stall({ durationMs: 1_000 }),
    stall({ durationMs: 1_000 }),
    stall({ door: "socket", operation: "ticket.list", durationMs: 300 }),
    stall({ version: "0.3.1", build: "fix", durationMs: 400, at: T0 + 2 * HOUR }),
    stall({
      version: "0.3.1",
      build: "fix",
      door: "timer",
      operation: "watchdog",
      durationMs: 800,
      at: T0 + 2 * HOUR,
    }),
  ];

  it("puts two builds side by side per hour observed, biggest move first", async () => {
    const answer = await perfCompare(reader(rows, runs), {
      versions: ["0.3.0", "fix"],
      since: null,
      until: T0 + 3 * HOUR,
      process: null,
      by: "operation",
      limit: 10,
    });
    expect(answer.a).toEqual({
      version: "0.3.0",
      matched: ["0.3.0"],
      runs: 1,
      observedMs: HOUR,
      stalls: 3,
      stallMs: 2_300,
      stallsPerHour: 3,
      stallMsPerHour: 2_300,
    });
    expect(answer.b).toMatchObject({
      matched: ["0.3.1+fix"],
      observedMs: 2 * HOUR,
      stallMs: 1_200,
    });
    expect(
      answer.groups.map((group) => [group.key, group.deltaStallMsPerHour, group.deltaTotalMs]),
    ).toEqual([
      ["ipc/volli:board-load", -1_800, -1_600],
      ["timer/watchdog", 400, 800],
      ["socket/ticket.list", -300, -300],
    ]);
    expect(answer.groups[1]!.a).toBeNull();
    expect(answer.groups[2]!.b).toBeNull();
    expect(answer.groupCount).toBe(3);
  });

  it("falls back to raw totals when a side was never observed, and honours since, process and limit", async () => {
    const answer = await perfCompare(reader(rows, runs), {
      versions: ["0.3.0", "0.9.9"],
      since: T0,
      until: T0 + 3 * HOUR,
      process: "main",
      by: "door",
      limit: 1,
    });
    expect(answer.b).toMatchObject({ runs: 0, observedMs: 0, stallsPerHour: null, matched: [] });
    expect(answer.groups).toEqual([
      expect.objectContaining({ key: "ipc", deltaStallMsPerHour: null, deltaTotalMs: -2_000 }),
    ]);
    expect(answer.groupCount).toBe(2);
  });

  it("drops stalls after the window and prints Sessions by their handles", async () => {
    const answer = await perfCompare(
      reader([stall({ sessionId: SESSION }), stall({ at: T0 + 9 * HOUR })], runs),
      {
        versions: ["0.3.0", "0.3.1"],
        since: null,
        until: T0 + 3 * HOUR,
        process: null,
        by: "session",
        limit: 10,
      },
    );
    expect(answer.groups.map((group) => group.key)).toEqual(["0123abcd"]);
  });
});

describe("perf stalls and the support summary", () => {
  it("lists a stall with its Session's handle and its build", () => {
    expect(perfStallLine(stall({ sessionId: SESSION, build: "abc", windowId: 2 }))).toEqual({
      at: T0 + 1_000,
      process: "main",
      kind: "door",
      door: "ipc",
      operation: "volli:board-load",
      label: null,
      session: "0123abcd",
      window: 2,
      durationMs: 200,
      hint: null,
      version: "0.3.0+abc",
    });
    expect(perfStallLine(stall()).session).toBeNull();
  });

  it("summarizes each process: count, time, p95 and its three worst operations", async () => {
    const runs = [{ startedAt: T0, lastSeenAt: T0 + HOUR, version: "0.3.0", build: null }];
    const rows = [
      stall({ durationMs: 400 }),
      stall({ door: "socket", operation: "a", durationMs: 300 }),
      stall({ door: "socket", operation: "b", durationMs: 250 }),
      stall({ door: "socket", operation: "c", durationMs: 210 }),
      stall({ at: T0 + 2 * HOUR }),
    ];
    expect(await perfSummary(reader(rows, runs), T0, T0 + HOUR)).toEqual({
      since: T0,
      observedMs: HOUR,
      processes: [
        {
          process: "main",
          stalls: 4,
          stallMs: 1_160,
          p95Ms: 400,
          top: [
            { key: "ipc/volli:board-load", count: 1, totalMs: 400 },
            { key: "socket/a", count: 1, totalMs: 300 },
            { key: "socket/b", count: 1, totalMs: 250 },
          ],
        },
        { process: "renderer", stalls: 0, stallMs: 0, p95Ms: 0, top: [] },
      ],
    });
  });
});

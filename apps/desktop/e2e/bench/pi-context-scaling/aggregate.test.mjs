import { describe, expect, it } from "vitest";

import {
  acrossLaunches,
  aggregateRun,
  armKey,
  binnedCorrelation,
  boundOf,
  launchLoad,
  linearFit,
  loadThresholdFor,
  memoryFigures,
  okSamples,
} from "./aggregate.mjs";
import { markdownTables } from "./tables.mjs";

const MIB = 1024 * 1024;

function snapshot({ heapUsedMiB, mainKiB, rendererKiB, descendants = 3 }) {
  return {
    processMemory: {
      rss: 300 * MIB,
      heapUsed: heapUsedMiB * MIB,
      heapTotal: (heapUsedMiB + 20) * MIB,
      external: 10 * MIB,
      arrayBuffers: 0,
    },
    mainMetric: { pid: 1, type: "Browser", workingSetKiB: mainKiB },
    metrics: [
      { pid: 1, type: "Browser", workingSetKiB: mainKiB },
      { pid: 2, type: "Tab", workingSetKiB: rendererKiB },
      { pid: 3, type: "GPU", workingSetKiB: 999_999 },
    ],
    descendants: Array.from({ length: descendants }, (_, pid) => ({ pid })),
    footprint: { mainBytes: mainKiB * 1024 * 2, rendererBytes: [rendererKiB * 1024] },
  };
}

function window({ gaps, echo, eldP95 = 2, eldMax = 9 }) {
  return {
    main: {
      wallMs: 1000,
      mainCpuMs: 50,
      eventLoopDelay: { count: 100, p50Ms: 1.1, p95Ms: eldP95, maxMs: eldMax },
      tickGaps: gaps,
      gc: { count: 1, totalMs: 2, maxMs: 2, entries: [{ epochMs: 0, durationMs: 2, kind: 1 }] },
    },
    renderer: { echo, rpc: echo },
  };
}

const QUIET_GAPS = [
  [1_010, 10],
  [1_110, 10],
  [1_210, 10],
];
const QUIET_ECHO = [
  [1_005, 0.3, 1],
  [1_105, 0.3, 1],
  [1_205, 0.3, 1],
];

function launch(bound, historyEntries, heapDelta, extra = {}) {
  return {
    arm: { bound, historyEntries },
    warmup: false,
    failures: [],
    bindings: {
      before: { live: 0 },
      after: { live: bound, unexpectedLive: [] },
    },
    sidecarEntries: Array.from({ length: bound }, () => historyEntries),
    sidecarBytes: Array.from({ length: bound }, () => historyEntries * 2_000),
    memory: {
      pre: snapshot({ heapUsedMiB: 100, mainKiB: 200 * 1024, rendererKiB: 150 * 1024 }),
      post: snapshot({
        heapUsedMiB: 100 + heapDelta,
        mainKiB: (200 + heapDelta) * 1024,
        rendererKiB: 150 * 1024,
      }),
    },
    fullGcPauseMs: { pre: [30, 20], post: [40, 25] },
    windows: {
      idle: window({ gaps: QUIET_GAPS, echo: QUIET_ECHO }),
      hydration: {
        ...window({
          gaps: [
            [1_010, 10],
            [1_150, 50],
            [1_260, 40],
          ],
          echo: [
            [1_005, 0.3, 1],
            [1_105, 40, 1],
            [1_225, 30, 1],
            [1_300, 500, 0],
          ],
          eldP95: 7,
          eldMax: 49,
        }),
        perSession: [{ ms: 90 }, { ms: 12 }, { ms: 14 }],
      },
      steady: window({ gaps: QUIET_GAPS, echo: QUIET_ECHO, eldP95: 2.5 }),
    },
    host: { before: { loadavg: [4] }, after: { loadavg: [5] } },
    tripwire: { blocked: [], chromiumBlocked: [] },
    tripwireSelfTest: { loaded: true, node: true, chromium: true },
    ...extra,
  };
}

describe("VC-445 arms", () => {
  it("names arms by how many Sessions are bound, reading the legacy field too", () => {
    expect(armKey({ bound: 0, historyEntries: 0 })).toBe("control");
    expect(armKey({ bound: 5, historyEntries: 500 })).toBe("n5-h500");
    expect(boundOf({ attached: 20, historyEntries: 10 })).toBe(20);
    expect(armKey({ attached: 20, historyEntries: 10 })).toBe("n20-h10");
  });

  it("derives the load threshold from the cores", () => {
    expect(loadThresholdFor(8)).toBe(12);
  });

  it("takes the worse of a launch's two load readings", () => {
    expect(launchLoad({ host: { before: { loadavg: [3] }, after: { loadavg: [9] } } })).toBe(9);
    expect(launchLoad({ host: { before: { loadavg: [30] }, after: { loadavg: [2] } } })).toBe(30);
  });
});

describe("VC-445 per-launch summaries", () => {
  it("reports median and range, never a relabelled max", () => {
    expect(acrossLaunches([5, 1, 3, Number.NaN])).toEqual({ n: 3, median: 3, min: 1, max: 5 });
    expect(acrossLaunches([1, 2, 3, 4])).toEqual({ n: 4, median: 2.5, min: 1, max: 4 });
    expect(acrossLaunches([])).toBeNull();
  });

  it("separates main from the renderer and ignores the GPU process", () => {
    const figures = memoryFigures(snapshot({ heapUsedMiB: 64, mainKiB: 2048, rendererKiB: 1024 }));
    expect(figures.mainWorkingSetMiB).toBe(2);
    expect(figures.rendererWorkingSetMiB).toBe(1);
    expect(figures.mainHeapUsedMiB).toBe(64);
    expect(figures.mainFootprintMiB).toBe(4);
    expect(figures.rendererFootprintMiB).toBe(1);
  });

  it("treats an unreadable footprint as missing, not zero", () => {
    const partial = snapshot({ heapUsedMiB: 1, mainKiB: 1, rendererKiB: 1 });
    partial.footprint.rendererBytes = [null];
    expect(memoryFigures(partial).rendererFootprintMiB).toBeNaN();
    delete partial.footprint;
    expect(memoryFigures(partial).mainFootprintMiB).toBeNaN();
  });
});

describe("VC-445 loop↔IPC correlation", () => {
  it("pairs the worst gap and the worst echo that started in the same 100 ms bin", () => {
    const perfect = binnedCorrelation(
      [
        [1_010, 10],
        [1_150, 50],
        [1_210, 10],
        [1_390, 90],
      ],
      [
        [1_005, 1],
        [1_105, 41],
        [1_205, 1],
        [1_305, 81],
      ],
    );
    expect(perfect).toEqual({ bins: 4, pearson: 1 });
  });

  it("attributes a gap to the bin where it BEGAN", () => {
    // A 150 ms gap ending at 1,160 began at 1,010: bin 10, beside the echo at 1,020.
    const result = binnedCorrelation(
      [
        [1_160, 150],
        [1_210, 10],
        [1_310, 10],
      ],
      [
        [1_020, 150],
        [1_220, 1],
        [1_320, 1],
      ],
    );
    expect(result.bins).toBe(3);
    expect(result.pearson).toBe(1);
  });

  it("uses 100 ms bins by default, and honours another width", () => {
    const gaps = [
      [1_010, 10],
      [1_060, 10],
      [1_110, 10],
    ];
    const echo = [
      [1_001, 1],
      [1_051, 2],
      [1_101, 3],
    ];
    expect(binnedCorrelation(gaps, echo).bins).toBe(2);
    expect(binnedCorrelation(gaps, echo, 50).bins).toBe(3);
  });

  it("answers null below three bins or with no variance", () => {
    expect(binnedCorrelation([[1_020, 10]], [[1_000, 1]])).toEqual({ bins: 1, pearson: null });
    expect(
      binnedCorrelation(
        [
          [1_010, 10],
          [1_110, 10],
          [1_210, 10],
        ],
        [
          [1_005, 1],
          [1_105, 2],
          [1_205, 3],
        ],
      ).pearson,
    ).toBeNull();
  });

  it("drops failed samples", () => {
    expect(
      okSamples([
        [1, 2, 1],
        [3, 4, 0],
      ]),
    ).toEqual([[1, 2, 1]]);
  });
});

describe("VC-445 fits", () => {
  it("fits a straight line", () => {
    expect(
      linearFit([
        [0, 1],
        [1, 3],
        [2, 5],
      ]),
    ).toEqual({ n: 3, slope: 2, intercept: 1, r2: 1 });
  });

  it("refuses to fit fewer than three points", () => {
    expect(
      linearFit([
        [0, 1],
        [1, 3],
      ]),
    ).toBeNull();
    expect(linearFit([[1, 1]])).toBeNull();
  });
});

describe("VC-445 run aggregation", () => {
  const launches = [
    launch(0, 0, 0.5),
    launch(1, 100, 2.5),
    launch(5, 100, 10.5),
    launch(5, 100, 999, { warmup: true }),
  ];
  const aggregate = aggregateRun(launches);
  const five = aggregate.arms.find((arm) => arm.key === "n5-h100");

  it("excludes the warm-up and orders arms", () => {
    expect(aggregate.arms.map((arm) => arm.key)).toEqual(["control", "n1-h100", "n5-h100"]);
    expect(five.launches).toBe(1);
    expect(five.boundVerified).toBe(true);
  });

  it("reports memory deltas per launch", () => {
    expect(five.memory.mainHeapUsedMiB.delta.median).toBe(10.5);
    expect(five.memory.rendererWorkingSetMiB.delta.median).toBe(0);
    expect(five.descendants.pre.median).toBe(3);
    expect(five.fullGcPauseMs.post.median).toBe(25);
  });

  it("pools samples and keeps failed IPC out of latency and correlation", () => {
    const hydration = five.windows.hydration;
    expect(hydration.ipcEchoMs.n).toBe(3);
    expect(hydration.ipcEchoMs.max).toBe(40);
    expect(hydration.ipcFailures).toBe(2);
    expect(hydration.tickGapMs.max).toBe(50);
    // With the failed 500 ms echo let in, bin 13 would join and r would fall.
    expect(hydration.loopVsEcho).toEqual({ bins: 3, pearson: expect.any(Number) });
    expect(hydration.loopVsEcho.pearson).toBeGreaterThan(0.9);
  });

  it("splits the first bind after boot from the later ones", () => {
    expect(five.hydrationFirstMs.max).toBe(90);
    expect(five.hydrationLaterMs.n).toBe(2);
    expect(five.hydrationLaterMs.max).toBe(14);
  });

  it("reports loop and IPC as deltas against the same launch's idle window", () => {
    expect(five.deltasVsIdle.hydration.eventLoopDelayP95Ms.median).toBe(5);
    expect(five.deltasVsIdle.hydration.eventLoopDelayMaxMs.median).toBe(40);
    expect(five.deltasVsIdle.hydration.tickGapP95Ms.median).toBe(40);
    expect(five.deltasVsIdle.hydration.ipcEchoP95Ms.median).toBeCloseTo(39.7, 5);
    expect(five.deltasVsIdle.steady.eventLoopDelayP95Ms.median).toBe(0.5);
    expect(five.deltasVsIdle.steady.ipcEchoP95Ms.median).toBe(0);
  });

  it("fits per-context cost only with the control arm as the third point", () => {
    const [fit] = aggregate.fits.mainHeapUsedMiB;
    expect(fit.historyEntries).toBe(100);
    expect(fit.fit.slope).toBe(2);
    expect(fit.fit.intercept).toBe(0.5);
    const withoutControl = aggregateRun(launches.filter((entry) => entry.arm.bound !== 0));
    expect(withoutControl.fits.mainHeapUsedMiB[0].fit).toBeNull();
  });

  it("counts tripwire self-tests and refusals across every launch", () => {
    expect(aggregate.tripwire).toEqual({
      blocked: [],
      chromiumBlocked: [],
      selfTestsRecorded: 4,
      selfTestsPassed: 4,
      launches: 4,
    });
  });

  it("marks a nearest-rank p95 that is really the maximum", () => {
    const tables = markdownTables(aggregate);
    expect(tables).toContain("| 5 | 100 | 1 |");
    expect(tables).toMatch(/\/ 40\.00† \/ 40\.00 \(3\)/);
    expect(tables).toContain("fewer than 20 samples");
  });

  it("excludes and counts a launch that failed a check", () => {
    const failed = launch(5, 100, 50, { failures: ["something tried to reach the network"] });
    const result = aggregateRun([...launches, failed]);
    expect(result.excludedFailedLaunches).toBe(1);
    expect(result.arms.find((arm) => arm.key === "n5-h100").launches).toBe(1);
    expect(markdownTables(result)).toContain("1 launch(es) failed a check");
  });

  it("flags an arm whose binding census disagrees", () => {
    const bad = launch(5, 10, 1);
    bad.bindings.after.live = 4;
    expect(aggregateRun([bad]).arms[0].boundVerified).toBe(false);
  });

  it("re-derives latency without the launches a loaded host distorted", () => {
    const quiet = launch(5, 100, 10);
    const busy = launch(5, 100, 12, {
      host: { before: { loadavg: [30] }, after: { loadavg: [9] } },
    });
    const sensitive = aggregateRun([quiet, busy], { loadThreshold: 12 });
    expect(sensitive.hostLoad.launchLoad1m.max).toBe(30);
    expect(sensitive.lowLoad.launchesKept).toBe(1);
    expect(sensitive.lowLoad.launchesDropped).toBe(1);
    expect(sensitive.lowLoad.arms[0].heapUsedDeltaMiB.median).toBe(10);
    expect(aggregateRun([quiet]).lowLoad).toBeUndefined();
    expect(markdownTables(sensitive)).toContain("Load sensitivity");
  });
});

import { describe, expect, it } from "vitest";

import {
  acrossLaunches,
  aggregateRun,
  armKey,
  binnedCorrelation,
  linearFit,
  memoryFigures,
} from "./aggregate.mjs";
import { markdownTables } from "./tables.mjs";

const MIB = 1024 * 1024;

function snapshot({ heapUsedMiB, mainKiB, rendererKiB }) {
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
  };
}

function window(gaps, echo) {
  return {
    main: {
      wallMs: 1000,
      mainCpuMs: 50,
      eventLoopDelay: { count: 100, p50Ms: 1.1, p95Ms: 2, maxMs: 9 },
      tickGaps: gaps,
      gc: { count: 1, totalMs: 2, maxMs: 2, entries: [{ epochMs: 0, durationMs: 2, kind: 1 }] },
    },
    renderer: { echo, rpc: echo },
  };
}

function launch(attached, historyEntries, heapDelta, extra = {}) {
  const gaps = [
    [1_000, 10],
    [1_110, 10],
    [1_260, 40],
  ];
  const echo = [
    [995, 0.3, 1],
    [1_105, 0.4, 1],
    [1_225, 30, 1],
    [1_300, 5, 0],
  ];
  return {
    arm: { attached, historyEntries },
    warmup: false,
    bindings: {
      before: { live: 0 },
      after: { live: attached, unexpectedLive: [] },
    },
    sidecarEntries: Array.from({ length: attached }, () => historyEntries),
    sidecarBytes: Array.from({ length: attached }, () => historyEntries * 2_000),
    memory: {
      pre: snapshot({ heapUsedMiB: 100, mainKiB: 200 * 1024, rendererKiB: 150 * 1024 }),
      post: snapshot({
        heapUsedMiB: 100 + heapDelta,
        mainKiB: (200 + heapDelta) * 1024,
        rendererKiB: 150 * 1024,
      }),
    },
    windows: {
      idle: window(gaps, echo),
      hydration: { ...window(gaps, echo), perSession: [{ ms: 12 }] },
      steady: window(gaps, echo),
    },
    tripwire: { blocked: [], chromiumBlocked: [] },
    ...extra,
  };
}

describe("VC-445 aggregation", () => {
  it("names arms and keeps the control apart", () => {
    expect(armKey({ attached: 0, historyEntries: 0 })).toBe("control");
    expect(armKey({ attached: 5, historyEntries: 500 })).toBe("n5-h500");
  });

  it("summarizes per-launch figures as median and range, not a relabelled max", () => {
    expect(acrossLaunches([5, 1, 3, Number.NaN])).toEqual({ n: 3, median: 3, min: 1, max: 5 });
    expect(acrossLaunches([1, 2, 3, 4])).toEqual({ n: 4, median: 2.5, min: 1, max: 4 });
    expect(acrossLaunches([])).toBeNull();
  });

  it("separates main working set from the renderer's, and ignores the GPU process", () => {
    const figures = memoryFigures(snapshot({ heapUsedMiB: 64, mainKiB: 2048, rendererKiB: 1024 }));
    expect(figures.mainWorkingSetMiB).toBe(2);
    expect(figures.rendererWorkingSetMiB).toBe(1);
    expect(figures.mainHeapUsedMiB).toBe(64);
  });

  it("correlates the worst loop gap with the worst echo that started in the same bin", () => {
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
    expect(perfect.bins).toBe(4);
    expect(perfect.pearson).toBe(1);
    expect(binnedCorrelation([[1_020, 10]], [[1_000, 1]])).toEqual({ bins: 1, pearson: null });
  });

  it("fits a straight line", () => {
    expect(
      linearFit([
        [0, 1],
        [1, 3],
        [2, 5],
      ]),
    ).toEqual({ n: 3, slope: 2, intercept: 1, r2: 1 });
    expect(linearFit([[1, 1]])).toBeNull();
  });

  it("aggregates arms, excludes warm-ups and failed IPC samples, and fits per-context cost", () => {
    const launches = [
      launch(0, 0, 0.5),
      launch(1, 100, 2.5),
      launch(5, 100, 10.5),
      launch(5, 100, 999, { warmup: true }),
    ];
    const aggregate = aggregateRun(launches);
    expect(aggregate.arms.map((arm) => arm.key)).toEqual(["control", "n1-h100", "n5-h100"]);
    const five = aggregate.arms.find((arm) => arm.key === "n5-h100");
    expect(five.launches).toBe(1);
    expect(five.boundVerified).toBe(true);
    expect(five.memory.mainHeapUsedMiB.delta.median).toBe(10.5);
    expect(five.memory.rendererWorkingSetMiB.delta.median).toBe(0);
    expect(five.windows.steady.ipcEchoMs.n).toBe(3);
    expect(five.windows.steady.ipcFailures).toBe(2);
    expect(five.windows.steady.tickGapMs.max).toBe(40);
    expect(five.hydrationPerSessionMs.n).toBe(1);
    const [fit] = aggregate.fits.mainHeapUsedMiB;
    expect(fit.historyEntries).toBe(100);
    expect(fit.fit.slope).toBe(2);
    expect(markdownTables({ ...aggregate })).toContain("| 5 | 100 | 1 |");
  });

  it("flags an arm whose binding census disagrees", () => {
    const bad = launch(5, 10, 1);
    bad.bindings.after.live = 4;
    expect(aggregateRun([bad]).arms[0].boundVerified).toBe(false);
  });
});

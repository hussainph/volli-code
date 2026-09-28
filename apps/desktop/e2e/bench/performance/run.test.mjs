import { readFile, rm, mkdtemp } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { busyLoadName } from "./background-load.mjs";
import {
  addNullableMeasurements,
  aggregateInteraction,
  backgroundLoadGap,
  INTERACTION_IDS,
  markdown,
  parseArgs,
  summarize,
  summaryReport,
  validateBenchmarkReport,
  writeReports,
  validateChatBenchReport,
} from "./run.mjs";

function streamSample(overrides = {}) {
  return {
    ok: true,
    steps: 120,
    tokenRate: 30,
    streamedWhileWorking: true,
    streamedWhileTurnActive: true,
    codeFenceOpened: true,
    codeFenceClosed: true,
    // A sample only counts if the growing fence was actually mounted and
    // highlighted; Streamdown defers offscreen code, so a probe that measured
    // nothing would otherwise look perfect.
    liveCodeBlocks: 1,
    liveHighlightedCodeBlocks: 1,
    liveHighlightedTokens: 42,
    settledCodeBlocks: 1,
    settledHighlightedCodeBlocks: 1,
    settledHighlightedTokens: 64,
    resizeObserverCallbacks: 12,
    settleLatencyMs: 5,
    settleLongTasksMs: [],
    latencyMs: 10,
    frameTimesMs: [16, 17],
    droppedFrames: 0,
    longTasksMs: [],
    rendererRssMb: 100,
    ...overrides,
  };
}

function chatReport(overrides = {}) {
  return {
    steps: [{ step: "empty", nodes: 1 }],
    checks: {
      firstTurn: { reached: true, steps: 2 },
      tail: { pinnedGapAfter: 0, releasedOffsetBefore: 20, releasedOffsetAfter: 20 },
    },
    errors: [],
    streamingSamples: [streamSample(), streamSample({ latencyMs: 20 })],
    ...overrides,
  };
}

function benchmarkReport(overrides = {}) {
  const chat = chatReport();
  const interaction = aggregateInteraction(
    "stream_scroll",
    "Simultaneous streaming and scrolling",
    chat.streamingSamples,
  );
  return {
    schemaVersion: 2,
    warning: "same-machine only",
    generatedAt: "2026-09-13T00:00:00.000Z",
    host: {
      git: { sha: "abc123", dirty: false },
      device: {
        model: "TestMac",
        cpu: "Test CPU",
        logicalCores: 8,
        memoryBytes: 16 * 2 ** 30,
      },
      os: { macosVersion: "26.5", macosBuild: "25F90" },
    },
    fixture: {
      preset: "small",
      seed: 353,
      counts: { sessions: 10, sessionEvents: 100, tickets: 4 },
    },
    config: {
      repetitions: 2,
      busyCores: 2,
      loadDurationSeconds: 60,
      streamSteps: 120,
      streamTokenRate: 30,
      streamOnly: true,
      arms: ["idle"],
    },
    arms: [
      {
        name: "idle",
        busyCores: 0,
        interactions: [interaction],
        chatWindow: {
          steps: chat.steps,
          checks: chat.checks,
          errors: chat.errors,
        },
        rendererErrors: [],
      },
    ],
    backgroundLoadGap: null,
    ...overrides,
  };
}

function twoArmBenchmarkReport() {
  const report = benchmarkReport();
  const loaded = structuredClone(report.arms[0]);
  loaded.name = busyLoadName(2, 60_000);
  loaded.busyCores = 2;
  loaded.load = {
    configuredDurationMs: 60_000,
    exposureDurationMs: 50,
    measurementsDurationMs: 25,
    completion: "quick-smoke-early-stop",
  };
  report.config.arms = ["idle", "loaded"];
  report.arms.push(loaded);
  return report;
}

describe("performance benchmark argument parsing", () => {
  it("parses the fixed load contract", () => {
    const parsed = parseArgs([
      "--preset",
      "small",
      "--seed",
      "42",
      "--repetitions",
      "4",
      "--busy-cores",
      "3",
      "--load-duration-seconds",
      "90",
      "--arms",
      "loaded",
      "--stream-steps",
      "40",
      "--stream-token-rate",
      "12.5",
      "--stream-only",
      "--skip-build",
    ]);

    expect(parsed).toMatchObject({
      preset: "small",
      seed: 42,
      repetitions: 4,
      busyCores: 3,
      loadDurationSeconds: 90,
      arms: ["loaded"],
      streamSteps: 40,
      streamTokenRate: 12.5,
      streamOnly: true,
      skipBuild: true,
    });
  });

  it.each([
    [["--repetitions", "1"], "--repetitions"],
    [["--busy-cores", "0"], "--busy-cores"],
    [["--load-duration-seconds", "0"], "--load-duration-seconds"],
    [["--stream-steps", "1"], "--stream-steps"],
    [["--stream-token-rate", "0"], "--stream-token-rate"],
    [["--arms", "idle,idle"], "without duplicates"],
    [["--arms", ""], "--arms accepts"],
    [["--seed"], "requires a value"],
  ])("rejects invalid CLI input %#", (argv, message) => {
    expect(() => parseArgs(argv)).toThrow(message);
  });
});

describe("performance benchmark statistics", () => {
  it("reports nearest-rank tails and population variance", () => {
    expect(summarize(Array.from({ length: 20 }, (_value, index) => index + 1))).toEqual({
      n: 20,
      min: 1,
      p50: 10,
      p95: 19,
      max: 20,
      mean: 10.5,
      variance: 33.25,
    });
  });

  it("ignores unavailable measurements and refuses an empty summary", () => {
    expect(summarize([null, Number.NaN, 4, 8])).toMatchObject({ n: 2, p50: 4, p95: 8 });
    expect(summarize([null, Number.NaN])).toBeNull();
  });

  it("aggregates frames and long tasks without inventing missing counts", () => {
    const aggregate = aggregateInteraction("sample", "Sample", [
      {
        latencyMs: 0,
        droppedFrames: null,
        frameTimesMs: [10, 20],
        longTasksMs: [55],
      },
      {
        latencyMs: 10,
        droppedFrames: null,
        frameTimesMs: [30],
      },
    ]);

    expect(aggregate.summary.latencyMs).toMatchObject({ n: 2, min: 0, p50: 0, p95: 10 });
    expect(aggregate.summary.frameTimeMs).toMatchObject({ n: 3, p50: 20, p95: 30 });
    expect(aggregate.summary.droppedFrames).toBeNull();
    expect(aggregate.summary.longTasks).toEqual({
      observedCount: 1,
      countPerSample: {
        n: 1,
        min: 1,
        p50: 1,
        p95: 1,
        max: 1,
        mean: 1,
        variance: 0,
      },
      durationMs: {
        n: 1,
        min: 55,
        p50: 55,
        p95: 55,
        max: 55,
        mean: 55,
        variance: 0,
      },
    });
  });

  it("keeps a sidebar total unknown when either phase is unknown", () => {
    expect(addNullableMeasurements(null, null)).toBeNull();
    expect(addNullableMeasurements(2, null)).toBeNull();
    expect(addNullableMeasurements(0, 3)).toBe(3);
  });

  it("renders unavailable dropped-frame data as a dash, never a false zero", () => {
    const report = benchmarkReport();
    report.arms[0].interactions[0] = aggregateInteraction(
      "stream_scroll",
      "Simultaneous streaming and scrolling",
      [streamSample({ droppedFrames: null }), streamSample({ droppedFrames: null, latencyMs: 20 })],
    );

    expect(report.arms[0].interactions[0].summary.droppedFrames).toBeNull();
    expect(markdown(report)).toContain(
      "| idle | Simultaneous streaming and scrolling | 10 ms | 20 ms | 25 ms² | 17 ms | — | 0 | 100 MB |",
    );
  });
});

const gapInteraction = (id, p50, p95) => ({
  id,
  label: id,
  summary: { latencyMs: p50 === null ? null : { p50, p95 } },
});

describe("background-load gap", () => {
  it("reports deltas and preserves undefined zero-denominator ratios", () => {
    const gap = backgroundLoadGap([
      {
        name: "idle",
        busyCores: 0,
        interactions: [gapInteraction("zero", 0, 0), gapInteraction("a", 10, 20)],
      },
      {
        name: "2-busy",
        busyCores: 2,
        interactions: [gapInteraction("zero", 5, 7), gapInteraction("a", 15, 50)],
      },
    ]);

    expect(gap).toEqual({
      from: "idle",
      to: "2-busy",
      interactions: [
        {
          id: "zero",
          label: "zero",
          p50DeltaMs: 5,
          p50Ratio: null,
          p95DeltaMs: 7,
          p95Ratio: null,
        },
        {
          id: "a",
          label: "a",
          p50DeltaMs: 5,
          p50Ratio: 1.5,
          p95DeltaMs: 30,
          p95Ratio: 2.5,
        },
      ],
    });
  });

  it("returns no comparison for a missing arm and skips null summaries", () => {
    expect(backgroundLoadGap([{ name: "idle", busyCores: 0, interactions: [] }])).toBeNull();
    expect(
      backgroundLoadGap([
        { name: "idle", busyCores: 0, interactions: [gapInteraction("a", null, null)] },
        { name: "loaded", busyCores: 1, interactions: [gapInteraction("a", 5, 8)] },
      ]).interactions,
    ).toEqual([]);
  });
});

describe("ChatPlane report validation", () => {
  it("accepts a complete healthy report", () => {
    expect(
      validateChatBenchReport(chatReport(), {
        expectedSamples: 2,
        expectedSteps: 120,
        requireCodeFence: true,
      }),
    ).toBeTruthy();
  });

  it.each([
    [
      () =>
        chatReport({ errors: ["Uncaught TypeError: Cannot convert object to primitive value"] }),
      "Cannot convert object to primitive value",
    ],
    [
      () => chatReport({ errors: ["Should not already be working."] }),
      "Should not already be working",
    ],
    [() => chatReport({ checks: { firstTurn: { reached: false } } }), "firstTurn.reached"],
    [
      () =>
        chatReport({
          checks: { firstTurn: { reached: true }, secondary: { ok: false } },
        }),
      "checks.secondary.ok",
    ],
    [() => chatReport({ streamingSamples: [streamSample()] }), "1 streaming samples"],
    [
      () => chatReport({ streamingSamples: [streamSample({ ok: false }), streamSample()] }),
      "streamingSamples[0] failed",
    ],
    [
      () =>
        chatReport({
          streamingSamples: [streamSample({ streamedWhileWorking: false }), streamSample()],
        }),
      "working state",
    ],
    [
      () =>
        chatReport({
          streamingSamples: [streamSample({ codeFenceClosed: false }), streamSample()],
        }),
      "default code fence",
    ],
  ])("rejects an invalid report %#", (create, message) => {
    expect(() =>
      validateChatBenchReport(create(), {
        expectedSamples: 2,
        expectedSteps: 120,
        requireCodeFence: true,
      }),
    ).toThrow(message);
  });

  it("does not require fence completion for a non-default quick smoke", () => {
    const report = chatReport({
      streamingSamples: [
        streamSample({ steps: 2, codeFenceOpened: false, codeFenceClosed: false }),
        streamSample({ steps: 2, codeFenceOpened: false, codeFenceClosed: false }),
      ],
    });
    expect(() =>
      validateChatBenchReport(report, {
        expectedSamples: 2,
        expectedSteps: 2,
        requireCodeFence: false,
      }),
    ).not.toThrow();
  });
});

describe("whole-report validation and Markdown", () => {
  /**
   * VC-385 — `--interactions` is the supported way to measure one interaction
   * without paying for the other eight (about nineteen minutes an arm). The
   * run itself honoured the flag; validation did not, and rejected the report
   * it had just produced for containing exactly what was asked for. A filtered
   * run that cannot write its report is a flag that does not work.
   */
  it("accepts a run that measured only the interactions it was asked for", () => {
    const report = benchmarkReport();
    report.config.streamOnly = false;
    report.config.interactions = ["ticket_switch"];
    report.arms[0].interactions = [
      aggregateInteraction("ticket_switch", "Switch between ticket workspaces", [
        streamSample({ latencyMs: 120 }),
        streamSample({ latencyMs: 140 }),
      ]),
    ];
    report.arms[0].chatWindow = null;

    expect(validateBenchmarkReport(report)).toBe(report);
  });

  it("accepts zero latency samples and renders the report contract", () => {
    const report = benchmarkReport();
    report.arms[0].interactions[0] = aggregateInteraction(
      "stream_scroll",
      "Simultaneous streaming and scrolling",
      [streamSample({ latencyMs: 0 }), streamSample({ latencyMs: 10 })],
    );
    expect(validateBenchmarkReport(report)).toBe(report);

    const output = markdown(report);
    expect(output).toContain("# Desktop performance baseline");
    expect(output).toContain("Loaded-arm contract: 2 busy cores for a fixed 60 seconds.");
    expect(output).toContain("Simultaneous streaming and scrolling");
    expect(output).toContain("N-busy-core-for-60s");
  });

  /**
   * VC-385 — `docs/performance-benchmark.md` makes the Markdown the only
   * committed artifact, so it has to be self-describing: none of the JSON is
   * kept. A narrowed run's report was not. It named neither the interaction
   * filter it ran under nor the way its load actually ended, and its Method
   * section asserted a full fixed-duration exposure that a narrowed arm never
   * receives — three claims a reader had no way to check and one that was
   * simply false.
   */
  it("states the interaction filter and the real load ending on a narrowed run", () => {
    const report = benchmarkReport();
    report.config.streamOnly = false;
    report.config.interactions = ["ticket_switch"];
    report.config.arms = ["loaded"];
    const name = busyLoadName(2, 60_000);
    report.arms[0] = {
      ...report.arms[0],
      name,
      busyCores: 2,
      interactions: [
        aggregateInteraction("ticket_switch", "Switch between ticket workspaces", [
          streamSample({ latencyMs: 120 }),
          streamSample({ latencyMs: 140 }),
        ]),
      ],
      chatWindow: null,
      load: {
        configuredDurationMs: 60_000,
        exposureDurationMs: 9_000,
        measurementsDurationMs: 8_500,
        completion: "narrowed-interactions-early-stop",
      },
    };

    const output = markdown(report);

    // The filter, so a reader knows this report covers one interaction.
    expect(output).toContain("Interactions measured: `ticket_switch`");
    // How the load really ended, rather than the contract it did not meet.
    expect(output).toContain("narrowed-interactions-early-stop");
    // And the Method must stop ASSERTING a complete exposure for this run. It
    // may still describe one as the ending a full arm has — that is the point
    // of naming which ending happened — but not as what happened here.
    expect(output).not.toContain("otherwise holds the load until the configured exposure");
    expect(output).toContain("stops as soon as its measurements are done");
    expect(output).toContain("sized to the measurements");
  });

  it("says so plainly when a run measured every interaction", () => {
    const report = benchmarkReport();
    report.config.interactions = INTERACTION_IDS;

    expect(markdown(report)).toContain(`Interactions measured: all ${INTERACTION_IDS.length}`);
  });

  it("rejects missing arms, console errors, zero samples, and null latency", () => {
    const missingArm = benchmarkReport();
    missingArm.config.arms = ["idle", "loaded"];
    expect(() => validateBenchmarkReport(missingArm)).toThrow("benchmark arms differ");

    const rendererError = benchmarkReport();
    rendererError.arms[0].rendererErrors = ["uncaught"];
    expect(() => validateBenchmarkReport(rendererError)).toThrow("console errors");

    const noSamples = benchmarkReport();
    noSamples.arms[0].interactions[0] = aggregateInteraction(
      "stream_scroll",
      "Simultaneous streaming and scrolling",
      [],
    );
    expect(() => validateBenchmarkReport(noSamples)).toThrow("0 samples; expected 2");

    const nullLatency = benchmarkReport();
    nullLatency.arms[0].interactions[0] = aggregateInteraction(
      "stream_scroll",
      "Simultaneous streaming and scrolling",
      [streamSample({ latencyMs: null }), streamSample()],
    );
    expect(() => validateBenchmarkReport(nullLatency)).toThrow("invalid latency");
  });

  it("rejects renderer failures on every arm, not only the first arm", () => {
    const cases = [
      (report) => {
        report.arms[1].rendererErrors = [
          "Uncaught TypeError: Cannot convert object to primitive value",
        ];
      },
      (report) => {
        report.arms[1].chatWindow.errors = ["Should not already be working."];
      },
      (report) => {
        report.arms[1].chatWindow.checks.firstTurn.reached = false;
      },
      (report) => {
        report.arms[1].interactions[0].samples[1].ok = false;
      },
    ];

    for (const breakLoadedArm of cases) {
      const report = twoArmBenchmarkReport();
      breakLoadedArm(report);
      expect(() => validateBenchmarkReport(report)).toThrow();
    }
  });

  it("creates a compact machine-readable summary without raw samples", () => {
    const report = twoArmBenchmarkReport();
    report.backgroundLoadGap = {
      from: "idle",
      to: busyLoadName(2, 60_000),
      interactions: [
        {
          id: "stream_scroll",
          label: "stream",
          p50DeltaMs: 1,
          p50Ratio: 1.1,
          p95DeltaMs: 2,
          p95Ratio: 1.2,
        },
      ],
    };

    const summary = summaryReport(report);
    expect(summary).toMatchObject({
      schemaVersion: 1,
      device: report.host.device,
      macos: { version: "26.5", build: "25F90" },
      build: { sha: "abc123", dirty: false },
      fixture: { preset: "small", seed: 353 },
      backgroundLoad: {
        name: "2-busy-core-for-60s",
        workerCount: 2,
        durationSeconds: 60,
      },
      repetitions: 2,
      armGap: report.backgroundLoadGap,
    });
    expect(summary.arms).toHaveLength(2);
    expect(summary.arms[0].interactions[0].aggregates).toMatchObject({
      latencyMs: { n: 2, min: 10, p50: 10, p95: 20, max: 20, mean: 15, variance: 25 },
      droppedFrames: { n: 2 },
      longTasks: { countPerSample: { n: 2 } },
    });
    expect(JSON.stringify(summary)).not.toMatch(/samples|frameTimesMs|longTasksMs/);
  });

  it("writes the raw, compact, and human-readable report split", async () => {
    const report = benchmarkReport();
    const output = await mkdtemp(join(os.tmpdir(), "vc353-report-test-"));
    try {
      const paths = await writeReports(report, output);
      expect(paths).toMatchObject({
        jsonPath: join(output, "benchmark.json"),
        summaryPath: join(output, "benchmark.summary.json"),
        markdownPath: join(output, "benchmark.md"),
      });
      const summary = JSON.parse(await readFile(paths.summaryPath, "utf8"));
      expect(summary.arms[0].interactions[0].aggregates.latencyMs.n).toBe(2);
      expect(JSON.stringify(summary)).not.toContain("frameTimesMs");
      expect(await readFile(paths.markdownPath, "utf8")).toContain(
        "# Desktop performance baseline",
      );
    } finally {
      await rm(output, { recursive: true, force: true });
    }
  });

  it("requires explicit loaded-arm completion metadata", () => {
    const report = benchmarkReport();
    const name = busyLoadName(2, 60_000);
    report.config.arms = ["loaded"];
    report.arms[0] = {
      ...report.arms[0],
      name,
      busyCores: 2,
      load: {
        configuredDurationMs: 60_000,
        exposureDurationMs: 50,
        measurementsDurationMs: 25,
        completion: "quick-smoke-early-stop",
      },
    };
    expect(validateBenchmarkReport(report)).toBe(report);

    report.arms[0].load.completion = "fixed-duration-complete";
    expect(() => validateBenchmarkReport(report)).toThrow("load ended as");
  });

  /**
   * VC-385 — the loaded arm of a narrowed run.
   *
   * `runArm` stops the busy workers as soon as the wanted interactions are
   * done rather than holding the exposure open for the full configured
   * duration, because a narrowed run has no streaming bench left to cover.
   * Validation only knew the two completions a FULL run can end with, so the
   * loaded arm of `--interactions ticket_switch` measured correctly and then
   * failed on its own load metadata — the same shape of bug as the interaction
   * list and the chat-window report.
   */
  it("accepts a loaded arm that stopped its load early because the run was narrowed", () => {
    const report = benchmarkReport();
    const name = busyLoadName(2, 60_000);
    report.config.streamOnly = false;
    report.config.arms = ["loaded"];
    report.config.interactions = ["ticket_switch"];
    report.arms[0] = {
      ...report.arms[0],
      name,
      busyCores: 2,
      interactions: [
        aggregateInteraction("ticket_switch", "Switch between ticket workspaces", [
          streamSample({ latencyMs: 120 }),
          streamSample({ latencyMs: 140 }),
        ]),
      ],
      chatWindow: null,
      load: {
        configuredDurationMs: 60_000,
        // Both shorter than the configured exposure: the arm ended when the
        // measurements did, which is the whole point of narrowing it.
        exposureDurationMs: 9_000,
        measurementsDurationMs: 8_500,
        completion: "narrowed-interactions-early-stop",
      },
    };

    expect(validateBenchmarkReport(report)).toBe(report);
  });
});

describe("interaction selection", () => {
  it("measures everything when nothing is named", () => {
    expect(parseArgs([]).interactions).toBeUndefined();
  });

  it("takes a comma-separated subset, so a narrow change need not fork this harness", () => {
    // VC-358 only moves "+ Chat to usable composer". It ran as a copy of this
    // file with the list edited down, which is how ~1,000 duplicated lines
    // nearly landed. One flag is the whole difference.
    expect(parseArgs(["--interactions", "new_chat"]).interactions).toEqual(["new_chat"]);
    expect(parseArgs(["--interactions", "new_chat,cold_launch"]).interactions).toEqual([
      "new_chat",
      "cold_launch",
    ]);
  });

  it("refuses an interaction it cannot measure rather than reporting an empty arm", () => {
    expect(() => parseArgs(["--interactions", "new_chat,typo"])).toThrow(/typo/);
  });
});

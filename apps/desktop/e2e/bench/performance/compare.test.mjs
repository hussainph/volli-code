import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  budgetsFrom,
  compareMarkdown,
  compareSummaries,
  comparability,
  DEFAULT_BUDGETS,
  parseCompareArgs,
  readSummary,
} from "./compare.mjs";

function interaction(id, p95, extra = {}) {
  return {
    id,
    label: id,
    aggregates: {
      latencyMs: { n: 2, p50: p95 / 2, p95 },
      frameTimeMs: { p95: 17 },
      droppedFrames: { p95: 0 },
      longTasks: { countPerSample: { p95: 1 } },
      ...extra,
    },
  };
}

function signals({ mainMs = 0, renderer = 0 } = {}) {
  return {
    main: {
      count: mainMs > 0 ? 1 : 0,
      maxMs: mainMs,
      unattributedShare: null,
      msPerRepetition: { p95: mainMs },
    },
    renderer: { count: renderer, maxMs: 0, countPerRepetition: { p95: renderer } },
  };
}

function summary(overrides = {}, interactions, armSignals = signals()) {
  return {
    schemaVersion: 1,
    generatedAt: "2026-11-02T00:00:00.000Z",
    device: { model: "Mac16,1", cpu: "M4" },
    macos: { version: "26.1" },
    build: { sha: "aaaaaaaaaaaa", dirty: false },
    fixture: { preset: "small", seed: 353 },
    backgroundLoad: { name: "2-busy-core-for-60s" },
    repetitions: 4,
    signalConfig: {
      mainStallThresholdMs: 200,
      storm: { sessions: 16, intervalMs: 60, durationMs: 4000 },
    },
    arms: [
      {
        name: "idle",
        busyCores: 0,
        interactions: interactions ?? [
          interaction("board_render", 100),
          interaction("fleet_storm", 4_100),
        ],
        signals: armSignals,
      },
    ],
    ...overrides,
  };
}

describe("benchmark compare", () => {
  it("refuses a pair that is not the same experiment", () => {
    const baseline = summary();
    for (const candidate of [
      summary({ fixture: { preset: "real", seed: 353 } }),
      summary({ fixture: { preset: "small", seed: 1 } }),
      summary({ signalConfig: { ...baseline.signalConfig, mainStallThresholdMs: 50 } }),
      summary({
        signalConfig: {
          ...baseline.signalConfig,
          storm: { sessions: 64, intervalMs: 60, durationMs: 4000 },
        },
      }),
    ]) {
      expect(() => compareSummaries(baseline, candidate)).toThrow(/not the same experiment/);
      const forced = compareSummaries(baseline, candidate, { allowMismatch: true });
      expect(forced.mismatches).toHaveLength(1);
      expect(compareMarkdown(forced)).toContain("Not the same experiment");
    }
  });

  it("warns, but compares, across machines, repetitions and dirty trees", () => {
    const { mismatches, warnings } = comparability(
      summary(),
      summary({
        device: { model: "Mac15,3", cpu: "M3" },
        repetitions: 2,
        build: { sha: "b", dirty: true },
      }),
    );
    expect(mismatches).toEqual([]);
    expect(warnings.join("\n")).toMatch(/device[\s\S]*cpu[\s\S]*repetitions[\s\S]*dirty/);
    expect(comparability(summary(), summary()).warnings).toContain(
      "both runs are the same commit: this is a noise measurement",
    );
  });

  it("flags a latency regression only past both the ratio and the floor", () => {
    const baseline = summary({}, [interaction("board_render", 100), interaction("rpc", 2)]);
    const small = compareSummaries(
      baseline,
      summary({ build: { sha: "b" } }, [interaction("board_render", 110), interaction("rpc", 3)]),
    );
    // +10% on one, +50% but +1 ms on the other: neither is a flag.
    expect(small.regressions).toEqual([]);
    const big = compareSummaries(
      baseline,
      summary({ build: { sha: "b" } }, [interaction("board_render", 140), interaction("rpc", 2)]),
    );
    expect(big.regressions).toEqual([
      "idle / board_render: latency p95 100 → 140 ms (+40 ms, ×1.4)",
    ]);
    expect(big.gating).toBe(false);
    const better = compareSummaries(
      summary({}, [interaction("board_render", 140)]),
      summary({ build: { sha: "b" } }, [interaction("board_render", 100)]),
    );
    expect(better.improvements).toEqual(["idle / board_render: latency p95 140 → 100 ms (-40 ms)"]);
  });

  it("flags stall growth per interaction window and per arm, and absolute ceilings", () => {
    const baseline = summary({}, [
      interaction("workspace_switch", 300, { mainStallMs: { p95: 0 } }),
    ]);
    const candidate = summary(
      { build: { sha: "b" } },
      [interaction("workspace_switch", 300, { mainStallMs: { p95: 450 } })],
      signals({ mainMs: 450, renderer: 3 }),
    );
    const result = compareSummaries(baseline, candidate, {
      budgets: { interactions: { workspace_switch: { maxLatencyP95Ms: 250 } } },
    });
    expect(result.regressions).toEqual([
      "idle: main stall ms per repetition p95 0 → 450",
      "idle: renderer stalls per repetition p95 0 → 3",
      "idle / workspace_switch: latency p95 300 ms is over its 250 ms ceiling",
      "idle / workspace_switch: main stall p95 0 → 450 ms in its window",
    ]);
    const markdown = compareMarkdown(result);
    expect(markdown).toContain("4 regression(s)");
    expect(markdown).toContain("| workspace_switch ⚠ |");
    expect(markdown).toContain("| main stall ms per repetition p95 | 0 → 450 ms (+450 ms) |");
  });

  it("lists what only one run measured instead of comparing it with nothing", () => {
    const result = compareSummaries(
      summary({}, [interaction("board_render", 100), interaction("ticket_switch", 50)]),
      summary({ build: { sha: "b" } }, [
        interaction("board_render", 100),
        interaction("draft_typing", 900),
      ]),
    );
    expect(result.arms[0].interactions.map((entry) => entry.id)).toEqual(["board_render"]);
    expect(result.unmatched).toEqual([
      "idle / draft_typing (candidate only)",
      "idle / ticket_switch (baseline only)",
    ]);
  });

  it("compares a pre-signal summary on latency alone, and says so", () => {
    const old = summary({ signalConfig: undefined });
    delete old.arms[0].signals;
    const result = compareSummaries(old, summary({ build: { sha: "b" } }));
    expect(result.warnings[0]).toMatch(/predates stall signals/);
    expect(result.arms[0].signals).toBeNull();
  });

  it("merges a budget file over the defaults", () => {
    const budgets = budgetsFrom({
      latencyP95Ratio: 1.5,
      interactions: { board_render: { maxLatencyP95Ms: 900 } },
    });
    expect(budgets).toMatchObject({
      latencyP95Ratio: 1.5,
      latencyP95MinDeltaMs: DEFAULT_BUDGETS.latencyP95MinDeltaMs,
      interactions: { board_render: { maxLatencyP95Ms: 900 } },
    });
    expect(() => budgetsFrom([])).toThrow();
  });

  it("reads a run directory or its summary file, and parses its arguments", async () => {
    const directory = await mkdtemp(join(os.tmpdir(), "vc1093-compare-"));
    try {
      await writeFile(join(directory, "benchmark.summary.json"), JSON.stringify(summary()));
      expect((await readSummary(directory)).fixture.preset).toBe("small");
      expect((await readSummary(join(directory, "benchmark.summary.json"))).source).toContain(
        "benchmark.summary.json",
      );
      await writeFile(join(directory, "other.json"), "{}");
      await expect(readSummary(join(directory, "other.json"))).rejects.toThrow(/not a benchmark/);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
    expect(
      parseCompareArgs(["--", "a", "b", "--budgets", "x.json", "--fail-on-regression"]),
    ).toEqual({
      paths: ["a", "b"],
      allowMismatch: false,
      failOnRegression: true,
      budgets: "x.json",
    });
    expect(() => parseCompareArgs(["a"])).toThrow(/exactly two/);
    expect(() => parseCompareArgs(["a", "b", "--nope"])).toThrow(/Unknown/);
  });
});

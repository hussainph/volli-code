import { describe, expect, it } from "vite-plus/test";

import { buildRuntimeCostReport, formatRuntimeCostReport } from "./runtime-cost-report";

describe("agent-runtime cost profile", () => {
  it("reports p50, p95 and variance for every fixture-driven hot path", async () => {
    const profiling = process.env["BENCH_PROFILE"] === "1";
    const report = await buildRuntimeCostReport({
      samples: profiling ? 20 : 5,
      operationScale: profiling ? 20 : 0.2,
    });
    console.log(`\n${formatRuntimeCostReport(report)}\n`);

    expect(report.fixturePreset).toBe("runtime-long-turn-v1");
    expect(report.samples.map((sample) => sample.name)).toEqual([
      "prompt.system-assembly",
      "prompt.first-message-assembly",
      "turn.context-projection-model-switch",
      "tool.activity-normalization",
      "stream.delta-translation",
    ]);
    for (const sample of report.samples) {
      expect(sample.samples).toBe(profiling ? 20 : 5);
      expect(sample.p50Us).toBeGreaterThan(0);
      expect(sample.p95Us).toBeGreaterThanOrEqual(sample.p50Us);
      expect(Number.isFinite(sample.relativeStandardDeviation)).toBe(true);
    }
  });
});

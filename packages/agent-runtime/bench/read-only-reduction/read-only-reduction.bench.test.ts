import { readFileSync } from "node:fs";
import { describe, expect, it } from "vite-plus/test";
import { FIXTURES, TASKS } from "./fixtures";
import {
  barrierNetworkMs,
  buildMcpDecisionSweep,
  modelledAllInOneMs,
  SWEEP_BATCH_SIZES,
  SWEEP_CALLS,
} from "./mcp-decision-sweep";
import { buildReadOnlyReductionReport, type ReductionSummary } from "./report";
import {
  FixtureReader,
  REDUCTION_BOUNDS,
  RunBudget,
  runFixtureTask,
  validateFilterProgram,
} from "./prototype";

function summary(
  rows: readonly ReductionSummary[],
  taskId: ReductionSummary["taskId"],
  lane: ReductionSummary["lane"],
): ReductionSummary {
  const result = rows.find((row) => row.taskId === taskId && row.lane === lane);
  if (result === undefined) throw new Error(`missing benchmark row ${taskId}/${lane}`);
  return result;
}

describe("VC-442 fixture-only read-result reduction prototype", () => {
  it("prints reproducible task-level medians and asserts answer/evidence invariants", async () => {
    const report = await buildReadOnlyReductionReport();
    console.log(`\n${report.text}\n`);

    expect(report.summaries).toHaveLength(Object.keys(TASKS).length * 5);
    expect(report.text).toContain("Selective parallelism, isolated from model rounds");
    expect(report.text).toContain("Per-lane schema setup overhead");
    expect(report.text).toContain("Mock read-only remote/MCP-like latency sensitivity");
    expect(report.latencySensitivity.map((row) => row.latencyMs)).toEqual([50, 250, 900]);
    for (const row of report.latencySensitivity) {
      expect(row.providerRounds).toBe(2);
      expect(row.maxConcurrency).toBe(4);
      expect(row.sameResults).toBe(true);
      expect(row.savedMs).toBeGreaterThan(0);
      // The closed-form decision sweep must describe what the timers measured.
      // Timers only ever fire late, so allow overshoot for a shared machine.
      for (const parallel of [false, true]) {
        const modelled = modelledAllInOneMs(row.latencyMs, row.reads, 35, parallel);
        const measured = parallel ? row.parallelMs : row.sequentialMs;
        expect(measured).toBeGreaterThanOrEqual(modelled - 1);
        expect(measured).toBeLessThanOrEqual(modelled * 1.1 + 25);
      }
    }
    expect(report.mcpDecision).toHaveLength(buildMcpDecisionSweep().length);
    expect(report.text).toContain("MCP-like decision sweep");
    for (const row of report.summaries) {
      expect(row.correct, `${row.taskId}/${row.lane} answer`).toBe(true);
      expect(row.retainedEvidence, `${row.taskId}/${row.lane} evidence`).toBe(row.evidenceCount);
      expect(row.retries, `${row.taskId}/${row.lane} retries`).toBe(0);
      expect(row.providerRounds).toBeGreaterThan(0);
      expect(row.inputTokens).toBeGreaterThanOrEqual(row.resultTokens);
      expect(row.resultBytes).toBeLessThanOrEqual(REDUCTION_BOUNDS.maxRunResultBytes);
      expect(row.historyMessages).toBeGreaterThan(row.toolCalls);
    }

    const directMulti = summary(report.summaries, "independent-multi-read", "direct-sequential");
    const parallelMulti = summary(
      report.summaries,
      "independent-multi-read",
      "safe-batch-parallel",
    );
    expect(directMulti.providerRounds).toBe(4);
    expect(parallelMulti.providerRounds).toBe(2);
    expect(parallelMulti.maxConcurrency).toBe(3);

    const serialBatch = summary(report.summaries, "dependent-loop-filter", "safe-batch-serial");
    const parallelBatch = summary(report.summaries, "dependent-loop-filter", "safe-batch-parallel");
    expect(serialBatch.providerRounds).toBe(parallelBatch.providerRounds);
    expect(serialBatch.inputTokens).toBe(parallelBatch.inputTokens);
    expect(serialBatch.resultBytes).toBe(parallelBatch.resultBytes);
    expect(parallelBatch.maxConcurrency).toBe(3);

    const noisyDirect = summary(report.summaries, "noisy-large-output", "direct-sequential");
    const noisyFilter = summary(report.summaries, "noisy-large-output", "filter-program");
    expect(noisyFilter.resultBytes).toBeLessThan(noisyDirect.resultBytes / 10);
    expect(noisyFilter.inputTokens).toBeLessThan(noisyDirect.inputTokens);
  }, 120_000);

  it("accepts only a closed literal filter AST with exact fixture paths", () => {
    const valid = validateFilterProgram({
      version: 1,
      operation: "select-lines",
      paths: ["/fixture/noisy.log"],
      containsAny: ["level=critical"],
      maxMatches: 3,
    });
    expect(valid.maxMatches).toBe(3);

    expect(() =>
      validateFilterProgram({
        version: 1,
        operation: "select-lines",
        paths: ["/fixture/noisy.log"],
        containsAny: ["level=critical"],
        maxMatches: 3,
        code: "process.env",
      }),
    ).toThrow(/closed object/);
    expect(() =>
      validateFilterProgram({
        version: 1,
        operation: "execute-code",
        paths: ["/fixture/noisy.log"],
        containsAny: ["secret"],
        maxMatches: 1,
      }),
    ).toThrow(/unsupported/);
    expect(() =>
      validateFilterProgram({
        version: 1,
        operation: "select-lines",
        paths: ["/fixture/../secret.txt"],
        containsAny: ["secret"],
        maxMatches: 1,
      }),
    ).toThrow(/outside the fixture capability/);
    expect(() =>
      validateFilterProgram({
        version: 1,
        operation: "select-lines",
        paths: Array.from(
          { length: REDUCTION_BOUNDS.maxPathsPerCall + 1 },
          () => "/fixture/noisy.log",
        ),
        containsAny: ["level=critical"],
        maxMatches: 3,
      }),
    ).toThrow(/between 1 and/);
    expect(() =>
      validateFilterProgram({
        version: 1,
        operation: "select-lines",
        paths: ["/fixture/noisy.log"],
        containsAny: Array.from({ length: REDUCTION_BOUNDS.maxFilterTerms + 1 }, () => "error"),
        maxMatches: 3,
      }),
    ).toThrow(/containsAny/);
    expect(() =>
      validateFilterProgram({
        version: 1,
        operation: "select-lines",
        paths: ["/fixture/noisy.log"],
        containsAny: ["x".repeat(REDUCTION_BOUNDS.maxFilterTermChars + 1)],
        maxMatches: 3,
      }),
    ).toThrow(/at most/);
    expect(() =>
      validateFilterProgram({
        version: 1,
        operation: "select-lines",
        paths: ["/fixture/noisy.log"],
        containsAny: ["level=critical"],
        maxMatches: REDUCTION_BOUNDS.maxFilterMatches + 1,
      }),
    ).toThrow(/maxMatches/);
  });

  it("keeps batch result order deterministic and observes cancellation without retry", async () => {
    const result = await runFixtureTask("independent-multi-read", "safe-batch-parallel");
    expect(result.resultOrder).toEqual(["call-1", "call-2", "call-3"]);
    expect(result.maxConcurrency).toBeLessThanOrEqual(REDUCTION_BOUNDS.maxPathsPerCall);
    expect(result.nestedReads).toBe(3);
    expect(result.retries).toBe(0);

    const cancellation = new AbortController();
    cancellation.abort(new Error("test cancellation"));
    await expect(
      runFixtureTask("noisy-large-output", "direct-sequential", { signal: cancellation.signal }),
    ).rejects.toThrow("test cancellation");
  });

  it("keeps the noisy fixture and every returned result within explicit byte bounds", () => {
    const fixtureBytes = new TextEncoder().encode(FIXTURES["/fixture/noisy.log"]).byteLength;
    expect(fixtureBytes).toBeLessThan(REDUCTION_BOUNDS.maxToolResultBytes);
    for (const fixture of Object.values(FIXTURES)) {
      expect(new TextEncoder().encode(fixture).byteLength).toBeLessThanOrEqual(
        REDUCTION_BOUNDS.maxToolResultBytes,
      );
    }
  });

  it("enforces call, read, byte, time and scan budgets at run time", async () => {
    await expect(
      runFixtureTask("independent-multi-read", "safe-batch-parallel", {
        limits: { maxToolCalls: 2 },
      }),
    ).rejects.toThrow(/tool-call budget/);
    await expect(
      runFixtureTask("independent-multi-read", "fixed-read-many", {
        limits: { maxNestedReads: 2 },
      }),
    ).rejects.toThrow(/nested-read budget/);
    await expect(
      runFixtureTask("noisy-large-output", "direct-sequential", {
        limits: { maxToolResultBytes: 1_024 },
      }),
    ).rejects.toThrow(/per-read byte budget/);
    await expect(
      runFixtureTask("independent-multi-read", "direct-sequential", {
        limits: { maxRunResultBytes: 150 },
      }),
    ).rejects.toThrow(/byte budget/);
    await expect(
      runFixtureTask("dependent-loop-filter", "direct-sequential", { limits: { maxTaskMs: 20 } }),
    ).rejects.toThrow(/time budget/);
    await expect(
      runFixtureTask("noisy-large-output", "filter-program", {
        limits: { maxFilterLinesScanned: 100 },
      }),
    ).rejects.toThrow(/line-scan budget/);

    // The reader refuses anything outside the exact fixture keys, before any read.
    const budget = new RunBudget();
    const reader = new FixtureReader(budget, new AbortController().signal);
    await expect(reader.read("/etc/passwd")).rejects.toThrow(/outside the fixture capability/);
    await expect(reader.read("/fixture/../fixture/team.txt")).rejects.toThrow(/outside/);
    await expect(reader.readMany(["/fixture/team.txt", "/fixture/team.txt"], true)).rejects.toThrow(
      /repeat/,
    );
    expect(budget.nestedReads).toBe(0);
  });

  it("gives the prototype no shell, filesystem, network, env or dynamic-code capability", () => {
    for (const file of ["prototype.ts", "fixtures.ts", "mcp-decision-sweep.ts"]) {
      const source = readFileSync(new URL(`./${file}`, import.meta.url), "utf8");
      const imports = [...source.matchAll(/^import[^;]*?from\s+"([^"]+)"/gms)].map(
        (match) => match[1],
      );
      for (const specifier of imports) {
        expect(
          ["gpt-tokenizer/encoding/cl100k_base", "./fixtures"],
          `${file} imports ${specifier}`,
        ).toContain(specifier);
      }
      for (const forbidden of [
        /\bprocess\./,
        /\brequire\(/,
        /\bimport\(/,
        /\beval\(/,
        /\bnew Function\b/,
        /\bfetch\(/,
        /\bWebSocket\b/,
        /\bchild_process\b/,
        /\bnode:/,
      ]) {
        expect(source, `${file} must not match ${forbidden}`).not.toMatch(forbidden);
      }
    }
  });

  it("models how batching propensity, network wait, output volume and barriers move the decision", () => {
    const rows = buildMcpDecisionSweep();
    const pick = (latencyMs: number, batchSize: number, providerRoundMs = 35, bytes = 512) =>
      rows.find(
        (row) =>
          row.latencyMs === latencyMs &&
          row.batchSize === batchSize &&
          row.providerRoundMs === providerRoundMs &&
          row.outputBytesPerCall === bytes,
      )!;

    // Propensity: a model that never batches gets nothing from parallel dispatch.
    for (const latency of [50, 250, 900]) expect(pick(latency, 1).savedMs).toBe(0);
    // Network wait: the saving is (calls - replies) x wait, so it grows with latency.
    expect(pick(900, 4).savedMs).toBe((SWEEP_CALLS - 1) * 900);
    expect(pick(250, 2).savedMs).toBe(2 * 250);
    expect(pick(50, 4).savedMs).toBeLessThan(pick(900, 4).savedMs);
    // Slow real-model rounds dilute the share, not the absolute saving.
    expect(pick(250, 4, 2_000).savedMs).toBe(pick(250, 4, 35).savedMs);
    expect(pick(250, 4, 2_000).savedPercent).toBeLessThan(pick(250, 4, 35).savedPercent);

    // Output volume: dispatch mode cannot change context; fewer batches cost more.
    const small = pick(50, 4, 35, 512);
    const large = pick(50, 4, 35, 16_384);
    expect(large.resultTokensPerCall).toBeGreaterThan(small.resultTokensPerCall * 10);
    for (const bytes of [512, 16_384]) {
      const tokens = SWEEP_BATCH_SIZES.map((batch) => pick(50, batch, 35, bytes).inputTokens);
      expect(tokens).toEqual(tokens.toSorted((left, right) => left - right));
    }

    // Correctness: a write/approval barrier keeps order and costs overlap.
    expect(barrierNetworkMs(100, 0)).toBe(200);
    expect(barrierNetworkMs(100, 1)).toBe(300);
    expect(barrierNetworkMs(100, SWEEP_CALLS - 1)).toBe(200);
    expect(() => barrierNetworkMs(100, SWEEP_CALLS)).toThrow(/barrier index/);
  });
});

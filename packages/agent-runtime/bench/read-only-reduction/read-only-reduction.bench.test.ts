import { readFileSync } from "node:fs";
import { describe, expect, it } from "vite-plus/test";
import {
  FIXTURES,
  MOCK_CALL_LATENCIES_MS,
  SCRIPTED_PROVIDER_ROUND_MS,
  TASKS,
  type FixturePath,
} from "./fixtures";
import {
  barrierNetworkMs,
  buildMcpDecisionSweep,
  SWEEP_BATCH_SIZES,
  SWEEP_CALLS,
} from "./mcp-decision-sweep";
import { buildReadOnlyReductionReport, type ReductionSummary } from "./report";
import {
  FixtureReader,
  READ_ONLY_REDUCTION_LANES,
  REDUCTION_BOUNDS,
  RunBudget,
  runFixtureTask,
  validateFilterProgram,
  type NestedReadEvent,
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const noisy = "/fixture/noisy.log";
const filter = (overrides: Record<string, unknown>): Record<string, unknown> => ({
  version: 1,
  operation: "select-lines",
  paths: [noisy],
  containsAny: ["level=critical"],
  maxMatches: 3,
  ...overrides,
});

describe("VC-442 fixture-only read-result reduction prototype", () => {
  it("prints reproducible task-level medians and asserts answer/evidence invariants", async () => {
    const report = await buildReadOnlyReductionReport();
    console.log(`\n${report.text}\n`);

    expect(report.summaries).toHaveLength(
      Object.keys(TASKS).length * READ_ONLY_REDUCTION_LANES.length,
    );
    for (const row of report.summaries) {
      expect(row.correct, `${row.taskId}/${row.lane} answer`).toBe(true);
      expect(row.retainedEvidence, `${row.taskId}/${row.lane} evidence`).toBe(row.evidenceCount);
      expect(row.historyMessages).toBeGreaterThan(row.toolCalls);
    }

    const directMulti = summary(report.summaries, "independent-multi-read", "direct-sequential");
    const serialMulti = summary(report.summaries, "independent-multi-read", "safe-batch-serial");
    const parallelMulti = summary(
      report.summaries,
      "independent-multi-read",
      "safe-batch-parallel",
    );
    expect(directMulti.providerRounds).toBe(4);
    expect(parallelMulti.providerRounds).toBe(2);
    expect(serialMulti.maxConcurrency).toBe(1);
    expect(parallelMulti.maxConcurrency).toBe(3);

    const serialBatch = summary(report.summaries, "dependent-loop-filter", "safe-batch-serial");
    const parallelBatch = summary(report.summaries, "dependent-loop-filter", "safe-batch-parallel");
    expect(serialBatch.providerRounds).toBe(parallelBatch.providerRounds);
    expect(serialBatch.inputTokens).toBe(parallelBatch.inputTokens);
    expect(serialBatch.resultBytes).toBe(parallelBatch.resultBytes);
    expect(serialBatch.maxConcurrency).toBe(1);
    expect(parallelBatch.maxConcurrency).toBe(3);
    // The index-following filter removes the round every other lane spends
    // learning the shard paths.
    const dependentFilter = summary(report.summaries, "dependent-loop-filter", "filter-program");
    expect(dependentFilter.providerRounds).toBe(serialBatch.providerRounds - 1);
    expect(dependentFilter.toolCalls).toBe(1);

    const noisyDirect = summary(report.summaries, "noisy-large-output", "direct-sequential");
    const noisyFilter = summary(report.summaries, "noisy-large-output", "filter-program");
    expect(noisyFilter.resultBytes).toBeLessThan(noisyDirect.resultBytes / 10);
    expect(noisyFilter.inputTokens).toBeLessThan(noisyDirect.inputTokens);

    // The measured MCP-like sweep: the turn model must describe what timers did.
    // Timers fire late by a bounded amount each, never proportionally, so the
    // band is per timer: rounds + (sequential calls | parallel replies).
    expect(report.measuredLatency.map((row) => row.batchSize)).toEqual([4, 4, 4, 2, 2, 1, 1]);
    for (const row of report.measuredLatency) {
      expect(row.orderedResults).toBe(true);
      expect(row.maxConcurrency).toBe(row.batchSize);
      if (row.batchSize > 1) expect(row.completionDiffered).toBe(true);
      const replies = row.providerRounds - 1;
      for (const [measured, modelled, timers] of [
        [row.sequentialMs, row.modelSequentialMs, row.providerRounds + row.calls],
        [row.parallelMs, row.modelParallelMs, row.providerRounds + replies],
      ] as const) {
        expect(measured).toBeGreaterThanOrEqual(modelled - 2);
        expect(measured).toBeLessThanOrEqual(modelled + timers * 6 + 10);
      }
    }
    expect(report.mcpDecision).toHaveLength(buildMcpDecisionSweep().length);
  }, 180_000);

  it("accepts only a closed literal filter AST with exact fixture sources", () => {
    expect(validateFilterProgram(filter({})).maxMatches).toBe(3);
    const { paths: _paths, ...noSource } = filter({});
    const indexed = { ...noSource, indexPath: "/fixture/index.json" };
    expect(validateFilterProgram(indexed).indexPath).toBe("/fixture/index.json");

    const rejects: [Record<string, unknown> | null, RegExp][] = [
      [null, /closed object/],
      [filter({ code: "process.env" }), /closed object/],
      [filter({ operation: "execute-code" }), /unsupported/],
      [filter({ version: "1" }), /unsupported/],
      [noSource, /exactly one source/],
      [{ ...indexed, paths: [noisy] }, /exactly one source/],
      [{ ...indexed, indexPath: "/etc/passwd" }, /outside the fixture capability/],
      [filter({ paths: ["/fixture/../secret.txt"] }), /outside the fixture capability/],
      [filter({ paths: [] }), /between 1 and/],
      [
        filter({
          paths: Array.from({ length: REDUCTION_BOUNDS.maxPathsPerCall + 1 }, () => noisy),
        }),
        /between 1 and/,
      ],
      [
        filter({
          containsAny: Array.from({ length: REDUCTION_BOUNDS.maxFilterTerms + 1 }, () => "x"),
        }),
        /containsAny/,
      ],
      [filter({ containsAny: ["   "] }), /non-empty/],
      [filter({ containsAny: [42] }), /non-empty/],
      [filter({ containsAny: ["x".repeat(REDUCTION_BOUNDS.maxFilterTermChars + 1)] }), /at most/],
      [filter({ maxMatches: 0 }), /maxMatches/],
      [filter({ maxMatches: 1.5 }), /maxMatches/],
      [filter({ maxMatches: REDUCTION_BOUNDS.maxFilterMatches + 1 }), /maxMatches/],
    ];
    for (const [input, error] of rejects) {
      expect(() => validateFilterProgram(input), JSON.stringify(input)).toThrow(error);
    }
  });

  it("commits parallel results in call order even when reads finish out of order", async () => {
    // The first call is slowest, so completion order is the reverse of call order.
    const readLatencyMs: Partial<Record<FixturePath, number>> = {
      "/fixture/service.md": 40,
      "/fixture/deploy.md": 20,
      "/fixture/runbook.md": 2,
    };
    const result = await runFixtureTask("independent-multi-read", "safe-batch-parallel", {
      readLatencyMs,
    });
    expect(result.completionOrder).toEqual([
      "/fixture/runbook.md",
      "/fixture/deploy.md",
      "/fixture/service.md",
    ]);
    expect(result.resultOrder).toEqual(["call-1", "call-2", "call-3"]);
    expect(result.maxConcurrency).toBe(3);
    expect(result.correct).toBe(true);
    // Every nested read is observable, one start and one end each.
    expect(result.readEvents.filter((event) => event.kind === "read-start")).toHaveLength(3);
    expect(result.readEvents.filter((event) => event.kind === "read-end")).toHaveLength(3);
  });

  it("propagates caller cancellation mid-run and cancels siblings when a run fails", async () => {
    const already = new AbortController();
    already.abort(new Error("test cancellation"));
    await expect(
      runFixtureTask("noisy-large-output", "direct-sequential", { signal: already.signal }),
    ).rejects.toThrow("test cancellation");

    // Abort during the dependent task's first read; it would otherwise take ~200 ms.
    const midRun = new AbortController();
    const midEvents: NestedReadEvent[] = [];
    const started = performance.now();
    const running = runFixtureTask("dependent-loop-filter", "direct-sequential", {
      signal: midRun.signal,
      readLatencyMs: { "/fixture/index.json": 200 },
      onReadEvent: (event) => midEvents.push(event),
    });
    setTimeout(() => midRun.abort(new Error("mid-run cancellation")), 60);
    await expect(running).rejects.toThrow("mid-run cancellation");
    expect(performance.now() - started).toBeLessThan(150);
    expect(midEvents.map((event) => event.kind)).toEqual(["read-start", "read-cancelled"]);

    // The third parallel call exceeds the read budget while the first two are
    // in flight; the run fails and those two siblings are cancelled, not finished.
    const siblingEvents: NestedReadEvent[] = [];
    await expect(
      runFixtureTask("independent-multi-read", "safe-batch-parallel", {
        limits: { maxNestedReads: 2 },
        readLatencyMs: { "/fixture/service.md": 50, "/fixture/deploy.md": 50 },
        onReadEvent: (event) => siblingEvents.push(event),
      }),
    ).rejects.toThrow(/nested-read budget/);
    await sleep(80);
    expect(siblingEvents.filter((event) => event.kind === "read-start")).toHaveLength(2);
    expect(siblingEvents.filter((event) => event.kind === "read-cancelled")).toHaveLength(2);
    expect(siblingEvents.filter((event) => event.kind === "read-end")).toHaveLength(0);
  });

  it("ships fixed default bounds and every fixture fits the per-read bound", () => {
    // Literal numbers, not the constants, so a loosened default fails here.
    expect(new RunBudget().limits).toEqual({
      maxTaskMs: 2_000,
      maxToolCalls: 16,
      maxNestedReads: 16,
      maxToolResultBytes: 65_536,
      maxRunResultBytes: 131_072,
      maxFilterLinesScanned: 8_192,
    });
    for (const fixture of Object.values(FIXTURES)) {
      expect(new TextEncoder().encode(fixture).byteLength).toBeLessThanOrEqual(65_536);
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
    // Each fixture passes the per-read check; the combined read_many result does not.
    await expect(
      runFixtureTask("independent-multi-read", "fixed-read-many", {
        limits: { maxToolResultBytes: 200 },
      }),
    ).rejects.toThrow(/per-result byte budget/);
    await expect(
      runFixtureTask("independent-multi-read", "direct-sequential", {
        limits: { maxRunResultBytes: 150 },
      }),
    ).rejects.toThrow(/aggregate result byte budget/);
    await expect(
      runFixtureTask("noisy-large-output", "filter-program", {
        limits: { maxFilterLinesScanned: 100 },
      }),
    ).rejects.toThrow(/line-scan budget/);
    // The abort timer fires mid-wait even though no budget check runs then.
    await expect(
      runFixtureTask("single-call", "direct-sequential", {
        limits: { maxTaskMs: 60 },
        readLatencyMs: { "/fixture/team.txt": 500 },
      }),
    ).rejects.toThrow(/time budget expired/);
    // The synchronous check trips on its own, with an injected clock.
    let now = 0;
    const clocked = new RunBudget({ maxTaskMs: 100 }, () => now);
    const signal = new AbortController().signal;
    clocked.check(signal);
    now = 101;
    expect(() => clocked.check(signal)).toThrow(/exceeded its time budget/);

    // The reader refuses anything outside the exact fixture keys, before any read.
    const budget = new RunBudget();
    const reader = new FixtureReader(budget, signal);
    for (const path of ["/etc/passwd", "/fixture/../fixture/team.txt", "constructor", "__proto__"])
      await expect(reader.read(path), path).rejects.toThrow(/outside the fixture capability/);
    await expect(reader.readMany(["/fixture/team.txt", "/fixture/team.txt"])).rejects.toThrow(
      /repeat/,
    );
    expect(budget.nestedReads).toBe(0);
  });

  it("keeps the capability modules free of shell, filesystem, network, env or dynamic code", () => {
    // A tripwire, not a sandbox: it catches the obvious regression of a
    // capability module reaching for a host API. report.ts and this test are
    // operator-side and are deliberately outside it.
    const allowed: Record<string, readonly string[]> = {
      "fixtures.ts": [],
      "prototype.ts": ["gpt-tokenizer/encoding/cl100k_base", "./fixtures"],
      "mcp-decision-sweep.ts": ["gpt-tokenizer/encoding/cl100k_base", "./fixtures", "./prototype"],
    };
    for (const [file, specifiers] of Object.entries(allowed)) {
      const source = readFileSync(new URL(`./${file}`, import.meta.url), "utf8");
      const imports = [
        ...source.matchAll(/\b(?:import|export)\b[^;]*?\bfrom\s*["']([^"']+)["']/gs),
        ...source.matchAll(/\bimport\s*["']([^"']+)["']/g),
      ].map((match) => match[1]);
      for (const specifier of imports)
        expect(specifiers, `${file} → ${specifier}`).toContain(specifier);
      for (const forbidden of [
        /\bprocess\b/,
        /\bglobalThis\b/,
        /\brequire\s*\(/,
        /\bimport\s*\(/,
        /\beval\b/,
        /\bFunction\s*\(/,
        /\bfetch\s*\(/,
        /\bWebSocket\b/,
        /\bchild_process\b/,
        /\bnode:/,
        /\bDeno\b|\bBun\b/,
      ]) {
        expect(source, `${file} must not match ${forbidden}`).not.toMatch(forbidden);
      }
    }
  });

  it("models how batching propensity, network wait, output volume and barriers move the decision", () => {
    const rows = buildMcpDecisionSweep();
    const pick = (
      latencyMs: number,
      batchSize: number,
      providerRoundMs = SCRIPTED_PROVIDER_ROUND_MS,
      bytes = 512,
    ) =>
      rows.find(
        (row) =>
          row.latencyMs === latencyMs &&
          row.batchSize === batchSize &&
          row.providerRoundMs === providerRoundMs &&
          row.outputBytesPerCall === bytes,
      )!;

    // Propensity: a model that never batches gets nothing from parallel dispatch.
    for (const latency of MOCK_CALL_LATENCIES_MS) expect(pick(latency, 1).savedMs).toBe(0);
    // Network wait: the saving is (calls - replies) x wait, so it grows with latency.
    expect(pick(900, 4).savedMs).toBe((SWEEP_CALLS - 1) * 900);
    expect(pick(250, 2).savedMs).toBe(2 * 250);
    // Slow real-model rounds dilute the share, not the absolute saving.
    expect(pick(250, 4, 2_000).savedMs).toBe(pick(250, 4).savedMs);
    expect(pick(250, 4, 2_000).savedPercent).toBeLessThan(pick(250, 4).savedPercent);

    // Output volume: dispatch mode cannot change context; fewer batches cost more.
    expect(pick(50, 4, SCRIPTED_PROVIDER_ROUND_MS, 16_384).resultTokensPerCall).toBeGreaterThan(
      pick(50, 4).resultTokensPerCall * 10,
    );
    for (const bytes of [512, 16_384]) {
      const tokens = SWEEP_BATCH_SIZES.map(
        (batch) => pick(50, batch, SCRIPTED_PROVIDER_ROUND_MS, bytes).inputTokens,
      );
      expect(tokens).toEqual(tokens.toSorted((left, right) => left - right));
    }

    // Correctness: a hypothetical write/approval barrier keeps order and costs overlap.
    expect(barrierNetworkMs(100, 0)).toBe(200);
    expect(barrierNetworkMs(100, 1)).toBe(300);
    expect(barrierNetworkMs(100, SWEEP_CALLS - 1)).toBe(200);
    expect(() => barrierNetworkMs(100, SWEEP_CALLS)).toThrow(/barrier index/);
  });
});

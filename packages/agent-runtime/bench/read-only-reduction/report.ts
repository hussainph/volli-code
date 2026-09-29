/**
 * The VC-442 bench driver: runs every task/lane and both MCP-like sweeps, then
 * renders them. This is operator-side code (like the test), so unlike the
 * capability modules it may reuse the sibling bench's table renderer.
 */

import { table } from "../parallel-tools/report";
import {
  FIXTURE_READ_LATENCY_MS,
  MOCK_CALL_LATENCIES_MS,
  SCRIPTED_PROVIDER_ROUND_MS,
  TASKS,
  type FixtureTaskId,
} from "./fixtures";
import {
  barrierNetworkMs,
  buildMcpDecisionSweep,
  runMockReadonlyLatencySweep,
  SWEEP_CALLS,
  type McpDecisionRow,
  type MeasuredLatencyRow,
} from "./mcp-decision-sweep";
import {
  buildToolSchemasForBenchmark,
  median,
  READ_ONLY_REDUCTION_LANES,
  runFixtureTask,
  type FixtureRunResult,
  type ReductionLane,
} from "./prototype";

const TASK_IDS = Object.keys(TASKS) as FixtureTaskId[];
const DEFAULT_REPEATS = 3;
const MAX_REPEATS = 20;
const SCHEMA_SAMPLES = 101;

type NumericField =
  | "elapsedMs"
  | "providerRounds"
  | "toolCalls"
  | "nestedReads"
  | "toolMs"
  | "inputTokens"
  | "cacheReadTokens"
  | "cacheWriteTokens"
  | "resultTokens"
  | "resultBytes"
  | "schemaTokens"
  | "historyMessages";

export type ReductionSummary = Pick<FixtureRunResult, NumericField | "taskId" | "lane"> & {
  correct: boolean;
  retainedEvidence: number;
  evidenceCount: number;
  maxConcurrency: number;
  schemaBuildP50Us: number;
};

export interface ReadOnlyReductionReport {
  repeats: number;
  summaries: ReductionSummary[];
  measuredLatency: MeasuredLatencyRow[];
  mcpDecision: McpDecisionRow[];
  text: string;
}

function summarize(results: readonly FixtureRunResult[], schemaBuildP50Us: number) {
  const first = results[0];
  if (first === undefined) throw new Error("a reduction summary needs at least one sample.");
  const medianOf = (field: NumericField): number => median(results.map((result) => result[field]));
  return {
    taskId: first.taskId,
    lane: first.lane,
    elapsedMs: medianOf("elapsedMs"),
    providerRounds: medianOf("providerRounds"),
    toolCalls: medianOf("toolCalls"),
    nestedReads: medianOf("nestedReads"),
    toolMs: medianOf("toolMs"),
    inputTokens: medianOf("inputTokens"),
    cacheReadTokens: medianOf("cacheReadTokens"),
    cacheWriteTokens: medianOf("cacheWriteTokens"),
    resultTokens: medianOf("resultTokens"),
    resultBytes: medianOf("resultBytes"),
    schemaTokens: medianOf("schemaTokens"),
    historyMessages: medianOf("historyMessages"),
    correct: results.every((result) => result.correct),
    retainedEvidence: Math.min(...results.map((result) => result.retainedEvidence)),
    evidenceCount: first.evidenceCount,
    maxConcurrency: Math.max(...results.map((result) => result.maxConcurrency)),
    schemaBuildP50Us,
  } satisfies ReductionSummary;
}

function measureSchemaBuildP50Us(lane: ReductionLane): number {
  const samples: number[] = [];
  let observed = 0;
  for (let index = 0; index < SCHEMA_SAMPLES; index += 1) {
    const started = performance.now();
    const schemas = buildToolSchemasForBenchmark(lane);
    const serialized = JSON.stringify(schemas);
    observed += serialized.length + schemas.length;
    samples.push((performance.now() - started) * 1_000);
  }
  if (observed === 0) throw new Error("schema construction produced no observable schema.");
  return median(samples);
}

function percentSaved(base: number, current: number): string {
  if (base === 0) return "0%";
  return `${(((base - current) / base) * 100).toFixed(1)}%`;
}

function laneSummary(
  summaries: readonly ReductionSummary[],
  taskId: FixtureTaskId,
  lane: ReductionLane,
): ReductionSummary {
  const summary = summaries.find(
    (candidate) => candidate.taskId === taskId && candidate.lane === lane,
  );
  if (summary === undefined) throw new Error(`missing ${taskId}/${lane} summary.`);
  return summary;
}

async function measure(repeats: number): Promise<Omit<ReadOnlyReductionReport, "text">> {
  const schemaBuildUs = new Map<ReductionLane, number>();
  for (const lane of READ_ONLY_REDUCTION_LANES)
    schemaBuildUs.set(lane, measureSchemaBuildP50Us(lane));
  const summaries: ReductionSummary[] = [];
  for (const taskId of TASK_IDS) {
    for (const lane of READ_ONLY_REDUCTION_LANES) {
      const results: FixtureRunResult[] = [];
      for (let repeat = 0; repeat < repeats; repeat += 1)
        results.push(await runFixtureTask(taskId, lane));
      summaries.push(summarize(results, schemaBuildUs.get(lane)!));
    }
  }
  const measuredLatency = await runMockReadonlyLatencySweep({ repeats });
  return { repeats, summaries, measuredLatency, mcpDecision: buildMcpDecisionSweep() };
}

function render(data: Omit<ReadOnlyReductionReport, "text">): string {
  const { repeats, summaries, measuredLatency, mcpDecision } = data;
  const out: string[] = [];
  out.push("# VC-442 read-only result-reduction fixture benchmark");
  out.push("");
  out.push(
    `fixture preset: read-only-reduction-v2 | repeats per task/lane: ${repeats} | median wall time`,
  );
  out.push(
    `provider latency: ${SCRIPTED_PROVIDER_ROUND_MS}ms per scripted round | fixture read latency: ${FIXTURE_READ_LATENCY_MS}ms per read (declared harness delays)`,
  );
  out.push(
    "tokenizer: cl100k BPE over serialized scripted inputs; cache figures count only the fixed system+tool prefix, not the user turn or prior results",
  );
  out.push(
    "retries: none by construction (the harness has no retry path; a failed call fails the run), so no retry column is reported",
  );
  out.push("");
  out.push("## Task latency, rounds, and correctness");
  out.push("");
  const latencyRows: string[][] = [];
  for (const taskId of TASK_IDS) {
    const direct = laneSummary(summaries, taskId, "direct-sequential");
    for (const lane of READ_ONLY_REDUCTION_LANES) {
      const row = laneSummary(summaries, taskId, lane);
      latencyRows.push([
        taskId,
        lane,
        row.elapsedMs.toFixed(1),
        percentSaved(direct.elapsedMs, row.elapsedMs),
        String(row.providerRounds),
        `${row.toolCalls}/${row.nestedReads}`,
        `${row.retainedEvidence}/${row.evidenceCount}`,
        row.correct ? "yes" : "no",
      ]);
    }
  }
  out.push(
    table(
      ["task", "lane", "p50 ms", "turn Δ", "provider rounds", "calls/reads", "evidence", "correct"],
      latencyRows,
    ),
  );
  out.push("");
  out.push("## Context and result volume");
  out.push("");
  const contextRows: string[][] = [];
  for (const taskId of TASK_IDS) {
    const direct = laneSummary(summaries, taskId, "direct-sequential");
    for (const lane of READ_ONLY_REDUCTION_LANES) {
      const row = laneSummary(summaries, taskId, lane);
      contextRows.push([
        taskId,
        lane,
        String(row.inputTokens),
        `${row.cacheReadTokens}/${row.cacheWriteTokens}`,
        String(row.resultTokens),
        String(row.resultBytes),
        percentSaved(direct.inputTokens, row.inputTokens),
        percentSaved(direct.resultBytes, row.resultBytes),
      ]);
    }
  }
  out.push(
    table(
      ["task", "lane", "input tok", "cache R/W", "result tok", "result B", "input Δ", "result Δ"],
      contextRows,
    ),
  );
  out.push("");
  out.push("## Selective parallelism, isolated from model rounds");
  out.push("");
  out.push(
    table(
      [
        "task",
        "serial batch ms",
        "parallel batch ms",
        "saved ms",
        "turn Δ",
        "same rounds",
        "same data",
        "peak reads",
      ],
      TASK_IDS.map((taskId) => {
        const serial = laneSummary(summaries, taskId, "safe-batch-serial");
        const parallel = laneSummary(summaries, taskId, "safe-batch-parallel");
        return [
          taskId,
          serial.elapsedMs.toFixed(1),
          parallel.elapsedMs.toFixed(1),
          (serial.elapsedMs - parallel.elapsedMs).toFixed(1),
          percentSaved(serial.elapsedMs, parallel.elapsedMs),
          String(serial.providerRounds === parallel.providerRounds),
          String(
            serial.inputTokens === parallel.inputTokens &&
              serial.resultBytes === parallel.resultBytes,
          ),
          String(parallel.maxConcurrency),
        ];
      }),
    ),
  );
  out.push("");
  out.push("## Per-lane schema setup overhead");
  out.push("");
  out.push(
    table(
      ["lane", "schema tok", "build + JSON p50 µs"],
      READ_ONLY_REDUCTION_LANES.map((lane) => {
        const row = summaries.find((summary) => summary.lane === lane)!;
        return [lane, String(row.schemaTokens), row.schemaBuildP50Us.toFixed(2)];
      }),
    ),
  );
  out.push("");
  out.push(
    "All answers are produced by a deterministic evidence oracle over retained fixture tool results, not by a model.",
  );
  out.push(
    "Tool results remain in the simulated transcript and are re-included in every later scripted request; no compaction is simulated.",
  );
  out.push(
    "The serial-vs-parallel rows use the same direct read calls and provider rounds; they isolate only fixture read scheduling.",
  );
  out.push("");
  out.push("## Mock MCP-like latency sweep, measured (timers only; no transport or model)");
  out.push("");
  out.push(
    `${SWEEP_CALLS} independent calls returning fixed values; batch = calls per assistant reply. Earlier calls in a reply wait 2 ms longer, so parallel replies finish out of call order. ${SCRIPTED_PROVIDER_ROUND_MS} ms scripted rounds.`,
  );
  out.push("");
  out.push(
    table(
      [
        "call wait ms",
        "batch",
        "rounds",
        "seq ms",
        "seq model",
        "parallel ms",
        "parallel model",
        "saved ms",
        "turn Δ",
        "peak",
        "ordered commit",
        "out-of-order finish",
      ],
      measuredLatency.map((row) => [
        String(row.latencyMs),
        String(row.batchSize),
        String(row.providerRounds),
        row.sequentialMs.toFixed(1),
        String(row.modelSequentialMs),
        row.parallelMs.toFixed(1),
        String(row.modelParallelMs),
        row.savedMs.toFixed(1),
        `${row.turnSavedPercent.toFixed(1)}%`,
        String(row.maxConcurrency),
        row.orderedResults ? "yes" : "no",
        row.completionDiffered ? "yes" : "no",
      ]),
    ),
  );
  out.push("");
  out.push("## MCP-like decision sweep (closed form; declared inputs)");
  out.push("");
  out.push(
    `Same turn model as the measured sweep, uniform waits. The ${SWEEP_CALLS}-call batch-4/2/1 rows at ${SCRIPTED_PROVIDER_ROUND_MS} ms are checked against measurement above; the 2000 ms provider round is a declared assumption, not a measurement. VC-245 measured a 17% batch rate on legacy Sessions.`,
  );
  out.push("");
  out.push("### Wall time: network wait x batching propensity x provider round");
  out.push("");
  const firstBytes = mcpDecision[0]!.outputBytesPerCall;
  out.push(
    table(
      [
        "provider round ms",
        "call wait ms",
        "batch",
        "rounds",
        "sequential ms",
        "selective parallel ms",
        "saved ms",
        "turn Δ",
      ],
      mcpDecision
        .filter((row) => row.outputBytesPerCall === firstBytes)
        .map((row) => [
          String(row.providerRoundMs),
          String(row.latencyMs),
          String(row.batchSize),
          String(row.providerRounds),
          String(row.sequentialMs),
          String(row.selectiveParallelMs),
          String(row.savedMs),
          `${row.savedPercent.toFixed(1)}%`,
        ]),
    ),
  );
  out.push("");
  out.push("### Context: output volume x batching propensity (same under both dispatch modes)");
  out.push("");
  out.push(
    table(
      ["result B/call", "result tok/call", "batch", "rounds", "turn input tok"],
      mcpDecision
        .filter(
          (row) =>
            row.latencyMs === MOCK_CALL_LATENCIES_MS[0] &&
            row.providerRoundMs === SCRIPTED_PROVIDER_ROUND_MS,
        )
        .map((row) => [
          String(row.outputBytesPerCall),
          String(row.resultTokensPerCall),
          String(row.batchSize),
          String(row.providerRounds),
          String(row.inputTokens),
        ]),
    ),
  );
  out.push("");
  out.push(
    "### Correctness: one write/approval-gated call in a reply of four (formula; network ms)",
  );
  out.push("");
  out.push(
    table(
      [
        "call wait ms",
        "Pi today (whole reply sequential)",
        "custom barrier, 2nd",
        "custom barrier, last",
        "all parallel (unsafe)",
      ],
      MOCK_CALL_LATENCIES_MS.map((latencyMs) => [
        String(latencyMs),
        String(SWEEP_CALLS * latencyMs),
        String(barrierNetworkMs(latencyMs, 1)),
        String(barrierNetworkMs(latencyMs, SWEEP_CALLS - 1)),
        String(latencyMs),
      ]),
    ),
  );
  out.push("");
  out.push(
    "Pi runs a whole reply sequentially when any call in it is sequential-mode. The barrier columns describe a hypothetical Volli dispatcher, not measured behaviour.",
  );
  return out.join("\n");
}

export async function buildReadOnlyReductionReport(
  options: { repeats?: number } = {},
): Promise<ReadOnlyReductionReport> {
  const repeats = options.repeats ?? DEFAULT_REPEATS;
  if (!Number.isInteger(repeats) || repeats < 1 || repeats > MAX_REPEATS) {
    throw new Error(`benchmark repeats must be an integer from 1 to ${MAX_REPEATS}.`);
  }
  const data = await measure(repeats);
  return { ...data, text: render(data) };
}

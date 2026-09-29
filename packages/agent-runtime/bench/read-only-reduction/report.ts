import {
  buildToolSchemasForBenchmark,
  READ_ONLY_REDUCTION_LANES,
  runFixtureTask,
  runMockReadonlyLatencySensitivity,
  type MockReadonlyLatencySensitivity,
  type FixtureRunResult,
  type ReductionLane,
} from "./prototype";
import { TASKS, type FixtureTaskId } from "./fixtures";
import {
  barrierNetworkMs,
  buildMcpDecisionSweep,
  modelledAllInOneMs,
  SWEEP_CALLS,
  SWEEP_LATENCIES_MS,
  type McpDecisionRow,
} from "./mcp-decision-sweep";

const TASK_IDS = Object.keys(TASKS) as FixtureTaskId[];
const DEFAULT_REPEATS = 3;
const SCHEMA_SAMPLES = 101;

export interface ReductionSummary extends Omit<
  FixtureRunResult,
  "elapsedMs" | "toolMs" | "maxConcurrency" | "historyMessages" | "resultOrder"
> {
  elapsedMs: number;
  toolMs: number;
  maxConcurrency: number;
  historyMessages: number;
  schemaBuildP50Us: number;
}

export interface ReadOnlyReductionReport {
  repeats: number;
  summaries: ReductionSummary[];
  latencySensitivity: MockReadonlyLatencySensitivity[];
  mcpDecision: McpDecisionRow[];
  text: string;
}

function median(values: readonly number[]): number {
  const sorted = values.toSorted((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!;
}

function pad(value: string, width: number): string {
  return value.length >= width ? value : `${value}${" ".repeat(width - value.length)}`;
}

function padLeft(value: string, width: number): string {
  return value.length >= width ? value : `${" ".repeat(width - value.length)}${value}`;
}

function markdownTable(headers: string[], rows: string[][]): string {
  const widths = headers.map((header, column) =>
    Math.max(header.length, ...rows.map((row) => (row[column] ?? "").length)),
  );
  const line = (cells: string[], align: "left" | "right"): string =>
    `| ${cells.map((cell, column) => (align === "right" ? padLeft(cell, widths[column]!) : pad(cell, widths[column]!))).join(" | ")} |`;
  return [
    line(headers, "left"),
    `|${widths.map((width) => "-".repeat(width + 2)).join("|")}|`,
    ...rows.map((row) => line(row, "left")),
  ].join("\n");
}

function medianResult(
  results: readonly FixtureRunResult[],
  schemaBuildP50Us: number,
): ReductionSummary {
  const first = results[0];
  if (first === undefined) throw new Error("a reduction summary needs at least one sample.");
  const same = (field: keyof FixtureRunResult): number => {
    const values = results.map((result) => result[field]);
    if (values.some((value) => typeof value !== "number"))
      throw new Error(`${field} is not numeric.`);
    return median(values as number[]);
  };
  const evidence = Math.min(...results.map((result) => result.retainedEvidence));
  return {
    taskId: first.taskId,
    lane: first.lane,
    elapsedMs: same("elapsedMs"),
    providerRounds: same("providerRounds"),
    toolCalls: same("toolCalls"),
    nestedReads: same("nestedReads"),
    toolMs: same("toolMs"),
    inputTokens: same("inputTokens"),
    cacheReadTokens: same("cacheReadTokens"),
    cacheWriteTokens: same("cacheWriteTokens"),
    resultTokens: same("resultTokens"),
    resultBytes: same("resultBytes"),
    schemaTokens: same("schemaTokens"),
    correct: results.every((result) => result.correct),
    retainedEvidence: evidence,
    evidenceCount: first.evidenceCount,
    retries: same("retries"),
    schemaBuildP50Us,
    maxConcurrency: Math.max(...results.map((result) => result.maxConcurrency)),
    historyMessages: same("historyMessages"),
  };
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

export async function buildReadOnlyReductionReport(
  options: { repeats?: number } = {},
): Promise<ReadOnlyReductionReport> {
  const repeats = options.repeats ?? DEFAULT_REPEATS;
  if (!Number.isInteger(repeats) || repeats < 1 || repeats > 20) {
    throw new Error("benchmark repeats must be an integer from 1 to 20.");
  }

  const schemaBuildUs = new Map<ReductionLane, number>();
  for (const lane of READ_ONLY_REDUCTION_LANES)
    schemaBuildUs.set(lane, measureSchemaBuildP50Us(lane));
  const summaries: ReductionSummary[] = [];
  for (const taskId of TASK_IDS) {
    for (const lane of READ_ONLY_REDUCTION_LANES) {
      const results: FixtureRunResult[] = [];
      for (let repeat = 0; repeat < repeats; repeat += 1)
        results.push(await runFixtureTask(taskId, lane));
      const summary = medianResult(results, schemaBuildUs.get(lane)!);
      if (!summary.correct || summary.retainedEvidence !== summary.evidenceCount) {
        throw new Error(`${taskId}/${lane} lost required evidence or changed the scripted answer.`);
      }
      if (summary.retries !== 0)
        throw new Error(`${taskId}/${lane} unexpectedly retried a read-only operation.`);
      summaries.push(summary);
    }
  }

  const latencySensitivity = await runMockReadonlyLatencySensitivity();
  const out: string[] = [];
  out.push("# VC-442 read-only result-reduction fixture benchmark");
  out.push("");
  out.push(
    `fixture preset: read-only-reduction-v1 | repeats per task/lane: ${repeats} | median wall time`,
  );
  out.push(
    "provider latency: 35ms per scripted round | fixture read latency: 8ms per read (declared harness delays)",
  );
  out.push(
    "tokenizer: cl100k BPE over serialized scripted inputs; cache figures count only the fixed system+tool prefix, not the user turn or prior results",
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
        String(row.retries),
      ]);
    }
  }
  out.push(
    markdownTable(
      [
        "task",
        "lane",
        "p50 ms",
        "turn Δ",
        "provider rounds",
        "calls/reads",
        "evidence",
        "correct",
        "retries",
      ],
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
    markdownTable(
      ["task", "lane", "input tok", "cache R/W", "result tok", "result B", "input Δ", "result Δ"],
      contextRows,
    ),
  );
  out.push("");
  out.push("## Selective parallelism, isolated from model rounds");
  out.push("");
  const parallelRows: string[][] = [];
  for (const taskId of TASK_IDS) {
    const serial = laneSummary(summaries, taskId, "safe-batch-serial");
    const parallel = laneSummary(summaries, taskId, "safe-batch-parallel");
    parallelRows.push([
      taskId,
      serial.elapsedMs.toFixed(1),
      parallel.elapsedMs.toFixed(1),
      (serial.elapsedMs - parallel.elapsedMs).toFixed(1),
      percentSaved(serial.elapsedMs, parallel.elapsedMs),
      String(serial.providerRounds === parallel.providerRounds),
      String(
        serial.inputTokens === parallel.inputTokens && serial.resultBytes === parallel.resultBytes,
      ),
      String(parallel.maxConcurrency),
    ]);
  }
  out.push(
    markdownTable(
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
      parallelRows,
    ),
  );
  out.push("");
  out.push("## Per-lane schema setup overhead");
  out.push("");
  const schemaRows = READ_ONLY_REDUCTION_LANES.map((lane) => {
    const row = summaries.find((summary) => summary.lane === lane)!;
    return [lane, String(row.schemaTokens), row.schemaBuildP50Us.toFixed(2)];
  });
  out.push(markdownTable(["lane", "schema tok", "build + JSON p50 µs"], schemaRows));
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
  out.push(
    "## Mock read-only remote/MCP-like latency sensitivity (not a provider or transport run)",
  );
  out.push("");
  out.push(
    "Four independent fixed in-memory replies; only the delayed read latency varies. Two scripted provider rounds in both modes.",
  );
  out.push("");
  out.push(
    markdownTable(
      [
        "declared read ms",
        "seq turn ms",
        "parallel turn ms",
        "saved ms",
        "turn Δ",
        "provider rounds",
        "peak reads",
        "same data",
      ],
      latencySensitivity.map((row) => [
        String(row.latencyMs),
        row.sequentialMs.toFixed(1),
        row.parallelMs.toFixed(1),
        row.savedMs.toFixed(1),
        `${row.turnSavedPercent.toFixed(1)}%`,
        String(row.providerRounds),
        String(row.maxConcurrency),
        row.sameResults ? "yes" : "no",
      ]),
    ),
  );
  out.push("");
  out.push(
    "This sensitivity arm creates no MCP client, network request, credential access or model inference; it only shows how selective read-only overlap scales with latency.",
  );
  out.push("");
  out.push("Measured vs closed-form model (all four calls in one reply, 35 ms scripted rounds):");
  out.push("");
  out.push(
    markdownTable(
      ["declared read ms", "seq measured", "seq model", "parallel measured", "parallel model"],
      latencySensitivity.map((row) => [
        String(row.latencyMs),
        row.sequentialMs.toFixed(1),
        modelledAllInOneMs(row.latencyMs, row.reads, 35, false).toFixed(1),
        row.parallelMs.toFixed(1),
        modelledAllInOneMs(row.latencyMs, row.reads, 35, true).toFixed(1),
      ]),
    ),
  );

  const mcpDecision = buildMcpDecisionSweep();
  out.push("");
  out.push("## MCP-like decision sweep (closed-form; declared inputs, no transport or model)");
  out.push("");
  out.push(
    `${SWEEP_CALLS} independent read-only calls. batch = calls the model puts in one reply (4 = always batches, 1 = never; VC-245 measured a 17% batch rate on legacy Sessions). The 2000 ms provider round is a declared assumption, not a measurement.`,
  );
  out.push("");
  out.push("### Wall time: network wait x batching propensity x provider round");
  out.push("");
  const timeRows = mcpDecision
    .filter((row) => row.outputBytesPerCall === mcpDecision[0]!.outputBytesPerCall)
    .map((row) => [
      String(row.providerRoundMs),
      String(row.latencyMs),
      String(row.batchSize),
      String(row.providerRounds),
      String(row.sequentialMs),
      String(row.selectiveParallelMs),
      String(row.savedMs),
      `${row.savedPercent.toFixed(1)}%`,
    ]);
  out.push(
    markdownTable(
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
      timeRows,
    ),
  );
  out.push("");
  out.push("### Context: output volume x batching propensity (same under both dispatch modes)");
  out.push("");
  const tokenRows = mcpDecision
    .filter(
      (row) =>
        row.latencyMs === SWEEP_LATENCIES_MS[0] &&
        row.providerRoundMs === mcpDecision[0]!.providerRoundMs,
    )
    .map((row) => [
      String(row.outputBytesPerCall),
      String(row.resultTokensPerCall),
      String(row.batchSize),
      String(row.providerRounds),
      String(row.inputTokens),
    ]);
  out.push(
    markdownTable(
      ["result B/call", "result tok/call", "batch", "rounds", "turn input tok"],
      tokenRows,
    ),
  );
  out.push("");
  out.push("### Correctness: one write/approval-gated call in a reply of four");
  out.push("");
  out.push(
    markdownTable(
      ["call wait ms", "all sequential", "barrier at 2nd", "barrier last", "all parallel (unsafe)"],
      SWEEP_LATENCIES_MS.map((latencyMs) => [
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
    "Network-wait ms only. A barrier keeps writes and approvals in reply order; reads either side still overlap.",
  );

  return { repeats, summaries, latencySensitivity, mcpDecision, text: out.join("\n") };
}

import {
  assertSameBatchedOutcome,
  p50p95,
  quantile,
  runScenarioRepeats,
  tailLabel,
  type McpRunResult,
  type McpScenario,
} from "./harness";

export const DEFAULT_REPEATS = 5;
export const NETWORK_LATENCIES_MS = [20, 80] as const;
export const BATCH_SIZES = [1, 2, 4, 8, 16] as const;
export const PROVIDER_LATENCY_MS = 20;
export const COLD_START_MS = 40;

interface ReportRow {
  label: string;
  sequential: McpRunResult[];
  parallel: McpRunResult[];
  unbatched: McpRunResult[];
}

function table(headers: readonly string[], rows: readonly (readonly string[])[]): string {
  const widths = headers.map((header, index) =>
    Math.max(header.length, ...rows.map((row) => (row[index] ?? "").length)),
  );
  const line = (values: readonly string[]): string =>
    `| ${values.map((value, index) => value.padEnd(widths[index]!)).join(" | ")} |`;
  return [
    line(headers),
    `|${widths.map((width) => "-".repeat(width + 2)).join("|")}|`,
    ...rows.map(line),
  ].join("\n");
}

function repeatCount(
  results: readonly McpRunResult[],
  key: "providerRequests" | "providerTokens" | "fixtureCalls",
): string {
  const values = new Set(results.map((result) => result[key]));
  return values.size === 1 ? String(values.values().next().value) : [...values].join("/");
}

function sumErrors(results: readonly McpRunResult[]): number {
  return results.reduce((sum, result) => sum + result.fixtureErrors, 0);
}

function completionDivergence(results: readonly McpRunResult[]): string {
  const different = results.filter(
    (result) => result.completionOrder.join(",") !== result.resultOrder.join(","),
  ).length;
  return `${different}/${results.length}`;
}

function formatTimingRows(rows: readonly ReportRow[], tail: string): string {
  return table(
    [
      "network/server/start/n",
      `seq wall p50/${tail}`,
      `seq tool p50/${tail}`,
      `par wall p50/${tail}`,
      `par tool p50/${tail}`,
      `unbatch wall p50/${tail}`,
      `unbatch tool p50/${tail}`,
    ],
    rows.map((row) => [
      row.label,
      p50p95(row.sequential.map((result) => result.elapsedMs)),
      p50p95(row.sequential.map((result) => result.toolTimeMs)),
      p50p95(row.parallel.map((result) => result.elapsedMs)),
      p50p95(row.parallel.map((result) => result.toolTimeMs)),
      p50p95(row.unbatched.map((result) => result.elapsedMs)),
      p50p95(row.unbatched.map((result) => result.toolTimeMs)),
    ]),
  );
}

function formatAccountingRows(rows: readonly ReportRow[]): string {
  return table(
    [
      "network/server/start/n",
      "provider req seq/par/unbatch",
      "tool calls seq/par/unbatch",
      "provider tokens seq/par",
      "result bytes/tokens (p50)",
      "fixture errors seq/par/unbatch",
      "peak Pi / server-per-server",
      "source order / completion≠source / cleanup",
    ],
    rows.map((row) => {
      const first = row.parallel[0]!;
      return [
        row.label,
        `${repeatCount(row.sequential, "providerRequests")}/${repeatCount(row.parallel, "providerRequests")}/${repeatCount(row.unbatched, "providerRequests")}`,
        `${repeatCount(row.sequential, "fixtureCalls")}/${repeatCount(row.parallel, "fixtureCalls")}/${repeatCount(row.unbatched, "fixtureCalls")}`,
        `${repeatCount(row.sequential, "providerTokens")}/${repeatCount(row.parallel, "providerTokens")}`,
        `${Math.round(
          quantile(
            row.parallel.map((result) => result.resultBytes),
            0.5,
          ),
        )}/${Math.round(
          quantile(
            row.parallel.map((result) => result.resultTokens),
            0.5,
          ),
        )}`,
        `${sumErrors(row.sequential)}/${sumErrors(row.parallel)}/${sumErrors(row.unbatched)}`,
        `${Math.max(...row.parallel.map((result) => result.peakConcurrency))}/${first.fixturePeakPerServer.join(",")}`,
        `${row.parallel.every((result) => result.resultOrder.join(",") === result.expectedOrder.join(",")) ? "source-order" : "MISMATCH"}/${completionDivergence(row.parallel)}/${row.parallel.every((result) => result.cleanup) ? "closed" : "LEAK"}`,
      ];
    }),
  );
}

export interface McpBenchReport {
  repeats: number;
  text: string;
  rows: ReportRow[];
}

export async function buildMcpBenchReport(repeats = DEFAULT_REPEATS): Promise<McpBenchReport> {
  const rows: ReportRow[] = [];
  for (const latencyMs of NETWORK_LATENCIES_MS) {
    for (const serverCount of [1, 2] as const) {
      for (const startup of ["cold", "warm"] as const) {
        for (const batchSize of BATCH_SIZES) {
          const base: Omit<McpScenario, "mode" | "batchShape"> = {
            latencyMs,
            serverCount,
            startup,
            batchSize,
            providerLatencyMs: PROVIDER_LATENCY_MS,
            coldStartMs: COLD_START_MS,
            resultChars: 128,
          };
          const results = await runScenarioRepeats(base, repeats);
          for (let index = 0; index < repeats; index += 1) {
            assertSameBatchedOutcome(results.sequential[index]!, results.parallel[index]!);
            for (const run of [
              results.sequential[index]!,
              results.parallel[index]!,
              results.unbatched[index]!,
            ]) {
              if (!run.cleanup) {
                throw new Error(
                  `MCP client/server cleanup failed for ${latencyMs}/${serverCount}/${startup}/${batchSize}`,
                );
              }
            }
            if (results.parallel[index]!.peakConcurrency > 1 && batchSize < 2) {
              throw new Error("A one-call model batch unexpectedly overlapped tools.");
            }
            if (results.unbatched[index]!.peakConcurrency > 1) {
              throw new Error("Unbatched control overlapped tool calls across model replies.");
            }
          }
          rows.push({
            label: `${latencyMs}ms/${serverCount}/${startup}/n${batchSize}`,
            ...results,
          });
        }
      }
    }
  }

  const tail = tailLabel(repeats);
  const out = [
    "# VC-444 local MCP parallel-dispatch fixture benchmark",
    "",
    `- Repeats per cell: ${repeats}; p50/${tail} are nearest-rank milliseconds over task wall time and summed MCP tool-call time${tail === "max" ? " (fewer than 20 samples cannot resolve a p95, so the tail is the maximum)" : ""}.`,
    `- Synthetic provider: fixed replies (not model propensity), ${PROVIDER_LATENCY_MS}ms per request, 1,000 input + 60 output tokens per request.`,
    `- Local Streamable HTTP MCP server: network-like per-call delays ${NETWORK_LATENCIES_MS.join("/")}ms on the first server; a second server adds max(5ms, latency/4) (${NETWORK_LATENCIES_MS.map((ms) => ms + Math.max(5, ms / 4)).join("/")}ms) so completions interleave; cold attach adds ${COLD_START_MS}ms per server; warm cells pre-open and reuse the host's cached client.`,
    "- Every sequential/parallel pair receives the same single-reply model batch; unbatched control emits the same N calls over N replies.",
    "- Baseline fixture has no rate/connection cap; constrained-limit stress is reported separately by the test. All result token counts use o200k_base on the Volli wrapper's tool-result text.",
    "",
    `## Task wall time and MCP tool time (p50/${tail} ms)`,
    "",
    formatTimingRows(rows, tail),
    "",
    "## Provider, result, errors, ordering and cleanup",
    "",
    formatAccountingRows(rows),
    "",
    "## Scope",
    "",
    "Pi parallel dispatch overlaps only calls the scripted assistant put into the same emitted batch. This lane uses no paid provider, credentials, remote MCP server or remote mutation. It does not measure whether real models choose to batch.",
    "Programmatic tool calling is a distinct lever: it can replace provider round trips and reduce model-visible result output; Pi's parallel scheduler only overlaps an already-issued model batch and leaves provider requests/result volume unchanged for that batch.",
  ];
  return { repeats, text: out.join("\n"), rows };
}

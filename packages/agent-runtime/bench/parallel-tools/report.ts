/**
 * Runs every scenario in both tool-execution modes and builds the report.
 *
 *   pnpm -C packages/agent-runtime run bench
 *   BENCH_REPEATS=9 pnpm -C packages/agent-runtime run bench
 *
 * Two things are reported side by side on purpose. The wall-clock column is
 * where parallel mode does its work; the token and cost columns are there to
 * show that it does not touch them. A reader who only sees the speedup will
 * conclude the wrong thing about context and spend.
 *
 * The findings this collects are returned rather than printed, so the bench
 * test can fail on them instead of leaving a warning in scrollback.
 */

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { runRepeated, type RunSpec } from "./harness";
import { FALLBACK_PROFILE, SCENARIOS, type LatencyProfile } from "./scenarios";

const here = fileURLToPath(new URL(".", import.meta.url));
const REPEATS = Number(process.env.BENCH_REPEATS ?? 3);

async function loadProfile(): Promise<{ profile: LatencyProfile; source: string }> {
  try {
    const raw = await readFile(join(here, "profile.measured.json"), "utf8");
    const parsed = JSON.parse(raw) as { profile: LatencyProfile; measuredAt: string };
    return { profile: parsed.profile, source: `profile.measured.json (${parsed.measuredAt})` };
  } catch {
    return { profile: FALLBACK_PROFILE, source: "FALLBACK_PROFILE (run bench:probe to measure)" };
  }
}

function pad(value: string, width: number): string {
  return value.length >= width
    ? value
    : `${value}${" ".repeat(width - value.length)}`.slice(0, width);
}
function padLeft(value: string, width: number): string {
  return value.length >= width ? value : `${" ".repeat(width - value.length)}${value}`;
}

function table(headers: string[], rows: string[][]): string {
  const widths = headers.map((header, column) =>
    Math.max(header.length, ...rows.map((row) => (row[column] ?? "").length)),
  );
  const line = (cells: string[], padder: (v: string, w: number) => string): string =>
    `| ${cells.map((cell, column) => padder(cell ?? "", widths[column]!)).join(" | ")} |`;
  return [
    line(headers, pad),
    `|${widths.map((width) => "-".repeat(width + 2)).join("|")}|`,
    ...rows.map((row) =>
      line(row, (value, width) =>
        /^[\d.$×%-]+$/.test(value) ? padLeft(value, width) : pad(value, width),
      ),
    ),
  ].join("\n");
}

/** Everything one bench run produced: the printable report and what failed. */
export interface BenchReport {
  text: string;
  /** Non-empty means an invariant the design depends on did not hold. */
  findings: string[];
  /** Per-scenario wall-clock and token facts, for assertions. */
  scenarios: {
    id: string;
    batched: boolean;
    sequentialMs: number;
    parallelMs: number;
    savedMs: number;
    sequentialTokens: number;
    parallelTokens: number;
    sequentialModelCalls: number;
    parallelModelCalls: number;
    peakConcurrency: number;
  }[];
}

export async function buildReport(): Promise<BenchReport> {
  const { profile, source } = await loadProfile();
  const out: string[] = [];
  const say = (line = ""): void => {
    out.push(line);
  };

  say("# Pi tool-execution mode bench (VC-245)");
  say();
  say(`repeats per cell: ${REPEATS} (median reported)`);
  say(`latency profile:  ${source}`);
  say(
    `  localFile=${profile.localFile}ms subprocess=${profile.subprocess}ms network=${profile.network}ms ` +
      `browser=${profile.browser}ms sessionStart=${profile.sessionStart}ms provider=${profile.provider}ms`,
  );
  say();

  const rows: string[][] = [];
  const findings: string[] = [];
  const completionOrderDiverged: string[] = [];
  const scenarioFacts: BenchReport["scenarios"] = [];

  for (const scenario of SCENARIOS) {
    const base: Omit<RunSpec, "mode"> = {
      tools: scenario.tools(profile),
      replies: scenario.replies,
      providerLatencyMs: profile.provider,
    };

    const sequential = await runRepeated({ ...base, mode: "sequential" }, REPEATS);
    const parallel = await runRepeated({ ...base, mode: "parallel" }, REPEATS);

    const saved = sequential.elapsedMsMedian - parallel.elapsedMsMedian;
    const speedup =
      parallel.elapsedMsMedian === 0 ? 1 : sequential.elapsedMsMedian / parallel.elapsedMsMedian;

    const tokensMatch =
      sequential.representative.provider.totalTokens ===
        parallel.representative.provider.totalTokens &&
      sequential.representative.provider.calls === parallel.representative.provider.calls;
    if (!tokensMatch) {
      findings.push(`!! ${scenario.id}: token/provider-call counts DIFFER between modes`);
    }

    rows.push([
      scenario.id,
      scenario.batched ? "yes" : "no",
      String(sequential.representative.toolCalls),
      String(sequential.representative.provider.calls),
      String(sequential.representative.provider.totalTokens),
      `${sequential.elapsedMsMedian.toFixed(0)}`,
      `${parallel.elapsedMsMedian.toFixed(0)}`,
      `${saved.toFixed(0)}`,
      `${speedup.toFixed(2)}×`,
      String(parallel.representative.peakConcurrency),
    ]);

    scenarioFacts.push({
      id: scenario.id,
      batched: scenario.batched,
      sequentialMs: sequential.elapsedMsMedian,
      parallelMs: parallel.elapsedMsMedian,
      savedMs: saved,
      sequentialTokens: sequential.representative.provider.totalTokens,
      parallelTokens: parallel.representative.provider.totalTokens,
      sequentialModelCalls: sequential.representative.provider.calls,
      parallelModelCalls: parallel.representative.provider.calls,
      peakConcurrency: parallel.representative.peakConcurrency,
    });

    // Result ordering is a correctness claim, so it is checked rather than
    // trusted: Pi promises assistant source order for persisted results even
    // when completion order differs.
    const sequentialOrder = sequential.representative.resultOrder.join(",");
    const parallelOrder = parallel.representative.resultOrder.join(",");
    if (sequentialOrder !== parallelOrder) {
      findings.push(
        `!! ${scenario.id}: persisted tool-result ORDER differs — seq[${sequentialOrder}] par[${parallelOrder}]`,
      );
    }
    if (parallelOrder === "") {
      findings.push(`!! ${scenario.id}: no persisted tool results were observed`);
    }
    // Not a failure, but the fact activity and transcript can disagree on
    // order is exactly what a reviewer needs to be told once.
    if (parallel.representative.completionOrder.join(",") !== parallelOrder) {
      completionOrderDiverged.push(scenario.id);
    }
  }

  say(
    table(
      [
        "scenario",
        "batched",
        "tools",
        "model calls",
        "tokens",
        "seq ms",
        "par ms",
        "saved ms",
        "speedup",
        "peak conc",
      ],
      rows,
    ),
  );

  say();
  say("## Correctness checks");
  say();
  if (findings.length === 0) {
    say("- token totals and model-call counts identical across modes in every scenario");
    say("- persisted tool-result order identical across modes in every scenario");
  } else {
    for (const finding of findings) say(finding);
  }
  say(
    completionOrderDiverged.length === 0
      ? "- completion order matched persisted order in this run (it is not guaranteed to)"
      : `- completion order DIVERGED from persisted order in: ${completionOrderDiverged.join(", ")} — ` +
          "activity sees finish order, the transcript sees source order",
  );

  // --- sensitivity ---------------------------------------------------------
  //
  // The headline speedup is a function of two numbers the bench cannot pin
  // down: how slow the tool is, and how many calls the model batches. Sweeping
  // both is more useful than defending one guess.
  say();
  say("## Sensitivity: batch size × tool latency (batched reads, no provider latency)");
  say();
  const sweepRows: string[][] = [];
  for (const latencyMs of [5, 50, 250, 900]) {
    const cells: string[] = [`${latencyMs}ms`];
    for (const size of [2, 3, 5, 8]) {
      const spec: Omit<RunSpec, "mode"> = {
        tools: [{ name: "t", latencyMs }],
        replies: [
          {
            toolCalls: Array.from({ length: size }, (_, index) => ({
              name: "t",
              args: { n: index },
            })),
          },
          { text: "done" },
        ],
        providerLatencyMs: 0,
      };
      // One run per cell: the quantity being shown is (n-1) x latency, which
      // is large next to scheduler noise at every latency in this sweep.
      const sequential = await runRepeated({ ...spec, mode: "sequential" }, 1);
      const parallel = await runRepeated({ ...spec, mode: "parallel" }, 1);
      const saved = sequential.elapsedMsMedian - parallel.elapsedMsMedian;
      cells.push(`${saved.toFixed(0)}ms`);
    }
    sweepRows.push(cells);
  }
  say(table(["tool latency", "n=2", "n=3", "n=5", "n=8"], sweepRows));
  say();
  say("(cells are wall-clock milliseconds SAVED by parallel mode over sequential)");

  // --- turn-level view -----------------------------------------------------
  //
  // A saved millisecond only matters next to the turn it sits in. Provider
  // round trips dominate most turns, so the same saving is worth a different
  // share of the wait depending on how many replies the turn took.
  say();
  say("## Share of total turn time saved (same runs, including provider latency)");
  say();
  // Derived from the runs already measured above rather than re-run: the
  // question here is what share of a turn the saving is, and re-timing the
  // same specs would only add noise and minutes.
  const shareRows = scenarioFacts.map((fact) => [
    fact.id,
    `${fact.sequentialMs.toFixed(0)}ms`,
    `${fact.savedMs.toFixed(0)}ms`,
    `${fact.sequentialMs === 0 ? 0 : ((fact.savedMs / fact.sequentialMs) * 100).toFixed(0)}%`,
  ]);
  say(table(["scenario", "turn (seq)", "saved", "share of turn"], shareRows));

  return { text: out.join("\n"), findings, scenarios: scenarioFacts };
}

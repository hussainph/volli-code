#!/usr/bin/env node
/**
 * Compare two desktop benchmark runs (VC-1093): a baseline and a candidate,
 * each a `pnpm bench:desktop` output directory or its `benchmark.summary.json`.
 *
 *   pnpm bench:desktop:compare -- performance-results/before performance-results/after
 *   pnpm bench:desktop:compare -- before after --budgets budgets.json --output compare-out
 *
 * It refuses an unlike pair — a different fixture preset or seed, a
 * different main-stall threshold or storm shape — because a delta between
 * two different experiments is not a measurement (`--allow-mismatch` reports
 * one anyway, marked). Different machines, macOS, repetition counts or a
 * dirty tree are warnings: still comparable, and said so beside the numbers.
 *
 * For every arm and interaction in both runs it reports latency p50/p95,
 * frame p95, dropped frames, long tasks and the main stalls inside the
 * interaction's window; per arm, the main and renderer stall totals. Then it
 * checks soft budgets ({@link DEFAULT_BUDGETS}, overridable with a JSON file):
 * relative ones against the baseline, and optional absolute ceilings per
 * interaction. A budget breach is a FLAG, not a failure — the exit code is 0
 * unless `--fail-on-regression` asks for gating. Budgets start non-gating
 * because a single run's p95 on a shared Mac moves by more than a small
 * regression; tighten them once their noise is known.
 */
import { promises as fs } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Soft budgets. A latency regression must clear BOTH the ratio and the
 * absolute floor, so a 2 ms interaction going to 3 ms is not a 50% headline.
 * Stall budgets are in the stall line's own units: one main stall at the
 * production threshold is 200 ms.
 */
export const DEFAULT_BUDGETS = Object.freeze({
  latencyP95Ratio: 1.15,
  latencyP95MinDeltaMs: 15,
  // Main stall time inside one interaction's window, p95 over repetitions.
  interactionMainStallMsP95MaxDelta: 200,
  // Whole-arm main stall time per repetition, p95.
  armMainStallMsP95MaxDelta: 200,
  // Whole-arm renderer stalls per repetition, p95.
  armRendererStallCountP95MaxDelta: 2,
  /**
   * Per-interaction overrides and absolute ceilings, keyed by interaction id:
   * `{ latencyP95Ratio?, latencyP95MinDeltaMs?, maxLatencyP95Ms?, maxMainStallMsP95? }`.
   */
  interactions: Object.freeze({}),
});

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function round(value) {
  return value === null || value === undefined ? null : Math.round(value * 1_000) / 1_000;
}

/** Reads a summary from a run directory or the file itself. */
export async function readSummary(path) {
  const absolute = resolve(path);
  const stat = await fs.stat(absolute);
  const file = stat.isDirectory() ? join(absolute, "benchmark.summary.json") : absolute;
  const summary = JSON.parse(await fs.readFile(file, "utf8"));
  if (!isRecord(summary) || !Array.isArray(summary.arms) || !isRecord(summary.fixture)) {
    throw new Error(`${file} is not a benchmark.summary.json`);
  }
  return { ...summary, source: file };
}

/** Merges a budget file over {@link DEFAULT_BUDGETS}. */
export function budgetsFrom(overrides = {}) {
  if (!isRecord(overrides)) throw new Error("budgets must be a JSON object");
  return {
    ...DEFAULT_BUDGETS,
    ...overrides,
    interactions: { ...DEFAULT_BUDGETS.interactions, ...overrides.interactions },
  };
}

/** Why two runs are not the same experiment (`mismatches`), and what differs but is allowed (`warnings`). */
/** Notes `label` into `into` when the two values differ. */
function same(label, a, b, into) {
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    into.push(`${label}: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`);
  }
}

export function comparability(baseline, candidate) {
  const mismatches = [];
  const warnings = [];
  same("fixture preset", baseline.fixture.preset, candidate.fixture.preset, mismatches);
  same("fixture seed", baseline.fixture.seed, candidate.fixture.seed, mismatches);
  if (baseline.signalConfig !== undefined && candidate.signalConfig !== undefined) {
    same(
      "main-stall threshold",
      baseline.signalConfig.mainStallThresholdMs,
      candidate.signalConfig.mainStallThresholdMs,
      mismatches,
    );
    same(
      "fleet storm shape",
      baseline.signalConfig.storm,
      candidate.signalConfig.storm,
      mismatches,
    );
  } else if ((baseline.signalConfig === undefined) !== (candidate.signalConfig === undefined)) {
    warnings.push("one run predates stall signals (VC-1093); only latency and frames compare");
  }
  same("device", baseline.device?.model, candidate.device?.model, warnings);
  same("cpu", baseline.device?.cpu, candidate.device?.cpu, warnings);
  same("macOS", baseline.macos?.version, candidate.macos?.version, warnings);
  same("repetitions", baseline.repetitions, candidate.repetitions, warnings);
  same("background load", baseline.backgroundLoad?.name, candidate.backgroundLoad?.name, warnings);
  if (baseline.build?.dirty) warnings.push("baseline was built from a dirty tree");
  if (candidate.build?.dirty) warnings.push("candidate was built from a dirty tree");
  if (baseline.build?.sha !== undefined && baseline.build.sha === candidate.build?.sha) {
    warnings.push("both runs are the same commit: this is a noise measurement");
  }
  return { mismatches, warnings };
}

/** One metric's two values, its delta and ratio. */
function delta(base, next) {
  if (!Number.isFinite(base) || !Number.isFinite(next)) {
    return { baseline: base ?? null, candidate: next ?? null, delta: null, ratio: null };
  }
  return {
    baseline: base,
    candidate: next,
    delta: round(next - base),
    ratio: base === 0 ? null : round(next / base),
  };
}

function interactionMetrics(base, next) {
  const a = base.aggregates;
  const b = next.aggregates;
  return {
    latencyP50: delta(a.latencyMs?.p50, b.latencyMs?.p50),
    latencyP95: delta(a.latencyMs?.p95, b.latencyMs?.p95),
    frameP95: delta(a.frameTimeMs?.p95, b.frameTimeMs?.p95),
    droppedP95: delta(a.droppedFrames?.p95, b.droppedFrames?.p95),
    longTasksP95: delta(a.longTasks?.countPerSample?.p95, b.longTasks?.countPerSample?.p95),
    mainStallMsP95: delta(a.mainStallMs?.p95, b.mainStallMs?.p95),
  };
}

function interactionFlags(id, metrics, budgets) {
  const own = { ...budgets, ...budgets.interactions[id] };
  const regressions = [];
  const improvements = [];
  const latency = metrics.latencyP95;
  if (latency.delta !== null) {
    const worse =
      latency.delta >= own.latencyP95MinDeltaMs &&
      latency.candidate > latency.baseline * own.latencyP95Ratio;
    const better =
      -latency.delta >= own.latencyP95MinDeltaMs &&
      latency.baseline > latency.candidate * own.latencyP95Ratio;
    if (worse) {
      regressions.push(
        `latency p95 ${latency.baseline} → ${latency.candidate} ms (+${latency.delta} ms, ×${latency.ratio ?? "∞"})`,
      );
    }
    if (better) {
      improvements.push(
        `latency p95 ${latency.baseline} → ${latency.candidate} ms (${latency.delta} ms)`,
      );
    }
  }
  if (Number.isFinite(own.maxLatencyP95Ms) && latency.candidate > own.maxLatencyP95Ms) {
    regressions.push(
      `latency p95 ${latency.candidate} ms is over its ${own.maxLatencyP95Ms} ms ceiling`,
    );
  }
  const stall = metrics.mainStallMsP95;
  if (stall.delta !== null && stall.delta >= own.interactionMainStallMsP95MaxDelta) {
    regressions.push(`main stall p95 ${stall.baseline} → ${stall.candidate} ms in its window`);
  }
  if (stall.delta !== null && -stall.delta >= own.interactionMainStallMsP95MaxDelta) {
    improvements.push(`main stall p95 ${stall.baseline} → ${stall.candidate} ms in its window`);
  }
  if (Number.isFinite(own.maxMainStallMsP95) && stall.candidate > own.maxMainStallMsP95) {
    regressions.push(
      `main stall p95 ${stall.candidate} ms is over its ${own.maxMainStallMsP95} ms ceiling`,
    );
  }
  return { regressions, improvements };
}

function armSignalMetrics(base, next) {
  if (base === undefined || next === undefined) return null;
  return {
    mainCount: delta(base.main.count, next.main.count),
    mainMsPerRepetitionP95: delta(base.main.msPerRepetition?.p95, next.main.msPerRepetition?.p95),
    mainMax: delta(base.main.maxMs, next.main.maxMs),
    unattributedShare: delta(base.main.unattributedShare, next.main.unattributedShare),
    rendererCount: delta(base.renderer.count, next.renderer.count),
    rendererCountPerRepetitionP95: delta(
      base.renderer.countPerRepetition?.p95,
      next.renderer.countPerRepetition?.p95,
    ),
    rendererMax: delta(base.renderer.maxMs, next.renderer.maxMs),
  };
}

function armFlags(metrics, budgets) {
  const regressions = [];
  const improvements = [];
  if (metrics === null) return { regressions, improvements };
  const mainMs = metrics.mainMsPerRepetitionP95;
  if (mainMs.delta !== null && mainMs.delta >= budgets.armMainStallMsP95MaxDelta) {
    regressions.push(`main stall ms per repetition p95 ${mainMs.baseline} → ${mainMs.candidate}`);
  }
  if (mainMs.delta !== null && -mainMs.delta >= budgets.armMainStallMsP95MaxDelta) {
    improvements.push(`main stall ms per repetition p95 ${mainMs.baseline} → ${mainMs.candidate}`);
  }
  const renderer = metrics.rendererCountPerRepetitionP95;
  if (renderer.delta !== null && renderer.delta >= budgets.armRendererStallCountP95MaxDelta) {
    regressions.push(
      `renderer stalls per repetition p95 ${renderer.baseline} → ${renderer.candidate}`,
    );
  }
  if (renderer.delta !== null && -renderer.delta >= budgets.armRendererStallCountP95MaxDelta) {
    improvements.push(
      `renderer stalls per repetition p95 ${renderer.baseline} → ${renderer.candidate}`,
    );
  }
  return { regressions, improvements };
}

/**
 * The comparison itself. Arms are matched by name and interactions by id;
 * anything in only one run is listed, never compared against nothing.
 */
export function compareSummaries(baseline, candidate, options = {}) {
  const budgets = budgetsFrom(options.budgets);
  const { mismatches, warnings } = comparability(baseline, candidate);
  if (mismatches.length > 0 && options.allowMismatch !== true) {
    const error = new Error(
      `these runs are not the same experiment (pass --allow-mismatch to compare anyway):\n- ${mismatches.join("\n- ")}`,
    );
    error.mismatches = mismatches;
    throw error;
  }
  const baseArms = new Map(baseline.arms.map((arm) => [arm.name, arm]));
  const arms = [];
  const unmatched = [];
  for (const arm of candidate.arms) {
    const base = baseArms.get(arm.name);
    if (base === undefined) {
      unmatched.push(`arm ${arm.name} (candidate only)`);
      continue;
    }
    const baseInteractions = new Map(base.interactions.map((entry) => [entry.id, entry]));
    const interactions = [];
    for (const interaction of arm.interactions) {
      const before = baseInteractions.get(interaction.id);
      if (before === undefined) {
        unmatched.push(`${arm.name} / ${interaction.id} (candidate only)`);
        continue;
      }
      const metrics = interactionMetrics(before, interaction);
      interactions.push({
        id: interaction.id,
        label: interaction.label,
        metrics,
        ...interactionFlags(interaction.id, metrics, budgets),
      });
    }
    for (const id of baseInteractions.keys()) {
      if (!arm.interactions.some((entry) => entry.id === id)) {
        unmatched.push(`${arm.name} / ${id} (baseline only)`);
      }
    }
    const signals = armSignalMetrics(base.signals, arm.signals);
    arms.push({ name: arm.name, interactions, signals, ...armFlags(signals, budgets) });
  }
  for (const name of baseArms.keys()) {
    if (!candidate.arms.some((arm) => arm.name === name))
      unmatched.push(`arm ${name} (baseline only)`);
  }
  const regressions = arms.flatMap((arm) => [
    ...arm.regressions.map((flag) => `${arm.name}: ${flag}`),
    ...arm.interactions.flatMap((entry) =>
      entry.regressions.map((flag) => `${arm.name} / ${entry.id}: ${flag}`),
    ),
  ]);
  const improvements = arms.flatMap((arm) => [
    ...arm.improvements.map((flag) => `${arm.name}: ${flag}`),
    ...arm.interactions.flatMap((entry) =>
      entry.improvements.map((flag) => `${arm.name} / ${entry.id}: ${flag}`),
    ),
  ]);
  return {
    schemaVersion: 1,
    baseline: describeRun(baseline),
    candidate: describeRun(candidate),
    mismatches,
    warnings,
    budgets,
    gating: false,
    arms,
    unmatched,
    regressions,
    improvements,
  };
}

function describeRun(summary) {
  return {
    source: summary.source ?? null,
    generatedAt: summary.generatedAt ?? null,
    sha: summary.build?.sha ?? null,
    dirty: summary.build?.dirty ?? null,
    preset: summary.fixture.preset,
    seed: summary.fixture.seed,
    repetitions: summary.repetitions ?? null,
  };
}

function cell(metric, unit = "") {
  if (metric.baseline === null && metric.candidate === null) return "—";
  const sign = metric.delta !== null && metric.delta > 0 ? "+" : "";
  const change = metric.delta === null ? "" : ` (${sign}${metric.delta}${unit})`;
  return `${metric.baseline ?? "—"} → ${metric.candidate ?? "—"}${unit}${change}`;
}

function short(sha) {
  return typeof sha === "string" ? sha.slice(0, 10) : "unknown";
}

/** The comparison as Markdown. */
export function compareMarkdown(result) {
  const lines = [
    "# Desktop performance comparison",
    "",
    `Baseline: \`${short(result.baseline.sha)}\`${result.baseline.dirty ? " (dirty)" : ""} — ${result.baseline.generatedAt ?? "?"}`,
    `Candidate: \`${short(result.candidate.sha)}\`${result.candidate.dirty ? " (dirty)" : ""} — ${result.candidate.generatedAt ?? "?"}`,
    `Fixture: \`${result.candidate.preset}\`, seed \`${result.candidate.seed}\`; repetitions ${result.baseline.repetitions} → ${result.candidate.repetitions}.`,
    "",
    "Budgets are soft: a flag below is a lead to re-measure, not a failed check.",
  ];
  if (result.mismatches.length > 0) {
    lines.push("", "**Not the same experiment** (compared anyway with `--allow-mismatch`):");
    lines.push(...result.mismatches.map((entry) => `- ${entry}`));
  }
  if (result.warnings.length > 0) {
    lines.push("", "Warnings:", ...result.warnings.map((entry) => `- ${entry}`));
  }
  lines.push(
    "",
    `## Flags: ${result.regressions.length} regression(s), ${result.improvements.length} improvement(s)`,
    "",
  );
  if (result.regressions.length === 0) lines.push("No budget flagged a regression.");
  lines.push(...result.regressions.map((entry) => `- ⚠ ${entry}`));
  lines.push(...result.improvements.map((entry) => `- ✓ ${entry}`));
  for (const arm of result.arms) {
    lines.push(
      "",
      `## ${arm.name}`,
      "",
      "| Interaction | latency p50 | latency p95 | frame p95 | dropped p95 | long tasks p95 | main stall ms p95 |",
      "|---|---:|---:|---:|---:|---:|---:|",
    );
    for (const entry of arm.interactions) {
      const m = entry.metrics;
      const mark = entry.regressions.length > 0 ? " ⚠" : entry.improvements.length > 0 ? " ✓" : "";
      lines.push(
        `| ${entry.label}${mark} | ${cell(m.latencyP50, " ms")} | ${cell(m.latencyP95, " ms")} | ${cell(m.frameP95, " ms")} | ${cell(m.droppedP95)} | ${cell(m.longTasksP95)} | ${cell(m.mainStallMsP95, " ms")} |`,
      );
    }
    if (arm.signals !== null) {
      const s = arm.signals;
      lines.push(
        "",
        "| Stall signal | baseline → candidate |",
        "|---|---:|",
        `| main stalls | ${cell(s.mainCount)} |`,
        `| main stall ms per repetition p95 | ${cell(s.mainMsPerRepetitionP95, " ms")} |`,
        `| longest main stall | ${cell(s.mainMax, " ms")} |`,
        `| unattributed share | ${cell(s.unattributedShare)} |`,
        `| renderer stalls | ${cell(s.rendererCount)} |`,
        `| renderer stalls per repetition p95 | ${cell(s.rendererCountPerRepetitionP95)} |`,
        `| longest renderer stall | ${cell(s.rendererMax, " ms")} |`,
      );
    }
  }
  if (result.unmatched.length > 0) {
    lines.push(
      "",
      "Not compared (in one run only):",
      ...result.unmatched.map((entry) => `- ${entry}`),
    );
  }
  lines.push("");
  return lines.join("\n");
}

export function parseCompareArgs(argv) {
  const args = { paths: [], allowMismatch: false, failOnRegression: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--") continue;
    if (argument === "--budgets" || argument === "--output") {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--"))
        throw new Error(`${argument} requires a value`);
      args[argument === "--budgets" ? "budgets" : "output"] = value;
      index += 1;
    } else if (argument === "--allow-mismatch") args.allowMismatch = true;
    else if (argument === "--fail-on-regression") args.failOnRegression = true;
    else if (argument === "--help") args.help = true;
    else if (argument.startsWith("--")) throw new Error(`Unknown compare argument ${argument}`);
    else args.paths.push(argument);
  }
  if (!args.help && args.paths.length !== 2) {
    throw new Error("compare takes exactly two runs: BASELINE CANDIDATE");
  }
  return args;
}

export function compareUsage() {
  return [
    "Usage: pnpm bench:desktop:compare -- BASELINE CANDIDATE [options]",
    "",
    "  BASELINE, CANDIDATE    a bench:desktop output directory or its benchmark.summary.json",
    "  --budgets FILE         JSON merged over the default soft budgets",
    "  --output DIR           write compare.json and compare.md here",
    "  --allow-mismatch       compare runs of different presets/seeds/signal settings anyway",
    "  --fail-on-regression   exit 1 when a budget flags a regression (default: never gate)",
  ].join("\n");
}

async function main() {
  const args = parseCompareArgs(process.argv.slice(2));
  if (args.help) {
    console.log(compareUsage());
    return;
  }
  const [baseline, candidate] = await Promise.all(args.paths.map(readSummary));
  const budgets =
    args.budgets === undefined ? {} : JSON.parse(await fs.readFile(resolve(args.budgets), "utf8"));
  const result = compareSummaries(baseline, candidate, {
    budgets,
    allowMismatch: args.allowMismatch,
  });
  const markdown = compareMarkdown(result);
  console.log(markdown);
  if (args.output !== undefined) {
    const directory = resolve(args.output);
    await fs.mkdir(directory, { recursive: true });
    await Promise.all([
      fs.writeFile(join(directory, "compare.json"), `${JSON.stringify(result, null, 2)}\n`),
      fs.writeFile(join(directory, "compare.md"), markdown),
    ]);
    console.log(`Comparison: ${join(directory, "compare.md")}`);
  }
  if (args.failOnRegression && result.regressions.length > 0) process.exitCode = 1;
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error?.message ?? error);
    process.exitCode = 2;
  });
}

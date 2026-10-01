/**
 * The VC-478 benchmark's table: medians across trials, per task and arm.
 */

import { table } from "../parallel-tools/report";
import type { ArmRun } from "./runner";

export function median(values: readonly number[]): number {
  if (values.length === 0) return Number.NaN;
  const sorted = values.toSorted((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!;
}

function ms(value: number): string {
  if (!Number.isFinite(value)) return "—";
  return value >= 10_000 ? `${(value / 1000).toFixed(1)} s` : `${Math.round(value)} ms`;
}

function count(value: number): string {
  return Number.isFinite(value) ? Math.round(value).toLocaleString("en-US") : "—";
}

function usd(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "—";
  if (value === 0) return "$0";
  return value < 0.01 ? `$${value.toFixed(5)}` : `$${value.toFixed(4)}`;
}

/** One row per task × arm: the medians of every trial's totals. */
export function decisionTable(runs: readonly ArmRun[]): string {
  const groups = new Map<string, ArmRun[]>();
  for (const run of runs) {
    const key = `${run.task}\u0000${run.arm}\u0000${run.model}`;
    const group = groups.get(key);
    if (group === undefined) groups.set(key, [run]);
    else group.push(run);
  }
  const rows = [...groups.values()].map((trials) => {
    const first = trials[0]!;
    const accuracy = median(trials.map((trial) => (trial.correct / trial.asked) * 100));
    const failed = median(trials.map((trial) => trial.failed));
    const perDecision = median(trials.flatMap((trial) => trial.latencies));
    const costs = trials.map((trial) => trial.costUsd);
    const cost = costs.some((value) => value === null)
      ? null
      : median(costs.map((value) => value as number));
    const localTokens = first.model.startsWith("local-llama-cpp/");
    return [
      first.task,
      first.arm,
      first.model,
      String(first.decisions),
      `${accuracy.toFixed(1)}%`,
      count(failed),
      first.arm === "chat-batch" ? "—" : ms(perDecision),
      ms(median(trials.map((trial) => trial.wallMs))),
      localTokens ? "n/a" : count(median(trials.map((trial) => trial.inputTokens))),
      localTokens ? "n/a" : count(median(trials.map((trial) => trial.outputTokens))),
      usd(cost),
      String(trials.length),
    ];
  });
  return table(
    [
      "task",
      "arm",
      "model",
      "decisions",
      "correct",
      "failed",
      "p50/decision",
      "wall",
      "input tok",
      "output tok",
      "cost",
      "trials",
    ],
    rows,
  );
}

/**
 * The VC-471 benchmark tables, from the saved live runs.
 *
 *   node --experimental-strip-types packages/agent-runtime/bench/codemode/report.ts
 *
 * Reads every `results/*.json` the live lane wrote. For each model and task the
 * newest file holding that task wins, so a rerun of one task replaces only that
 * task. Tasks whose grade depends on the answer alone are graded again with the
 * current grader — a grader fixed after a run must not need a paid rerun — and
 * the multi-Session task keeps the grade it was given, which depended on what
 * the host saw. Medians throughout.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { TASKS, type TaskId } from "./tasks.ts";

interface Trial {
  task: TaskId;
  arm: string;
  correct: boolean;
  inputTokens: number;
  outputTokens: number;
  toolResultTokens: number;
  modelCalls: number;
  directCalls: number;
  nestedCalls: number;
  codemodeCalls: number;
  elapsedMs: number;
  costUsd: number;
  answer: string;
}

interface Saved {
  model: string;
  trials: number;
  results: Trial[];
}

const ANSWER_GRADED: ReadonlySet<TaskId> = new Set(["loop-filter", "browser-tabs", "single-call"]);
const ARMS = ["direct", "codemode", "codemode-only"];
const ORDER: TaskId[] = ["loop-filter", "browser-tabs", "session-fanout", "single-call"];

function median(values: readonly number[]): number {
  const sorted = values.toSorted((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

function table(headers: string[], rows: string[][]): string {
  return [
    `| ${headers.join(" | ")} |`,
    `|${headers.map((_, index) => (index < 2 ? "---" : "---:")).join("|")}|`,
    ...rows.map((row) => `| ${row.join(" | ")} |`),
  ].join("\n");
}

const directory = join(import.meta.dirname, "results");
const files = readdirSync(directory)
  .filter((name) => name.endsWith(".json"))
  .map((name) => ({ path: join(directory, name), at: statSync(join(directory, name)).mtimeMs }))
  .toSorted((left, right) => left.at - right.at);

const byModel = new Map<string, Map<TaskId, Trial[]>>();
const graders = new Map<TaskId, (answer: string) => boolean>();
for (const file of files) {
  const saved = JSON.parse(readFileSync(file.path, "utf8")) as Saved;
  const tasks = byModel.get(saved.model) ?? new Map<TaskId, Trial[]>();
  const present = new Set(saved.results.map((result) => result.task));
  for (const task of present) {
    tasks.set(
      task,
      saved.results.filter((result) => result.task === task),
    );
  }
  byModel.set(saved.model, tasks);
}

let spend = 0;
for (const [model, tasks] of byModel) {
  const rows: string[][] = [];
  for (const task of ORDER) {
    const trials = tasks.get(task);
    if (trials === undefined) continue;
    if (ANSWER_GRADED.has(task) && !graders.has(task)) graders.set(task, TASKS[task]().grade);
    const regrade = graders.get(task);
    for (const arm of ARMS) {
      const mine = trials.filter((trial) => trial.arm === arm);
      if (mine.length === 0) continue;
      const correct = mine.filter((trial) =>
        regrade ? regrade(trial.answer) : trial.correct,
      ).length;
      const pick = (field: (trial: Trial) => number) => median(mine.map(field));
      spend += mine.reduce((sum, trial) => sum + trial.costUsd, 0);
      rows.push([
        task,
        arm,
        `${correct}/${mine.length}`,
        pick((trial) => trial.inputTokens).toLocaleString("en-US"),
        pick((trial) => trial.outputTokens).toLocaleString("en-US"),
        pick((trial) => trial.toolResultTokens).toLocaleString("en-US"),
        pick((trial) => trial.modelCalls).toString(),
        pick((trial) => trial.nestedCalls).toString(),
        `${(pick((trial) => trial.elapsedMs) / 1_000).toFixed(1)} s`,
        `$${pick((trial) => trial.costUsd).toFixed(4)}`,
        `${mine.filter((trial) => trial.codemodeCalls > 0).length}/${mine.length}`,
      ]);
    }
  }
  console.log(`\n### ${model}\n`);
  console.log(
    table(
      [
        "task",
        "arm",
        "correct",
        "input tok",
        "output tok",
        "tool-result tok",
        "model calls",
        "nested calls",
        "elapsed",
        "cost",
        "used codemode",
      ],
      rows,
    ),
  );
}
console.log(`\nTotal spend across every saved trial: $${spend.toFixed(2)}`);

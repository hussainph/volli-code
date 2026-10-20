/**
 * The VC-471 benchmark tables, from the saved live runs.
 *
 *   node --experimental-strip-types packages/agent-runtime/bench/codemode/report.ts [phase2]
 *
 * Reads every `results/*.json` the live lane wrote (phase 1), or with
 * `phase2`, every `results/phase2/*.json`. Phase 1: for each model, task and
 * arm the newest file holding that cell wins, so a rerun replaces only that
 * cell. Phase 2: every file's trials are pooled, so a follow-up run of a few
 * arms adds trials to those cells rather than replacing them. Tasks whose grade depends on the answer alone are graded again with the
 * current grader — a grader fixed after a run must not need a paid rerun — and
 * the multi-Session task is graded again from the host's saved evidence
 * (`fanoutGrade`: every Ticket started, the reply exactly their handles;
 * watching is implied, as the real `session_start` watches what it opens).
 * Medians throughout.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { fanoutGrade, TASKS, type TaskId } from "./tasks.ts";

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
  evidence?: { started?: Record<string, string> };
}

interface Saved {
  model: string;
  trials: number;
  results: Trial[];
}

const ANSWER_GRADED: ReadonlySet<TaskId> = new Set([
  "loop-filter",
  "browser-tabs",
  "single-call",
  "browser-crawl",
]);
const ARMS = ["direct", "codemode", "codemode-nudge", "codemode-only"];
const ORDER: TaskId[] = [
  "loop-filter",
  "browser-tabs",
  "session-fanout",
  "single-call",
  "browser-crawl",
  "edit-loop",
];

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

const phase = process.argv.find((argument) => /^phase2b?$/u.test(argument));
const pooled = phase !== undefined;
const directory = join(import.meta.dirname, "results", ...(phase === undefined ? [] : [phase]));
const files = readdirSync(directory)
  .filter((name) => name.endsWith(".json") && statSync(join(directory, name)).isFile())
  .map((name) => ({ path: join(directory, name), at: statSync(join(directory, name)).mtimeMs }))
  .toSorted((left, right) => left.at - right.at);

const byModel = new Map<string, Map<TaskId, Trial[]>>();
const graders = new Map<TaskId, (answer: string) => boolean>();
for (const file of files) {
  const saved = JSON.parse(readFileSync(file.path, "utf8")) as Saved;
  const tasks = byModel.get(saved.model) ?? new Map<TaskId, Trial[]>();
  const present = new Set(saved.results.map((result) => result.task));
  for (const task of present) {
    // Newest wins per (task, arm): a file that reran one arm keeps the rest.
    const fresh = saved.results.filter((result) => result.task === task);
    const arms = new Set(fresh.map((result) => result.arm));
    tasks.set(task, [
      ...(tasks.get(task) ?? []).filter((result) => pooled || !arms.has(result.arm)),
      ...fresh,
    ]);
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
        regrade
          ? regrade(trial.answer)
          : task === "session-fanout" && trial.evidence !== undefined
            ? fanoutGrade(trial.answer, trial.evidence)
            : trial.correct,
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

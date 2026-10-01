/**
 * VC-471's benchmark: the same four tasks, direct tools against Code Mode,
 * through a real Session on a real model.
 *
 * Every trial is a real `createPiAgentRuntime` Session: Volli's composed system
 * prompt, the Agent Tool Surface, real `bash`/`read` against a real fixture
 * worktree, stand-in Browser and verb hosts (`tasks.ts`), durable usage
 * observations. The two arms differ in one thing — whether the Session was born
 * with Code Mode — and the model decides for itself whether to use it.
 *
 *   PI_LIVE_BENCH=1 pnpm -C packages/agent-runtime run bench:live -- codemode
 *   PI_BENCH_MODEL=anthropic/claude-haiku-4-5    # optional, provider/model
 *   PI_BENCH_TRIALS=3                            # per arm per task
 *   PI_BENCH_TASKS=loop-filter,single-call       # optional subset
 *   PI_BENCH_ARMS=direct,codemode-nudge          # optional subset of arms
 *   PI_BENCH_REASONING=low                       # default off; for models without it
 *   PI_BENCH_OUT=phase2b                         # results/ subdirectory, default phase2
 *
 * Spends real money through the developer's own Pi credentials, so it never
 * runs by default. Results print as tables and land as JSON beside this file,
 * in `results/phase2/` (phase 1's runs stay in `results/`), for the design
 * note.
 */

import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  codeModeSurfaceFor,
  DEFAULT_CODE_MODE_LIMITS,
  sessionToolIds,
  type ReasoningLevel,
  type RuntimeObservation,
  type SessionRuntimeSpec,
} from "@volli/shared";
import { countTokens } from "gpt-tokenizer/encoding/o200k_base";
import { describe, expect, it } from "vite-plus/test";

import { createPiAgentRuntime } from "../../src/pi/runtime";
import { TASKS, type TaskId } from "./tasks";

const DEFAULT_MODEL = "anthropic/claude-haiku-4-5";

/**
 * `direct`: no Code Mode. `codemode`: mode `both` — Code Mode added and every
 * other tool still declared, the model chooses. `codemode-nudge`: the same,
 * plus the system prompt's "when to write a program" paragraph (the nudge),
 * so its effect is measured on its own. `codemode-only`: mode `only` — every
 * capability group a program can call whole is reachable only through
 * programs.
 */
type Arm = "direct" | "codemode" | "codemode-nudge" | "codemode-only";
const ALL_ARMS: readonly Arm[] = ["direct", "codemode", "codemode-nudge", "codemode-only"];
const ARMS: readonly Arm[] =
  (process.env.PI_BENCH_ARMS?.split(",") as Arm[] | undefined)?.filter((arm) =>
    ALL_ARMS.includes(arm),
  ) ?? ALL_ARMS;

interface Trial {
  task: TaskId;
  arm: Arm;
  correct: boolean;
  /** Everything the model was sent, cache included: input + cache read + cache write. */
  inputTokens: number;
  outputTokens: number;
  /** Tokens of tool results that entered the model's context. */
  toolResultTokens: number;
  modelCalls: number;
  /** Tool calls the model made directly, `codemode` included. */
  directCalls: number;
  /** Calls programs made. */
  nestedCalls: number;
  codemodeCalls: number;
  elapsedMs: number;
  costUsd: number;
  answer: string;
  evidence?: Record<string, unknown>;
  failed?: string;
}

interface SidecarEntry {
  message?: { role?: string; content?: { type: string; text?: string }[] };
}

function sidecarToolResultTokens(root: string): number {
  let tokens = 0;
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith(".jsonl")) {
        for (const line of readFileSync(path, "utf8").split("\n")) {
          if (!line.includes('"toolResult"')) continue;
          // A sidecar line holds one entry or a batch of them.
          const parsed = JSON.parse(line) as SidecarEntry | SidecarEntry[];
          for (const record of Array.isArray(parsed) ? parsed : [parsed]) {
            if (record.message?.role !== "toolResult") continue;
            const text = (record.message.content ?? [])
              .map((block) => (block.type === "text" ? (block.text ?? "") : ""))
              .join("\n");
            tokens += countTokens(text);
          }
        }
      }
    }
  };
  walk(root);
  return tokens;
}

async function runTrial(
  task: TaskId,
  arm: Arm,
  providerId: string,
  modelId: string,
): Promise<Trial> {
  const run = TASKS[task]();
  const sessionDataDir = mkdtempSync(join(tmpdir(), "vc471-sessions-"));
  const observations: RuntimeObservation[] = [];
  const base: SessionRuntimeSpec = {
    identity:
      run.role === "project"
        ? {
            role: "project",
            sessionId: "vc471-bench",
            rootThreadId: "vc471-thread",
            attachmentId: "vc471-attachment",
            projectId: "vc471-project",
            ticketId: null,
          }
        : {
            role: "ticket",
            sessionId: "vc471-bench",
            rootThreadId: "vc471-thread",
            attachmentId: "vc471-attachment",
            projectId: "vc471-project",
            ticketId: "vc471-ticket",
          },
    workspacePath: run.workspacePath,
    venue: "local",
    model: {
      providerId,
      modelId,
      reasoningLevel: (process.env.PI_BENCH_REASONING ?? "off") as ReasoningLevel,
    },
    brief: { text: "VC-471 benchmark fixture. Answer exactly in the format asked." },
    tools: { tools: ["read", "edit", "write", "execute"] },
    observer: async (observation) => {
      observations.push(observation);
    },
    ...run.spec,
  };
  // No Authority Snapshot: the product default (`observe`) installs no gate,
  // so this is the path a real Session takes. The gate's own parity is
  // proven in the unit suite, not measured here.
  // The record main freezes at birth, for the arm's mode.
  const spec: SessionRuntimeSpec =
    arm === "direct"
      ? base
      : {
          ...base,
          tools: {
            ...base.tools,
            codeMode: codeModeSurfaceFor({
              tools: sessionToolIds(base),
              mode: arm === "codemode-only" ? "only" : "both",
              nudge: arm === "codemode-nudge",
              limits: DEFAULT_CODE_MODE_LIMITS,
            }),
          },
        };
  const runtime = createPiAgentRuntime({ sessionDataDir });
  const handle = await runtime.startSession(spec);
  const started = performance.now();
  let failed: string | undefined;
  try {
    await handle.submitUserMessage(run.prompt);
  } catch (error) {
    failed = error instanceof Error ? error.message : String(error);
  } finally {
    await handle.close();
  }
  const elapsedMs = performance.now() - started;
  const usage = observations.flatMap((observation) =>
    observation.kind === "usage" ? [observation.usage] : [],
  );
  const settled = observations.flatMap((observation) =>
    observation.kind === "message-settled" ? [observation.message.text] : [],
  );
  const ended = observations.flatMap((observation) =>
    observation.kind === "activity" &&
    (observation.state === "completed" || observation.state === "failed")
      ? [observation]
      : [],
  );
  const answer = settled.at(-1) ?? "";
  const failure = observations.find(
    (observation) => observation.kind === "attention" && observation.state === "raised",
  );
  return {
    task,
    arm,
    correct: failed === undefined && run.grade(answer),
    inputTokens: usage.reduce(
      (sum, one) =>
        sum + (one.inputTokens ?? 0) + (one.cacheReadTokens ?? 0) + (one.cacheWriteTokens ?? 0),
      0,
    ),
    outputTokens: usage.reduce((sum, one) => sum + (one.outputTokens ?? 0), 0),
    toolResultTokens: sidecarToolResultTokens(sessionDataDir),
    modelCalls: usage.length,
    directCalls: ended.filter((activity) => !activity.activityId.includes(":")).length,
    nestedCalls: ended.filter((activity) => activity.activityId.includes(":")).length,
    codemodeCalls: ended.filter(
      (activity) =>
        !activity.activityId.includes(":") && activity.descriptor.nativeToolName === "codemode",
    ).length,
    elapsedMs,
    costUsd: usage.reduce((sum, one) => sum + (one.costUsd ?? 0), 0),
    answer,
    ...(run.evidence === undefined ? {} : { evidence: run.evidence() }),
    ...(failed !== undefined
      ? { failed }
      : failure?.kind === "attention"
        ? { failed: failure.message }
        : {}),
  };
}

function median(values: readonly number[]): number {
  if (values.length === 0) return Number.NaN;
  const sorted = values.toSorted((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

function table(headers: string[], rows: string[][]): string {
  const widths = headers.map((header, column) =>
    Math.max(header.length, ...rows.map((row) => (row[column] ?? "").length)),
  );
  const line = (cells: string[]) =>
    `| ${cells.map((cell, column) => cell.padEnd(widths[column]!)).join(" | ")} |`;
  return [
    line(headers),
    `|${widths.map((width) => "-".repeat(width + 2)).join("|")}|`,
    ...rows.map(line),
  ].join("\n");
}

describe.skipIf(process.env.PI_LIVE_BENCH !== "1")("VC-471 Code Mode, live", () => {
  it("runs each task direct and with Code Mode, and reports medians", async () => {
    const reasoning = process.env.PI_BENCH_REASONING ?? "off";
    const [providerId = "", modelId = ""] = (process.env.PI_BENCH_MODEL ?? DEFAULT_MODEL).split(
      "/",
    );
    // The reasoning level is part of what was measured, so it names the row.
    const model = `${providerId}/${modelId}${reasoning === "off" ? "" : ` (${reasoning})`}`;
    const trials = Number(process.env.PI_BENCH_TRIALS ?? 3);
    const tasks = (process.env.PI_BENCH_TASKS?.split(",") ?? Object.keys(TASKS)) as TaskId[];
    const results: Trial[] = [];
    for (const task of tasks) {
      for (let trial = 0; trial < trials; trial += 1) {
        // Interleaved, so drift in provider latency over the run lands on
        // both arms alike.
        for (const arm of ARMS) {
          const result = await runTrial(task, arm, providerId, modelId);
          console.log(
            `[vc471] ${task} ${arm} #${trial + 1}: ${result.correct ? "correct" : "WRONG"} ` +
              `calls=${result.modelCalls} in=${result.inputTokens} results=${result.toolResultTokens} ` +
              `cm=${result.codemodeCalls} nested=${result.nestedCalls} ${Math.round(result.elapsedMs)}ms ` +
              `$${result.costUsd.toFixed(4)}${result.failed ? ` failed=${result.failed}` : ""}`,
          );
          results.push(result);
        }
      }
    }
    const rows: string[][] = [];
    for (const task of tasks) {
      for (const arm of ARMS) {
        const mine = results.filter((result) => result.task === task && result.arm === arm);
        const pick = (field: (trial: Trial) => number) => median(mine.map(field));
        rows.push([
          task,
          arm,
          `${mine.filter((trial) => trial.correct).length}/${mine.length}`,
          pick((trial) => trial.inputTokens).toFixed(0),
          pick((trial) => trial.outputTokens).toFixed(0),
          pick((trial) => trial.toolResultTokens).toFixed(0),
          pick((trial) => trial.modelCalls).toFixed(1),
          pick((trial) => trial.directCalls).toFixed(1),
          pick((trial) => trial.nestedCalls).toFixed(1),
          `${(pick((trial) => trial.elapsedMs) / 1_000).toFixed(1)}s`,
          `$${pick((trial) => trial.costUsd).toFixed(4)}`,
          `${mine.filter((trial) => trial.codemodeCalls > 0).length}/${mine.length}`,
        ]);
      }
    }
    const printed = table(
      [
        "task",
        "arm",
        "correct",
        "input tok",
        "output tok",
        "tool-result tok",
        "model calls",
        "direct calls",
        "nested calls",
        "elapsed",
        "cost",
        "used codemode",
      ],
      rows,
    );
    const spend = results.reduce((sum, trial) => sum + trial.costUsd, 0);
    console.log(
      `\n# VC-471 — ${model}, ${trials} trials per cell, medians\n\n${printed}\n\ntotal spend: $${spend.toFixed(4)}\n`,
    );
    const directory = join(import.meta.dirname, "results", process.env.PI_BENCH_OUT ?? "phase2");
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      join(
        directory,
        `${model.replace(/[^A-Za-z0-9.-]+/gu, "_")}__${process.env.PI_BENCH_TASKS === undefined ? "all" : tasks.join("+")}${process.env.PI_BENCH_ARMS === undefined ? "" : `__${ARMS.join("+")}`}.json`,
      ),
      `${JSON.stringify({ model, trials, table: printed, spend, results }, null, 2)}\n`,
    );
    expect(results).toHaveLength(tasks.length * trials * ARMS.length);
  }, 3_600_000);
});

/**
 * The VC-478 benchmark's arms: the same decisions made by a chat model and by
 * the decision service, measured the same way.
 *
 * - `chat` — one chat call per decision, the state and the questions in the
 *   prompt, a JSON answer back. The least an agent pays to decide without
 *   `classify`: a real agent turn also re-reads the whole Session context, so
 *   this arm is a LOWER bound on what deciding in-turn costs.
 * - `chat-batch` (triage only) — every item in one chat call. The cheapest a
 *   chat model can label a list, when the list fits in context.
 * - `classify` — one call per decision through the real decision service
 *   (`createDecisionService` + Pi's classifier), exactly what a Code Mode
 *   loop calling `tools.classify` does. Plus, once per run, the chat call
 *   that writes that loop — what it costs an agent to start one.
 *
 * Every arm runs its decisions with the same concurrency, and every number is
 * measured, never estimated: latency on the wall clock, tokens and cost from
 * the provider's own usage.
 */

import type { Model, Models } from "@earendil-works/pi-ai";
import type {
  DecisionAnswered,
  DecisionMiss,
  DecisionPort,
  DecisionQuestion,
  SessionUsage,
} from "@volli/shared";

import type { DecisionItem, DecisionTask } from "./tasks";

export type Arm = "chat" | "chat-batch" | "classify";

/** What one arm did over one task, in one trial. */
export interface ArmRun {
  task: string;
  arm: Arm;
  /** `provider/model` that made the decisions. */
  model: string;
  decisions: number;
  /** Answers that matched the expected value, per question asked. */
  correct: number;
  asked: number;
  /** Decisions that came back with no usable answer (error, timeout, unparsable). */
  failed: number;
  /** Per-decision latency in ms, answered decisions only: an error round trip is not a decision. Empty for the batch arm, which has one call. */
  latencies: number[];
  wallMs: number;
  inputTokens: number;
  outputTokens: number;
  /** Null when any call reported no price. */
  costUsd: number | null;
}

/** Runs `work` over `items` with at most `limit` in flight, in order of start. */
async function pool<T>(items: readonly T[], limit: number, work: (item: T) => Promise<void>) {
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next++]!;
      await work(item);
    }
  });
  await Promise.all(runners);
}

const SYSTEM_PROMPT =
  "You answer typed questions about a state for an agent. Reply with exactly one JSON object and nothing else: no prose, no code fence.";

function describeQuestion(id: string, question: DecisionQuestion): string {
  switch (question.type) {
    case "choice":
      return `- ${id} (one of: ${Object.keys(question.criteria).join(", ")}): ${question.instructions}\n${Object.entries(
        question.criteria,
      )
        .map(([key, meaning]) => `    ${key}: ${meaning}`)
        .join("\n")}`;
    case "bool":
      return `- ${id} (true or false): ${question.instructions}\n    true: ${question.criteria.true}\n    false: ${question.criteria.false}`;
    case "score":
      return `- ${id} (a level 0 to ${question.criteria.length - 1}): ${question.instructions}\n${question.criteria
        .map((level, index) => `    ${index}: ${level}`)
        .join("\n")}`;
  }
}

function replyShape(questions: Record<string, DecisionQuestion>): string {
  return `{${Object.entries(questions)
    .map(([id, question]) =>
      question.type === "bool" ? `"${id}": true|false` : `"${id}": "<${question.type}>"`,
    )
    .join(", ")}}`;
}

/** The prompt one chat decision is asked with: the same facts `classify` gets. */
export function chatPrompt(task: DecisionTask, item: DecisionItem): string {
  return [
    "State:",
    JSON.stringify(item.state, null, 1),
    "",
    "Questions:",
    ...Object.entries(task.questions).map(([id, question]) => describeQuestion(id, question)),
    "",
    `Reply as ${replyShape(task.questions)}.`,
  ].join("\n");
}

/** The first JSON object in a reply, or null. */
function firstJson(text: string): Record<string, unknown> | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    const parsed = JSON.parse(text.slice(start, end + 1)) as unknown;
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function score(expected: DecisionItem["expected"], answers: Record<string, unknown>): number {
  let correct = 0;
  for (const [id, want] of Object.entries(expected)) {
    const got = answers[id];
    if (typeof want === "boolean" ? got === want || got === String(want) : got === want) {
      correct += 1;
    }
  }
  return correct;
}

interface Meter {
  inputTokens: number;
  outputTokens: number;
  costUsd: number | null;
}

function meterChat(
  meter: Meter,
  usage:
    | {
        input: number;
        output: number;
        cacheRead: number;
        cacheWrite: number;
        cost: { total: number };
      }
    | undefined,
): void {
  meter.inputTokens += (usage?.input ?? 0) + (usage?.cacheRead ?? 0) + (usage?.cacheWrite ?? 0);
  meter.outputTokens += usage?.output ?? 0;
  const cost = usage?.cost.total;
  meter.costUsd =
    meter.costUsd === null || cost === undefined || !Number.isFinite(cost)
      ? null
      : meter.costUsd + cost;
}

function textOf(message: { content: readonly { type: string; text?: string }[] }): string {
  return message.content
    .filter((part) => part.type === "text")
    .map((part) => part.text ?? "")
    .join("");
}

export interface ChatOptions {
  models: Models;
  model: Model<string>;
  reasoning?: "minimal" | "low" | "medium" | "high";
  concurrency: number;
}

/** Arm `chat`: one chat call per decision. */
export async function runChat(task: DecisionTask, options: ChatOptions): Promise<ArmRun> {
  const meter: Meter = { inputTokens: 0, outputTokens: 0, costUsd: 0 };
  const latencies: number[] = [];
  let correct = 0;
  let failed = 0;
  const started = performance.now();
  await pool(task.items, options.concurrency, async (item) => {
    const begun = performance.now();
    const reply = await options.models.completeSimple(
      options.model,
      {
        systemPrompt: SYSTEM_PROMPT,
        messages: [{ role: "user", content: chatPrompt(task, item), timestamp: Date.now() }],
      },
      options.reasoning === undefined ? {} : { reasoning: options.reasoning },
    );
    meterChat(meter, reply.usage);
    const answers = reply.stopReason === "error" ? null : firstJson(textOf(reply));
    if (answers === null) {
      failed += 1;
    } else {
      // A decision that came back with no usable answer is a failure, not a
      // latency: an error round trip in `latencies` would put the median on
      // the cheapest way to fail.
      latencies.push(performance.now() - begun);
      correct += score(item.expected, answers);
    }
  });
  return {
    task: task.id,
    arm: "chat",
    model: `${options.model.provider}/${options.model.id}`,
    decisions: task.items.length,
    correct,
    asked: task.items.length * Object.keys(task.questions).length,
    failed,
    latencies,
    wallMs: performance.now() - started,
    ...meter,
  };
}

/**
 * Scores a chat-batch reply's `labels` against a task's known answers.
 *
 * The reply is asked for an object keyed by item index — one missing label
 * fails only its own item, instead of shifting every later one onto the
 * wrong answers. An array reply, the shape an earlier prompt asked for, is
 * still accepted and scored positionally; a short array or a missing index
 * fails the item it leaves unlabelled.
 */
export function scoreBatchLabels(
  task: DecisionTask,
  labels: unknown,
): { correct: number; failed: number } {
  const id = Object.keys(task.questions)[0]!;
  let correct = 0;
  let failed = 0;
  task.items.forEach((item, index) => {
    const label = Array.isArray(labels)
      ? labels[index]
      : typeof labels === "object" && labels !== null
        ? (labels as Record<string, unknown>)[String(index)]
        : undefined;
    if (label === undefined) failed += 1;
    else correct += score(item.expected, { [id]: label });
  });
  return { correct, failed };
}

/** Arm `chat-batch`: every item labelled in one chat call. */
export async function runChatBatch(task: DecisionTask, options: ChatOptions): Promise<ArmRun> {
  const meter: Meter = { inputTokens: 0, outputTokens: 0, costUsd: 0 };
  const [id, question] = Object.entries(task.questions)[0]!;
  const prompt = [
    "Items, one per line as `index: state`:",
    ...task.items.map((item, index) => `${index}: ${JSON.stringify(item.state)}`),
    "",
    "Question, for every item:",
    describeQuestion(id, question),
    "",
    `Reply as {"labels": {"0": "<key>", "1": "<key>", ...}} with one ${
      question.type === "bool" ? "true|false" : "key"
    } per item, keyed by item index.`,
  ].join("\n");
  const started = performance.now();
  const reply = await options.models.completeSimple(
    options.model,
    {
      systemPrompt: SYSTEM_PROMPT,
      messages: [{ role: "user", content: prompt, timestamp: Date.now() }],
    },
    options.reasoning === undefined ? {} : { reasoning: options.reasoning },
  );
  const wallMs = performance.now() - started;
  meterChat(meter, reply.usage);
  const labels = firstJson(textOf(reply))?.["labels"];
  const { correct, failed } = scoreBatchLabels(task, labels);
  return {
    task: task.id,
    arm: "chat-batch",
    model: `${options.model.provider}/${options.model.id}`,
    decisions: task.items.length,
    correct,
    asked: task.items.length,
    failed,
    latencies: [],
    wallMs,
    ...meter,
  };
}

/** The script an agent would write to run a decision loop, for the classify arm's one-off cost. */
export const LOOP_PROMPT = [
  "Write a short JavaScript async function body for a Code Mode script.",
  "`items` is an array of states. For each, call `await tools.classify({ state, questions })` with the questions below,",
  "run at most 4 calls at once, and return an array of each item's answers mapped to plain values (the choice key, or the bool value).",
  "Reply with only the code.",
].join(" ");

export interface ClassifyOptions {
  port: DecisionPort;
  /** The label for the table: `provider/model`. */
  model: string;
  concurrency: number;
  /** Bills each decision, as the desktop's ledger would. */
  usage: SessionUsage[];
  /** The one-off chat call that writes the loop; omitted, the arm has none. */
  loop?: ChatOptions;
}

/** Arm `classify`: one decision-service call per decision. */
export async function runClassify(task: DecisionTask, options: ClassifyOptions): Promise<ArmRun> {
  const meter: Meter = { inputTokens: 0, outputTokens: 0, costUsd: 0 };
  const latencies: number[] = [];
  let correct = 0;
  let failed = 0;
  const started = performance.now();
  if (options.loop !== undefined) {
    const reply = await options.loop.models.completeSimple(
      options.loop.model,
      {
        systemPrompt: "You write short JavaScript for an agent's Code Mode.",
        messages: [
          {
            role: "user",
            content: `${LOOP_PROMPT}\n\nQuestions: ${JSON.stringify(task.questions)}`,
            timestamp: Date.now(),
          },
        ],
      },
      options.loop.reasoning === undefined ? {} : { reasoning: options.loop.reasoning },
    );
    meterChat(meter, reply.usage);
  }
  const before = options.usage.length;
  await pool(task.items, options.concurrency, async (item) => {
    const begun = performance.now();
    const outcome = await options.port.decide<
      { answered: DecisionAnswered } | { miss: DecisionMiss }
    >({
      purpose: "agent.classify",
      sessionId: "bench",
      state: item.state,
      questions: task.questions,
      use: (answered) => ({ answered }),
      fallback: (miss) => ({ miss }),
    });
    // The same rule as the chat arm: a missed decision is a failure, and no
    // latency, or the median would sit on the fallback's fast path.
    if ("miss" in outcome) {
      failed += 1;
      return;
    }
    latencies.push(performance.now() - begun);
    const plain = Object.fromEntries(
      Object.entries(outcome.answered.answers).map(([id, answer]) => [
        id,
        answer.type === "bool"
          ? answer.value
          : answer.type === "choice"
            ? answer.choice
            : String(answer.level),
      ]),
    );
    correct += score(item.expected, plain);
  });
  // Usage lands asynchronously; give the last bills a tick to arrive.
  await new Promise((resolve) => setTimeout(resolve, 50));
  for (const usage of options.usage.slice(before)) {
    meter.inputTokens += (usage.inputTokens ?? 0) + (usage.cacheReadTokens ?? 0);
    meter.outputTokens += usage.outputTokens ?? 0;
    meter.costUsd =
      meter.costUsd === null || usage.costUsd === null ? null : meter.costUsd + usage.costUsd;
  }
  return {
    task: task.id,
    arm: "classify",
    model: options.model,
    decisions: task.items.length,
    correct,
    asked: task.items.length * Object.keys(task.questions).length,
    failed,
    latencies,
    wallMs: performance.now() - started,
    ...meter,
  };
}

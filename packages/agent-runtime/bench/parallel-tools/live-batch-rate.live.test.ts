/**
 * The one number the offline bench cannot produce: how often a real model puts
 * independent tool calls in a single reply.
 *
 * `parallel-tools.bench.test.ts` proved that Pi's parallel mode saves 23–51%
 * of a turn *when the model batches* and exactly nothing when it does not. So
 * the value of the flag is the batch rate, and only a real model can be asked.
 *
 * This lane also runs the cheaper half of the question as an A/B: Volli's
 * system prompt currently says nothing about batching in either direction, so
 * arm B adds one sentence permitting it. Batching saves model calls and tokens
 * whether or not the flag is ever flipped, which makes the nudge worth
 * measuring on its own.
 *
 *   PI_LIVE_BENCH=1 pnpm -C packages/agent-runtime run bench:live
 *   PI_BENCH_MODEL=anthropic/claude-haiku-4-5   # optional, provider/model
 *   PI_BENCH_TRIALS=3                           # optional, per arm per task
 *
 * Cost control, because this spends real money:
 *  - never runs by default, exactly like `smoke/live.test.ts`;
 *  - a cheap model by default;
 *  - three trials per cell, and six short tasks;
 *  - tools are latency-only, so no page is fetched and no Session is started.
 *
 * Each trial runs ONCE, in parallel mode. The model cannot observe the
 * execution mode — it sees the same results in the same order either way, as
 * the offline bench asserts — so the sequential counterfactual is computed
 * from the same measured latencies rather than paid for twice.
 */

import { Agent } from "@earendil-works/pi-agent-core";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vite-plus/test";

import { piOwnedModels } from "../../src/pi/models";
import { composeSystemPrompt } from "../../src/prompt";
import { sleep } from "./harness";
import { FALLBACK_PROFILE, type LatencyProfile } from "./scenarios";

const DEFAULT_MODEL = "anthropic/claude-haiku-4-5";
const TRIALS = Number(process.env.PI_BENCH_TRIALS ?? 3);

/**
 * The sentence arm B adds, and the whole of the treatment.
 *
 * Deliberately permissive rather than instructive: it removes a doubt the
 * model may be carrying, and it names the one safety condition that makes
 * batching correct — independence. It does not tell the model to batch, and it
 * says nothing about speed, so a model that batches more under it is
 * responding to the permission and not to pressure.
 */
const BATCH_NUDGE =
  "If you intend to call multiple tools and there are no dependencies between the calls, " +
  "make all of the independent calls in the same block, otherwise you MUST wait for previous " +
  "calls to finish before starting the next one.";

/** Latency-only stand-ins, named and described as Volli's own tools are. */
interface LiveTool {
  name: string;
  description: string;
  latencyMs: number;
  parameters: ReturnType<typeof Type.Object>;
  reply: (args: Record<string, unknown>) => string;
}

function liveTools(profile: LatencyProfile): LiveTool[] {
  return [
    {
      name: "browser_navigate",
      description:
        "Open a URL in a Browser Tab and return the page's accessibility tree. Omit tabId to open a new tab.",
      latencyMs: profile.browser,
      parameters: Type.Object({
        url: Type.String({ description: "The http or https URL to open." }),
        tabId: Type.Optional(Type.String()),
      }),
      reply: (args) =>
        `Tab loaded ${String(args["url"])}. Title: "Example Domain". Body: this domain is for use in illustrative examples. Status: 200.`,
    },
    {
      name: "web_search",
      description: "Search the web and return a short list of titles, URLs and snippets.",
      latencyMs: profile.network,
      parameters: Type.Object({ query: Type.String() }),
      reply: (args) => {
        const query = String(args["query"]);
        return [
          `1. "${query} — overview" https://example.com/a — a general introduction.`,
          `2. "${query} in practice" https://example.org/b — published 2019, considered outdated.`,
          `3. "${query} reference" https://example.net/c — published 2024, current.`,
        ].join("\n");
      },
    },
    {
      name: "read",
      description: "Read the contents of a file.",
      latencyMs: profile.localFile,
      parameters: Type.Object({ path: Type.String() }),
      // package.json really does name its `main`, so the dependent-chain task
      // has a genuine dependency to respect rather than a dead end it has to
      // improvise around. Everything else answers with a version line, which
      // is all the config-agreement tasks need.
      reply: (args) => {
        const path = String(args["path"]);
        if (path.endsWith("package.json")) {
          return '{\n  "name": "volli-code",\n  "version": "2.1.0",\n  "main": "dist/entry.js"\n}\n';
        }
        if (path.endsWith("dist/entry.js")) {
          return "// entry: boots the desktop host\nimport { boot } from './host';\nboot();\n";
        }
        return `# ${path}\nversion: 2.1.0\nstatus: active\n`;
      },
    },
  ];
}

/** One assistant reply's tool-call count, in order. */
interface TrialRecord {
  /** Tool calls per assistant message, for messages that called tools. */
  batches: number[];
  toolCalls: number;
  modelCalls: number;
  /**
   * Everything the model had to be given, cache included.
   *
   * `usage.input` alone is NOT that number on a caching provider: Anthropic
   * reports cache hits under `cacheRead` and bills them separately, so a
   * cached Sonnet turn reports single-digit `input` for a prompt of thousands
   * of tokens. Summing the three is the only reading that means the same
   * thing across providers and across a warm or cold cache.
   */
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  /** Real elapsed time, run in parallel mode. */
  parallelMs: number;
  /** Counterfactual: the same calls run one at a time, from the same latencies. */
  sequentialMs: number;
  failed?: string;
}

interface LiveTask {
  id: string;
  prompt: string;
  /**
   * What batching would mean for this task.
   *
   * `independent` — the subtasks do not depend on each other, so batching is
   * correct and a high rate is the win.
   * `dependent` — the second call needs the first call's result, so batching
   * would be a CORRECTNESS BUG. A high rate here is a reason not to flip the
   * flag, which is why the set contains one.
   * `single` — one call; the control.
   */
  shape: "independent" | "dependent" | "single";
}

const TASKS: LiveTask[] = [
  // --- explicitly enumerated: the easy case, and the one a sceptic will say
  // was led. Kept so the harder cases below have something to be compared to.
  {
    id: "four-tabs-enumerated",
    shape: "independent",
    prompt:
      "Open these four pages and tell me, in one line each, what each one is: " +
      "https://example.com/alpha, https://example.com/beta, https://example.com/gamma, https://example.com/delta",
  },
  {
    id: "three-searches-enumerated",
    shape: "independent",
    prompt:
      "Search the web separately for 'sqlite wal mode', 'electron context isolation' and " +
      "'node worker threads', then tell me which of the three has the most current reference.",
  },
  // --- naturally phrased: independence is implied by the goal, not spelled
  // out as a list. This is what a real request looks like.
  {
    id: "implicit-config-check",
    shape: "independent",
    prompt:
      "Do our package.json, tsconfig.json and README.md still agree with each other about the version? " +
      "I need to know before I cut a release.",
  },
  {
    id: "implicit-research",
    shape: "independent",
    prompt:
      "I'm writing a note on our Electron setup. Find out what the current advice is on " +
      "sqlite WAL mode and on Electron context isolation.",
  },
  // --- the correctness control. The second read cannot be issued until the
  // first has been read, so a model that batches here is wrong, not fast.
  {
    id: "dependent-chain",
    shape: "dependent",
    prompt:
      'Read package.json, find the file path it lists under its "main" field, then read that file ' +
      "and tell me its first line.",
  },
  {
    id: "single-call-control",
    shape: "single",
    prompt: "Read package.json and tell me the version.",
  },
];

function toolFor(spec: LiveTool, onCall: (latencyMs: number) => void): AgentTool {
  return {
    name: spec.name,
    label: spec.name,
    description: spec.description,
    parameters: spec.parameters,
    execute: async (_toolCallId: string, params: Record<string, unknown>) => {
      onCall(spec.latencyMs);
      await sleep(spec.latencyMs);
      return {
        content: [{ type: "text" as const, text: spec.reply(params ?? {}) }],
        isError: false,
      };
    },
  } as unknown as AgentTool;
}

async function runTrial(
  task: LiveTask,
  systemPrompt: string,
  providerId: string,
  modelId: string,
  profile: LatencyProfile,
): Promise<TrialRecord> {
  const models = piOwnedModels();
  const model = models.getModel(providerId, modelId);

  const record: TrialRecord = {
    batches: [],
    toolCalls: 0,
    modelCalls: 0,
    inputTokens: 0,
    outputTokens: 0,
    costUsd: 0,
    parallelMs: 0,
    sequentialMs: 0,
  };

  // Per-assistant-message latency bookkeeping: parallel pays the slowest call
  // in the batch, sequential pays the sum. Both are exact for latency-only
  // tools, so the counterfactual needs no second paid run.
  let batchLatencies: number[] = [];
  const settleBatch = (): void => {
    if (batchLatencies.length === 0) return;
    record.sequentialMs += batchLatencies.reduce((total, value) => total + value, 0);
    record.parallelMs += Math.max(...batchLatencies);
    batchLatencies = [];
  };

  const tools = liveTools(profile).map((spec) =>
    toolFor(spec, (latencyMs) => {
      batchLatencies.push(latencyMs);
    }),
  );

  const agent = new Agent({
    initialState: { systemPrompt, model, tools, messages: [] },
    streamFn: models.streamSimple.bind(models),
    toolExecution: "parallel",
  });

  agent.subscribe((event) => {
    if (event.type !== "message_end") return;
    const message = event.message;
    if (message.role !== "assistant") return;
    const assistant = message as AssistantMessage;
    const calls = assistant.content.filter((part) => part.type === "toolCall").length;
    record.modelCalls += 1;
    record.inputTokens +=
      (assistant.usage?.input ?? 0) +
      (assistant.usage?.cacheRead ?? 0) +
      (assistant.usage?.cacheWrite ?? 0);
    record.outputTokens += assistant.usage?.output ?? 0;
    record.costUsd += assistant.usage?.cost?.total ?? 0;
    if (calls > 0) {
      record.batches.push(calls);
      record.toolCalls += calls;
    }
  });

  // Batches settle as each assistant message's tools finish. `turn_end` is the
  // boundary Pi guarantees for that.
  agent.subscribe((event) => {
    if (event.type === "turn_end") settleBatch();
  });

  const startedAt = Date.now();
  try {
    await agent.prompt(task.prompt);
  } catch (error) {
    record.failed = error instanceof Error ? error.message : String(error);
  }
  settleBatch();
  // Real elapsed time is reported for reference only; the comparable number is
  // the modelled one, because provider latency dwarfs the tool latency here and
  // varies run to run.
  void (Date.now() - startedAt);
  return record;
}

interface ArmSummary {
  arm: string;
  task: string;
  shape: LiveTask["shape"];
  trials: number;
  /** Share of tool-calling replies that carried two or more calls. */
  batchedReplyShare: number;
  /** Share of tool calls that could have overlapped: (calls - replies) / calls. */
  overlappableShare: number;
  meanToolCalls: number;
  meanModelCalls: number;
  meanInputTokens: number;
  meanCostUsd: number;
  meanSequentialMs: number;
  meanParallelMs: number;
  failures: number;
}

function summarize(arm: string, task: LiveTask, records: TrialRecord[]): ArmSummary {
  const ok = records.filter((record) => record.failed === undefined);
  const mean = (pick: (record: TrialRecord) => number): number =>
    ok.length === 0 ? 0 : ok.reduce((total, record) => total + pick(record), 0) / ok.length;

  const replies = ok.flatMap((record) => record.batches);
  const totalCalls = replies.reduce((total, count) => total + count, 0);
  const batchedReplies = replies.filter((count) => count >= 2).length;

  return {
    arm,
    task: task.id,
    shape: task.shape,
    trials: ok.length,
    batchedReplyShare: replies.length === 0 ? 0 : batchedReplies / replies.length,
    overlappableShare: totalCalls === 0 ? 0 : (totalCalls - replies.length) / totalCalls,
    meanToolCalls: mean((record) => record.toolCalls),
    meanModelCalls: mean((record) => record.modelCalls),
    meanInputTokens: mean((record) => record.inputTokens),
    meanCostUsd: mean((record) => record.costUsd),
    meanSequentialMs: mean((record) => record.sequentialMs),
    meanParallelMs: mean((record) => record.parallelMs),
    failures: records.length - ok.length,
  };
}

function table(headers: string[], rows: string[][]): string {
  const widths = headers.map((header, column) =>
    Math.max(header.length, ...rows.map((row) => (row[column] ?? "").length)),
  );
  const line = (cells: string[]): string =>
    `| ${cells.map((cell, column) => (cell ?? "").padEnd(widths[column]!)).join(" | ")} |`;
  return [
    line(headers),
    `|${widths.map((width) => "-".repeat(width + 2)).join("|")}|`,
    ...rows.map((row) => line(row)),
  ].join("\n");
}

describe.skipIf(process.env.PI_LIVE_BENCH !== "1")("live batch rate", () => {
  it("measures how often a real model batches, with and without the prompt nudge", async () => {
    const [providerId = "", modelId = ""] = (process.env.PI_BENCH_MODEL ?? DEFAULT_MODEL).split(
      "/",
    );
    const profile = FALLBACK_PROFILE;

    // Volli's real composed system prompt, so arm A is the product's own
    // batching propensity rather than a bare prompt's.
    const basePrompt = composeSystemPrompt({
      role: "ticket",
      tools: { tools: ["read"] },
    });
    const arms: { name: string; prompt: string }[] = [
      { name: "A: Volli prompt as shipped", prompt: basePrompt },
      { name: "B: + batch permission", prompt: `${basePrompt}\n\n${BATCH_NUDGE}` },
    ];

    const summaries: ArmSummary[] = [];
    for (const arm of arms) {
      for (const task of TASKS) {
        const records: TrialRecord[] = [];
        for (let trial = 0; trial < TRIALS; trial += 1) {
          records.push(await runTrial(task, arm.prompt, providerId, modelId, profile));
        }
        summaries.push(summarize(arm.name, task, records));
      }
    }

    const rows = summaries.map((summary) => [
      summary.arm,
      summary.task,
      summary.shape,
      String(summary.trials),
      `${(summary.batchedReplyShare * 100).toFixed(0)}%`,
      `${(summary.overlappableShare * 100).toFixed(0)}%`,
      summary.meanToolCalls.toFixed(1),
      summary.meanModelCalls.toFixed(1),
      summary.meanInputTokens.toFixed(0),
      `$${summary.meanCostUsd.toFixed(5)}`,
      `${summary.meanSequentialMs.toFixed(0)}ms`,
      `${summary.meanParallelMs.toFixed(0)}ms`,
      summary.failures === 0 ? "-" : String(summary.failures),
    ]);

    console.log(`\n# Live batch rate — ${providerId}/${modelId}, ${TRIALS} trials per cell\n`);
    console.log(
      table(
        [
          "arm",
          "task",
          "shape",
          "n",
          "batched replies",
          "overlappable calls",
          "tool calls",
          "model calls",
          "input tok",
          "cost",
          "tool time (seq)",
          "tool time (par)",
          "fail",
        ],
        rows,
      ),
    );

    // Totals are taken over the independent tasks only: averaging the
    // dependent control and the single-call control into a "batch rate" would
    // understate the real one, since neither task should batch at all.
    const armTotals = arms.map((arm) => {
      const mine = summaries.filter(
        (summary) => summary.arm === arm.name && summary.shape === "independent",
      );
      const mean = (pick: (summary: ArmSummary) => number): number =>
        mine.reduce((total, summary) => total + pick(summary), 0) / mine.length;
      return {
        arm: arm.name,
        batched: mean((summary) => summary.batchedReplyShare),
        overlappable: mean((summary) => summary.overlappableShare),
        modelCalls: mean((summary) => summary.meanModelCalls),
        inputTokens: mean((summary) => summary.meanInputTokens),
        cost: mean((summary) => summary.meanCostUsd),
      };
    });

    console.log("\n## Arm totals (independent tasks only)\n");
    console.log(
      table(
        ["arm", "batched replies", "overlappable calls", "model calls", "input tok", "cost"],
        armTotals.map((total) => [
          total.arm,
          `${(total.batched * 100).toFixed(0)}%`,
          `${(total.overlappable * 100).toFixed(0)}%`,
          total.modelCalls.toFixed(1),
          total.inputTokens.toFixed(0),
          `$${total.cost.toFixed(5)}`,
        ]),
      ),
    );

    const spend = summaries.reduce(
      (total, summary) => total + summary.meanCostUsd * summary.trials,
      0,
    );
    console.log(`\ntotal spend: $${spend.toFixed(4)}\n`);

    // The dependent control is the one cell with a right answer: a model that
    // batches a call on a result it does not yet have is wrong, and parallel
    // mode would execute that mistake concurrently rather than catching it.
    const dependent = summaries.filter((summary) => summary.shape === "dependent");
    for (const summary of dependent) {
      console.log(
        `dependent-chain batching under "${summary.arm}": ` +
          `${(summary.batchedReplyShare * 100).toFixed(0)}% of replies carried 2+ calls`,
      );
    }

    // The lane is a measurement, so it asserts only that it measured something:
    // every cell ran, and at least one tool call happened somewhere. What the
    // batch rate turns out to be is the finding, not a pass condition.
    expect(summaries).toHaveLength(arms.length * TASKS.length);
    expect(summaries.some((summary) => summary.meanToolCalls > 0)).toBe(true);
  }, 1_800_000);
});

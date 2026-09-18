/**
 * What `@volli/agent-runtime` itself spends on one turn (VC-356).
 *
 * The subject is CPU this package owns and the rest of the app waits on:
 * prompt assembly, the context projection every compaction and output-ceiling
 * check makes, and the normalization that turns one finished tool call into a
 * bounded activity payload. Provider latency and real tool execution dominate
 * a turn's wall clock and are deliberately absent — they cannot be measured
 * without spending money, and `bench:live` is where that lane lives.
 *
 * The boundary is the point. What the Session Engine then does with an
 * observation — translate it, fold it, append it — is measured in
 * `packages/session-engine/src/turn-write-cost.bench.test.ts`, in the package
 * that owns it. The Agent Runtime emits observations and never holds durable
 * Session state, so a probe here that reached into the Engine would be pricing
 * someone else's code across a package boundary it does not depend on.
 */

import { execFileSync } from "node:child_process";
import { cpus, freemem, hostname, platform, release, totalmem } from "node:os";

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Api, AssistantMessage, Model, Tool, Usage } from "@earendil-works/pi-ai";
import type { PromptResource, RuntimeToolBundle } from "@volli/shared";

import { composeFirstUserMessage, composeSystemPrompt } from "../../src/prompt";
import { mapPiActivity } from "../../src/pi/activity";
import { createContextTokenProjector } from "../../src/pi/token-counting";
import { table } from "./report";
import { measureSync, type TimingSummary } from "./runtime-cost-measure";

export interface RuntimeCostReport {
  schemaVersion: 1;
  generatedAt: string;
  revision: string;
  machine: {
    hostname: string;
    platform: string;
    release: string;
    architecture: string;
    cpu: string;
    logicalCpus: number;
    totalMemoryBytes: number;
    freeMemoryBytes: number;
    node: string;
  };
  fixturePreset: "runtime-long-turn-v1";
  /**
   * Operations per timed batch, relative to the fixture's own base counts.
   *
   * Recorded because it changes the ANSWER, not just how long the run takes: a
   * batch of one op prices `performance.now()` alongside the work, so the same
   * code reads several times slower at 0.2x than at the published 20x. Two
   * tables are comparable only at equal scale, and a table that did not carry
   * its scale could not say so.
   */
  operationScale: number;
  loadArm: string;
  concurrencyHint: number | null;
  samples: TimingSummary[];
}

const usage = (): Usage => ({
  input: 12_000,
  output: 400,
  cacheRead: 2_000,
  cacheWrite: 0,
  totalTokens: 14_400,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});

const model = {
  id: "claude-fable-5-1",
  name: "Claude Fable 5.1",
  api: "anthropic-messages",
  provider: "anthropic",
  baseUrl: "https://api.anthropic.com",
  reasoning: true,
  input: ["text", "image"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 200_000,
  maxTokens: 64_000,
} as Model<Api>;

const assistant = (index: number): AssistantMessage => ({
  role: "assistant",
  content: [
    {
      type: "text",
      text: `Reply ${index}: ${"The implementation keeps the durable contract unchanged. ".repeat(10)}`,
    },
    {
      type: "toolCall",
      id: `call-${index}`,
      name: "read",
      arguments: { path: `packages/example-${index}.ts`, offset: index + 1, limit: 200 },
    },
  ],
  api: "anthropic-messages",
  provider: "anthropic",
  // Deliberately another model: the model-switch path has no reusable provider
  // measurement and must estimate the full conversation before its first call.
  model: "claude-previous-model",
  usage: usage(),
  stopReason: "toolUse",
  timestamp: index,
});

function conversationFixture(): AgentMessage[] {
  const messages: AgentMessage[] = [];
  for (let index = 0; index < 160; index += 1) {
    messages.push({
      role: "user",
      content:
        `Turn ${index}: inspect the implementation and preserve behavior.\n` +
        "const fixture = { path: 'src/example.ts', enabled: true };\n".repeat(18),
      timestamp: index,
    });
    messages.push(assistant(index));
    messages.push({
      role: "toolResult",
      toolCallId: `call-${index}`,
      toolName: "read",
      content: [
        {
          type: "text",
          text: `export const value${index} = ${index}; // deterministic fixture\n`.repeat(20),
        },
      ],
      isError: false,
      timestamp: index,
    });
  }
  return messages;
}

const tools = Array.from({ length: 20 }, (_, index): Tool => ({
  name: `fixture_tool_${index}`,
  description: `Fixture tool ${index}. ${"A deterministic schema description. ".repeat(12)}`,
  parameters: {
    type: "object",
    properties: Object.fromEntries(
      Array.from({ length: 10 }, (__, field) => [
        `field_${field}`,
        { type: "string", description: `Field ${field} for tool ${index}` },
      ]),
    ),
  } as Tool["parameters"],
}));

const bundle: RuntimeToolBundle = {
  tools: ["read", "edit", "write", "execute"],
  verbs: ["session.start", "session.await", "session.delegate"],
};

const resources: PromptResource[] = Array.from({ length: 6 }, (_, index) => ({
  name: `fixture-resource-${index}`,
  text: `# Fixture resource ${index}\n\n${"Keep this deterministic and bounded.\n".repeat(120)}`,
}));

const systemPrompt = composeSystemPrompt({
  role: "ticket",
  tools: bundle,
  promptResources: resources,
});
const firstMessageSpec = {
  identity: { role: "ticket" as const },
  brief: {
    text: `Work in the fixture repository.\n${"Measure before changing behavior.\n".repeat(120)}`,
  },
  tools: bundle,
  workspaceEnvironment: { dependencies: "absent" as const, installCommand: "pnpm install" },
};

/**
 * Clean tool output, shaped like what a coding agent's tools actually return.
 *
 * Source lines rather than prose, deliberately: redaction's cost is driven by
 * how often `-`, `_`, `:` and `=` appear, and prose has almost none of them.
 * A punctuation-free fixture makes the secret scan look cheap and would hide a
 * regression on every `read` and `execute` result the runtime really handles.
 */
function cleanOutputBlock(index: number): string {
  return Array.from(
    { length: 24 },
    (_, line) =>
      `export const session_id_${index}_${line}: string = "sess-${line}"; // read-only path`,
  ).join("\n");
}

function activityEvent(): unknown {
  const cleanBlocks = Array.from({ length: 32 }, (_, index) => ({
    type: "text",
    text: cleanOutputBlock(index),
  }));
  return {
    type: "tool_execution_end",
    toolName: "read",
    toolCallId: "call-profile",
    isError: false,
    result: {
      content: cleanBlocks,
      details: {
        path: "packages/agent-runtime/src/pi/runtime.ts",
        patch: `--- a/runtime.ts\n+++ b/runtime.ts\n${"+const measured = true;\n".repeat(700)}`,
        ...Object.fromEntries(
          Array.from({ length: 40 }, (_, index) => [
            `detail_${index}`,
            `detail value ${index} ${"plain fixture data ".repeat(20)}`,
          ]),
        ),
      },
    },
  };
}

function revision(): string {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

function positiveInteger(value: string | undefined): number | null {
  if (value === undefined) return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

/**
 * The two arms this bench has, named rather than hidden behind a flag.
 *
 * `published` is the arm every number in `docs/research/` was taken at, and
 * the only arm whose figures may be quoted. `probe` is the fast regression
 * lane: same fixture and same code path, small enough to sit in the default
 * bench run, and honest about the fact that its batches are too short to
 * separate the work from the timer. Quoting a probe figure as a published one
 * is the mistake the split exists to prevent, so the arm travels in the report
 * and prints above the table.
 */
/**
 * The long settled context the projection sample runs against, handed out so
 * the bench's assertions exercise the very fixture its table is timed on. A
 * property proved against a different fixture proves nothing about the table.
 */
export function longContextFixture(): {
  messages: AgentMessage[];
  model: Model<Api>;
  systemPrompt: string;
  tools: readonly Tool[];
} {
  return { messages: conversationFixture(), model, systemPrompt, tools };
}

export const RUNTIME_COST_ARMS = {
  published: { samples: 20, operationScale: 20 },
  probe: { samples: 5, operationScale: 0.2 },
} as const satisfies Record<string, { samples: number; operationScale: number }>;

export type RuntimeCostArm = keyof typeof RUNTIME_COST_ARMS;

/** The arm `BENCH_ARM` names, or the fast probe when it names nothing valid. */
export function runtimeCostArm(value = process.env["BENCH_ARM"]): RuntimeCostArm {
  return value === "published" ? "published" : "probe";
}

export function buildRuntimeCostReport(
  options: {
    samples?: number;
    operationScale?: number;
  } = {},
): RuntimeCostReport {
  const samples = options.samples ?? positiveInteger(process.env["BENCH_SAMPLES"]) ?? 25;
  const operationScale = options.operationScale ?? 1;
  const operations = (base: number): number => Math.max(1, Math.floor(base * operationScale));
  const messages = conversationFixture();
  const contextTokenProjector = createContextTokenProjector();
  const event = activityEvent();

  const timings: TimingSummary[] = [];
  timings.push(
    measureSync(
      {
        name: "prompt.system-assembly",
        waiting: "user",
        fixture: "ticket role, 6 prompt resources, full frozen tool bundle",
        operationsPerSample: operations(200),
        samples,
      },
      () =>
        composeSystemPrompt({ role: "ticket", tools: bundle, promptResources: resources }).length,
    ),
  );
  timings.push(
    measureSync(
      {
        name: "prompt.first-message-assembly",
        waiting: "user",
        fixture: "4 KB brief, tool-surface block, dependency reminder",
        operationsPerSample: operations(500),
        samples,
      },
      () => composeFirstUserMessage(firstMessageSpec, "Begin the measured turn.").length,
    ),
  );
  timings.push(
    measureSync(
      {
        name: "turn.context-projection-model-switch",
        waiting: "user",
        fixture: "480-message / ~450 KB context, 20 tool schemas, no reusable usage",
        operationsPerSample: operations(2),
        samples,
      },
      () => contextTokenProjector(messages, model, systemPrompt, tools),
    ),
  );
  timings.push(
    measureSync(
      {
        name: "tool.activity-normalization",
        waiting: "user",
        fixture: "completed read, bounded source-shaped nested output and 16 KB patch",
        operationsPerSample: operations(8),
        samples,
      },
      () =>
        mapPiActivity(event, {
          turnId: "turn-profile",
          input: { path: "packages/agent-runtime/src/pi/runtime.ts", offset: 1, limit: 200 },
          startedAt: 900,
          observedAt: 1_000,
        }).activityId.length,
    ),
  );
  const cpu = cpus();
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    revision: revision(),
    machine: {
      hostname: hostname(),
      platform: platform(),
      release: release(),
      architecture: process.arch,
      cpu: cpu[0]?.model ?? "unknown",
      logicalCpus: cpu.length,
      totalMemoryBytes: totalmem(),
      freeMemoryBytes: freemem(),
      node: process.version,
    },
    fixturePreset: "runtime-long-turn-v1",
    operationScale,
    loadArm: process.env["BENCH_LOAD_ARM"] ?? "idle",
    concurrencyHint: positiveInteger(process.env["VOLLI_CONCURRENCY_HINT"]),
    samples: timings,
  };
}

/**
 * Above this relative standard deviation a figure is describing the machine,
 * not the code, and must not be quoted as a result. A shared machine under
 * load routinely puts these benchmarks past it, which is the failure this
 * exists to make visible: a quiet-looking table with a noisy figure in it is
 * how a wrong number ends up in a design note.
 */
const QUOTABLE_RSD = 0.2;

export function formatRuntimeCostReport(report: RuntimeCostReport): string {
  const noisy = report.samples.filter((sample) => sample.relativeStandardDeviation > QUOTABLE_RSD);
  return [
    "# Agent Runtime cost profile (VC-356)",
    "",
    `revision: ${report.revision}`,
    `machine: ${report.machine.cpu}, ${report.machine.logicalCpus} logical CPUs, ${Math.round(report.machine.totalMemoryBytes / 2 ** 30)} GiB, ${report.machine.platform} ${report.machine.release}, Node ${report.machine.node}`,
    `fixture: ${report.fixturePreset}; scale: ${report.operationScale}\u00d7; load arm: ${report.loadArm}; VOLLI_CONCURRENCY_HINT=${report.concurrencyHint ?? "unset"}`,
    "",
    table(
      ["path", "benchmark", "p50 us", "p95 us", "RSD", ""],
      report.samples.map((sample) => [
        sample.waiting,
        sample.name,
        sample.p50Us.toFixed(1),
        sample.p95Us.toFixed(1),
        `${(sample.relativeStandardDeviation * 100).toFixed(1)}%`,
        sample.relativeStandardDeviation > QUOTABLE_RSD ? "too noisy to quote" : "",
      ]),
    ),
    ...(noisy.length === 0
      ? []
      : [
          "",
          `${noisy.length} of ${report.samples.length} figures exceeded ${QUOTABLE_RSD * 100}% RSD.`,
          "Re-run on a quiet machine before quoting them. The assertions in",
          "runtime-cost.bench.test.ts count work rather than time and hold either way.",
        ]),
  ].join("\n");
}

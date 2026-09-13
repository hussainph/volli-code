import { execFileSync } from "node:child_process";
import { cpus, freemem, hostname, platform, release, totalmem } from "node:os";

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Api, AssistantMessage, Model, Tool, Usage } from "@earendil-works/pi-ai";
import type { PromptResource, RuntimeObservation, RuntimeToolBundle } from "@volli/shared";

import { RuntimeObservationTranslator } from "../../../session-engine/src/observation-translation";
import { composeFirstUserMessage, composeSystemPrompt } from "../../src/prompt";
import { mapPiActivity } from "../../src/pi/activity";
import { createContextTokenProjector } from "../../src/pi/token-counting";
import { measureAsync, measureSync, type TimingSummary } from "./runtime-cost-measure";

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

function activityEvent(): unknown {
  const cleanBlocks = Array.from({ length: 32 }, (_, index) => ({
    type: "text",
    text: `Block ${index}: ${"ordinary tool output without credentials ".repeat(28)}`,
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

async function emitTranslated(translated: { id: string }): Promise<void> {
  if (translated.id.length === Number.MIN_SAFE_INTEGER) console.log(translated.id);
}

export async function buildRuntimeCostReport(
  options: {
    samples?: number;
    operationScale?: number;
  } = {},
): Promise<RuntimeCostReport> {
  const samples = options.samples ?? positiveInteger(process.env["BENCH_SAMPLES"]) ?? 25;
  const operationScale = options.operationScale ?? 1;
  const operations = (base: number): number => Math.max(1, Math.floor(base * operationScale));
  const messages = conversationFixture();
  const contextTokenProjector = createContextTokenProjector();
  const event = activityEvent();
  const translator = new RuntimeObservationTranslator({
    namespace: "pi",
    sessionId: "session-profile",
    attachmentId: "attachment-profile",
    now: () => 1_000,
  });
  await translator.translate(
    { kind: "turn", state: "started", turnId: "turn-profile" },
    emitTranslated,
  );
  const delta: RuntimeObservation = {
    kind: "delta",
    turnId: "turn-profile",
    channel: "text",
    text: "deterministic streamed text ",
  };

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
      () => contextTokenProjector.projectedContextTokens(messages, model, systemPrompt, tools),
    ),
  );
  timings.push(
    measureSync(
      {
        name: "tool.activity-normalization",
        waiting: "user",
        fixture: "completed read, bounded 64 KB nested output and 16 KB patch",
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
  timings.push(
    await measureAsync(
      {
        name: "stream.delta-translation",
        waiting: "user",
        fixture: "steady-state text delta, no durable sink work",
        operationsPerSample: operations(500),
        samples,
      },
      async () => {
        await translator.translate(delta, emitTranslated);
        return 1;
      },
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
    loadArm: process.env["BENCH_LOAD_ARM"] ?? "idle",
    concurrencyHint: positiveInteger(process.env["VOLLI_CONCURRENCY_HINT"]),
    samples: timings,
  };
}

function pad(value: string, width: number): string {
  return value.padEnd(width, " ");
}

export function formatRuntimeCostReport(report: RuntimeCostReport): string {
  const rows = report.samples.map((sample) => [
    sample.waiting,
    sample.name,
    sample.p50Us.toFixed(1),
    sample.p95Us.toFixed(1),
    `${(sample.relativeStandardDeviation * 100).toFixed(1)}%`,
  ]);
  const headers = ["path", "benchmark", "p50 us", "p95 us", "RSD"];
  const widths = headers.map((header, column) =>
    Math.max(header.length, ...rows.map((row) => row[column]?.length ?? 0)),
  );
  const line = (cells: readonly string[]): string =>
    `| ${cells.map((cell, column) => pad(cell, widths[column] ?? cell.length)).join(" | ")} |`;
  return [
    "# Agent Runtime cost profile (VC-356)",
    "",
    `revision: ${report.revision}`,
    `machine: ${report.machine.cpu}, ${report.machine.logicalCpus} logical CPUs, ${Math.round(report.machine.totalMemoryBytes / 2 ** 30)} GiB, ${report.machine.platform} ${report.machine.release}, Node ${report.machine.node}`,
    `fixture: ${report.fixturePreset}; load arm: ${report.loadArm}; VOLLI_CONCURRENCY_HINT=${report.concurrencyHint ?? "unset"}`,
    "",
    line(headers),
    `|${widths.map((width) => "-".repeat(width + 2)).join("|")}|`,
    ...rows.map(line),
  ].join("\n");
}

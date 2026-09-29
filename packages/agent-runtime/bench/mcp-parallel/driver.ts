/**
 * VC-444's Pi-facing half of the fixture-only MCP parallel-dispatch benchmark.
 *
 * This module is reachable only through the `@volli/agent-runtime/bench/mcp-parallel`
 * subpath and is never imported by the shipping runtime. It owns everything
 * that speaks Pi — the real `Agent` loop, the VC-245 scripted provider, and the
 * Volli MCP tool wrapper — and takes the MCP side as a plain
 * {@link RuntimeMcpPort}. The composition that binds that port to the desktop
 * `McpSessionHost` and a local Streamable HTTP fixture server lives in the app
 * (`apps/desktop/e2e/bench/mcp-parallel/`), so the dependency points app →
 * package and never the other way.
 */
import { writeFileSync } from "node:fs";
import { Agent, type AgentTool, type ToolExecutionMode } from "@earendil-works/pi-agent-core";
import { Type, type Model } from "@earendil-works/pi-ai";
import type { McpToolDefinition, RuntimeMcpPort } from "@volli/shared";
import { countTokens } from "gpt-tokenizer/encoding/o200k_base";

import { createMcpTool } from "../../src/pi/tools";
import { scriptedProvider, sleep, type ScriptedReply } from "../parallel-tools/harness";

export type BatchShape = "batched" | "unbatched";

/** A synthetic model descriptor; the scripted provider never contacts it. */
const FIXTURE_MODEL = {
  id: "vc444-fixture-model",
  api: "anthropic-messages",
  provider: "vc444-fixture",
  name: "VC-444 fixture model",
  reasoning: false,
  contextWindow: 200_000,
  maxTokens: 8_192,
  cost: { input: 3, output: 15, cacheRead: 0, cacheWrite: 0 },
} as unknown as Model<string>;

/** Exact `serverId:toolName` keys a host has audited as idempotent reads. */
export type McpParallelAllowlist = ReadonlySet<string>;

/**
 * Wrap one MCP definition as a Pi tool under a host-authored trust policy.
 *
 * Only exact allowlist membership leaves the tool eligible to overlap. The
 * definition's description, annotations or any "read-only" claim are
 * third-party data and never select concurrency; everything else is marked
 * `sequential`, which makes Pi run the whole batch that contains it serially.
 */
export function fixtureMcpTool(
  definition: McpToolDefinition,
  port: RuntimeMcpPort,
  allowlist: McpParallelAllowlist,
): AgentTool {
  const tool = createMcpTool({ definition, port }) as AgentTool;
  return allowlist.has(`${definition.serverId}:${definition.toolName}`)
    ? tool
    : { ...tool, executionMode: "sequential" };
}

function makeReplies(
  definitions: readonly McpToolDefinition[],
  size: number,
  shape: BatchShape,
): ScriptedReply[] {
  const calls = Array.from({ length: size }, (_, index) => ({
    name: definitions[index % definitions.length]!.providerName,
    args: {},
  }));
  if (shape === "unbatched") {
    return [...calls.map((toolCall) => ({ toolCalls: [toolCall] })), { text: "fixture complete" }];
  }
  return [{ toolCalls: calls }, { text: "fixture complete" }];
}

function resultVolume(message: unknown): { bytes: number; tokens: number; isError: boolean } {
  const toolResult = message as {
    content?: readonly ({ type?: string; text?: string } | Record<string, unknown>)[];
    isError?: boolean;
  };
  const texts = (toolResult.content ?? []).flatMap((block) =>
    block.type === "text" && typeof block.text === "string" ? [block.text] : [],
  );
  return {
    bytes: Buffer.byteLength(JSON.stringify(toolResult.content ?? [])),
    tokens: countTokens(texts.join("\n")),
    isError: toolResult.isError === true,
  };
}

export interface ScriptedMcpTurnSpec {
  definitions: readonly McpToolDefinition[];
  port: RuntimeMcpPort;
  allowlist: McpParallelAllowlist;
  /** Number of MCP calls in the task, distributed round-robin over `definitions`. */
  batchSize: number;
  /** `batched`: one assistant reply carries every call; `unbatched`: one call per reply. */
  batchShape: BatchShape;
  mode: ToolExecutionMode;
  providerLatencyMs: number;
}

export interface ScriptedMcpTurnResult {
  elapsedMs: number;
  providerRequests: number;
  providerTokens: number;
  resultBytes: number;
  resultTokens: number;
  toolErrors: number;
  /** Tool-call ids in the order the scripted provider emitted them. */
  expectedOrder: string[];
  /** Tool-call ids in the order Pi appended their results to the transcript. */
  resultOrder: string[];
  /** Tool-call ids in the order Pi saw each execution finish. */
  completionOrder: string[];
}

/** Run one real Pi Agent turn whose MCP tools call `spec.port`. */
export async function runScriptedMcpTurn(
  spec: ScriptedMcpTurnSpec,
): Promise<ScriptedMcpTurnResult> {
  const tools = spec.definitions.map((definition) =>
    fixtureMcpTool(definition, spec.port, spec.allowlist),
  );
  const { streamFn, record } = scriptedProvider(
    makeReplies(spec.definitions, spec.batchSize, spec.batchShape),
    { latencyMs: spec.providerLatencyMs, usage: { input: 1_000, output: 60 } },
  );
  const expectedOrder = Array.from({ length: spec.batchSize }, (_, index) =>
    spec.batchShape === "batched" ? `tc-1-${index}` : `tc-${index + 1}-0`,
  );
  const agent = new Agent({
    initialState: {
      systemPrompt: "Fixture-only MCP parallel-dispatch measurement.",
      model: FIXTURE_MODEL,
      tools,
      messages: [],
    },
    streamFn,
    // The opt-in exists only in this fixture driver. The production runtime
    // still passes sequential at its Agent construction site.
    toolExecution: spec.mode,
  });

  const resultOrder: string[] = [];
  const completionOrder: string[] = [];
  let resultBytes = 0;
  let resultTokens = 0;
  let toolErrors = 0;
  agent.subscribe((event) => {
    if (event.type === "tool_execution_end") {
      completionOrder.push(event.toolCallId);
    } else if (event.type === "message_end" && event.message.role === "toolResult") {
      const volume = resultVolume(event.message);
      resultOrder.push(event.message.toolCallId);
      resultBytes += volume.bytes;
      resultTokens += volume.tokens;
      if (volume.isError) toolErrors += 1;
    }
  });

  const startedAt = performance.now();
  await agent.prompt("Run the synthetic MCP fixture task.");
  const elapsedMs = performance.now() - startedAt;
  return {
    elapsedMs,
    providerRequests: record.calls,
    providerTokens: record.totalTokens,
    resultBytes,
    resultTokens,
    toolErrors,
    expectedOrder,
    resultOrder,
    completionOrder,
  };
}

/** Hooks the negative control uses to observe overlap across both side effects. */
export interface SideEffectProbe {
  enter(): void;
  exit(startedAt: number): void;
  record(event: string): void;
}

export interface MixedSideEffectSpec {
  /** A non-allowlisted MCP tool whose server mutates state. */
  mcpDefinition: McpToolDefinition;
  port: RuntimeMcpPort;
  allowlist: McpParallelAllowlist;
  /** A disposable file the local edit tool overwrites. */
  filePath: string;
  probe: SideEffectProbe;
}

export interface MixedSideEffectResult {
  mcpExecutionMode: AgentTool["executionMode"];
  resultOrder: string[];
}

/**
 * The negative control: one emitted batch of local edit → MCP mutation →
 * local edit, run with Pi in `parallel` mode. A single sequential tool in the
 * batch must make Pi run the whole batch in source order.
 */
export async function runMixedSideEffectTurn(
  spec: MixedSideEffectSpec,
): Promise<MixedSideEffectResult> {
  const mcpTool = fixtureMcpTool(spec.mcpDefinition, spec.port, spec.allowlist);
  const localEdit: AgentTool = {
    name: "fixture_local_edit",
    label: "fixture local edit",
    description: "Writes only to this disposable benchmark file.",
    parameters: Type.Object({ value: Type.String() }),
    executionMode: "sequential",
    async execute(_toolCallId, params, signal) {
      const startedAt = performance.now();
      spec.probe.enter();
      const value = (params as { value: string }).value;
      try {
        await sleep(15, signal);
        writeFileSync(spec.filePath, value);
        spec.probe.record(`file:${value}`);
        return { content: [{ type: "text" as const, text: `wrote ${value}` }], details: undefined };
      } finally {
        spec.probe.exit(startedAt);
      }
    },
  };
  const { streamFn } = scriptedProvider(
    [
      {
        toolCalls: [
          { name: localEdit.name, args: { value: "first" } },
          { name: mcpTool.name, args: {} },
          { name: localEdit.name, args: { value: "last" } },
        ],
      },
      { text: "fixture side effects complete" },
    ],
    { latencyMs: 0 },
  );
  const agent = new Agent({
    initialState: {
      systemPrompt: "Fixture negative control.",
      model: FIXTURE_MODEL,
      tools: [localEdit, mcpTool],
      messages: [],
    },
    streamFn,
    toolExecution: "parallel",
  });
  const resultOrder: string[] = [];
  agent.subscribe((event) => {
    if (event.type === "message_end" && event.message.role === "toolResult") {
      resultOrder.push(event.message.toolCallId);
    }
  });
  await agent.prompt("Run the mixed fixture negative control.");
  return { mcpExecutionMode: mcpTool.executionMode, resultOrder };
}

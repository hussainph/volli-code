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

import { applyToolDispatch } from "../../src/pi/tool-dispatch";
import { createMcpTool } from "../../src/pi/tools";
import { scriptedProvider, sleep, type ScriptedReply } from "../parallel-tools/harness";

// The VC-245 primitives the app-side composition reuses rather than copies.
export { peakConcurrency, sleep, type ToolSample } from "../parallel-tools/harness";

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
 * Apply the same dispatch policy the runtime's fixture factory uses
 * (`src/pi/tool-dispatch.ts`) to a bench tool set: in `parallel` mode only MCP
 * tools whose exact `serverId:toolName` is on the host-authored allowlist stay
 * eligible to overlap, and every other tool — local ones included — is marked
 * `sequential`, which makes Pi run the whole batch containing it serially. The
 * definition's description, annotations or "read-only" claim never count.
 */
function dispatchTools(
  tools: readonly AgentTool[],
  definitions: readonly McpToolDefinition[],
  mode: ToolExecutionMode,
  allowlist: McpParallelAllowlist,
): { tools: AgentTool[]; toolExecution: ToolExecutionMode } {
  return applyToolDispatch(
    tools,
    definitions,
    mode === "parallel"
      ? { mode: "parallel", mcpReadAllowlist: allowlist }
      : { mode: "sequential" },
  );
}

/** One MCP definition as the Pi tool a `parallel` fixture run would dispatch. */
export function fixtureMcpTool(
  definition: McpToolDefinition,
  port: RuntimeMcpPort,
  allowlist: McpParallelAllowlist,
): AgentTool {
  const tool = createMcpTool({ definition, port }) as AgentTool;
  return dispatchTools([tool], [definition], "parallel", allowlist).tools[0]!;
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

interface BatchTurn {
  elapsedMs: number;
  providerRequests: number;
  providerTokens: number;
  resultBytes: number;
  resultTokens: number;
  toolErrors: number;
  resultOrder: string[];
  completionOrder: string[];
}

/** One real Pi Agent prompt over scripted replies, recording result lineage. */
async function runBatchTurn(input: {
  tools: AgentTool[];
  toolExecution: ToolExecutionMode;
  replies: ScriptedReply[];
  providerLatencyMs: number;
}): Promise<BatchTurn> {
  const { streamFn, record } = scriptedProvider(input.replies, {
    latencyMs: input.providerLatencyMs,
    usage: { input: 1_000, output: 60 },
  });
  const agent = new Agent({
    initialState: {
      systemPrompt: "Fixture-only MCP parallel-dispatch measurement.",
      model: FIXTURE_MODEL,
      tools: input.tools,
      messages: [],
    },
    streamFn,
    // A bare Agent, not `attachSession`: approval, the Agent Tool Surface and
    // durable tool events are outside these timings. The runtime's own
    // fixture factory covers the same policy through the real attach path.
    toolExecution: input.toolExecution,
  });

  const turn: BatchTurn = {
    elapsedMs: 0,
    providerRequests: 0,
    providerTokens: 0,
    resultBytes: 0,
    resultTokens: 0,
    toolErrors: 0,
    resultOrder: [],
    completionOrder: [],
  };
  agent.subscribe((event) => {
    if (event.type === "tool_execution_end") {
      turn.completionOrder.push(event.toolCallId);
    } else if (event.type === "message_end" && event.message.role === "toolResult") {
      const volume = resultVolume(event.message);
      turn.resultOrder.push(event.message.toolCallId);
      turn.resultBytes += volume.bytes;
      turn.resultTokens += volume.tokens;
      if (volume.isError) turn.toolErrors += 1;
    }
  });

  const startedAt = performance.now();
  await agent.prompt("Run the synthetic MCP fixture task.");
  turn.elapsedMs = performance.now() - startedAt;
  turn.providerRequests = record.calls;
  turn.providerTokens = record.totalTokens;
  return turn;
}

/** Run one real Pi Agent turn whose MCP tools call `spec.port`. */
export async function runScriptedMcpTurn(
  spec: ScriptedMcpTurnSpec,
): Promise<ScriptedMcpTurnResult> {
  const { tools, toolExecution } = dispatchTools(
    spec.definitions.map(
      (definition) => createMcpTool({ definition, port: spec.port }) as AgentTool,
    ),
    spec.definitions,
    spec.mode,
    spec.allowlist,
  );
  const turn = await runBatchTurn({
    tools,
    toolExecution,
    replies: makeReplies(spec.definitions, spec.batchSize, spec.batchShape),
    providerLatencyMs: spec.providerLatencyMs,
  });
  const expectedOrder = Array.from({ length: spec.batchSize }, (_, index) =>
    spec.batchShape === "batched" ? `tc-1-${index}` : `tc-${index + 1}-0`,
  );
  return { ...turn, expectedOrder };
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
  localEditExecutionMode: AgentTool["executionMode"];
  mcpExecutionMode: AgentTool["executionMode"];
  resultOrder: string[];
}

/**
 * The negative control: one emitted batch of local edit → MCP call → local
 * edit, run with Pi in `parallel` mode under the fixture dispatch policy. The
 * local edit is never allowlisted, so Pi must run the whole batch in source
 * order even when the MCP call itself is an allowlisted read.
 */
export async function runMixedSideEffectTurn(
  spec: MixedSideEffectSpec,
): Promise<MixedSideEffectResult> {
  // Deliberately declares no `executionMode`, exactly like Volli's built-in
  // file tools: the dispatch policy, not the tool, has to serialize it.
  const localEdit: AgentTool = {
    name: "fixture_local_edit",
    label: "fixture local edit",
    description: "Writes only to this disposable benchmark file.",
    parameters: Type.Object({ value: Type.String() }),
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
  const { tools, toolExecution } = dispatchTools(
    [localEdit, createMcpTool({ definition: spec.mcpDefinition, port: spec.port }) as AgentTool],
    [spec.mcpDefinition],
    "parallel",
    spec.allowlist,
  );
  const mcpTool = tools[1]!;
  const turn = await runBatchTurn({
    tools,
    toolExecution,
    replies: [
      {
        toolCalls: [
          { name: localEdit.name, args: { value: "first" } },
          { name: mcpTool.name, args: {} },
          { name: localEdit.name, args: { value: "last" } },
        ],
      },
      { text: "fixture side effects complete" },
    ],
    providerLatencyMs: 0,
  });
  return {
    localEditExecutionMode: tools[0]!.executionMode,
    mcpExecutionMode: mcpTool.executionMode,
    resultOrder: turn.resultOrder,
  };
}

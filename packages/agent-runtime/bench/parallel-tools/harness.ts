/**
 * An isolated bench for Pi's built-in tool-execution modes (VC-245).
 *
 * The subject here is one line of Volli's runtime — `toolExecution:
 * "sequential"` — and the only honest way to measure what changing it buys is
 * to run Pi's real loop against it. So the `Agent`, its batching, its
 * preflight, its `beforeToolCall` gate and its result ordering all run
 * unmodified; the two things a benchmark must own are faked and only those:
 *
 *  - the provider call, scripted exactly as `runtime.test.ts` scripts it, so a
 *    scenario decides how many tool calls arrive per assistant message; and
 *  - the tools, which do nothing but sleep for a named duration and record
 *    when they started and stopped.
 *
 * Everything reported is measured from those recordings rather than modelled.
 * `speedup` is wall-clock over the same script; token and provider-call counts
 * come from the usage the scripted stream reports, which is the same number in
 * both modes by construction — that identity is the finding, not an
 * assumption, so the bench asserts it rather than printing it.
 *
 * Nothing here ships. It builds no Session, touches no database, reads no
 * credential and opens no socket.
 */

import { Agent, type StreamFn, type ToolExecutionMode } from "@earendil-works/pi-agent-core";
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type Model,
  type ToolCall,
} from "@earendil-works/pi-ai";
import { Type } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";

/** Wall-clock, monotonic, in whole milliseconds since the run began. */
const clock = (): number => Number(process.hrtime.bigint() / 1_000_000n);

/** A sleep that a cancelled run can actually get out of. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("aborted"));
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new Error("aborted"));
      },
      { once: true },
    );
  });
}

// --- instrumented tools ----------------------------------------------------

/** One tool invocation, as the bench observed it rather than as it was planned. */
export interface ToolSample {
  tool: string;
  toolCallId: string;
  startedAt: number;
  endedAt: number;
}

export interface BenchTool {
  /** Tool name the script calls it by. */
  name: string;
  /** How long one call takes. */
  latencyMs: number;
  /**
   * Pi's per-tool override. One tool carrying `"sequential"` forces the whole
   * batch sequential regardless of the agent-wide mode — the property the
   * `mixed-batch` scenario exists to measure.
   */
  executionMode?: ToolExecutionMode;
}

/** Builds a latency-only tool that records when it ran. */
function benchTool(spec: BenchTool, samples: ToolSample[]): AgentTool {
  return {
    name: spec.name,
    label: spec.name,
    description: `bench tool ${spec.name}`,
    parameters: Type.Object({ n: Type.Optional(Type.Number()) }),
    ...(spec.executionMode === undefined ? {} : { executionMode: spec.executionMode }),
    execute: async (toolCallId: string, _params: unknown, signal?: AbortSignal) => {
      const startedAt = clock();
      await sleep(spec.latencyMs, signal);
      const endedAt = clock();
      samples.push({ tool: spec.name, toolCallId, startedAt, endedAt });
      return {
        content: [{ type: "text" as const, text: `${spec.name} ok` }],
        isError: false,
      };
    },
  } as unknown as AgentTool;
}

// --- scripted provider -----------------------------------------------------

/**
 * One assistant reply: either a batch of tool calls, or the closing text.
 *
 * `toolCalls` is what makes or breaks the whole optimisation. Pi can only run
 * concurrently what the model asked for in a single message, so a script that
 * emits one call per reply measures the case where parallel mode is
 * unreachable — which is why the control scenario emits exactly that.
 */
export type ScriptedReply =
  | { toolCalls: { name: string; args?: Record<string, unknown> }[] }
  | { text: string };

/** Deterministic per-reply usage, so token totals are comparable across modes. */
export interface ScriptedUsage {
  input: number;
  output: number;
}

const DEFAULT_USAGE: ScriptedUsage = { input: 1_000, output: 60 };

/** What the scripted provider recorded about the run, independent of the tools. */
export interface ProviderRecord {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costUsd: number;
}

/**
 * A provider that replays `replies` in order and charges for each one.
 *
 * `latencyMs` models the round trip. It is charged per provider call, so a
 * script that needs more replies pays it more times — the axis on which real
 * batching (fewer, larger replies) beats one call per reply.
 */
export function scriptedProvider(
  replies: ScriptedReply[],
  options: { latencyMs?: number; usage?: ScriptedUsage } = {},
): { streamFn: StreamFn; record: ProviderRecord } {
  const usage = options.usage ?? DEFAULT_USAGE;
  const latencyMs = options.latencyMs ?? 0;
  const record: ProviderRecord = {
    calls: 0,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    costUsd: 0,
  };
  let call = 0;

  const streamFn: StreamFn = (model, _context, streamOptions) => {
    const reply = replies[call];
    call += 1;
    const stream = createAssistantMessageEventStream();
    const typed = model as Model<string>;
    // Priced off the same per-reply usage in both modes: the bench's claim is
    // that mode does not move this number, and a cost that drifted with
    // scheduling would hide exactly that.
    const cost = {
      input: usage.input * 0.000_003,
      output: usage.output * 0.000_015,
      cacheRead: 0,
      cacheWrite: 0,
      total: usage.input * 0.000_003 + usage.output * 0.000_015,
    };
    const message: AssistantMessage = {
      role: "assistant",
      content: [],
      api: typed.api,
      provider: typed.provider,
      model: typed.id,
      usage: {
        input: usage.input,
        output: usage.output,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: usage.input + usage.output,
        cost,
      },
      stopReason: "stop",
      timestamp: 0,
    };

    void (async () => {
      stream.push({ type: "start", partial: message });
      if (latencyMs > 0) await sleep(latencyMs, streamOptions?.signal);
      if (reply === undefined) {
        // A script that ran out is a bench bug, not a model behaviour: end the
        // turn rather than looping the agent forever on an empty reply.
        message.content.push({ type: "text", text: "(script exhausted)" });
        stream.push({ type: "done", reason: "stop", message });
        stream.end(message);
        return;
      }
      if ("text" in reply) {
        message.content.push({ type: "text", text: reply.text });
        stream.push({ type: "text_start", contentIndex: 0, partial: message });
        stream.push({ type: "text_delta", contentIndex: 0, delta: reply.text, partial: message });
        stream.push({
          type: "text_end",
          contentIndex: 0,
          content: reply.text,
          partial: message,
        });
      } else {
        message.stopReason = "toolUse";
        reply.toolCalls.forEach((requestedCall, index) => {
          const toolCall: ToolCall = {
            type: "toolCall",
            id: `tc-${call}-${index}`,
            name: requestedCall.name,
            arguments: requestedCall.args ?? {},
          };
          message.content.push(toolCall);
          stream.push({ type: "toolcall_start", contentIndex: index, partial: message });
          stream.push({ type: "toolcall_end", contentIndex: index, toolCall, partial: message });
        });
      }
      record.calls += 1;
      record.inputTokens += usage.input;
      record.outputTokens += usage.output;
      record.totalTokens += usage.input + usage.output;
      record.costUsd += cost.total;
      stream.push({
        type: "done",
        reason: message.stopReason === "toolUse" ? "toolUse" : "stop",
        message,
      });
      stream.end(message);
    })();

    return stream;
  };

  return { streamFn, record };
}

// --- the run ---------------------------------------------------------------

/** A `beforeToolCall` stand-in, so approval behaviour can be measured too. */
export type BenchGate = (context: { toolName: string; toolCallId: string }) => Promise<void>;

export interface RunSpec {
  mode: ToolExecutionMode;
  tools: BenchTool[];
  replies: ScriptedReply[];
  providerLatencyMs?: number;
  usage?: ScriptedUsage;
  /** Run before each call, serialized by Pi's preflight exactly as Volli's gate is. */
  gate?: BenchGate;
}

export interface RunResult {
  mode: ToolExecutionMode;
  elapsedMs: number;
  provider: ProviderRecord;
  toolCalls: number;
  samples: ToolSample[];
  /**
   * Order tool results were persisted in, which Pi promises is assistant
   * source order in both modes.
   */
  resultOrder: string[];
  /**
   * Order calls actually finished in, which in parallel mode is completion
   * order and need not match {@link resultOrder}. Kept separate because the
   * two orders are exactly what a reader of activity vs transcript sees.
   */
  completionOrder: string[];
  /** Peak number of tools in flight at once, measured from the samples. */
  peakConcurrency: number;
}

/** Highest number of samples whose [start, end) intervals overlap. */
export function peakConcurrency(samples: ToolSample[]): number {
  const edges = samples
    .flatMap((sample) => [
      { at: sample.startedAt, delta: 1 },
      { at: sample.endedAt, delta: -1 },
    ])
    // A call that ends exactly as another starts is not concurrent, so ends
    // sort before starts at the same millisecond.
    .toSorted((left, right) => left.at - right.at || left.delta - right.delta);
  let live = 0;
  let peak = 0;
  for (const edge of edges) {
    live += edge.delta;
    if (live > peak) peak = live;
  }
  return peak;
}

/** One agent run, start to finish, measured. */
export async function runOnce(spec: RunSpec): Promise<RunResult> {
  const samples: ToolSample[] = [];
  const tools = spec.tools.map((tool) => benchTool(tool, samples));
  const { streamFn, record } = scriptedProvider(spec.replies, {
    ...(spec.providerLatencyMs === undefined ? {} : { latencyMs: spec.providerLatencyMs }),
    ...(spec.usage === undefined ? {} : { usage: spec.usage }),
  });

  const resultOrder: string[] = [];
  const completionOrder: string[] = [];
  const agent = new Agent({
    initialState: {
      systemPrompt: "bench",
      model: {
        id: "bench-model",
        api: "anthropic-messages",
        provider: "bench",
        name: "bench",
        reasoning: false,
        contextWindow: 200_000,
        maxTokens: 8_192,
        cost: { input: 3, output: 15, cacheRead: 0, cacheWrite: 0 },
      } as unknown as Model<string>,
      tools,
      messages: [],
    },
    streamFn,
    toolExecution: spec.mode,
    ...(spec.gate === undefined
      ? {}
      : {
          beforeToolCall: async ({ toolCall }) => {
            await spec.gate?.({ toolName: toolCall.name, toolCallId: toolCall.id });
            return undefined;
          },
        }),
  });

  agent.subscribe((event) => {
    // `tool_execution_end` fires as each call finalizes: completion order.
    if (event.type === "tool_execution_end") {
      completionOrder.push(event.toolCallId);
      return;
    }
    // `message_end` for a toolResult is the persisted message: source order.
    if (event.type === "message_end" && event.message.role === "toolResult") {
      resultOrder.push((event.message as unknown as { toolCallId: string }).toolCallId);
    }
  });

  const startedAt = clock();
  await agent.prompt("go");
  const elapsedMs = clock() - startedAt;

  return {
    mode: spec.mode,
    elapsedMs,
    provider: record,
    toolCalls: samples.length,
    samples,
    resultOrder,
    completionOrder,
    peakConcurrency: peakConcurrency(samples),
  };
}

/** Median, so one scheduler hiccup does not become the reported number. */
export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = values.toSorted((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!;
}

/** Runs one spec `repeats` times and reports the median run alongside every sample. */
export async function runRepeated(
  spec: RunSpec,
  repeats: number,
): Promise<{ representative: RunResult; elapsedMsMedian: number; elapsedMsAll: number[] }> {
  const results: RunResult[] = [];
  for (let index = 0; index < repeats; index += 1) {
    results.push(await runOnce(spec));
  }
  const elapsedMsAll = results.map((result) => result.elapsedMs);
  const elapsedMsMedian = median(elapsedMsAll);
  // The representative run is the one closest to the median, so the ordering
  // and concurrency facts printed beside a timing belong to a real run.
  const representative = results.reduce((best, candidate) =>
    Math.abs(candidate.elapsedMs - elapsedMsMedian) < Math.abs(best.elapsedMs - elapsedMsMedian)
      ? candidate
      : best,
  );
  return { representative, elapsedMsMedian, elapsedMsAll };
}

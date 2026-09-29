/**
 * The Pi-facing half of the fixture-only MCP parallel-dispatch benchmark,
 * through the real Session path (VC-454; VC-444 measured a bare `Agent`).
 *
 * Every turn runs on {@link createPiAgentRuntime}: `startSession`, the
 * Authority gate (`beforeToolCall`), the Agent Tool Surface, the MCP tool
 * wrapper and durable activity observations all run for real. Only the
 * provider is scripted, so no credentials or paid requests are involved. The
 * caller hands in a Session's MCP definitions as they were born — stamped, or
 * not, by the host's own policy — and whether the runtime honours the marks,
 * which is how a Session is selected in the product.
 *
 * This module is reachable only through the `@volli/agent-runtime/bench/mcp-parallel`
 * subpath and is never imported by the shipping runtime. It takes the MCP side
 * as a plain {@link RuntimeMcpPort}; the composition that binds that port to
 * the desktop `McpSessionHost`, the per-server budget and local Streamable HTTP
 * fixture servers lives in the app (`apps/desktop/e2e/bench/mcp-parallel/`),
 * so the dependency points app → package and never the other way.
 */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import { createModels, fauxProvider, type Context, type Model } from "@earendil-works/pi-ai";
import {
  BUILTIN_RULE_PACK_HASH,
  BUILTIN_RULE_PACK_ID,
  sessionToolIds,
  type AuthoritySnapshot,
  type McpToolDefinition,
  type ObservabilityEvent,
  type RuntimeMcpPort,
  type RuntimeObservation,
  type SessionRuntimeSpec,
} from "@volli/shared";
import { countTokens } from "gpt-tokenizer/encoding/o200k_base";

import { createPiAgentRuntime } from "../../src/index";
import { scriptedProvider, type ScriptedReply } from "../parallel-tools/harness";

// The VC-245 primitives the app-side composition reuses rather than copies.
export { peakConcurrency, sleep, type ToolSample } from "../parallel-tools/harness";

export type BatchShape = "batched" | "unbatched";
export type DispatchArm = "sequential" | "parallel";

const PROVIDER = "vc454-fixture";
const MODEL_ID = "vc454-fixture-model";

/** One call the script puts in the batch. */
export type ScriptedCall = Extract<ScriptedReply, { toolCalls: unknown }>["toolCalls"][number];

export interface RuntimeMcpTurnSpec {
  /** The Session's MCP definitions as it was born: marked by the host, or not. */
  definitions: readonly McpToolDefinition[];
  port: RuntimeMcpPort;
  /** Whether the runtime honours the definitions' parallel-read marks. */
  parallelMcpReads: boolean;
  /** Number of MCP calls in the task, distributed round-robin over `definitions`. */
  batchSize: number;
  /** `batched`: one assistant reply carries every call; `unbatched`: one call per reply. */
  batchShape: BatchShape;
  providerLatencyMs: number;
  /**
   * The emitted batch in full, overriding `batchSize`: built-in and MCP calls
   * in source order. Used by the mixed-batch negative controls.
   */
  batch?: readonly ScriptedCall[];
  /** Built-in coding tools the Session holds (the negative controls add `write`). */
  codingTools?: SessionRuntimeSpec["tools"]["tools"];
  /** Where built-in tools run; a fresh temporary directory when absent. */
  workspacePath?: string;
  /** Resolves when the turn should be interrupted, as a person pressing stop. */
  interruptWhen?: Promise<void>;
}

export interface RuntimeMcpTurnResult {
  elapsedMs: number;
  providerRequests: number;
  providerTokens: number;
  resultBytes: number;
  resultTokens: number;
  toolErrors: number;
  /** Tool-call ids in the order the scripted provider emitted them. */
  expectedOrder: string[];
  /** Tool-call ids in the order Pi handed their results back to the model. */
  resultOrder: string[];
  /** Tool-call ids in the order the runtime observed each call settle. */
  completionOrder: string[];
  /** `started`/`completed`/`failed` activity lifecycle, as observed. */
  activityLog: string[];
  /** Summed time the Authority gate held calls waiting on a person. */
  approvalWaitMs: number;
  /** Calls the Authority gate judged before dispatch. */
  gatedCalls: number;
  /** How the turn ended, from the runtime's own observation. */
  turnState: string;
  /** From `interrupt()` to the turn and the interrupt both settling, before close. */
  interruptSettleMs?: number;
  /** Whether the runtime selected Pi's parallel mode for this Session. */
  toolExecution: DispatchArm;
}

function resultVolume(content: unknown): { bytes: number; tokens: number } {
  const blocks = Array.isArray(content) ? content : [];
  const texts = blocks.flatMap((block: { type?: string; text?: string }) =>
    block.type === "text" && typeof block.text === "string" ? [block.text] : [],
  );
  return {
    bytes: Buffer.byteLength(JSON.stringify(blocks)),
    tokens: countTokens(texts.join("\n")),
  };
}

function authority(tools: AuthoritySnapshot["tools"]): AuthoritySnapshot {
  return {
    mode: "auto",
    location: "worktree",
    enforcement: "enforce",
    judgmentMode: "ask",
    tools,
    rulePackId: BUILTIN_RULE_PACK_ID,
    rulePackHash: BUILTIN_RULE_PACK_HASH,
    classifierModel: null,
    fallback: { consecutiveDenials: 3, sessionDenials: 20 },
  };
}

function replies(spec: RuntimeMcpTurnSpec, definitions: readonly McpToolDefinition[]) {
  const calls: ScriptedCall[] =
    spec.batch === undefined
      ? Array.from({ length: spec.batchSize }, (_, index) => ({
          name: definitions[index % definitions.length]!.providerName,
          args: {},
        }))
      : [...spec.batch];
  const script: ScriptedReply[] =
    spec.batchShape === "unbatched"
      ? calls.map((call) => ({ toolCalls: [{ name: call.name, args: call.args ?? {} }] }))
      : [{ toolCalls: calls.map((call) => ({ name: call.name, args: call.args ?? {} })) }];
  const expectedOrder = calls.map((_, index) =>
    spec.batchShape === "batched" ? `tc-1-${index}` : `tc-${index + 1}-0`,
  );
  return { script: [...script, { text: "fixture complete" }], expectedOrder };
}

/**
 * One real Session turn whose MCP tools call `spec.port`: born, attached,
 * prompted, and closed on {@link createPiAgentRuntime}.
 */
export async function runRuntimeMcpTurn(spec: RuntimeMcpTurnSpec): Promise<RuntimeMcpTurnResult> {
  const root = mkdtempSync(join(tmpdir(), "vc454-mcp-runtime-"));
  const workspacePath = spec.workspacePath ?? join(root, "workspace");
  if (spec.workspacePath === undefined) mkdirSync(workspacePath);
  try {
    const definitions = spec.definitions;
    const { script, expectedOrder } = replies(spec, definitions);
    const provider = scriptedProvider(script, {
      latencyMs: spec.providerLatencyMs,
      usage: { input: 1_000, output: 60 },
    });
    let lastContext: Context | undefined;
    const streamSimple: StreamFn = (model, context, options) => {
      lastContext = context;
      return provider.streamFn(model, context, options);
    };
    const faux = fauxProvider({
      api: "anthropic-messages",
      provider: PROVIDER,
      models: [{ id: MODEL_ID }],
    });
    const catalog = faux.provider.getModels() as Model<string>[];
    const models = createModels();
    models.setProvider({
      ...faux.provider,
      getModels: () => catalog,
      streamSimple: streamSimple as typeof faux.provider.streamSimple,
    });

    const observability: ObservabilityEvent[] = [];
    const runtime = createPiAgentRuntime({
      sessionDataDir: join(root, "sessions"),
      models,
      parallelMcpReads: spec.parallelMcpReads,
      observability: { record: (event) => void observability.push(event) },
    });
    const observations: RuntimeObservation[] = [];
    const base: SessionRuntimeSpec = {
      identity: {
        role: "ticket",
        sessionId: "vc454-bench-session",
        rootThreadId: "vc454-bench-thread",
        attachmentId: "vc454-bench-attachment",
        projectId: "vc454-bench-project",
        ticketId: "vc454-bench-ticket",
      },
      workspacePath,
      venue: "local",
      model: { providerId: PROVIDER, modelId: MODEL_ID, reasoningLevel: "off" },
      brief: { text: "Fixture-only MCP parallel-dispatch measurement." },
      tools: { tools: spec.codingTools ?? [], mcp: definitions },
      mcp: spec.port,
      observer: async (observation) => {
        observations.push(observation);
      },
    };
    const sessionSpec: SessionRuntimeSpec = {
      ...base,
      authority: authority(sessionToolIds(base)),
    };

    const handle = await runtime.startSession(sessionSpec);
    let elapsedMs = 0;
    let stoppedAt: number | undefined;
    let interruptSettleMs: number | undefined;
    try {
      const startedAt = performance.now();
      const delivery = handle.submitUserMessage("Run the synthetic MCP fixture task.");
      const interrupted = spec.interruptWhen?.then(() => {
        stoppedAt = performance.now();
        return handle.interrupt();
      });
      await delivery;
      await interrupted;
      const settledAt = performance.now();
      elapsedMs = settledAt - startedAt;
      if (stoppedAt !== undefined) interruptSettleMs = settledAt - stoppedAt;
    } finally {
      await handle.close();
    }

    const results = (lastContext?.messages ?? []).flatMap((message) =>
      message.role === "toolResult" ? [message] : [],
    );
    let resultBytes = 0;
    let resultTokens = 0;
    for (const result of results) {
      const volume = resultVolume(result.content);
      resultBytes += volume.bytes;
      resultTokens += volume.tokens;
    }
    const activities = observations.flatMap((observation) =>
      observation.kind === "activity" ? [observation] : [],
    );
    const authorityEvents = observability.flatMap((event) =>
      event.kind === "authority" ? [event] : [],
    );
    const turns = observations.flatMap((observation) =>
      observation.kind === "turn" ? [observation.state] : [],
    );
    return {
      elapsedMs,
      providerRequests: provider.record.calls,
      providerTokens: provider.record.totalTokens,
      resultBytes,
      resultTokens,
      toolErrors: results.filter((result) => result.isError).length,
      expectedOrder,
      resultOrder: results.map((result) => result.toolCallId),
      completionOrder: activities.flatMap((activity) =>
        activity.state === "completed" || activity.state === "failed" ? [activity.activityId] : [],
      ),
      activityLog: activities.flatMap((activity) =>
        activity.state === "progress" ? [] : [`${activity.state}:${activity.activityId}`],
      ),
      approvalWaitMs: authorityEvents.reduce((sum, event) => sum + (event.waitDurationMs ?? 0), 0),
      gatedCalls: authorityEvents.length,
      turnState: turns.at(-1) ?? "none",
      ...(interruptSettleMs === undefined ? {} : { interruptSettleMs }),
      toolExecution:
        spec.parallelMcpReads && definitions.some((definition) => definition.parallelRead)
          ? "parallel"
          : "sequential",
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

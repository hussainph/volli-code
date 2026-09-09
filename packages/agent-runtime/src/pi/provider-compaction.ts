/**
 * First-party native compaction, persisted as raw JSON in CompactionEntry.details.
 * Pi 0.85 cannot represent native compaction blocks, so a standalone request
 * captures them and onPayload projects them back into subsequent requests.
 * An opaque checkpoint is NOT a portable summary: model switches and local
 * fallback must reconstruct original history (compaction.ts owns that rule).
 *
 * Contracts: developers.openai.com/api/docs/guides/compaction and
 * platform.claude.com/docs/en/build-with-claude/compaction.
 */
import { convertToLlm, type AgentMessage } from "@earendil-works/pi-agent-core";
import {
  calculateCost,
  type Api,
  type Model,
  type Models,
  type Tool,
  type Usage,
} from "@earendil-works/pi-ai";
import { convertResponsesMessages } from "@earendil-works/pi-ai/api/openai-responses-shared";
import type { SessionUsage } from "@volli/shared";
import { sanitizeDiagnostic, sessionUsageFrom } from "./transcript";

// Pi 0.85's convertToLlm summary wrapper; projection fails closed if it changes.
const COMPACTION_SUMMARY_PREFIX =
  "The conversation history before this point was compacted into the following summary:\n\n<summary>\n";
export const ANTHROPIC_COMPACT_BETA = "compact-2026-01-12";
export const ANTHROPIC_COMPACT_MIN_TRIGGER_TOKENS = 50_000;
const CLAUDE_MODELS =
  /^(?:claude-(?:opus-4-[678]|sonnet-4-6|opus-5|sonnet-5|fable-5(?:-1)?|mythos-5(?:-1)?|mythos-preview))(?:-\d{8})?$/;

export type ProviderCompactionState =
  | { kind: "openai-responses"; items: readonly unknown[]; model: string; compactedAt: number }
  | {
      kind: "anthropic-messages";
      block: Record<string, unknown>;
      model: string;
      compactedAt: number;
    };

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function openAIWindow(value: unknown): value is unknown[] {
  return (
    Array.isArray(value) &&
    value.every(record) &&
    value.some(
      (item) =>
        item["type"] === "compaction" &&
        typeof item["encrypted_content"] === "string" &&
        item["encrypted_content"].length > 0,
    )
  );
}
function anthropicBlock(value: unknown): value is Record<string, unknown> {
  // A null-content block is a documented failed/no-op compaction, NOT a checkpoint.
  return (
    record(value) &&
    value["type"] === "compaction" &&
    typeof value["content"] === "string" &&
    value["content"].length > 0
  );
}

/** A malformed durable checkpoint must never degrade to its empty placeholder. */
export function providerCompactionFromDetails(
  details: unknown,
): ProviderCompactionState | undefined {
  if (!record(details) || !("providerCompaction" in details)) return undefined;
  const state = details["providerCompaction"];
  if (
    record(state) &&
    typeof state["model"] === "string" &&
    typeof state["compactedAt"] === "number" &&
    Number.isFinite(state["compactedAt"]) &&
    ((state["kind"] === "openai-responses" && openAIWindow(state["items"])) ||
      (state["kind"] === "anthropic-messages" && anthropicBlock(state["block"])))
  )
    return state as ProviderCompactionState;
  throw new Error("The provider-native compaction checkpoint is malformed.");
}
export function isProviderCompactionDetails(details: unknown): boolean {
  return providerCompactionFromDetails(details) !== undefined;
}

export type ProviderCompactionOutcome =
  | {
      kind: "compacted";
      state: ProviderCompactionState;
      textSummary: string;
      usage: SessionUsage | null;
      rawUsage?: Usage;
    }
  | { kind: "unsupported"; reason: string }
  | { kind: "failed"; message: string; rawUsage?: Usage };

export interface ProviderCompactionInput {
  model: Model<Api>;
  models: Models;
  messages: readonly AgentMessage[];
  systemPrompt?: string;
  tools?: readonly Tool[];
  previousState?: ProviderCompactionState;
  enabled: boolean;
  customInstructions?: string;
  signal?: AbortSignal;
  fetch?: typeof globalThis.fetch;
}

/** Public API capability is not inherited by compatible gateways or OAuth backends. */
export function nativeCompactionSupport(
  model: Pick<Model<Api>, "provider" | "api" | "baseUrl" | "id">,
): { supported: true } | { supported: false; reason: string } {
  const unsupported = {
    supported: false as const,
    reason: "This model/endpoint has no supported native compaction API.",
  };
  let url: URL;
  try {
    url = new URL(model.baseUrl);
  } catch {
    return unsupported;
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.pathname !== "/" && url.pathname !== "/v1" && url.pathname !== "/v1/")
  )
    return unsupported;
  if (
    model.provider === "openai" &&
    model.api === "openai-responses" &&
    url.host === "api.openai.com"
  )
    return { supported: true };
  if (
    model.provider === "anthropic" &&
    model.api === "anthropic-messages" &&
    url.host === "api.anthropic.com" &&
    CLAUDE_MODELS.test(model.id)
  )
    return { supported: true };
  return unsupported;
}

type ResolvedAuth = NonNullable<Awaited<ReturnType<Models["getAuth"]>>>;
export async function compactProviderNative(
  input: ProviderCompactionInput,
): Promise<ProviderCompactionOutcome> {
  if (!input.enabled) return { kind: "unsupported", reason: "Native compaction is disabled." };
  const support = nativeCompactionSupport(input.model);
  if (!support.supported) return { kind: "unsupported", reason: support.reason };
  try {
    input.signal?.throwIfAborted();
    const auth = await input.models.getAuth(input.model, { signal: input.signal });
    if (!auth)
      return { kind: "failed", message: "No resolved provider authentication for compaction." };
    // Resolve again after auth: a credential may override the model's endpoint.
    if (
      !nativeCompactionSupport({
        ...input.model,
        baseUrl: auth.auth.baseUrl ?? input.model.baseUrl,
      }).supported ||
      /oauth/i.test(auth.source ?? "") ||
      auth.auth.apiKey?.startsWith("sk-ant-oat")
    ) {
      return {
        kind: "unsupported",
        reason:
          "Native compaction requires the supported public API endpoint and API-key authentication.",
      };
    }
    if (
      input.previousState &&
      (input.previousState.model !== input.model.id || input.previousState.kind !== input.model.api)
    ) {
      return { kind: "unsupported", reason: "Native checkpoint belongs to another model." };
    }
    return input.model.api === "openai-responses"
      ? await compactOpenAI(input, auth)
      : await compactAnthropic(input, auth);
  } catch (error) {
    return {
      kind: "failed",
      message: input.signal?.aborted
        ? "provider-native compaction aborted"
        : sanitizeDiagnostic(error instanceof Error ? error.message : String(error)),
    };
  }
}

async function compactOpenAI(
  input: ProviderCompactionInput,
  auth: ResolvedAuth,
): Promise<ProviderCompactionOutcome> {
  const converted = convertResponsesMessages(
    input.model,
    { messages: convertToLlm([...input.messages]) },
    new Set(["openai"]),
  );
  const body = {
    model: input.model.id,
    input: converted as unknown[],
    // /compact is stateless; store and tools are NOT fields of its public schema.
    ...(input.systemPrompt || input.customInstructions
      ? {
          instructions: [input.systemPrompt, input.customInstructions].filter(Boolean).join("\n\n"),
        }
      : {}),
  };
  const request =
    input.previousState?.kind === "openai-responses"
      ? projectOpenAICompaction(body, input.previousState)
      : body;
  if (!request)
    return {
      kind: "failed",
      message: "Previous native checkpoint is missing from compaction input.",
    };
  const headers = requestHeaders(input, auth);
  if (!headers["authorization"] && auth.auth.apiKey)
    headers["authorization"] = `Bearer ${auth.auth.apiKey}`;
  const response = await postJson(
    input,
    `${endpoint(input, auth)}/responses/compact`,
    headers,
    request,
  );
  if (!response.ok) return failure(response, "OpenAI /responses/compact");
  const parsed: unknown = await response.json();
  input.signal?.throwIfAborted();
  const rawUsage = record(parsed) ? readUsage(parsed["usage"], input.model, false) : undefined;
  if (!record(parsed) || !openAIWindow(parsed["output"]))
    return {
      kind: "failed",
      message: "OpenAI /responses/compact returned no valid compaction window.",
      rawUsage,
    };
  return {
    kind: "compacted",
    state: {
      kind: "openai-responses",
      items: parsed["output"],
      model: input.model.id,
      compactedAt: Date.now(),
    },
    textSummary: "Provider-native context checkpoint.",
    rawUsage,
    usage: usageFor(rawUsage, input.model),
  };
}

/** Replace only the summary block; keep every canonical item and every later block. */
export function projectOpenAICompaction<T extends { input?: unknown }>(
  params: T,
  state: Extract<ProviderCompactionState, { kind: "openai-responses" }>,
): T | undefined {
  if (!Array.isArray(params.input)) return undefined;
  const index = params.input.findIndex((item) => summaryIndex(item, "input_text") >= 0);
  if (index < 0) return undefined;
  const item = params.input[index] as { content: unknown[] };
  const block = summaryIndex(item, "input_text");
  const remaining = item.content.slice(block + 1);
  return {
    ...params,
    input: [
      ...params.input.slice(0, index),
      ...state.items,
      ...(remaining.length ? [{ ...item, content: remaining }] : []),
      ...params.input.slice(index + 1),
    ],
  };
}
function summaryIndex(item: unknown, type: string): number {
  if (!record(item) || item["role"] !== "user" || !Array.isArray(item["content"])) return -1;
  return item["content"].findIndex(
    (block) =>
      record(block) &&
      block["type"] === type &&
      typeof block["text"] === "string" &&
      block["text"].startsWith(COMPACTION_SUMMARY_PREFIX),
  );
}

async function compactAnthropic(
  input: ProviderCompactionInput,
  auth: ResolvedAuth,
): Promise<ProviderCompactionOutcome> {
  const messages = toAnthropicMessages(input.messages);
  if (typeof messages === "string") return { kind: "unsupported", reason: messages };
  const base = {
    model: input.model.id,
    messages,
    ...(input.systemPrompt ? { system: input.systemPrompt } : {}),
    ...(input.tools?.length
      ? {
          tools: input.tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            input_schema: tool.parameters,
          })),
        }
      : {}),
  };
  const request =
    input.previousState?.kind === "anthropic-messages"
      ? projectAnthropicCompaction(base, input.previousState)
      : base;
  if (!request)
    return {
      kind: "failed",
      message: "Previous native checkpoint is missing from compaction input.",
    };
  const headers = requestHeaders(input, auth);
  headers["anthropic-version"] = "2023-06-01";
  headers["anthropic-beta"] = [headers["anthropic-beta"], ANTHROPIC_COMPACT_BETA]
    .filter(Boolean)
    .join(",");
  if (!headers["x-api-key"] && !headers["authorization"] && auth.auth.apiKey)
    headers["x-api-key"] = auth.auth.apiKey;
  // Claude has no published local tokenizer. Its non-generating count endpoint
  // also prevents paying for a normal answer when below the beta's 50k minimum.
  const counted = await postJson(
    input,
    `${endpoint(input, auth)}/messages/count_tokens`,
    headers,
    request,
  );
  if (!counted.ok) return failure(counted, "Anthropic token counting");
  const countResult: unknown = await counted.json();
  if (
    !record(countResult) ||
    typeof countResult["input_tokens"] !== "number" ||
    !Number.isFinite(countResult["input_tokens"])
  )
    return { kind: "failed", message: "Anthropic returned an invalid token count." };
  if (countResult["input_tokens"] < ANTHROPIC_COMPACT_MIN_TRIGGER_TOKENS)
    return {
      kind: "unsupported",
      reason: "Context is below Anthropic's minimum compaction trigger.",
    };
  const response = await postJson(input, `${endpoint(input, auth)}/messages`, headers, {
    ...request,
    max_tokens: Math.min(16_384, input.model.maxTokens),
    context_management: {
      edits: [
        {
          type: "compact_20260112",
          trigger: { type: "input_tokens", value: ANTHROPIC_COMPACT_MIN_TRIGGER_TOKENS },
          pause_after_compaction: true,
          ...(input.customInstructions
            ? {
                instructions: `Summarize the conversation for continuation, preserving goals, constraints, decisions and next steps. Wrap the summary in <summary> tags.\n\nAdditional focus: ${input.customInstructions}`,
              }
            : {}),
        },
      ],
    },
  });
  if (!response.ok) return failure(response, "Anthropic compaction");
  const parsed: unknown = await response.json();
  input.signal?.throwIfAborted();
  const rawUsage = record(parsed) ? readUsage(parsed["usage"], input.model, true) : undefined;
  const block =
    record(parsed) && Array.isArray(parsed["content"])
      ? parsed["content"].find(anthropicBlock)
      : undefined;
  if (!record(parsed) || parsed["stop_reason"] !== "compaction" || !block)
    return {
      kind: "failed",
      message: "Anthropic did not return a successful compaction block.",
      rawUsage,
    };
  return {
    kind: "compacted",
    state: { kind: "anthropic-messages", block, model: input.model.id, compactedAt: Date.now() },
    textSummary: block["content"] as string,
    rawUsage,
    usage: usageFor(rawUsage, input.model),
  };
}

export function projectAnthropicCompaction<T extends { messages?: unknown }>(
  params: T,
  state: Extract<ProviderCompactionState, { kind: "anthropic-messages" }>,
): T | undefined {
  if (!Array.isArray(params.messages)) return undefined;
  const index = params.messages.findIndex((item) => summaryIndex(item, "text") >= 0);
  if (index < 0) return undefined;
  const item = params.messages[index] as { content: unknown[] };
  const remaining = item.content.slice(summaryIndex(item, "text") + 1);
  // Pi coalesces consecutive user messages: resources, text and images may be
  // in the SAME wire message as the summary. Never drop those blocks with it.
  const rest = [
    ...(remaining.length ? [{ ...item, content: remaining }] : []),
    ...params.messages.slice(index + 1),
  ];
  const next = rest[0];
  if (record(next) && next["role"] === "assistant" && Array.isArray(next["content"]))
    return {
      ...params,
      messages: [{ ...next, content: [state.block, ...next["content"]] }, ...rest.slice(1)],
    };
  return { ...params, messages: [{ role: "assistant", content: [state.block] }, ...rest] };
}

/** Visible-message projection for the standalone Claude summarizer; no tools execute. */
export function toAnthropicMessages(
  messages: readonly AgentMessage[],
): Record<string, unknown>[] | string {
  const wire: { role: "user" | "assistant"; content: Record<string, unknown>[] }[] = [];
  const push = (role: "user" | "assistant", content: Record<string, unknown>) => {
    const last = wire.at(-1);
    if (last?.role === role) last.content.push(content);
    else wire.push({ role, content: [content] });
  };
  for (const message of convertToLlm([...messages])) {
    if (message.role === "user") {
      const blocks =
        typeof message.content === "string"
          ? [{ type: "text" as const, text: message.content }]
          : message.content;
      for (const block of blocks)
        push("user", block.type === "text" ? { type: "text", text: block.text } : image(block));
    } else if (message.role === "assistant") {
      if (["error", "aborted", "deferred"].includes(message.stopReason)) continue;
      for (const block of message.content) {
        if (block.type === "text" && block.text)
          push("assistant", { type: "text", text: block.text });
        if (block.type === "toolCall")
          push("assistant", {
            type: "tool_use",
            id: id(block.id),
            name: block.name,
            input: block.arguments,
          });
      }
    } else {
      push("user", {
        type: "tool_result",
        tool_use_id: id(message.toolCallId),
        is_error: message.isError,
        content: message.content.map((block) =>
          block.type === "text" ? { type: "text", text: block.text } : image(block),
        ),
      });
    }
  }
  return wire[0]?.role === "user" ? wire : "Conversation must begin with a user message.";
}

function requestHeaders(
  input: ProviderCompactionInput,
  auth: ResolvedAuth,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries({ ...input.model.headers, ...auth.auth.headers })
      .filter((pair): pair is [string, string] => typeof pair[1] === "string")
      .map(([key, value]) => [key.toLowerCase(), value]),
  );
}
function endpoint(input: ProviderCompactionInput, auth: ResolvedAuth): string {
  return `${new URL(auth.auth.baseUrl ?? input.model.baseUrl).origin}/v1`;
}
async function postJson(
  input: ProviderCompactionInput,
  url: string,
  headers: Record<string, string>,
  body: unknown,
): Promise<Response> {
  input.signal?.throwIfAborted();
  const timeout = AbortSignal.timeout(120_000);
  return (input.fetch ?? globalThis.fetch)(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
    redirect: "error",
    signal: input.signal ? AbortSignal.any([input.signal, timeout]) : timeout,
  });
}
async function failure(
  response: Response,
  endpointName: string,
): Promise<ProviderCompactionOutcome> {
  return {
    kind: "failed",
    message: `${endpointName} failed with ${response.status}: ${sanitizeDiagnostic((await response.text()).slice(0, 500))}`,
  };
}
function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}
/** Pi's ledger convention: OpenAI cached input is a subset, Claude cache fields are additive. */
function readUsage(value: unknown, model: Model<Api>, anthropic: boolean): Usage | undefined {
  if (!record(value)) return undefined;
  const input = count(value["input_tokens"]);
  const cacheRead = anthropic
    ? count(value["cache_read_input_tokens"])
    : record(value["input_tokens_details"])
      ? Math.min(input, count(value["input_tokens_details"]["cached_tokens"]))
      : 0;
  const usage: Usage = {
    input: anthropic ? input : input - cacheRead,
    output: count(value["output_tokens"]),
    cacheRead,
    cacheWrite: anthropic ? count(value["cache_creation_input_tokens"]) : 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
  calculateCost(model, usage);
  // Claude compaction iterations are explicitly EXCLUDED from top-level usage.
  // Price each independently so context-tier rates apply to the right request.
  if (anthropic && Array.isArray(value["iterations"])) {
    for (const iteration of value["iterations"]) {
      if (!record(iteration) || iteration["type"] !== "compaction") continue;
      const extra = readUsage(iteration, model, true)!;
      for (const key of ["input", "output", "cacheRead", "cacheWrite"] as const) {
        usage[key] += extra[key];
        usage.cost[key] += extra.cost[key];
      }
      usage.cost.total += extra.cost.total;
    }
  }
  usage.totalTokens = usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
  return usage;
}
function usageFor(usage: Usage | undefined, model: Model<Api>): SessionUsage | null {
  return sessionUsageFrom(
    usage,
    { provider: model.provider, model: model.id, api: model.api },
    "compaction",
  );
}

const image = (block: { mimeType: string; data: string }) => ({
  type: "image",
  source: { type: "base64", media_type: block.mimeType, data: block.data },
});
const id = (value: string) => value.replace(/[^a-zA-Z0-9_-]/g, "_");

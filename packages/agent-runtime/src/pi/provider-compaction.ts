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
import {
  convertToLlm,
  COMPACTION_SUMMARY_PREFIX,
  type AgentMessage,
} from "@earendil-works/pi-agent-core";
import {
  calculateCost,
  type Api,
  type Model,
  type Models,
  type Tool,
  type Usage,
} from "@earendil-works/pi-ai";
import { convertResponsesMessages } from "@earendil-works/pi-ai/api/openai-responses-shared";
import { transformMessages } from "@earendil-works/pi-ai/api/transform-messages";
import { sanitizeSurrogates } from "@earendil-works/pi-ai/utils/sanitize-unicode";
import type { SessionUsage } from "@volli/shared";
import { Buffer } from "node:buffer";
import { costBasisForApi, sanitizeDiagnostic } from "./transcript";

export const ANTHROPIC_COMPACT_BETA = "compact-2026-01-12";
export const ANTHROPIC_COMPACT_MIN_TRIGGER_TOKENS = 50_000;
const CLAUDE_MODELS =
  /^(?:claude-(?:opus-4-[678]|sonnet-4-6|opus-5|sonnet-5|fable-5(?:-1)?|mythos-5(?:-1)?|mythos-preview))(?:-\d{8})?$/;

export type ProviderCompactionState =
  | {
      kind: "openai-responses";
      /** Records by construction: {@link openAIWindow} refuses anything else. */
      items: readonly Record<string, unknown>[];
      model: string;
      compactedAt: number;
    }
  | {
      kind: "anthropic-messages";
      block: Record<string, unknown>;
      model: string;
      compactedAt: number;
    };

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function openAIWindow(value: unknown): value is Record<string, unknown>[] {
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
function anthropicBlock(
  value: unknown,
): value is Record<string, unknown> & { type: "compaction"; content: string } {
  // A null-content block is a documented failed/no-op compaction, NOT a checkpoint.
  return (
    record(value) &&
    value["type"] === "compaction" &&
    typeof value["content"] === "string" &&
    value["content"].length > 0
  );
}

/**
 * What one durable compaction entry's `details` says about native state.
 *
 * Three answers, not two, because a malformed checkpoint is not the same fact
 * as an absent one and the two callers want opposite things from it. The
 * OUTGOING projection must fail closed — a request that silently sent the empty
 * placeholder would ask the model to continue from nothing — so
 * {@link providerCompactionFromDetails} throws. Attaching a Session must not:
 * the original history is still on disk, so a Session whose checkpoint cannot
 * be read is recoverable by rebuilding from it, and refusing to attach would
 * turn one unreadable entry into a Session nobody can open (VC-331).
 */
export type ProviderCompactionRead =
  | { kind: "absent" }
  | { kind: "state"; state: ProviderCompactionState }
  | { kind: "malformed"; reason: string };

export function readProviderCompaction(details: unknown): ProviderCompactionRead {
  if (!record(details) || !("providerCompaction" in details)) return { kind: "absent" };
  const state = details["providerCompaction"];
  if (
    record(state) &&
    typeof state["model"] === "string" &&
    typeof state["compactedAt"] === "number" &&
    Number.isFinite(state["compactedAt"]) &&
    ((state["kind"] === "openai-responses" && openAIWindow(state["items"])) ||
      (state["kind"] === "anthropic-messages" && anthropicBlock(state["block"])))
  )
    return { kind: "state", state: state as ProviderCompactionState };
  return {
    kind: "malformed",
    reason:
      "A provider-native compaction checkpoint could not be read; this Session continues from its original history.",
  };
}

/** A malformed durable checkpoint must never degrade to its empty placeholder. */
export function providerCompactionFromDetails(
  details: unknown,
): ProviderCompactionState | undefined {
  const read = readProviderCompaction(details);
  if (read.kind === "malformed")
    throw new Error("The provider-native compaction checkpoint is malformed.");
  return read.kind === "state" ? read.state : undefined;
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
  /**
   * Where each native HTTP call is reported, so a direct request is not a hole
   * in the instrumentation every other model call feeds (VC-331).
   *
   * This module reports only what it measured; the attachment owns what those
   * facts MEAN. Volli's passive Usage Window read and its provider-attempt
   * envelope are both product vocabulary, and neither belongs in a module whose
   * job is one provider's wire protocol. A hook that throws costs the
   * measurement, never the compaction.
   */
  onNativeRequest?: (observation: NativeRequestObservation) => void;
}

/** One native HTTP call, in facts an instrumentation seam can read. */
export interface NativeRequestObservation {
  /** Which endpoint answered, as a bounded word rather than a URL. */
  endpoint: "openai-compact" | "anthropic-count-tokens" | "anthropic-compact";
  status: number;
  durationMs: number;
  /** Lowercased response headers. Rate-limit headers live here. */
  headers: Record<string, string>;
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

/**
 * The same verdict against the route a request would ACTUALLY take.
 *
 * The catalog's `baseUrl` and provider id are a claim about where a model
 * lives; the resolved credential is what decides. An OAuth subscription and a
 * credential that overrides the endpoint both reach a backend that has no
 * standalone compaction API even though the catalog entry still says
 * `api.anthropic.com`, so a checkpoint minted on the public API is not
 * replayable there. Both the compaction call and checkpoint replay eligibility
 * ask this one function, so they cannot drift (VC-331).
 */
export function nativeCompactionRoute(
  model: Pick<Model<Api>, "provider" | "api" | "baseUrl" | "id">,
  auth: Pick<ResolvedAuth, "source"> & { auth: { baseUrl?: string; apiKey?: string } },
): { supported: true } | { supported: false; reason: string } {
  const unsupported = {
    supported: false as const,
    reason:
      "Native compaction requires the supported public API endpoint and API-key authentication.",
  };
  const catalog = nativeCompactionSupport(model);
  if (!catalog.supported) return catalog;
  if (!nativeCompactionSupport({ ...model, baseUrl: auth.auth.baseUrl ?? model.baseUrl }).supported)
    return unsupported;
  // A subscription token reaches a different backend than the metered API, and
  // Anthropic's OAuth access tokens are recognizable even when `source` is not.
  if (/oauth/i.test(auth.source ?? "") || auth.auth.apiKey?.startsWith("sk-ant-oat"))
    return unsupported;
  return { supported: true };
}

/**
 * Whether THIS model, on the credential that resolves for it right now, can
 * replay a native checkpoint it minted earlier.
 *
 * Resolved at attach and at model selection rather than per request: `getAuth`
 * can refresh an OAuth token or read a keychain, and the outgoing projection
 * runs inside the stream call. A credential swapped mid-Session takes effect at
 * the next attach or model selection, which is when a Session's route is
 * re-decided anyway.
 */
export async function nativeCompactionAvailable(
  model: Model<Api>,
  models: Pick<Models, "getAuth">,
  signal?: AbortSignal,
): Promise<boolean> {
  if (!nativeCompactionSupport(model).supported) return false;
  try {
    const auth = await models.getAuth(model, { signal });
    return auth !== undefined && nativeCompactionRoute(model, auth).supported;
  } catch {
    // An unresolvable credential is not a route this checkpoint can be replayed
    // on. The Session falls back to its original durable history.
    return false;
  }
}

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
    const route = nativeCompactionRoute(input.model, auth);
    if (!route.supported) return { kind: "unsupported", reason: route.reason };
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
    "openai-compact",
    `${endpoint(input, auth)}/responses/compact`,
    headers,
    request,
  );
  if (!response.ok) return failure(response, "OpenAI /responses/compact");
  const parsed: unknown = await boundedJson(response);
  input.signal?.throwIfAborted();
  const rawUsage = record(parsed)
    ? toPiUsage(readUsage(parsed["usage"], false), input.model)
    : undefined;
  if (!record(parsed) || !openAIWindow(parsed["output"]))
    return {
      kind: "failed",
      message: "OpenAI /responses/compact returned no valid compaction window.",
      ...(rawUsage ? { rawUsage } : {}),
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
    ...(rawUsage ? { rawUsage } : {}),
    usage: toSessionUsage(rawUsage, input.model),
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
  const messages = toAnthropicMessages(input.messages, input.model);
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
    "anthropic-count-tokens",
    `${endpoint(input, auth)}/messages/count_tokens`,
    headers,
    request,
  );
  if (!counted.ok) return failure(counted, "Anthropic token counting");
  const countResult: unknown = await boundedJson(counted);
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
  const response = await postJson(
    input,
    "anthropic-compact",
    `${endpoint(input, auth)}/messages`,
    headers,
    {
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
    },
  );
  if (!response.ok) return failure(response, "Anthropic compaction");
  const parsed: unknown = await boundedJson(response);
  input.signal?.throwIfAborted();
  const rawUsage = record(parsed)
    ? toPiUsage(readUsage(parsed["usage"], true), input.model)
    : undefined;
  const block =
    record(parsed) && Array.isArray(parsed["content"])
      ? parsed["content"].find(anthropicBlock)
      : undefined;
  if (!record(parsed) || parsed["stop_reason"] !== "compaction" || !block)
    return {
      kind: "failed",
      message: "Anthropic did not return a successful compaction block.",
      ...(rawUsage ? { rawUsage } : {}),
    };
  return {
    kind: "compacted",
    state: { kind: "anthropic-messages", block, model: input.model.id, compactedAt: Date.now() },
    textSummary: block.content,
    ...(rawUsage ? { rawUsage } : {}),
    usage: toSessionUsage(rawUsage, input.model),
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

/**
 * The conversation as Anthropic's Messages API requires it for the standalone
 * summarizer, restated from Pi's own adapter rather than simplified.
 *
 * PI-RESTATED(0.85.0): `anthropic-messages`' private `convertMessages`. This is
 * the same request shape a later reply will be sent in, and the projected
 * checkpoint has to land in a conversation the API accepts, so "a visible-text
 * summary of what happened" is not good enough:
 *
 * - **Thinking travels or the request is refused.** Anthropic's rule for tool
 *   use is that the assistant turn goes back complete and unmodified: a
 *   `thinking` block keeps its `signature`, a `redacted_thinking` block keeps
 *   its opaque `data`, and filtering either one out of a turn that also carries
 *   `tool_use` is a documented 400. Every compaction-capable model is one of
 *   the generations that KEEPS prior thinking in context, so these blocks are
 *   also part of what the summarizer reads (the docs call that out for the
 *   custom-`instructions` case, which excludes them).
 * - **A `tool_use` without its `tool_result` is a 400 too.** Pi's exported
 *   `transformMessages` is what closes that: it drops the errored and aborted
 *   replies this runtime also refuses to replay, synthesizes results for tool
 *   calls that never got one, normalizes tool-call ids to Anthropic's
 *   `^[a-zA-Z0-9_-]+$`, renames the matching results, and downgrades images a
 *   model cannot take. Doing that by hand here would be a second rule.
 *
 * A signature-less thinking block becomes text, exactly as Pi does it, because
 * Anthropic rejects an unsigned one; `compat.allowEmptySignature` models keep
 * theirs. Tool definitions ride on the request but nothing executes: the
 * response is a compaction block, not a turn.
 */
export function toAnthropicMessages(
  messages: readonly AgentMessage[],
  model: Model<Api>,
): Record<string, unknown>[] | string {
  const wire: { role: "user" | "assistant"; content: Record<string, unknown>[] }[] = [];
  const push = (role: "user" | "assistant", content: Record<string, unknown>) => {
    const last = wire.at(-1);
    if (last?.role === role) last.content.push(content);
    else wire.push({ role, content: [content] });
  };
  const compat: Record<string, unknown> = record(model.compat) ? model.compat : {};
  const allowEmptySignature = compat["allowEmptySignature"] === true;
  for (const message of transformMessages(
    convertToLlm([...messages]),
    model,
    normalizeToolCallId,
  )) {
    if (message.role === "user") {
      const blocks =
        typeof message.content === "string"
          ? [{ type: "text" as const, text: message.content }]
          : message.content;
      for (const block of blocks) {
        if (block.type !== "text") push("user", image(block));
        else if (block.text.trim().length > 0)
          push("user", { type: "text", text: sanitizeSurrogates(block.text) });
      }
    } else if (message.role === "assistant") {
      // `transformMessages` already dropped `error` and `aborted`; a deferred
      // reply is Volli's own third unreplayable stop reason.
      if (message.stopReason === "deferred") continue;
      const blocks: Record<string, unknown>[] = [];
      for (const block of message.content) {
        if (block.type === "text") {
          if (block.text.trim().length > 0)
            blocks.push({ type: "text", text: sanitizeSurrogates(block.text) });
        } else if (block.type === "thinking") {
          if (block.redacted) {
            blocks.push({ type: "redacted_thinking", data: block.thinkingSignature });
            continue;
          }
          // A block with neither text nor signature never arrives: Pi's
          // `transformMessages` drops it ahead of this.
          const signature = block.thinkingSignature;
          const signed = signature !== undefined && signature.trim().length > 0;
          if (signed)
            blocks.push({
              type: "thinking",
              thinking: sanitizeSurrogates(block.thinking),
              signature,
            });
          else if (allowEmptySignature)
            blocks.push({
              type: "thinking",
              thinking: sanitizeSurrogates(block.thinking),
              signature: "",
            });
          else blocks.push({ type: "text", text: sanitizeSurrogates(block.thinking) });
        } else if (block.type === "toolCall") {
          blocks.push({
            type: "tool_use",
            // Normalized on both sides at the wire rather than only for the
            // cross-model case Pi's transform covers: the function is
            // deterministic and idempotent, so a call and its result cannot
            // disagree, and an id that never met Anthropic's grammar cannot
            // reach it just because the message claims the same model.
            id: normalizeToolCallId(block.id),
            name: block.name,
            input: block.arguments ?? {},
          });
        }
      }
      for (const block of blocks) push("assistant", block);
    } else {
      push("user", {
        type: "tool_result",
        tool_use_id: normalizeToolCallId(message.toolCallId),
        is_error: message.isError,
        content: anthropicToolResultContent(message.content),
      });
    }
  }
  return wire[0]?.role === "user" ? wire : "Conversation must begin with a user message.";
}

type ToolResultBlock = { type: "text"; text: string } | { mimeType: string; data: string };

function isTextBlock(block: ToolResultBlock): block is { type: "text"; text: string } {
  return "type" in block && block.type === "text";
}

/** Pi's `convertContentBlocks`: a plain string unless an image forces blocks. */
function anthropicToolResultContent(
  content: readonly ToolResultBlock[],
): string | Record<string, unknown>[] {
  if (content.every(isTextBlock))
    return sanitizeSurrogates(content.map((block) => block.text).join("\n"));
  const blocks = content.map((block) =>
    isTextBlock(block) ? { type: "text", text: sanitizeSurrogates(block.text) } : image(block),
  );
  return blocks.some((block) => block["type"] === "text")
    ? blocks
    : [{ type: "text", text: "(see attached image)" }, ...blocks];
}

/** Pi's `normalizeToolCallId`: Anthropic's id grammar, and its 64-character cap. */
const normalizeToolCallId = (value: string): string =>
  value.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);

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
/**
 * A native response body is bounded before it is parsed. A canonical OpenAI
 * window legitimately runs to megabytes of opaque state, so the ceiling is
 * generous rather than tight — but it is a ceiling, because a first-party
 * endpoint answering with an unbounded stream must fail this request rather
 * than the process.
 */
const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;
const MAX_ERROR_BODY_BYTES = 8 * 1024;

async function postJson(
  input: ProviderCompactionInput,
  route: NativeRequestObservation["endpoint"],
  url: string,
  headers: Record<string, string>,
  body: unknown,
): Promise<Response> {
  input.signal?.throwIfAborted();
  const timeout = AbortSignal.timeout(120_000);
  const startedAt = Date.now();
  const response = await (input.fetch ?? globalThis.fetch)(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
    redirect: "error",
    signal: input.signal ? AbortSignal.any([input.signal, timeout]) : timeout,
  });
  try {
    input.onNativeRequest?.({
      endpoint: route,
      status: response.status,
      durationMs: Date.now() - startedAt,
      headers: headerRecord(response),
    });
  } catch {
    // A lost measurement, never a lost compaction.
  }
  return response;
}

function headerRecord(response: Response): Record<string, string> {
  const headers: Record<string, string> = {};
  response.headers?.forEach((value, key) => {
    headers[key.toLowerCase()] = value;
  });
  return headers;
}

/**
 * A response body, read no further than `limit` bytes.
 *
 * The two callers want opposite things from that limit, so they say which. A
 * JSON body has to arrive whole or not at all — half a canonical window is not
 * a smaller canonical window — so it `fail`s. An error body is only ever read
 * for its first few hundred characters, so it `truncate`s: refusing to quote a
 * provider's complaint because the complaint was long would lose the one thing
 * that failure was carrying.
 */
async function boundedText(
  response: Response,
  limit: number,
  whenOversized: "fail" | "truncate",
): Promise<string> {
  const body = response.body;
  if (!body) return (await response.text()).slice(0, limit);
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      size += value.byteLength;
      if (size <= limit) continue;
      await reader.cancel();
      if (whenOversized === "fail")
        throw new Error("The provider response exceeded the size this runtime will read.");
      break;
    }
  } finally {
    reader.releaseLock();
  }
  return new TextDecoder().decode(Buffer.concat(chunks)).slice(0, limit);
}

async function boundedJson(response: Response): Promise<unknown> {
  return JSON.parse(await boundedText(response, MAX_RESPONSE_BYTES, "fail")) as unknown;
}

async function failure(
  response: Response,
  endpointName: string,
): Promise<ProviderCompactionOutcome> {
  const body = await boundedText(response, MAX_ERROR_BODY_BYTES, "truncate");
  return {
    kind: "failed",
    message: `${endpointName} failed with ${response.status}: ${sanitizeDiagnostic(body.slice(0, 500))}`,
  };
}

/**
 * What a provider REPORTED, with absence kept absent.
 *
 * A token class the response did not carry is not a class that cost nothing:
 * "an unreported number is absent, never zero" is the Metered operation rule,
 * and folding a missing `output_tokens` into a 0 makes a partial measurement
 * indistinguishable from a free one on every surface that later sums these
 * rows. Pi's own `Usage` cannot express that — its four fields are required
 * numbers — so the nullable counts are read first and the Pi shape is derived
 * from them only where Pi's storage demands one (VC-331).
 */
interface NativeTokenCounts {
  input: number | null;
  output: number | null;
  cacheRead: number | null;
  cacheWrite: number | null;
}

function count(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function sum(left: number | null, right: number | null): number | null {
  if (left === null) return right;
  if (right === null) return left;
  return left + right;
}

/** Pi's ledger convention: OpenAI cached input is a subset, Claude cache fields are additive. */
function readUsage(value: unknown, anthropic: boolean): NativeTokenCounts | undefined {
  return record(value) ? readReportedUsage(value, anthropic) : undefined;
}

function readReportedUsage(value: Record<string, unknown>, anthropic: boolean): NativeTokenCounts {
  const reported = count(value["input_tokens"]);
  const details = value["input_tokens_details"];
  const cached = anthropic
    ? count(value["cache_read_input_tokens"])
    : record(details)
      ? count(details["cached_tokens"])
      : null;
  // OpenAI's cached share is a subset of a prompt it can never exceed.
  const cacheRead =
    !anthropic && cached !== null && reported !== null ? Math.min(reported, cached) : cached;
  const counts: NativeTokenCounts = {
    // OpenAI's `input_tokens` INCLUDES the cached share; Anthropic's does not.
    input: anthropic || reported === null ? reported : Math.max(0, reported - (cacheRead ?? 0)),
    output: count(value["output_tokens"]),
    cacheRead,
    cacheWrite: anthropic ? count(value["cache_creation_input_tokens"]) : null,
  };
  // Claude compaction iterations are explicitly EXCLUDED from top-level usage.
  if (!anthropic || !Array.isArray(value["iterations"])) return counts;
  return value["iterations"].reduce<NativeTokenCounts>((held, iteration) => {
    if (!record(iteration) || iteration["type"] !== "compaction") return held;
    const extra = readReportedUsage(iteration, true);
    return {
      input: sum(held.input, extra.input),
      output: sum(held.output, extra.output),
      cacheRead: sum(held.cacheRead, extra.cacheRead),
      cacheWrite: sum(held.cacheWrite, extra.cacheWrite),
    };
  }, counts);
}

/**
 * The Pi `Usage` a durable compaction entry stores, or nothing when the
 * provider reported no class at all. Absent classes become zero HERE and only
 * here, because Pi's storage shape has no other spelling; the Session's own
 * bill is built from the nullable counts by {@link toSessionUsage}.
 */
function toPiUsage(
  counts: NativeTokenCounts | undefined,
  model: Model<Api>,
): (Usage & { reported: NativeTokenCounts }) | undefined {
  if (counts === undefined) return undefined;
  if (Object.values(counts).every((value) => value === null)) return undefined;
  const usage: Usage & { reported: NativeTokenCounts } = {
    input: counts.input ?? 0,
    output: counts.output ?? 0,
    cacheRead: counts.cacheRead ?? 0,
    cacheWrite: counts.cacheWrite ?? 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    reported: counts,
  };
  calculateCost(model, usage);
  usage.totalTokens = usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
  return usage;
}

/** The Session's bill, with every class the provider did not report left null. */
function toSessionUsage(
  usage: (Usage & { reported: NativeTokenCounts }) | undefined,
  model: Model<Api>,
): SessionUsage | null {
  if (usage === undefined) return null;
  const costUsd = Number.isFinite(usage.cost.total) ? usage.cost.total : null;
  return {
    cause: "compaction",
    providerId: model.provider,
    modelId: model.id,
    inputTokens: usage.reported.input,
    outputTokens: usage.reported.output,
    cacheReadTokens: usage.reported.cacheRead,
    cacheWriteTokens: usage.reported.cacheWrite,
    costUsd,
    costBasis: costUsd === null ? "unavailable" : costBasisForApi(model.api),
  };
}

const image = (block: { mimeType: string; data: string }) => ({
  type: "image",
  source: { type: "base64", media_type: block.mimeType, data: block.data },
});

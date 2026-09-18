/**
 * Context estimates, never billed usage. Published OpenAI BPE vocabularies
 * count text locally; framing and vision remain estimates. For other model
 * families use a conservative Unicode-aware fallback until the provider has
 * measured the request. No credentials, downloads or token-counting API calls.
 */

import { Buffer } from "node:buffer";
import { countTokens as countO200k } from "gpt-tokenizer/encoding/o200k_base";
import { countTokens as countCl100k } from "gpt-tokenizer/encoding/cl100k_base";
import { calculateContextTokens, type AgentMessage } from "@earendil-works/pi-agent-core";
import type { Api, AssistantMessage, Model, Tool } from "@earendil-works/pi-ai";

// ASCII code/JSON is denser than prose. Non-ASCII uses UTF-8 bytes as an
// upper-bound-style fallback; dividing UTF-16 length by four badly undercounts
// CJK and emoji. Neither this nor image framing is advertised as exact.
const IMAGE_TOKENS = 4096;
const PER_MESSAGE_FRAMING = 8;
const PER_TOOL_FRAMING = 8;
const SYSTEM_PROMPT_FRAMING = 8;
const LITERAL_SPECIAL_TOKENS = { disallowedSpecial: new Set<string>() };

type TokenCounter = (text: string) => number;
type TokenizerFamily = "o200k" | "cl100k" | "conservative";

const O200K_ID_PATTERN = /^(?:gpt-4o|gpt-4\.[15]|gpt-5|o[134](?:-|$)|chatgpt-4o|codex-mini)/;
const CL100K_ID_PATTERN = /^(?:gpt-4(?:-|$)|gpt-3\.5)/;

function tokenizerFamily(model: Model<Api>): TokenizerFamily {
  if (!model.api.startsWith("openai") && model.api !== "azure-openai-responses")
    return "conservative";
  const id = model.id.toLowerCase();
  if (O200K_ID_PATTERN.test(id)) return "o200k";
  if (CL100K_ID_PATTERN.test(id)) return "cl100k";
  return "conservative";
}

function exactTokenizerFor(model: Model<Api>): TokenCounter | undefined {
  const family = tokenizerFamily(model);
  if (family === "o200k") return (text) => countO200k(text, LITERAL_SPECIAL_TOKENS);
  if (family === "cl100k") return (text) => countCl100k(text, LITERAL_SPECIAL_TOKENS);
  return undefined;
}

function conservativeTokens(text: string): number {
  let ascii = 0;
  for (let index = 0; index < text.length; index++) {
    if (text.charCodeAt(index) < 128) ascii++;
  }
  return Math.ceil(ascii / 3) + Buffer.byteLength(text, "utf8") - ascii;
}

function counterFor(model: Model<Api>): TokenCounter {
  return exactTokenizerFor(model) ?? conservativeTokens;
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value ?? null) ?? "null";
  } catch {
    // A cyclic or throwing payload still occupies context — a provider
    // stringifies it or refuses it; refusing means the request fails and
    // occupies nothing. The `?? "{}"` keeps the estimate a number either way.
    return "{}";
  }
}

function isText(block: { type: string }): block is { type: "text"; text: string } {
  return block.type === "text";
}

function contentTokens(content: string | readonly { type: string }[], count: TokenCounter): number {
  if (typeof content === "string") return count(content);
  let tokens = 0;
  for (const block of content) {
    if (isText(block)) tokens += count(block.text);
    else if (block.type === "image") tokens += IMAGE_TOKENS;
  }
  return tokens;
}

function usageValid(usage: AssistantMessage["usage"]): boolean {
  return (
    typeof usage === "object" &&
    usage !== null &&
    [usage.input, usage.output, usage.cacheRead, usage.cacheWrite].every(
      (field) => typeof field === "number" && Number.isFinite(field) && field >= 0,
    )
  );
}

/**
 * Valid measurement: Pi's own `calculateContextTokens` over a validated block,
 * so the projected half and the compaction decision share one definition of
 * "measured" even where a provider's `totalTokens` totals differently.
 */
function measuredTokens(usage: AssistantMessage["usage"]): number | undefined {
  if (!usageValid(usage) || !Number.isFinite(usage.totalTokens) || usage.totalTokens < 0)
    return undefined;
  const tokens = calculateContextTokens(usage);
  return Number.isFinite(tokens) && tokens > 0 ? tokens : undefined;
}

/** Whether a settled assistant reply's usage was measured by this model. */
function isCurrentModelUsage(message: AgentMessage, model: Model<Api>): boolean {
  return (
    message.role === "assistant" &&
    message.stopReason !== "error" &&
    message.stopReason !== "aborted" &&
    message.stopReason !== "deferred" &&
    message.provider === model.provider &&
    message.api === model.api &&
    message.model === model.id &&
    usageValid((message as AssistantMessage).usage)
  );
}

/**
 * Tokens for one message as the current model's provider would hold it.
 *
 * Per role:
 * - `user` / `toolResult` / `custom`: text through the counter, images at the
 *   flat conservative figure.
 * - `assistant`: text, thinking (it is replayed context for the providers
 *   that bind it), and each tool call's name plus full JSON arguments —
 *   arguments are machine-generated and tokenize densely, so this is exactly
 *   the place `chars/4` understated and the conservative divisor earns keep.
 * - `bashExecution`: rendered as `convertToLlm` renders it, and zero when
 *   excluded from context, because excluded means it never reaches a
 *   provider and honest estimates price only what is sent.
 * - `branchSummary` / `compactionSummary`: the prefix + summary + suffix
 *   wrapper Pi's `convertToLlm` actually sends, not the bare summary.
 */
export function estimateMessageTokens(message: AgentMessage, model: Model<Api>): number {
  const count = counterFor(model);
  switch (message.role) {
    case "user":
      return PER_MESSAGE_FRAMING + contentTokens(message.content, count);
    case "assistant": {
      let tokens = PER_MESSAGE_FRAMING;
      for (const block of message.content) {
        if (isText(block)) tokens += count(block.text);
        else if (block.type === "thinking") tokens += count(block.thinking);
        else if (block.type === "toolCall")
          tokens += count(block.name) + count(safeJson(block.arguments));
      }
      return tokens;
    }
    case "toolResult":
      return PER_MESSAGE_FRAMING + count(message.toolName) + contentTokens(message.content, count);
    case "custom":
      return PER_MESSAGE_FRAMING + contentTokens(message.content, count);
    case "bashExecution": {
      if (message.excludeFromContext) return 0;
      const text = `Ran \`${message.command}\`\n${message.output}`;
      return PER_MESSAGE_FRAMING + count(text);
    }
    case "branchSummary":
      return (
        PER_MESSAGE_FRAMING +
        count(
          `The following is a summary of a branch that this conversation came back from:\n\n<summary>\n${message.summary}</summary>`,
        )
      );
    case "compactionSummary":
      return (
        PER_MESSAGE_FRAMING +
        count(
          `The conversation history before this point was compacted into the following summary:\n\n<summary>\n${message.summary}\n</summary>`,
        )
      );
    default:
      // An unknown custom role added by declaration merging after this module
      // was written: estimate nothing rather than guess, and let the caller's
      // other signals carry the occupancy.
      return 0;
  }
}

/** Tokens for the tool definitions a request carries. */
function toolsTokens(tools: readonly Tool[] | undefined, count: TokenCounter): number {
  if (!tools || tools.length === 0) return 0;
  return tools.reduce(
    (total, tool) =>
      total +
      PER_TOOL_FRAMING +
      count(
        safeJson({ name: tool.name, description: tool.description, parameters: tool.parameters }),
      ),
    0,
  );
}

/**
 * The two things a projection must estimate because no provider usage covers
 * them: one settled message, and the request metadata ahead of the messages.
 *
 * Named as one type because they always travel together and are always chosen
 * together — a caller either wants both estimates fresh or both reused. Making
 * that a single seam is what keeps the projection itself free of any knowledge
 * about whether an estimate was cached.
 */
interface ContextEstimator {
  message(message: AgentMessage, model: Model<Api>): number;
  prefix(
    model: Model<Api>,
    systemPrompt: string | undefined,
    tools: readonly Tool[] | undefined,
  ): number;
}

/** Estimates everything afresh. The honest answer when nothing is known to be reusable. */
const DIRECT_ESTIMATOR: ContextEstimator = {
  message: estimateMessageTokens,
  prefix: (model, systemPrompt, tools) => {
    const count = counterFor(model);
    return (
      (systemPrompt ? count(systemPrompt) + SYSTEM_PROMPT_FRAMING : 0) + toolsTokens(tools, count)
    );
  },
};

function wholeContextTokens(
  messages: readonly AgentMessage[],
  model: Model<Api>,
  systemPrompt: string | undefined,
  tools: readonly Tool[] | undefined,
  estimator: ContextEstimator,
): number {
  let tokens = estimator.prefix(model, systemPrompt, tools);
  for (const message of messages) tokens += estimator.message(message, model);
  return tokens;
}

/**
 * Model-aware estimate of the whole request: system prompt, tool definitions
 * and every message. No provider usage is consulted — this is the pure
 * estimate, for contexts the model has not measured yet.
 */
export function estimateContextTokens(
  messages: readonly AgentMessage[],
  model: Model<Api>,
  systemPrompt?: string,
  tools?: readonly Tool[],
): number {
  return wholeContextTokens(messages, model, systemPrompt, tools, DIRECT_ESTIMATOR);
}

/**
 * Last valid current-model usage plus the unmeasured suffix. Runtime context
 * reconstruction clears usage on retained replies after compaction: those
 * measurements belong to the replaced prefix, not the retained text.
 */
export function projectedContextTokens(
  messages: readonly AgentMessage[],
  model: Model<Api>,
  systemPrompt?: string,
  tools?: readonly Tool[],
): number {
  return projectContextTokens(messages, model, systemPrompt, tools, DIRECT_ESTIMATOR);
}

function projectContextTokens(
  messages: readonly AgentMessage[],
  model: Model<Api>,
  systemPrompt: string | undefined,
  tools: readonly Tool[] | undefined,
  estimator: ContextEstimator,
): number {
  let measured: number | undefined;
  let measuredIndex = -1;
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message?.role === "compactionSummary") {
      // Do not search history older than the current summary.
      break;
    }
    if (message && isCurrentModelUsage(message, model)) {
      measured = measuredTokens((message as AssistantMessage).usage);
      if (measured !== undefined) {
        measuredIndex = index;
        break;
      }
    }
  }
  if (measured === undefined) {
    return wholeContextTokens(messages, model, systemPrompt, tools, estimator);
  }
  let suffix = 0;
  for (let index = measuredIndex + 1; index < messages.length; index++) {
    suffix += estimator.message(messages[index]!, model);
  }
  return measured + suffix;
}

/**
 * Project one settled request context, reusing whatever this projector has
 * already counted. Callers must not mutate settled messages or tool
 * definitions in place.
 */
export type ContextTokenProjector = (
  messages: readonly AgentMessage[],
  model: Model<Api>,
  systemPrompt?: string,
  tools?: readonly Tool[],
) => number;

/**
 * One tokenizer family's reusable answers.
 *
 * Keyed by FAMILY rather than by model because `estimateMessageTokens` depends
 * on the model only through {@link counterFor}: two models of one family
 * necessarily agree, and two models of different families necessarily may not.
 *
 * The system prompt is a single slot rather than a map. Context Assembly makes
 * it a pure function of Role, bundle, product version and resource set, all
 * frozen for an attachment, so there is one value to hold; a map would keep
 * every multi-kilobyte prompt it ever saw alive as its own key to cache an
 * entry nothing asks for twice.
 */
interface FamilyEstimateCache {
  readonly count: TokenCounter;
  readonly messages: WeakMap<object, number>;
  readonly tools: WeakMap<readonly Tool[], number>;
  prompt: { readonly text: string; readonly tokens: number } | null;
}

/**
 * Per-attachment token projector for the repeated preflight checks made before
 * a turn and again before its provider request. Pi messages are append-only
 * once settled, and system/tool request metadata is frozen for an attachment,
 * so rescanning those identical values cannot improve the estimate.
 */
export function createContextTokenProjector(): ContextTokenProjector {
  const families = new Map<TokenizerFamily, FamilyEstimateCache>();
  const cacheFor = (model: Model<Api>): FamilyEstimateCache => {
    const family = tokenizerFamily(model);
    const existing = families.get(family);
    if (existing !== undefined) return existing;
    const created: FamilyEstimateCache = {
      count: counterFor(model),
      messages: new WeakMap<object, number>(),
      tools: new WeakMap<readonly Tool[], number>(),
      prompt: null,
    };
    families.set(family, created);
    return created;
  };

  const memoizing = (cache: FamilyEstimateCache): ContextEstimator => ({
    message: (message, model) => {
      const key = message as object;
      const existing = cache.messages.get(key);
      if (existing !== undefined) return existing;
      const estimated = estimateMessageTokens(message, model);
      cache.messages.set(key, estimated);
      return estimated;
    },
    prefix: (_model, systemPrompt, tools) => {
      let promptTokens = 0;
      if (systemPrompt) {
        if (cache.prompt?.text === systemPrompt) promptTokens = cache.prompt.tokens;
        else {
          promptTokens = cache.count(systemPrompt) + SYSTEM_PROMPT_FRAMING;
          cache.prompt = { text: systemPrompt, tokens: promptTokens };
        }
      }
      let toolTokens = 0;
      if (tools && tools.length > 0) {
        const existing = cache.tools.get(tools);
        if (existing !== undefined) toolTokens = existing;
        else {
          toolTokens = toolsTokens(tools, cache.count);
          cache.tools.set(tools, toolTokens);
        }
      }
      return promptTokens + toolTokens;
    },
  });

  return (messages, model, systemPrompt, tools) =>
    projectContextTokens(messages, model, systemPrompt, tools, memoizing(cacheFor(model)));
}

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
import {
  getCurrentTools,
  getSystemMessageText,
  type Api,
  type AssistantMessage,
  type Model,
  type SystemMessage,
  type Tool,
} from "@earendil-works/pi-ai";

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
 * - `system`: the rendered prompt text (content and sections, exactly as
 *   Pi's `getSystemMessageText` sends the leading one) plus every tool
 *   declaration it adds and the name of every tool it removes. Pi 0.86 moved
 *   the system prompt and tool declarations INTO the transcript as system
 *   messages, so a normalized request's prefix is now a message like any
 *   other, and the leading one costs exactly what the separate
 *   `systemPrompt` + `tools` pair cost before: same framing, same tool
 *   serialization. This is the message ON ITS OWN, as a provider that accepts
 *   mid-conversation system messages sends it in place; a whole transcript is
 *   priced by {@link estimateContextTokens}, which counts each declaration
 *   once however many messages carry it.
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
    case "system":
      return systemMessageTokens(message, count);
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

/**
 * One system message as the provider holds it: prompt text with its framing,
 * added declarations at the per-tool rate, removed names as bare text.
 *
 * An empty message — Pi's loop emits one carrying only tool deltas when the
 * executable set and the transcript disagree — costs only its deltas, so a
 * transcript with no prompt still prices its tools and nothing else.
 */
function systemMessageTokens(message: SystemMessage, count: TokenCounter): number {
  return systemTextTokens(message, count) + toolsTokens(message.toolsAdded, count);
}

/**
 * A system message without its declarations: the rendered text with its
 * framing, and the name of every tool it removes. What a transcript-wide
 * estimate prices per message, because the declarations are priced once over
 * the whole transcript rather than once per message that carries them.
 */
function systemTextTokens(message: SystemMessage, count: TokenCounter): number {
  const text = getSystemMessageText(message);
  let tokens = text.length > 0 ? SYSTEM_PROMPT_FRAMING + count(text) : 0;
  for (const removed of message.toolsRemoved ?? []) tokens += count(removed.name);
  return tokens;
}

/** Tokens for one tool definition as a request carries it. */
function toolTokens(tool: Tool, count: TokenCounter): number {
  return (
    PER_TOOL_FRAMING +
    count(safeJson({ name: tool.name, description: tool.description, parameters: tool.parameters }))
  );
}

/** Tokens for the tool definitions a request carries. */
function toolsTokens(tools: readonly Tool[] | undefined, count: TokenCounter): number {
  if (!tools || tools.length === 0) return 0;
  return tools.reduce((total, tool) => total + toolTokens(tool, count), 0);
}

/**
 * The things a projection must estimate because no provider usage covers
 * them: one settled message as sent in place, a system message's text alone,
 * and one tool declaration.
 *
 * Named as one type because they always travel together and are always chosen
 * together — a caller either wants every estimate fresh or every one reused.
 * Making that a single seam is what keeps the projection itself free of any
 * knowledge about whether an estimate was cached.
 */
interface ContextEstimator {
  message(message: AgentMessage, model: Model<Api>): number;
  systemText(message: SystemMessage, model: Model<Api>): number;
  tool(tool: Tool, model: Model<Api>): number;
}

/** Estimates everything afresh. The honest answer when nothing is known to be reusable. */
const DIRECT_ESTIMATOR: ContextEstimator = {
  message: estimateMessageTokens,
  systemText: (message, model) => systemTextTokens(message, counterFor(model)),
  tool: (tool, model) => toolTokens(tool, counterFor(model)),
};

/**
 * The whole request, unmeasured: every declaration the request carries, and
 * every message.
 *
 * Declarations are priced over the transcript rather than per message, through
 * Pi's own `getCurrentTools` — which is what every provider adapter is sent:
 * one that folds the system messages into a leading prompt sends exactly this
 * list, and one that anchors additions in place still declares each name
 * once. Later declarations win and removed tools are gone, so a tool the head
 * declares and a persisted delta declares again costs one declaration, not
 * two, and a tool a later delta removed costs nothing but its name. A system
 * message therefore contributes its text here and not its `toolsAdded`.
 */
function wholeContextTokens(
  messages: readonly AgentMessage[],
  model: Model<Api>,
  estimator: ContextEstimator,
): number {
  let tokens = 0;
  for (const tool of getCurrentTools(messages)) tokens += estimator.tool(tool, model);
  for (const message of messages) {
    tokens +=
      message.role === "system"
        ? estimator.systemText(message, model)
        : estimator.message(message, model);
  }
  return tokens;
}

/**
 * Model-aware estimate of the whole request. No provider usage is consulted —
 * this is the pure estimate, for contexts the model has not measured yet.
 *
 * The request is the transcript, and nothing beside it: since pi-ai 0.86 the
 * system prompt and the tool declarations are system messages inside
 * `messages`, and that is the only spelling this module prices. There is no
 * `systemPrompt` or `tools` parameter to hand the same tokens over a second
 * time. A caller holding a sidecar conversation and the attachment's own
 * prompt and tools composes the head with `systemHead` and prices
 * `withSystemHead(head, conversation)` — the same array the runtime sends —
 * and a transcript that declares a tool in more than one system message
 * still pays for it once (see {@link wholeContextTokens}).
 */
export function estimateContextTokens(
  messages: readonly AgentMessage[],
  model: Model<Api>,
): number {
  return wholeContextTokens(messages, model, DIRECT_ESTIMATOR);
}

/**
 * Last valid current-model usage plus the unmeasured suffix. Runtime context
 * reconstruction clears usage on retained replies after compaction: those
 * measurements belong to the replaced prefix, not the retained text.
 */
export function projectedContextTokens(
  messages: readonly AgentMessage[],
  model: Model<Api>,
): number {
  return projectContextTokens(messages, model, DIRECT_ESTIMATOR);
}

function projectContextTokens(
  messages: readonly AgentMessage[],
  model: Model<Api>,
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
    return wholeContextTokens(messages, model, estimator);
  }
  // Whole messages here, a system message's declarations included: a tool
  // delta after the measured reply declares what that request did not carry,
  // so its declarations are exactly the unmeasured part.
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
) => number;

/**
 * One tokenizer family's reusable answers.
 *
 * Keyed by FAMILY rather than by model because `estimateMessageTokens` depends
 * on the model only through {@link counterFor}: two models of one family
 * necessarily agree, and two models of different families necessarily may not.
 *
 * The system prompt needs no slot of its own: it is the text of the head, one
 * system message the runtime builds once per attachment and puts back at the
 * front of every array it rebuilds, so the per-message memo holds it exactly
 * as it holds any other settled message.
 */
interface FamilyEstimateCache {
  readonly count: TokenCounter;
  /** Whole messages, as sent in place. */
  readonly messages: WeakMap<object, number>;
  /** System messages without their declarations. */
  readonly systemText: WeakMap<object, number>;
  /**
   * One declaration each, keyed by the tool object: the head's declarations
   * are stable objects for the life of an attachment, and `getCurrentTools`
   * hands back those same objects, so the list it builds afresh per
   * projection still hits.
   */
  readonly tools: WeakMap<Tool, number>;
}

/** One memo slot: the estimate already held for `key`, or the one made now and kept. */
function remembered<K extends object>(
  slots: WeakMap<K, number>,
  key: K,
  estimate: () => number,
): number {
  const existing = slots.get(key);
  if (existing !== undefined) return existing;
  const estimated = estimate();
  slots.set(key, estimated);
  return estimated;
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
      systemText: new WeakMap<object, number>(),
      tools: new WeakMap<Tool, number>(),
    };
    families.set(family, created);
    return created;
  };

  const memoizing = (cache: FamilyEstimateCache): ContextEstimator => ({
    message: (message, model) =>
      remembered(cache.messages, message as object, () => estimateMessageTokens(message, model)),
    systemText: (message) =>
      remembered(cache.systemText, message, () => systemTextTokens(message, cache.count)),
    tool: (tool) => remembered(cache.tools, tool, () => toolTokens(tool, cache.count)),
  });

  return (messages, model) => projectContextTokens(messages, model, memoizing(cacheFor(model)));
}

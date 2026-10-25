/**
 * One adapter per relayable API family: how the provider wants its key, the
 * one request-body edit the gateway may make, and how to read the provider's
 * own usage report from its response.
 *
 * Usage is normalized to Pi's shape: `input` is uncached input, so cached
 * reads and cache writes are never counted twice.
 */
import type { GatewayApi, GatewayUsageTokens } from "@volli/shared/cloud";

/** Reads one call's usage from the events (or the JSON body) of its response. */
export interface UsageMeter {
  /** One parsed SSE `data:` payload, with its `event:` type when it had one. */
  event(data: unknown, type?: string): void;
  /** A whole non-streaming JSON response body. */
  json(body: unknown): void;
  /** Whether the provider's final usage report has been read. */
  readonly complete: boolean;
  readonly usage: GatewayUsageTokens;
  readonly modelId: string | undefined;
}

export interface ProviderAdapter {
  /**
   * The only endpoints relayed, by path under the route's base URL, with their
   * method. A key reaches far more than model calls (files, batches, stored
   * completions, fine-tuning); none of that is metered or the runner's to use.
   */
  endpoints: Readonly<Record<string, "GET" | "POST">>;
  /** The provider's native auth header for the real key. */
  authHeaders(key: string): Record<string, string>;
  /**
   * When set, the gateway parses the JSON request body (whatever its declared
   * content type) and forwards the result instead of the original bytes when
   * it is not `null`. Chat Completions streams report usage only when asked, so
   * the gateway asks.
   */
  editBody?(body: unknown): unknown;
  meter(): UsageMeter;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function count(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function cost(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function compact(tokens: GatewayUsageTokens): GatewayUsageTokens {
  return Object.fromEntries(Object.entries(tokens).filter(([, value]) => value !== undefined));
}

function minus(total: number | undefined, ...parts: (number | undefined)[]): number | undefined {
  if (total === undefined) return undefined;
  return Math.max(
    0,
    parts.reduce<number>((left, part) => left - (part ?? 0), total),
  );
}

abstract class BaseMeter implements UsageMeter {
  complete = false;
  usage: GatewayUsageTokens = {};
  modelId: string | undefined;

  abstract event(data: unknown, type?: string): void;
  abstract json(body: unknown): void;

  protected model(value: unknown): void {
    if (typeof value === "string" && value !== "") this.modelId = value;
  }
}

/**
 * Anthropic Messages. Input, cache read and cache write arrive with
 * `message_start`; `message_delta` carries the cumulative output count, and may
 * restate the input counts, so a later report wins field by field.
 */
class AnthropicMeter extends BaseMeter {
  event(data: unknown): void {
    const event = record(data);
    if (event?.type === "message_start") {
      const message = record(event.message);
      this.model(message?.model);
      this.read(message?.usage);
    } else if (event?.type === "message_delta" && record(event.usage)) {
      this.read(event.usage);
      this.complete = true;
    }
  }

  json(body: unknown): void {
    const message = record(body);
    this.model(message?.model);
    if (record(message?.usage)) {
      this.read(message?.usage);
      this.complete = true;
    }
  }

  private read(value: unknown): void {
    const usage = record(value);
    if (!usage) return;
    // A field the later report omits keeps its earlier value.
    this.usage = {
      ...this.usage,
      ...compact({
        input: count(usage.input_tokens),
        output: count(usage.output_tokens),
        cacheRead: count(usage.cache_read_input_tokens),
        cacheWrite: count(usage.cache_creation_input_tokens),
      }),
    };
  }
}

/** OpenAI Responses: the terminal `response.*` event carries the response and its usage. */
class OpenAiResponsesMeter extends BaseMeter {
  event(data: unknown): void {
    const event = record(data);
    const response = record(event?.response);
    this.model(response?.model);
    if (
      event?.type === "response.completed" ||
      event?.type === "response.incomplete" ||
      event?.type === "response.failed"
    ) {
      this.read(response?.usage);
    }
  }

  json(body: unknown): void {
    const response = record(body);
    this.model(response?.model);
    this.read(response?.usage);
  }

  private read(value: unknown): void {
    const usage = record(value);
    if (!usage) return;
    const cached = count(record(usage.input_tokens_details)?.cached_tokens);
    this.usage = compact({
      input: minus(count(usage.input_tokens), cached),
      output: count(usage.output_tokens),
      cacheRead: cached,
      reasoning: count(record(usage.output_tokens_details)?.reasoning_tokens),
    });
    this.complete = true;
  }
}

/**
 * Chat Completions (OpenAI-compatible endpoints and OpenRouter): the usage
 * chunk comes last, with empty `choices`. OpenRouter adds `cost` and, for
 * providers that charge for it, `cache_write_tokens`.
 */
class ChatCompletionsMeter extends BaseMeter {
  event(data: unknown): void {
    this.json(data);
  }

  json(body: unknown): void {
    const chunk = record(body);
    this.model(chunk?.model);
    const usage = record(chunk?.usage);
    if (!usage) return;
    const details = record(usage.prompt_tokens_details);
    const cacheRead = count(details?.cached_tokens);
    const cacheWrite = count(details?.cache_write_tokens);
    this.usage = compact({
      input: minus(count(usage.prompt_tokens), cacheRead, cacheWrite),
      output: count(usage.completion_tokens),
      cacheRead,
      cacheWrite,
      reasoning: count(record(usage.completion_tokens_details)?.reasoning_tokens),
      upstreamCostUsd: cost(usage.cost),
    });
    this.complete = true;
  }
}

const bearer = (key: string) => ({ authorization: `Bearer ${key}` });

export const PROVIDER_ADAPTERS: Record<GatewayApi, ProviderAdapter> = {
  "anthropic-messages": {
    endpoints: { "/v1/messages": "POST", "/v1/messages/count_tokens": "POST", "/v1/models": "GET" },
    authHeaders: (key) => ({ "x-api-key": key }),
    meter: () => new AnthropicMeter(),
  },
  "openai-responses": {
    endpoints: { "/responses": "POST", "/models": "GET" },
    authHeaders: bearer,
    meter: () => new OpenAiResponsesMeter(),
  },
  "openai-completions": {
    endpoints: { "/chat/completions": "POST", "/models": "GET" },
    authHeaders: bearer,
    editBody(body) {
      const request = record(body);
      if (request?.stream !== true) return null;
      const streamOptions = record(request.stream_options);
      if (streamOptions?.include_usage === true) return null;
      return { ...request, stream_options: { ...streamOptions, include_usage: true } };
    },
    meter: () => new ChatCompletionsMeter(),
  },
};

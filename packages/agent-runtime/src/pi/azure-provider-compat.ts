/**
 * Pi 1.5 renamed Azure's provider, not its Responses API. Our provider id is
 * durable: credentials, catalog caches, model selections and assistant history
 * already name `azure-openai-responses`, and older builds must still read new
 * writes. Keep that id outside Pi's request adapter; never migrate stored data.
 */
import {
  lazyStream,
  type Api,
  type AssistantMessage,
  type AssistantMessageEvent,
  type AssistantMessageEventStream,
  type Model,
  type Provider,
  type StreamOptions,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import type { CatalogSource } from "./model-catalog";

/** Frozen durable provider id, deliberately not Pi's current live id. */
const DURABLE_AZURE_ID = "azure-openai-responses";
const NATIVE_AZURE_ID = "azure";

function durableIdentity<T extends { provider: string }>(value: T): T {
  return { ...value, provider: DURABLE_AZURE_ID };
}

function nativeModel<T extends Api>(model: Model<T>): Model<T> {
  return { ...model, provider: NATIVE_AZURE_ID };
}

function nativeContext(context: TranscriptContext): TranscriptContext {
  return {
    ...context,
    messages: context.messages.map((message) =>
      message.role === "assistant" && message.provider === DURABLE_AZURE_ID
        ? { ...message, provider: NATIVE_AZURE_ID }
        : message,
    ),
  };
}

/** Callbacks are host-visible too: never hand them the temporary native id. */
function durableCallbacks<T extends StreamOptions>(options: T | undefined): T | undefined {
  if (options === undefined) return undefined;
  const { onPayload, onResponse, onProviderStreamEvent } = options;
  return {
    ...options,
    ...(onPayload && {
      onPayload: (payload: unknown, model: Model<Api>) =>
        onPayload(payload, durableIdentity(model)),
    }),
    ...(onResponse && {
      onResponse: (response, model) => onResponse(response, durableIdentity(model)),
    }),
    ...(onProviderStreamEvent && {
      onProviderStreamEvent: (event: unknown, model: Model<Api>) =>
        onProviderStreamEvent(event, durableIdentity(model)),
    }),
  };
}

function durableStream(
  model: Model<Api>,
  setup: () => AssistantMessageEventStream,
): AssistantMessageEventStream {
  return lazyStream(model, async () => {
    const source = setup();
    // Preserve Pi's shared live-partial semantics without mutating its private
    // native response, or changing any tool id, signature, usage or stop reason.
    const copies = new WeakMap<AssistantMessage, AssistantMessage>();
    const copy = (message: AssistantMessage): AssistantMessage => {
      const held = copies.get(message) ?? durableIdentity(message);
      Object.assign(held, message, { provider: DURABLE_AZURE_ID });
      copies.set(message, held);
      return held;
    };
    return {
      async *[Symbol.asyncIterator](): AsyncGenerator<AssistantMessageEvent> {
        for await (const event of source) {
          if (event.type === "done") yield { ...event, message: copy(event.message) };
          else if (event.type === "error") yield { ...event, error: copy(event.error) };
          else yield { ...event, partial: copy(event.partial) };
        }
      },
      result: async () => copy(await source.result()),
    };
  });
}

/** Applied before attaching the catalog, so its cache keys stay durable too. */
export function withDurableAzureProvider(provider: Provider): Provider {
  if (provider.id !== NATIVE_AZURE_ID) return provider;
  return {
    ...provider,
    id: DURABLE_AZURE_ID,
    getModels: () => provider.getModels().map(durableIdentity),
    getAllModels: () => (provider.getAllModels?.() ?? provider.getModels()).map(durableIdentity),
    // The native Responses adapter allowlists `azure`, not our durable id.
    // Both sides of same-provider comparisons must agree: changing only the
    // model loses signed thinking and corrupts composite function-call ids on
    // replay. Translate copies for dispatch only; persisted history is untouched.
    stream: (model, context, options) =>
      durableStream(model, () =>
        provider.stream(nativeModel(model), nativeContext(context), durableCallbacks(options)),
      ),
    streamSimple: (model, context, options) =>
      durableStream(model, () =>
        provider.streamSimple(
          nativeModel(model),
          nativeContext(context),
          durableCallbacks(options),
        ),
      ),
  };
}

/**
 * The public feed follows Pi's live name. Run its existing parser/redirection
 * guard against the same baseline with that name, then restore our durable id.
 * No URL, API, admission proof or other protocol field is changed here.
 */
export function withDurableAzureCatalog(source: CatalogSource): CatalogSource {
  return {
    fetchCatalog: async (providerId, baseline, context) => {
      if (providerId !== DURABLE_AZURE_ID) {
        return source.fetchCatalog(providerId, baseline, context);
      }
      const fetched = await source.fetchCatalog(
        NATIVE_AZURE_ID,
        baseline.map(nativeModel),
        context,
      );
      return { ...fetched, models: fetched.models.map(durableIdentity) };
    },
  };
}

/**
 * VC-456's Pi-facing half of the real-path turn benchmark.
 *
 * VC-441's fixture (`measurement.ts`) ran scripted turns straight against
 * VC-119's instrumentation, so no Session runtime, input queue, agent loop,
 * authority gate or ledger was ever on the path. VC-456 composes the real ones
 * in the desktop app (`apps/desktop/e2e/bench/turn-real-path/`), where the
 * Session runtime, the Pi adapter and the SQLite ledger live. This module is
 * the only part of that composition that has to speak pi-ai, so it lives here
 * and the dependency points app → package, as VC-444's MCP bench does.
 *
 * It provides one thing: a Pi `Models` collection whose single provider is a
 * local, in-process stream stand-in. The real Pi runtime resolves the model
 * from it, wraps its stream in the same supervision and VC-119
 * instrumentation it wraps a real provider in, and Pi's local compaction
 * summarizer calls it through `completeSimple`. It opens no socket, makes no
 * provider request, and reads nothing but the request it is handed.
 *
 * It also re-exports VC-441's analysis (`analyzeTurn`, `checkEventOrder`,
 * `summarize`) so the real-path bench reuses it rather than growing a second
 * harness.
 */
import {
  createAssistantMessageEventStream,
  createModels,
  fauxProvider,
  getCurrentTools,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type JsonObject,
  type Model,
  type Models,
  type TranscriptContext,
} from "@earendil-works/pi-ai";

export {
  analyzeTurn,
  checkEventOrder,
  summarize,
  type Distribution,
  type RecordedFixtureEvent,
  type TimerLateness,
  type TurnExpectations,
  type TurnSample,
} from "./measurement";

const DEFAULT_DELTAS_PER_REPLY = 8;

export const REAL_PATH_PROVIDER_ID = "vc456-fixture-local";
export const REAL_PATH_MODEL_ID = "vc456-fixture-model";

/**
 * How a provider refuses a payload larger than the model can hold. The Pi
 * runtime classifies this as a context overflow, compacts, and continues the
 * same turn from its tool results.
 */
const OVERFLOW_MESSAGE = "maximum context length exceeded: 210000 tokens";

/** The text Pi's compacted context carries its summary under. */
const COMPACTED_MARKER = "compacted into the following summary";

/** What each scripted request is, decided from the request itself. */
export type RealPathRequestKind = "tool-round" | "overflow" | "summary" | "final";

export interface RealPathRequestPlan {
  kind: RealPathRequestKind;
  /** When the first delta is pushed, measured from the request. */
  ttftMs: number;
  /** When the request settles, measured from the request. */
  serviceMs: number;
}

/**
 * VC-441's attempt timings, kept so the two fixtures script the same provider
 * time: 34 / 23 / 31 ms with first deltas at 11 / 9 / 10 ms. The summary
 * request is new here — VC-441 had no summarizer to call — and stands in for
 * the model time a local compaction spends.
 */
export const REAL_PATH_REQUEST_PLAN: Readonly<Record<RealPathRequestKind, RealPathRequestPlan>> = {
  "tool-round": { kind: "tool-round", ttftMs: 11, serviceMs: 34 },
  overflow: { kind: "overflow", ttftMs: 9, serviceMs: 23 },
  summary: { kind: "summary", ttftMs: 6, serviceMs: 18 },
  final: { kind: "final", ttftMs: 10, serviceMs: 31 },
};

/** One tool call the scripted tool round asks for, by provider-visible name. */
export interface RealPathToolCall {
  name: string;
  arguments: JsonObject;
}

export interface RealPathProviderOptions {
  /**
   * The tool round every turn's first request answers with, in order. The app
   * composition names the files and command, because only it knows the
   * disposable workspace they live in.
   */
  toolCalls: readonly RealPathToolCall[];
  /**
   * Text the stand-in streams in every reply. The bench passes a canary so its
   * privacy test can prove the instrumentation and ledger reading drop it.
   */
  replyText: string;
  /** Text deltas per reply, spread from the first event to the settle. Default 8. */
  deltasPerReply?: number;
  /** Receives signed lateness for the stand-in's first-event and settle timers. */
  onTimer?: (kind: "ttft" | "completion", latenessMs: number) => void;
}

export interface RealPathProvider {
  models: Models;
  providerId: string;
  modelId: string;
  /** Requests served, by kind. The bench checks them against the script. */
  readonly requests: Readonly<Record<RealPathRequestKind, number>>;
}

function classify(context: TranscriptContext): RealPathRequestKind {
  // Pi's local summarizer sends the conversation with no tool declarations;
  // every live turn of this Session declares its tools.
  if (getCurrentTools(context.messages).length === 0) return "summary";
  const serialized = JSON.stringify(context.messages);
  if (serialized.includes(COMPACTED_MARKER)) return "final";
  if (context.messages.some((message) => message.role === "toolResult")) return "overflow";
  return "tool-round";
}

function timer(
  targetAt: number,
  kind: "ttft" | "completion" | "delta",
  onTimer: RealPathProviderOptions["onTimer"],
  signal: AbortSignal | undefined,
): Promise<void> {
  return new Promise((resolvePromise) => {
    const handle = setTimeout(
      () => {
        signal?.removeEventListener("abort", abort);
        // Signed, as in VC-441: libuv's cached loop clock can fire early.
        if (kind !== "delta") onTimer?.(kind, performance.now() - targetAt);
        resolvePromise();
      },
      Math.max(0, targetAt - performance.now()),
    );
    const abort = (): void => {
      clearTimeout(handle);
      resolvePromise();
    };
    signal?.addEventListener("abort", abort, { once: true });
  });
}

/**
 * A `Models` collection holding one local stand-in provider.
 *
 * Every request is classified from its own context rather than by a global
 * call counter, because concurrent Sessions share this one collection exactly
 * as they share the desktop's.
 */
export function realPathProvider(options: RealPathProviderOptions): RealPathProvider {
  const faux = fauxProvider({
    api: "anthropic-messages",
    provider: REAL_PATH_PROVIDER_ID,
    models: [
      {
        id: REAL_PATH_MODEL_ID,
        name: "VC-456 local model stand-in",
        reasoning: false,
        contextWindow: 200_000,
        maxTokens: 8_192,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
    ],
  });
  const requests: Record<RealPathRequestKind, number> = {
    "tool-round": 0,
    overflow: 0,
    summary: 0,
    final: 0,
  };
  let toolCallSequence = 0;
  const streamSimple = (
    model: Model<string>,
    context: TranscriptContext,
    streamOptions?: { signal?: AbortSignal },
  ): AssistantMessageEventStream => {
    const kind = classify(context);
    requests[kind] += 1;
    const plan = REAL_PATH_REQUEST_PLAN[kind];
    const startedAt = performance.now();
    const signal = streamOptions?.signal;
    const stream = createAssistantMessageEventStream();
    const message: AssistantMessage = {
      role: "assistant",
      content: [],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: {
        input: 240,
        output: 24,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 264,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: Date.now(),
    };
    void (async () => {
      // `start` waits for the first-byte delay rather than being pushed at
      // once. A real pi-ai provider pushes it when the response's first event
      // arrives, and VC-119 times TTFT to the first event the supervised stream
      // forwards, so an immediate `start` would read as a 0 ms TTFT.
      await timer(startedAt + plan.ttftMs, "ttft", options.onTimer, signal);
      stream.push({ type: "start", partial: message });
      const text = kind === "summary" ? "## Goal\nfinish the fixture turn" : options.replyText;
      const block = { type: "text" as const, text: "" };
      message.content.push(block);
      stream.push({ type: "text_start", contentIndex: 0, partial: message });
      // The reply streams as several deltas spread across the request, as a
      // provider's does, so the Session runtime's live overlay sees a stream
      // rather than one chunk.
      const deltas = Math.max(1, options.deltasPerReply ?? DEFAULT_DELTAS_PER_REPLY);
      for (let index = 0; index < deltas; index += 1) {
        if (index > 0) {
          const at = startedAt + plan.ttftMs + ((plan.serviceMs - plan.ttftMs) * index) / deltas;
          // Node clamps a timer to 1 ms, so a delta due sooner than that is
          // pushed on the next turn of the loop instead; waiting a whole
          // millisecond per delta would make a many-delta reply slower than
          // its script.
          if (at - performance.now() >= 1) await timer(at, "delta", undefined, signal);
          else await new Promise<void>((resolvePromise) => setImmediate(resolvePromise));
        }
        const delta = `${index === 0 ? "" : " "}${text}`;
        block.text += delta;
        stream.push({ type: "text_delta", contentIndex: 0, delta, partial: message });
      }
      stream.push({ type: "text_end", contentIndex: 0, content: block.text, partial: message });
      await timer(startedAt + plan.serviceMs, "completion", options.onTimer, signal);
      if (signal?.aborted === true) {
        message.stopReason = "aborted";
        message.errorMessage = "Aborted";
        stream.push({ type: "error", reason: "aborted", error: message });
        stream.end(message);
        return;
      }
      if (kind === "overflow") {
        message.stopReason = "error";
        message.errorMessage = OVERFLOW_MESSAGE;
        stream.push({ type: "error", reason: "error", error: message });
        stream.end(message);
        return;
      }
      if (kind === "tool-round") {
        for (const call of options.toolCalls) {
          const contentIndex = message.content.length;
          toolCallSequence += 1;
          const toolCall = {
            type: "toolCall" as const,
            id: `vc456-call-${toolCallSequence}`,
            name: call.name,
            arguments: { ...call.arguments },
          };
          message.content.push(toolCall);
          stream.push({ type: "toolcall_start", contentIndex, partial: message });
          stream.push({ type: "toolcall_end", contentIndex, toolCall, partial: message });
        }
        message.stopReason = "toolUse";
      }
      stream.push({
        type: "done",
        reason: message.stopReason === "toolUse" ? "toolUse" : "stop",
        message,
      });
      stream.end(message);
    })().catch((error: unknown) => {
      message.stopReason = "error";
      message.errorMessage = error instanceof Error ? error.message : String(error);
      stream.push({ type: "error", reason: "error", error: message });
      stream.end(message);
    });
    return stream;
  };
  const models = createModels();
  models.setProvider({
    ...faux.provider,
    streamSimple: streamSimple as unknown as typeof faux.provider.streamSimple,
    stream: streamSimple as unknown as typeof faux.provider.stream,
  });
  return { models, providerId: REAL_PATH_PROVIDER_ID, modelId: REAL_PATH_MODEL_ID, requests };
}

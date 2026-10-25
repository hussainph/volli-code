/**
 * Pipes a provider response body to the runner unchanged while a copy of each
 * chunk feeds the usage meter, and settles once the call is over.
 *
 * It is a pull stream over the upstream reader, rather than a tee, so the two
 * ends stay tied: when the runner disconnects or stops the Session, the
 * upstream read is cancelled at once (the provider stops generating) and the
 * call settles as partial with whatever usage had been reported.
 */
import { SseParser } from "./sse.ts";
import type { UsageMeter } from "./providers.ts";

/** The most of a non-streaming JSON body kept to read its usage. */
export const MAX_METERED_JSON_BYTES = 8 * 1024 * 1024;

export interface BodyOutcome {
  /** False when the body was cut short: cancelled downstream or failed upstream. */
  finished: boolean;
  /** Milliseconds from the start of the call to the first body byte. */
  ttftMs?: number;
}

type Sink = { push(chunk: Uint8Array): void; end(): void };

function sinkFor(contentType: string, meter: UsageMeter): Sink {
  if (contentType.includes("text/event-stream")) {
    const parser = new SseParser();
    const deliver = (events: ReturnType<SseParser["push"]>) => {
      for (const { event, data } of events) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(data);
        } catch {
          // `[DONE]`, keep-alives and anything else that is not JSON carries no usage.
          continue;
        }
        meter.event(parsed, event);
      }
    };
    return { push: (chunk) => deliver(parser.push(chunk)), end: () => deliver(parser.end()) };
  }
  if (contentType.includes("json")) {
    const chunks: Uint8Array[] = [];
    let size = 0;
    return {
      push(chunk) {
        size += chunk.length;
        if (size <= MAX_METERED_JSON_BYTES) chunks.push(chunk);
      },
      end() {
        if (size > MAX_METERED_JSON_BYTES) return;
        let parsed: unknown;
        try {
          parsed = JSON.parse(new TextDecoder().decode(concat(chunks, size)));
        } catch {
          // Not JSON after all: no usage to read.
          return;
        }
        meter.json(parsed);
      },
    };
  }
  return { push() {}, end() {} };
}

function concat(chunks: Uint8Array[], size: number): Uint8Array {
  const out = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/**
 * The body to return to the runner, and a promise that settles exactly once
 * when the call is over, however it ends. It never rejects.
 */
export function meteredBody(
  upstream: ReadableStream<Uint8Array>,
  contentType: string,
  meter: UsageMeter,
  timing: { startedAt: number; now: () => number },
): { body: ReadableStream<Uint8Array>; outcome: Promise<BodyOutcome> } {
  const reader = upstream.getReader();
  const sink = sinkFor(contentType, meter);
  let ttftMs: number | undefined;
  let settle!: (outcome: BodyOutcome) => void;
  let settled = false;
  const outcome = new Promise<BodyOutcome>((resolve) => {
    settle = resolve;
  });
  const finish = (finished: boolean) => {
    settled = true;
    try {
      sink.end();
    } catch {
      // Metering never fails the call.
    }
    settle({ finished, ...(ttftMs === undefined ? {} : { ttftMs }) });
  };

  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      let result: ReadableStreamReadResult<Uint8Array>;
      try {
        result = await reader.read();
      } catch (error) {
        if (settled) return;
        finish(false);
        controller.error(error);
        return;
      }
      // Cancelled while the read was pending: the call has already settled.
      if (settled) return;
      if (result.done) {
        finish(true);
        controller.close();
        return;
      }
      ttftMs ??= timing.now() - timing.startedAt;
      try {
        sink.push(result.value);
      } catch {
        // Metering never fails the call.
      }
      controller.enqueue(result.value);
    },
    async cancel(reason) {
      finish(false);
      await reader.cancel(reason);
    },
  });
  return { body, outcome };
}

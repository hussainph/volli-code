/**
 * Cutting a provider request that has stopped answering, without ending the turn.
 *
 * A laptop that sleeps mid-stream wakes holding a TCP connection the server
 * dropped long ago. Nothing on this side sends, so nothing on this side learns:
 * the request just stays open, silent, until some keepalive far below gives up
 * — about half an hour, on the owner's ledger, thirty times over (VC-443). No
 * error ever reaches the runtime's retry path, because nothing ever fails.
 *
 * So the request is watched from outside, at the one seam every provider call
 * crosses — the `StreamFn` — and cut two ways:
 *
 * - **Idle.** No stream event for {@link STREAM_IDLE_TIMEOUT_MS}.
 * - **Woken.** The machine resumed and the request has produced nothing in the
 *   {@link WAKE_STREAM_GRACE_MS} since. A socket that survived a short sleep
 *   starts talking again at once; one that did not never will.
 *
 * **Why cutting here does not end the turn.** Pi gives each request the RUN's
 * signal, and aborting that is `agent.abort()` — the person's Stop, which ends
 * the turn. This wrapper hands the provider a signal of its own instead, linked
 * to the run's so a Stop still reaches it, and aborts only that. The provider
 * then settles its reply as `aborted`, which this runtime would read as a
 * person's choice and quietly drop; so the terminal event the loop sees is this
 * wrapper's own `error`, carrying {@link STREAM_STALLED}. That is a transient
 * transport failure by the classifier's table, and it goes down exactly the
 * path a dropped socket always has: the failed reply is discarded and the turn
 * `continue`s from the message it answered. Nothing the user said is sent twice.
 *
 * **Why the idle limit is what it is.** Pi surfaces no keepalive: Anthropic's
 * `ping`s and any SSE comment are consumed below the event stream, so the
 * only liveness visible here is a content event. Reasoning is the risk — a
 * model may think for minutes before its first visible token — but every
 * reasoning family Pi drives streams it: Anthropic sends thinking deltas, and
 * both OpenAI Responses adapters ask for reasoning summaries (`summary:
 * "auto"`). So the limit errs long, and is then pinned one minute beneath the
 * session watchdog's silence threshold, which reads the same silence from the
 * durable side. A dead socket is cut, and its retry's observations reset that
 * clock, before the watchdog tells anyone the Session is wedged.
 */

import type { StreamFn } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import { DEFAULT_SESSION_WATCHDOG_SILENCE_MS } from "@volli/shared";
import { STREAM_STALLED } from "./transcript";

/** How long a provider request may produce no event before it is cut. */
export const STREAM_IDLE_TIMEOUT_MS = DEFAULT_SESSION_WATCHDOG_SILENCE_MS - 60_000;
/**
 * How long a request that was open across a sleep has to say something after
 * the wake. Wi-Fi rejoins in a few seconds; a live socket resumes at once.
 */
export const WAKE_STREAM_GRACE_MS = 15_000;

export interface StreamSupervisionTiming {
  idleTimeoutMs: number;
  wakeGraceMs: number;
}

export const DEFAULT_STREAM_SUPERVISION: StreamSupervisionTiming = {
  idleTimeoutMs: STREAM_IDLE_TIMEOUT_MS,
  wakeGraceMs: WAKE_STREAM_GRACE_MS,
};

/** What each cut says. Short: after a spent budget it is the Attention's whole detail. */
export const STREAM_IDLE_MESSAGE = `${STREAM_STALLED}.`;
export const STREAM_WAKE_MESSAGE = `${STREAM_STALLED} after sleep.`;

export interface StreamSupervisor {
  streamFn: StreamFn;
  /** The machine resumed: check every request that was open across the sleep. */
  wake(): void;
  /** Drop the pending wake checks; the attachment is closing. */
  dispose(): void;
}

interface OpenRequest {
  /** How many events this request has produced; the wake check compares it. */
  events: number;
  stall(message: string): void;
}

type RequestModel = Parameters<StreamFn>[0];

/** The reply a request that never started gets to fail with. */
function emptyReply(model: RequestModel): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "error",
    timestamp: Date.now(),
  };
}

export function superviseStreams(
  inner: StreamFn,
  timing: StreamSupervisionTiming = DEFAULT_STREAM_SUPERVISION,
): StreamSupervisor {
  const open = new Set<OpenRequest>();
  const wakeChecks = new Set<ReturnType<typeof setTimeout>>();

  const streamFn: StreamFn = (model, context, options) => {
    const out = createAssistantMessageEventStream();
    // The provider's own signal. The run's still reaches it — a Stop is a Stop
    // — but aborting this one alone leaves the run, and the turn, standing.
    const provider = new AbortController();
    const run = options?.signal;
    const forwardStop = (): void => provider.abort(run?.reason);
    run?.addEventListener("abort", forwardStop, { once: true });
    let partial: AssistantMessage | undefined;
    let idle: ReturnType<typeof setTimeout> | undefined;
    let settled = false;

    /** The one exit every path takes, once. False when another path already took it. */
    const settle = (): boolean => {
      if (settled) return false;
      settled = true;
      clearTimeout(idle);
      open.delete(request);
      run?.removeEventListener("abort", forwardStop);
      return true;
    };
    const fail = (reason: "aborted" | "error", message: string, cause?: unknown): void => {
      const failed: AssistantMessage = {
        ...(partial ?? emptyReply(model)),
        stopReason: reason,
        errorMessage: message,
        rawStopReason: cause === undefined ? "volli.stream-stalled" : "volli.runtime-error",
        ...(cause instanceof Error
          ? {
              diagnostics: [
                {
                  type: "runtime_transport_failure",
                  timestamp: Date.now(),
                  error: {
                    name: cause.name,
                    message,
                    ...("code" in cause && typeof cause.code === "string"
                      ? { code: cause.code }
                      : {}),
                  },
                },
              ],
            }
          : {}),
      };
      out.push({ type: "error", reason, error: failed });
      out.end(failed);
    };
    const request: OpenRequest = {
      events: 0,
      stall(message) {
        if (!settle()) return;
        provider.abort(new Error(message));
        fail("error", message);
      },
    };
    const arm = (): void => {
      clearTimeout(idle);
      idle = setTimeout(() => request.stall(STREAM_IDLE_MESSAGE), timing.idleTimeoutMs);
    };

    open.add(request);
    arm();
    if (run?.aborted) provider.abort(run.reason);
    void (async () => {
      try {
        const source = await inner(model, context, { ...options, signal: provider.signal });
        for await (const event of source) {
          // A stalled request has already failed on `out`; whatever the
          // provider says on its way down is about a request nobody is reading.
          if (settled) return;
          request.events += 1;
          if (event.type === "done" || event.type === "error") {
            settle();
            out.push(event);
            out.end(event.type === "done" ? event.message : event.error);
            return;
          }
          partial = event.partial;
          arm();
          out.push(event);
        }
        // A stream that ended without a terminal event settles on its result,
        // exactly as Pi's own loop reads one; the idle cut stays armed while
        // that is awaited, so a result that never comes is still a stall.
        const result = await source.result();
        if (!settle()) return;
        out.end(result);
      } catch (error) {
        // Pi's adapters report failure as an event rather than a throw; this is
        // a wrapper further in that broke that contract.
        if (!settle()) return;
        fail(
          run?.aborted ? "aborted" : "error",
          error instanceof Error ? error.message : String(error),
          error,
        );
      }
    })();
    return out;
  };

  return {
    streamFn,
    wake() {
      for (const request of open) {
        const seen = request.events;
        const check = setTimeout(() => {
          wakeChecks.delete(check);
          if (request.events === seen) request.stall(STREAM_WAKE_MESSAGE);
        }, timing.wakeGraceMs);
        wakeChecks.add(check);
      }
    },
    dispose() {
      for (const check of wakeChecks) clearTimeout(check);
      wakeChecks.clear();
    },
  };
}

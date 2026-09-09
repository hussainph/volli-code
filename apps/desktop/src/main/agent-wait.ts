import type { RuntimeVerbResult } from "@volli/shared";

/** A refusal the model reads and can act on. Never a thrown error. */
export function waitRefusal(text: string): RuntimeVerbResult {
  return { text };
}

/** One optional positive number field, or a refusal naming the field. */
export function optionalPositiveNumber(
  input: Readonly<Record<string, unknown>>,
  field: string,
): { ok: true; value: number | undefined } | { ok: false; text: string } {
  const raw = input[field];
  if (raw === undefined || raw === null) return { ok: true, value: undefined };
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) {
    return { ok: false, text: `\`${field}\` must be a positive number when given.` };
  }
  return { ok: true, value: raw };
}

const NOOP_UNSUBSCRIBE = (): void => undefined;

export interface ParkForWakeOptions<TWake> {
  signal: AbortSignal;
  subscribe(listener: (wake: TWake) => void): () => void;
  /** Return an answer for a matching wake, or `undefined` to keep parking. */
  onWake(wake: TWake): RuntimeVerbResult | undefined;
  /** Synchronous durable replay, run only after the live subscription opens. */
  replay?: () => RuntimeVerbResult | undefined;
  timeoutMs?: number;
  onTimeout?: () => RuntimeVerbResult;
}

/**
 * The shared subscribe → durable replay → park lifecycle for Agent waits.
 *
 * Ticket Await and Session Await use different ledgers, policy vocabularies and
 * wake text. This helper owns only the interruptible promise machinery that
 * must be identical for both: exactly one settlement, complete cleanup, and no
 * gap between opening the live subscription and checking durable history.
 */
export function parkForWake<TWake>(options: ParkForWakeOptions<TWake>): Promise<RuntimeVerbResult> {
  return new Promise<RuntimeVerbResult>((resolve, reject) => {
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    let unsubscribe = NOOP_UNSUBSCRIBE;

    const settle = (act: () => void): void => {
      if (settled) return;
      settled = true;
      unsubscribe();
      if (timer !== undefined) clearTimeout(timer);
      options.signal.removeEventListener("abort", withdraw);
      act();
    };
    const withdraw = (): void =>
      settle(() => reject(new Error("The wait was withdrawn before any event arrived.")));
    const fail = (error: unknown): void => settle(() => reject(error));
    const answer = (result: RuntimeVerbResult | undefined): void => {
      if (result !== undefined) settle(() => resolve(result));
    };

    const subscribed = options.subscribe((wake) => {
      try {
        answer(options.onWake(wake));
      } catch (error) {
        fail(error);
      }
    });
    unsubscribe = subscribed;
    // A custom subscriber is allowed to answer synchronously while it opens.
    if (settled) {
      unsubscribe();
      return;
    }

    try {
      answer(options.replay?.());
    } catch (error) {
      fail(error);
    }
    if (settled) return;

    const onTimeout = options.onTimeout;
    if (options.timeoutMs !== undefined && onTimeout !== undefined) {
      timer = setTimeout(() => {
        try {
          const result = onTimeout();
          settle(() => resolve(result));
        } catch (error) {
          fail(error);
        }
      }, options.timeoutMs);
    }

    // Read rather than trusted to the listener: a signal that aborted while
    // the subscription opened would never fire again.
    if (options.signal.aborted) withdraw();
    else options.signal.addEventListener("abort", withdraw, { once: true });
  });
}

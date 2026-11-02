/**
 * One wait with a ceiling, and the ways an attach's wait ends (VC-1072).
 *
 * Every bounded wait in the runtime — the queue's admission bound, a first
 * attach's workspace preparation, a direct door's executor attach, a cold
 * binding's recovery — is the same race: the operation against a timer, and
 * for an attach a person can stop, against that stop as well. The operation is
 * never cancelled underneath (none of them can be); the wait for it is, and
 * `abandon` is the caller's chance to deal with a result that arrives late.
 */
import { ATTACH_TIMEOUT_CODE } from "@volli/shared";

import { NativeAttachmentError } from "./native-adapter";

export interface CeilingOptions {
  /** How long to wait before giving up on the operation. */
  ms: number;
  /** The error a wait that ran out of time rejects with. */
  timeout: () => Error;
  /** Called once when the wait gives up, by timeout or by `signal`. */
  abandon?: () => void;
  /** Ends the wait early; it rejects with the signal's reason. */
  signal?: AbortSignal;
}

/** `operation`, unless the ceiling or `signal` ends the wait first. */
export async function withCeiling<T>(operation: Promise<T>, options: CeilingOptions): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  // Once the operation has settled, or the wait has already given up, nothing
  // may give up again: a late abort must not release a handle its caller is
  // about to use, and a timer and an abort together must not abandon twice.
  let over = false;
  const end = (): void => {
    over = true;
  };
  // Registered before the race, so it runs before the race's own reaction.
  operation.then(end, end);
  const ended = new Promise<never>((_resolve, reject) => {
    const giveUp = (error: unknown) => {
      if (over) return;
      over = true;
      options.abandon?.();
      reject(error);
    };
    timer = setTimeout(() => giveUp(options.timeout()), options.ms);
    const signal = options.signal;
    if (signal === undefined) return;
    onAbort = () => giveUp(signal.reason);
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([operation, ended]);
  } finally {
    clearTimeout(timer);
    if (onAbort !== undefined) options.signal?.removeEventListener("abort", onAbort);
  }
}

/** The queue's admission bound, unless a host configures its own. */
export const QUEUE_ADMISSION_TIMEOUT_MS = 30_000;

/** The queue's own bound, run out: definitely unsent, retried by the queue. */
export function queueAdmissionTimeoutError(stage: string): NativeAttachmentError {
  return new NativeAttachmentError(
    `queue_admission_timeout: ${stage} did not finish. Check the transcript before retrying.`,
    "queue_admission_timeout",
    "adapter_unrecoverable",
  );
}

/**
 * A direct door's attach stage that did not finish within its ceiling.
 *
 * Persisted as `adapter_unrecoverable` — the kind every N−1 build clears on its
 * next successful attach, and the one the queue drain already reads — and worded
 * for a person by its detail, not its kind: the detail starts with
 * {@link ATTACH_TIMEOUT_CODE}, which `isAttachTimeoutAttention` reads back.
 * No "; " in the sentence: the queue joins several blockers with one, and that
 * reader tells a single quoted timeout from a list by it.
 */
export function attachTimeoutError(stage: string, ms: number): NativeAttachmentError {
  return new NativeAttachmentError(
    `${ATTACH_TIMEOUT_CODE}: ${stage} did not finish within ${ms / 1000} s. Nothing was sent, and Retry starts it again.`,
    ATTACH_TIMEOUT_CODE,
    "adapter_unrecoverable",
  );
}

/** The code of an attach a person stopped before it finished. */
export const ATTACH_CANCELLED_CODE = "attach_cancelled";

/** What a direct attach's wait rejects with when its Session is stopped meanwhile. */
export function attachCancelledError(): NativeAttachmentError {
  return new NativeAttachmentError(
    `${ATTACH_CANCELLED_CODE}: the Session was stopped while it was starting.`,
    ATTACH_CANCELLED_CODE,
    "adapter_unrecoverable",
  );
}

/** Whether a wait ended because a bound ran out: the queue's or a direct door's. */
export function isAttachWaitTimeout(error: unknown): error is NativeAttachmentError {
  return (
    error instanceof NativeAttachmentError &&
    (error.code === "queue_admission_timeout" || error.code === ATTACH_TIMEOUT_CODE)
  );
}

/** Whether a recorded detail is one a bounded wait wrote when it ran out. */
export function isAttachWaitTimeoutDetail(detail: string | null | undefined): boolean {
  return WAIT_TIMEOUT_DETAIL.test(detail ?? "");
}

// Anchored: the code a bounded wait writes leads its detail. Prose that merely
// mentions one, or a wrapper that quotes one, is not a wait that ran out.
const WAIT_TIMEOUT_DETAIL = new RegExp(`^(?:queue_admission_timeout|${ATTACH_TIMEOUT_CODE}):`);

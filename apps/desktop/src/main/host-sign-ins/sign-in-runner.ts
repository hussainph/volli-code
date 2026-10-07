/**
 * One subscription sign-in on a host, driven from this Mac (VC-702).
 *
 * The flow runs on the host (`signIns.start`); this Mac follows its stream
 * (`signIns.subscribe`) and does the two things only this Mac can:
 *
 * - **the relay.** An `auth-callback` grant binds the redirect's loopback
 *   address here ({@link bindOneCallback}) before anything opens the browser;
 *   the redirect is delivered to the host once and the listener closes.
 * - **the browser.** The `auth-url` that follows is opened in this Mac's
 *   browser only after that bind settled, so the redirect always has
 *   somewhere to land. A device code needs no relay: the person opens its
 *   page from the row.
 *
 * Everything else the flow says goes to the row as it is, prompts included:
 * a pasted redirect is the answer to the flow's own pasted-code step, which
 * pi races against the callback, so paste works whether or not the relay
 * could bind. Updates are handled strictly in order, one at a time.
 *
 * The host link is a port ({@link HostSignInLink}): VC-700's host registry
 * supplies one per host; tests use a fake.
 */
import type {
  HostSignInRelayState,
  HostSignInRunEvent,
  HostAuthCallbackDeliverInput,
  HostAuthCallbackDeliverResult,
  HostSignInAnswerInput,
  HostSignInFlow,
  HostSignInStartInput,
  HostSignInUpdate,
} from "@volli/shared";

import { bindOneCallback, type RelayBinding } from "./relay-client";

/** The sign-in operations of one host's link: the host protocol's, as a typed client calls them. */
export interface HostSignInLink {
  start(input: HostSignInStartInput): Promise<HostSignInFlow>;
  subscribe(
    flow: HostSignInFlow,
    observer: {
      onData(update: HostSignInUpdate): void;
      onError(error: unknown): void;
      onComplete(): void;
    },
  ): { unsubscribe(): void };
  deliver(input: HostAuthCallbackDeliverInput): Promise<HostAuthCallbackDeliverResult>;
  answer(input: HostSignInAnswerInput): Promise<unknown>;
  cancel(flow: HostSignInFlow): Promise<unknown>;
  /**
   * Calls `lost` once the connection this link holds now is gone: dropped,
   * retired, refused or closed. A flow is its connection's and never resumes
   * on another, so its run ends there. Answers the stop.
   */
  watchLoss(lost: () => void): () => void;
}

/** What a row hears (`@volli/shared`, so the IPC wire can carry them). */
export type RelayState = HostSignInRelayState;
export type { HostSignInRunEvent };

export type HostSignInEnd = "done" | "failed" | "cancelled" | "lost";

/**
 * The flows one host and provider may still hold for this Mac: started by a
 * run here, and not yet known to be over. A run that ends here (cancelled,
 * refused, timed out) leaves its flow in it, still unwinding on the host.
 *
 * The host answers a repeat start from the same connection with the flow it
 * still holds, so a start that answers one of these is never a new run's
 * own. A flow leaves when its end is known: its own `done`, `failed` or
 * `cancelled`, its connection gone, or a start answering a fresh flow, which
 * the host gives only once it holds no other for that provider.
 *
 * One per host and provider, kept across every replacement (VC-702 review
 * B3): a run that never got a flow of its own, or gave up waiting, does not
 * make an older flow any less the host's.
 */
export class HostFlowLedger {
  readonly #flows = new Set<string>();

  /** Whether `flowId` may still be an older run's flow on the host. */
  holds(flowId: string): boolean {
    return this.#flows.has(flowId);
  }

  /** The host started a fresh flow: every other it held for this provider is over. */
  started(flowId: string): void {
    this.#flows.clear();
    this.#flows.add(flowId);
  }

  /** `flowId`'s end is known. */
  ended(flowId: string): void {
    this.#flows.delete(flowId);
  }
}

export interface HostSignInRun {
  /** The flow's id once the host started it. */
  readonly flowId: Promise<string>;
  /** Settles with the run's end here: the flow's, a loss, or this Mac's cancel. */
  readonly ended: Promise<HostSignInEnd>;
  /** Answers a step: the pasted redirect, a choice, a value. */
  answer(promptId: string, value: string): Promise<unknown>;
  /**
   * Ends the run here at once: nothing more is heard, opened or relayed.
   * Then asks the host to cancel its flow, once the flow is known. Settles
   * true once the host was asked, or there was nothing to ask; false when the
   * host did not answer within {@link CANCEL_WAIT_MS}. Never rejects.
   */
  cancel(): Promise<boolean>;
}

export interface RunHostSignInOptions {
  readonly link: HostSignInLink;
  readonly providerId: string;
  readonly type?: HostSignInStartInput["type"];
  readonly openExternal: (url: string) => void | Promise<void>;
  readonly onEvent: (event: HostSignInRunEvent) => void;
  /**
   * The run this one replaces, for the same host and provider. It is
   * cancelled first, and this one starts only once its flow is over: the
   * host answers a repeat start with the flow it still holds.
   */
  readonly replaces?: HostSignInRun | undefined;
  /** The host and provider's flows not yet known to be over; this run's own when absent. */
  readonly ledger?: HostFlowLedger | undefined;
  /** Test seam: the relay's bind. */
  readonly bind?: typeof bindOneCallback | undefined;
}

/** How long a cancel waits for the host to start, then take the cancel. */
export const CANCEL_WAIT_MS = 10_000;

/** The longest one sign-in runs here; then it ends, here and on the host. */
export const RUN_DEADLINE_MS = 30 * 60_000;

/** How often, and how many times, a replacement asks again while the host's old flow unwinds. */
export const REPLACE_RETRY_MS = 100;
export const REPLACE_ATTEMPTS = 50;

/** What a row says when the run's own deadline passed. */
export const RUN_TIMED_OUT = "The sign-in took too long. Start it again.";

/** What a row says when the run it replaced is still ending on the host. */
export const STILL_ENDING = "The last sign-in on this host is still ending. Try again.";

/** What a row says when the host's sign-in link is not one Volli opens. */
export const REFUSED_SIGN_IN_LINK = "The host sent a sign-in link Volli won’t open";

/** The longest sign-in link Volli opens. */
export const MAX_SIGN_IN_URL_LENGTH = 8192;

/**
 * Whether a link the host sent is one this Mac opens: an `http:` or `https:`
 * page, of bounded length. A host is not trusted to name anything else
 * (`file:`, an app's own scheme, `ssh:`) to this Mac's browser.
 */
export function isOpenableSignInUrl(url: string): boolean {
  if (url.length > MAX_SIGN_IN_URL_LENGTH) return false;
  try {
    const { protocol } = new URL(url);
    return protocol === "https:" || protocol === "http:";
  } catch {
    return false;
  }
}

/** Settles with `promise`'s value, or `fallback` after `ms`. */
function within<T, F>(promise: Promise<T>, ms: number, fallback: F): Promise<T | F> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<F>((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms);
    timer.unref();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** A start this run gave up on: it was cancelled first, or its predecessor never ended. */
class NotStarted extends Error {
  constructor(readonly why: "cancelled" | "still-ending") {
    super(why);
  }
}

export function runHostSignIn(options: RunHostSignInOptions): HostSignInRun {
  const { link, onEvent } = options;
  const bind = options.bind ?? bindOneCallback;
  let binding: Extract<RelayBinding, { kind: "bound" }> | null = null;
  let finished = false;
  let endWith!: (end: HostSignInEnd) => void;
  const ended = new Promise<HostSignInEnd>((resolve) => (endWith = resolve));
  // Strictly in order: a bind must settle before the URL after it is opened.
  let chain: Promise<void> = Promise.resolve();
  let subscription: { unsubscribe(): void } | null = null;
  let stopWatching: (() => void) | null = null;
  let cancelled: Promise<boolean> | null = null;
  const ledger = options.ledger ?? new HostFlowLedger();
  /** This run's own flow, once the host started a fresh one. */
  let own: string | null = null;
  /** Wakes a replacement's wait between starts, so a cancel ends it at once. */
  let wake: (() => void) | null = null;

  /**
   * The run's one end, wherever it comes from: everything it held goes, and
   * nothing after it is heard. Answers whether this call ended it.
   */
  const finish = (end: HostSignInEnd, event?: HostSignInRunEvent): boolean => {
    if (finished) return false;
    finished = true;
    clearTimeout(deadline);
    wake?.();
    stopWatching?.();
    stopWatching = null;
    binding?.close();
    binding = null;
    subscription?.unsubscribe();
    subscription = null;
    if (event !== undefined) onEvent(event);
    endWith(end);
    return true;
  };

  /** Ends the run here, then on the host once its flow is known; bounded. */
  const endOnHost = (): Promise<boolean> =>
    within(
      flowId.then(
        async (id) => {
          await link.cancel({ flowId: id }).catch(() => undefined);
          return true;
        },
        () => true,
      ),
      CANCEL_WAIT_MS,
      false,
    );

  // A link this Mac will not open ends the sign-in, here and on the host.
  const refuseLink = (id: string): void => {
    finish("failed", { kind: "failed", message: REFUSED_SIGN_IN_LINK });
    void link.cancel({ flowId: id }).catch(() => undefined);
  };

  // Every end clears it, so when it fires the run is still going.
  const deadline = setTimeout(() => {
    finish("failed", { kind: "failed", message: RUN_TIMED_OUT });
    void endOnHost();
  }, RUN_DEADLINE_MS);
  deadline.unref();

  const handle = async (flowId: string, update: HostSignInUpdate): Promise<void> => {
    if (finished) return;
    switch (update.kind) {
      case "auth-callback": {
        binding?.close();
        binding = null;
        const bound = await bind(update.redirectUri, (pathAndQuery) =>
          link.deliver({ flowId, pathAndQuery }),
        );
        // Ended while it bound (cancelled here, the link lost): the late
        // listener closes, and nothing after it is heard.
        if (finished) {
          if (bound.kind === "bound") bound.close();
          return;
        }
        if (bound.kind === "unavailable") {
          onEvent({ kind: "relay", state: "paste" });
          return;
        }
        binding = bound;
        onEvent({ kind: "relay", state: "listening" });
        void bound.outcome.then((outcome) => {
          if (finished || outcome.kind === "closed") return;
          if (outcome.kind === "timed-out") {
            onEvent({ kind: "relay", state: "paste" });
            return;
          }
          const ok = outcome.kind === "delivered" && outcome.status >= 200 && outcome.status < 300;
          onEvent({ kind: "relay", state: ok ? "delivered" : "failed" });
        });
        return;
      }
      case "auth-url":
        // The host names the page; only a plain web page is ever opened.
        if (!isOpenableSignInUrl(update.url)) {
          refuseLink(flowId);
          return;
        }
        onEvent(update);
        await options.openExternal(update.url);
        return;
      case "device-code":
        if (!isOpenableSignInUrl(update.verificationUri)) {
          refuseLink(flowId);
          return;
        }
        onEvent(update);
        return;
      case "done":
      case "failed":
      case "cancelled":
        // The host's own end: its flow is over.
        ledger.ended(flowId);
        finish(update.kind, update);
        return;
      default:
        onEvent(update);
    }
  };

  const lose = (): void => {
    // The connection that owned the flow is gone, and the host ended its flows with it.
    if (own !== null) ledger.ended(own);
    finish("lost", { kind: "lost" });
  };
  // The flow is this connection's: when it goes, the run ends here, and its
  // stream is withdrawn before the link could open it on another.
  stopWatching = link.watchLoss(lose);
  if (finished) {
    stopWatching();
    stopWatching = null;
  }

  /**
   * Starts the flow, once the run this replaces was cancelled on the host. A
   * start that answers a flow in the {@link HostFlowLedger} (cancelled, still
   * unwinding) answers an older run's flow, never this one's, so this asks
   * again, a bounded number of times, and a cancel here stops it at once.
   */
  const begin = async (): Promise<string> => {
    if (options.replaces !== undefined && !(await options.replaces.cancel())) {
      throw new NotStarted("still-ending");
    }
    for (let attempt = 1; ; attempt++) {
      if (finished) throw new NotStarted("cancelled");
      const { flowId: id } = await link.start({
        providerId: options.providerId,
        ...(options.type === undefined ? {} : { type: options.type }),
      });
      if (!ledger.holds(id)) {
        ledger.started(id);
        own = id;
        return id;
      }
      if (attempt >= REPLACE_ATTEMPTS) throw new NotStarted("still-ending");
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, REPLACE_RETRY_MS);
        wake = () => {
          clearTimeout(timer);
          resolve();
        };
      });
      wake = null;
    }
  };

  const flowId = begin().then((id) => {
    // Cancelled or lost while the host started it: never followed.
    if (finished) return id;
    subscription = link.subscribe(
      { flowId: id },
      {
        onData: (update) => {
          chain = chain.then(() => handle(id, update)).catch(() => {});
        },
        // The stream's own end, after what it said before it.
        onError: () => void (chain = chain.then(lose)),
        onComplete: () => void (chain = chain.then(lose)),
      },
    );
    return id;
  });
  flowId.catch((error: unknown) => {
    // The host's refusal is not repeated (it is the host's wording, not this
    // row's); the row says the one thing that is true.
    const message =
      error instanceof NotStarted && error.why === "still-ending"
        ? STILL_ENDING
        : "This host could not start the sign-in.";
    finish("failed", { kind: "failed", message });
  });

  return {
    flowId,
    ended,
    answer: async (promptId, value) => {
      const id = await flowId;
      if (finished) throw new Error("That sign-in is no longer running.");
      return link.answer({ flowId: id, promptId, value });
    },
    cancel: () => {
      if (cancelled !== null) return cancelled;
      // Ended by this cancel: the host is told. Ended before by the flow
      // itself, a loss or a refusal: nothing is left to ask.
      cancelled = finish("cancelled", { kind: "cancelled" })
        ? endOnHost()
        : within(
            flowId.then(
              () => true,
              () => true,
            ),
            CANCEL_WAIT_MS,
            false,
          );
      return cancelled;
    },
  };
}

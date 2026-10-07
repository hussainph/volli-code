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
}

/** What the relay is doing, and what a row hears (`@volli/shared`, so the IPC wire can carry them). */
export type RelayState = HostSignInRelayState;
export type { HostSignInRunEvent };

export interface HostSignInRun {
  /** The flow's id once the host started it. */
  readonly flowId: Promise<string>;
  /** Settles with the flow's end. */
  readonly ended: Promise<"done" | "failed" | "cancelled" | "lost">;
  /** Answers a step: the pasted redirect, a choice, a value. */
  answer(promptId: string, value: string): Promise<unknown>;
  cancel(): Promise<void>;
}

export interface RunHostSignInOptions {
  readonly link: HostSignInLink;
  readonly providerId: string;
  readonly type?: HostSignInStartInput["type"];
  readonly openExternal: (url: string) => void | Promise<void>;
  readonly onEvent: (event: HostSignInRunEvent) => void;
  /** Test seam: the relay's bind. */
  readonly bind?: typeof bindOneCallback | undefined;
}

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

export function runHostSignIn(options: RunHostSignInOptions): HostSignInRun {
  const { link, onEvent } = options;
  const bind = options.bind ?? bindOneCallback;
  let binding: Extract<RelayBinding, { kind: "bound" }> | null = null;
  let finished = false;
  let endWith!: (end: "done" | "failed" | "cancelled" | "lost") => void;
  const ended = new Promise<"done" | "failed" | "cancelled" | "lost">(
    (resolve) => (endWith = resolve),
  );
  // Strictly in order: a bind must settle before the URL after it is opened.
  let chain: Promise<void> = Promise.resolve();
  let subscription: { unsubscribe(): void } | null = null;

  // Called once: every end but a failed start is an update in the chain,
  // which checks `finished` first, and a failed start has no chain.
  const finish = (end: "done" | "failed" | "cancelled" | "lost"): void => {
    finished = true;
    binding?.close();
    binding = null;
    subscription?.unsubscribe();
    endWith(end);
  };

  // A link this Mac will not open ends the sign-in, here and on the host.
  const refuseLink = (flowId: string): void => {
    onEvent({ kind: "failed", message: REFUSED_SIGN_IN_LINK });
    finish("failed");
    void link.cancel({ flowId }).catch(() => undefined);
  };

  const handle = async (flowId: string, update: HostSignInUpdate): Promise<void> => {
    if (finished) return;
    switch (update.kind) {
      case "auth-callback": {
        binding?.close();
        const bound = await bind(update.redirectUri, (pathAndQuery) =>
          link.deliver({ flowId, pathAndQuery }),
        );
        // Nothing can finish the flow meanwhile: its end is a later update in
        // this same chain, so the binding is always closed by `finish`.
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
        onEvent(update);
        finish("done");
        return;
      case "failed":
        onEvent(update);
        finish("failed");
        return;
      case "cancelled":
        onEvent(update);
        finish("cancelled");
        return;
      default:
        onEvent(update);
    }
  };

  const flowId = link
    .start({
      providerId: options.providerId,
      ...(options.type === undefined ? {} : { type: options.type }),
    })
    .then(({ flowId: id }) => {
      const lose = (): void => {
        chain = chain.then(() => {
          if (finished) return;
          onEvent({ kind: "lost" });
          finish("lost");
        });
      };
      subscription = link.subscribe(
        { flowId: id },
        {
          onData: (update) => {
            chain = chain.then(() => handle(id, update)).catch(() => {});
          },
          onError: lose,
          onComplete: lose,
        },
      );
      return id;
    });
  flowId.catch(() => {
    // The host's refusal is not repeated (it is the host's wording, not this
    // row's); the row says the one thing that is true.
    onEvent({ kind: "failed", message: "This host could not start the sign-in." });
    finish("failed");
  });

  return {
    flowId,
    ended,
    answer: async (promptId, value) => link.answer({ flowId: await flowId, promptId, value }),
    cancel: async () => {
      const id = await flowId.catch(() => null);
      if (finished || id === null) return;
      await link.cancel({ flowId: id }).catch(() => undefined);
    },
  };
}

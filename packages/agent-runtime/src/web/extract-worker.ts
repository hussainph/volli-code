/**
 * HTML extraction off the calling thread.
 *
 * {@link extractReadableMarkdown} is synchronous: jsdom's parse, the sanitiser,
 * Readability and Turndown run start to finish once begun, and on the shapes
 * its bounds still admit that is seconds of work — measured at 2.9-3.8 s for a
 * 2 MiB document on a loaded machine. `webPortsFor` builds the fetcher in the
 * host's own process, which on desktop is Electron main: SQLite, the IPC
 * bridge, the `volli` CLI socket and every Session's agent loop. Run there, one
 * agent reading one large page froze the whole app for those seconds, and no
 * deadline could stop it, because a deadline is a timer and a timer needs the
 * thread the extraction was holding.
 *
 * So the host runs it in a worker thread instead. The function the worker
 * calls is the same function, given the same string, and what comes back is
 * the same plain object by structured clone — the output is byte-identical by
 * construction rather than by test alone. What the thread buys is that the
 * deadline is real: past it the worker is terminated, which interrupts even the
 * synchronous middle of a parse, and the caller hears a timeout.
 *
 * One warm worker is kept between reads, because starting one is not free —
 * loading jsdom, Readability and Turndown into a fresh isolate measured at
 * 0.35-1.3 s. A read that finds it busy starts another rather than queueing,
 * so one slow page never spends a second read's deadline; only one is kept
 * when they finish. The kept worker leaves after {@link WEB_EXTRACT_IDLE_MS}
 * of idleness and never holds the process open.
 *
 * Wiring: a host bundles a module that calls {@link serveWebExtractWorker} as
 * its own entry and passes that file's URL to {@link createWorkerWebExtractor}.
 * Bundlers each spell that differently, which is why the entry is a parameter.
 * A host that passes none extracts on its own thread, as before
 * ({@link extractInProcess}).
 */
import { Worker, parentPort, type MessagePort } from "node:worker_threads";

import { extractReadableMarkdown, type ExtractedDocument } from "./extract";
import { declareStatelessWorker } from "./stateless-worker";

/** One document to read. The signal withdraws it. */
export interface WebExtractRequest {
  html: string;
  url: string;
  signal: AbortSignal;
}

/** Turns one document into its article; where that work runs is the implementation's. */
export type WebExtractor = (request: WebExtractRequest) => Promise<ExtractedDocument>;

/**
 * Why an extraction did not answer.
 *
 * `failed` is the document's fault (or the worker's) and reads as an
 * unreadable page; `timeout` and `cancelled` are about time, and read as such.
 */
export type WebExtractFailure = "failed" | "timeout" | "cancelled";

export class WebExtractError extends Error {
  readonly reason: WebExtractFailure;
  constructor(reason: WebExtractFailure, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "WebExtractError";
    this.reason = reason;
  }
}

/**
 * How long one extraction may take in a worker, worker start included.
 *
 * Four times the worst case the bounds in `WEB_EXTRACT_LIMITS` were measured
 * to permit (2.4 s), because the measurement was taken on an idle machine and
 * a host running many Sessions is not one: 2 MiB measured at 3.8 s under load.
 * A page past this is not a page any bound anticipated, and the thread it was
 * holding is no longer the app's.
 */
export const WEB_EXTRACT_DEADLINE_MS = 10_000;

/** How long the warm worker waits for its next read before leaving. */
export const WEB_EXTRACT_IDLE_MS = 60_000;

/** The thread the caller is on; what a host without a worker entry runs. */
export const extractInProcess: WebExtractor = async ({ html, url }) =>
  extractReadableMarkdown(html, url);

/** Parent to worker: one document. */
interface ExtractJob {
  html: string;
  url: string;
}

/** Worker to parent: the answer to the one job it was given. */
type ExtractAnswer = { type: "done"; document: ExtractedDocument } | { type: "failed" };

export interface WorkerWebExtractorOptions {
  /** Default {@link WEB_EXTRACT_DEADLINE_MS}. */
  deadlineMs?: number;
  /** Default {@link WEB_EXTRACT_IDLE_MS}; zero keeps no worker between reads. */
  idleMs?: number;
}

/** An extractor that runs each document in a worker started from `entry`. */
export function createWorkerWebExtractor(
  entry: string | URL,
  options: WorkerWebExtractorOptions = {},
): WebExtractor {
  const deadlineMs = options.deadlineMs ?? WEB_EXTRACT_DEADLINE_MS;
  const idleMs = options.idleMs ?? WEB_EXTRACT_IDLE_MS;
  let warm: { worker: Worker; timer: NodeJS.Timeout; onExit: () => void } | undefined;

  const start = (): Worker => {
    const worker = new Worker(entry);
    // Parses HTML in memory and writes nothing: a quit may end the process under it (VC-1208).
    declareStatelessWorker(worker);
    // A read hears its worker's failure through its own listener. This one is
    // for a failure with no read listening — a kept worker between reads —
    // which as an unheard `error` event would be an uncaught exception on the
    // host's own thread; the `exit` that follows it is what retires the worker.
    worker.on("error", () => {});
    // A worker never keeps the host alive: a read in flight is held open by
    // its deadline timer, and an idle worker has nothing to finish.
    worker.unref();
    return worker;
  };

  const take = (): Worker => {
    if (warm === undefined) return start();
    const { worker, timer, onExit } = warm;
    warm = undefined;
    clearTimeout(timer);
    worker.off("exit", onExit);
    return worker;
  };

  /** Keep a worker that answered, unless one is already kept. */
  const keep = (worker: Worker): void => {
    if (warm !== undefined || idleMs <= 0) {
      void worker.terminate();
      return;
    }
    const timer = setTimeout(() => {
      take();
      void worker.terminate();
    }, idleMs);
    timer.unref();
    // A kept worker that dies while idle is forgotten, so the next read starts
    // a live one rather than posting into a thread that will never answer.
    // `take` removes this listener, so it only ever fires while kept.
    const onExit = (): void => {
      take();
    };
    worker.once("exit", onExit);
    warm = { worker, timer, onExit };
  };

  return ({ html, url, signal }) => {
    if (signal.aborted) {
      return Promise.reject(new WebExtractError("cancelled", "The read was cancelled."));
    }
    const worker = take();
    return new Promise<ExtractedDocument>((resolve, reject) => {
      /**
       * One way out for every outcome; `reusable` only when the worker
       * answered. It removes every listener and the deadline first, so no
       * second outcome can arrive after it.
       */
      const finish = (outcome: () => void, reusable: boolean): void => {
        clearTimeout(deadline);
        signal.removeEventListener("abort", onAbort);
        worker.off("message", onMessage);
        worker.off("error", onError);
        worker.off("exit", onExit);
        if (reusable) keep(worker);
        // Terminating interrupts the synchronous middle of a parse; that is
        // the whole reason this runs in a thread.
        else void worker.terminate();
        outcome();
      };
      const onMessage = (answer: ExtractAnswer): void => {
        if (answer.type === "done") finish(() => resolve(answer.document), true);
        // A document that made the extractor throw may have left the thread
        // in any state, so it is not handed the next one.
        else
          finish(
            () => reject(new WebExtractError("failed", "The document could not be read.")),
            false,
          );
      };
      const onError = (error: Error): void => {
        finish(
          () =>
            reject(
              new WebExtractError("failed", "The extraction worker failed.", { cause: error }),
            ),
          false,
        );
      };
      const onExit = (code: number): void => {
        finish(
          () =>
            reject(
              new WebExtractError(
                "failed",
                `The extraction worker exited (${code}) without answering.`,
              ),
            ),
          false,
        );
      };
      const onAbort = (): void => {
        finish(() => reject(new WebExtractError("cancelled", "The read was cancelled.")), false);
      };
      const deadline = setTimeout(() => {
        finish(
          () =>
            reject(
              new WebExtractError(
                "timeout",
                `The document took longer than ${deadlineMs} ms to read.`,
              ),
            ),
          false,
        );
      }, deadlineMs);
      worker.on("message", onMessage);
      worker.on("error", onError);
      worker.on("exit", onExit);
      signal.addEventListener("abort", onAbort, { once: true });
      // The empty transfer list is Node's second argument, not a browser target origin.
      worker.postMessage({ html, url } satisfies ExtractJob, []);
    });
  };
}

/** The worker side: reads each document it is sent, one at a time, over `port`. */
export function serveWebExtractWorker(port: MessagePort | null = parentPort): void {
  if (port === null) throw new Error("serveWebExtractWorker must run inside a worker thread");
  port.on("message", ({ html, url }: ExtractJob) => {
    let answer: ExtractAnswer;
    try {
      answer = { type: "done", document: extractReadableMarkdown(html, url) };
    } catch {
      // The error itself stays here: it describes a hostile document, and the
      // parent's answer to every such document is the same refusal.
      answer = { type: "failed" };
    }
    // The empty transfer list is Node's second argument, not a browser target origin.
    port.postMessage(answer, []);
  });
}

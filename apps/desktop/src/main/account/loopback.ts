/**
 * The sign-in's redirect target: a one-shot listener on
 * `http://127.0.0.1:<random port>/auth/callback` (RFC 8252 §7.3). Every dev
 * build, harness build and installed app gets its own port, so instances
 * never collide over a URL scheme registration; WorkOS accepts a loopback
 * redirect with a wildcard port in production for native clients.
 *
 * It answers only `GET /auth/callback` whose `state` matches this flow's:
 * any other request (a stale tab, a port scan, a guess) gets a 400 and the
 * listener keeps waiting. The first matching request settles the flow and
 * closes the listener. It binds 127.0.0.1 only.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export const CALLBACK_PATH = "/auth/callback";

/** What the provider sent back: a code, or the error it named. */
export type CallbackResult =
  | { readonly kind: "code"; readonly code: string }
  | { readonly kind: "error"; readonly error: string; readonly description: string | null };

export interface LoopbackCallback {
  readonly redirectUri: string;
  /** Settles with the first matching callback; rejects on abort or timeout. */
  readonly result: Promise<CallbackResult>;
  /** Stops listening; harmless after the result. */
  close(): void;
}

export class CallbackAbortedError extends Error {
  readonly code = "callback-aborted";
  constructor(readonly reason: "cancelled" | "timed-out") {
    super(
      reason === "timed-out"
        ? "The browser sign-in took too long. Try again."
        : "The browser sign-in was cancelled.",
    );
    this.name = "CallbackAbortedError";
  }
}

const page = (title: string, line: string): string =>
  `<!doctype html><meta charset="utf-8"><title>${title}</title>` +
  `<body style="font:16px system-ui;margin:4rem auto;max-width:28rem;text-align:center">` +
  `<h1 style="font-size:1.25rem">${title}</h1><p>${line}</p></body>`;

export async function listenForCallback(options: {
  readonly state: string;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
}): Promise<LoopbackCallback> {
  const settled = Promise.withResolvers<CallbackResult>();
  let done = false;
  const server: Server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const reply = (status: number, title: string, line: string) => {
      response.writeHead(status, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        // The page has nothing to run or embed.
        "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'",
      });
      response.end(page(title, line));
    };
    if (
      done ||
      request.method !== "GET" ||
      url.pathname !== CALLBACK_PATH ||
      url.searchParams.get("state") !== options.state
    ) {
      reply(400, "Not this sign-in", "Return to Volli and start signing in again.");
      return;
    }
    const code = url.searchParams.get("code");
    const error = url.searchParams.get("error");
    if (code !== null && code !== "") {
      finish({ kind: "code", code });
      reply(200, "Signed in", "You can close this tab and return to Volli.");
      return;
    }
    finish({
      kind: "error",
      error: error ?? "no_code",
      description: url.searchParams.get("error_description"),
    });
    reply(200, "Sign-in didn't finish", "Return to Volli to try again.");
  });
  const timer = setTimeout(() => abort("timed-out"), options.timeoutMs);
  timer.unref();
  const onAbort = () => abort("cancelled");
  function close(): void {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onAbort);
    server.close();
    server.closeAllConnections();
  }
  function finish(result: CallbackResult): void {
    if (done) return;
    done = true;
    settled.resolve(result);
    // Let the answer leave first.
    setImmediate(close);
  }
  function abort(reason: "cancelled" | "timed-out"): void {
    if (done) return;
    done = true;
    settled.reject(new CallbackAbortedError(reason));
    close();
  }
  // Observed here so an unawaited rejection is never unhandled.
  settled.promise.catch(() => {});
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  server.unref();
  const { port } = server.address() as AddressInfo;
  if (options.signal?.aborted) abort("cancelled");
  else options.signal?.addEventListener("abort", onAbort, { once: true });
  return {
    redirectUri: `http://127.0.0.1:${port}${CALLBACK_PATH}`,
    result: settled.promise,
    close: () => abort("cancelled"),
  };
}

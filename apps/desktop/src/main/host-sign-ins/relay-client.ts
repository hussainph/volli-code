/**
 * The auth-callback relay, this Mac's side (HP § Auth-callback relay; VC-702).
 *
 * A subscription sign-in runs on the host. Its provider redirects this Mac's
 * browser to a loopback address, where only the host's listener was ever
 * meant to be — on the host. So, for one request, this Mac stands in:
 *
 * 1. The host sends `auth-callback {flowId, redirectUri}` before the
 *    authorization URL. {@link bindOneCallback} binds that loopback host and
 *    port here **before** the URL is opened, so the browser's redirect has
 *    somewhere to land.
 * 2. The first request on the grant's path is the redirect. Its path and
 *    query go to the host with `auth.callback.deliver`; the host replays them
 *    to its own listener, which checks `state` and exchanges the code with
 *    the PKCE verifier only the host holds. This Mac never sees a token.
 * 3. The browser is answered with a page that says how it went, and the
 *    listener closes. Any other request is answered 404 and changes nothing.
 *
 * **Paste when it cannot bind.** The port is taken (another sign-in, the
 * provider's own CLI on this Mac), or the address is not one this Mac may
 * bind: the result is `unavailable`, and the person pastes the redirect into
 * the flow's own pasted-code step, which Pi races against the callback anyway.
 *
 * Nothing here logs, and nothing here keeps the request: it is handed on once.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

/** Where the relay listens, read from the redirect the host registered. */
export interface RelayAddress {
  /** What to bind: `127.0.0.1` for `localhost`, as pi binds it; `::1` for `[::1]`. */
  readonly host: string;
  readonly port: number;
  readonly path: string;
}

/**
 * The loopback address a redirect names, or null for one this Mac must not
 * bind: not plain `http`, not loopback, no port, or carrying credentials.
 */
export function relayAddressOf(redirectUri: string): RelayAddress | null {
  let url: URL;
  try {
    url = new URL(redirectUri);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" || url.username !== "" || url.password !== "") return null;
  const port = Number(url.port);
  if (url.port === "" || !Number.isInteger(port) || port <= 0) return null;
  const host =
    url.hostname === "localhost" || url.hostname === "127.0.0.1"
      ? "127.0.0.1"
      : url.hostname === "[::1]"
        ? "::1"
        : null;
  return host === null ? null : { host, port, path: url.pathname };
}

/** What the browser's one request became. */
export type RelayOutcome =
  /** Delivered to the host; `status` is what the host's own listener answered. */
  | { readonly kind: "delivered"; readonly status: number }
  /** Delivering failed; the person can still paste the redirect. */
  | { readonly kind: "failed" }
  /** Closed before a redirect arrived: the flow ended, or it was cancelled. */
  | { readonly kind: "closed" }
  /** No redirect came in time; the listener closed, and the person pastes instead. */
  | { readonly kind: "timed-out" };

/** A bound one-shot listener, or why there is none and the person pastes instead. */
export type RelayBinding =
  | {
      readonly kind: "bound";
      /** Settles once: the redirect delivered or not, or the listener closed first. */
      readonly outcome: Promise<RelayOutcome>;
      /** Stops listening; an outcome not yet settled settles `closed`. */
      close(): void;
    }
  | { readonly kind: "unavailable"; readonly reason: "address" | "port-taken" | "bind-failed" };

/** Sends the redirect's path and query to the host (`auth.callback.deliver`). */
export type DeliverCallback = (pathAndQuery: string) => Promise<{ status: number }>;

/** How long a listener waits for the browser's redirect before it gives up. */
export const RELAY_IDLE_MS = 10 * 60_000;

export interface BindOptions {
  /** Test seam: the server factory. */
  readonly createServer?: typeof createServer;
  /** Test seam: how long the listener waits; {@link RELAY_IDLE_MS} by default. */
  readonly idleMs?: number;
}

/**
 * Binds the redirect's loopback address for exactly one request on its path.
 * Resolves once listening (or refused), so the caller opens the authorization
 * URL only after the redirect has somewhere to land.
 */
export function bindOneCallback(
  redirectUri: string,
  deliver: DeliverCallback,
  options: BindOptions = {},
): Promise<RelayBinding> {
  const address = relayAddressOf(redirectUri);
  if (address === null) return Promise.resolve({ kind: "unavailable", reason: "address" });
  let settle!: (outcome: RelayOutcome) => void;
  const outcome = new Promise<RelayOutcome>((resolve) => (settle = resolve));
  let taken = false;
  const server: Server = (options.createServer ?? createServer)((request, response) => {
    void answer(request, response);
  });
  // A host cannot keep this Mac's port bound: with no redirect in time, the
  // listener closes and the person pastes the redirect instead.
  let idle: NodeJS.Timeout | null = null;
  const stopListening = (end: RelayOutcome): void => {
    if (idle !== null) clearTimeout(idle);
    idle = null;
    settle(end);
    server.close();
    server.closeAllConnections();
  };
  const close = (): void => stopListening({ kind: "closed" });

  async function answer(request: IncomingMessage, response: ServerResponse): Promise<void> {
    // Node always sets a server request's target.
    const target = String(request.url);
    const query = target.indexOf("?");
    const path = query === -1 ? target : target.slice(0, query);
    if (taken || request.method !== "GET" || path !== address!.path) {
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" }).end("Not found");
      return;
    }
    // One request, ever: a second redirect (a reload, a stray tab) is not delivered.
    taken = true;
    // Listening started the wait, and a request can only follow that.
    clearTimeout(idle!);
    idle = null;
    server.close();
    let result: RelayOutcome;
    try {
      result = { kind: "delivered", status: (await deliver(target)).status };
    } catch {
      result = { kind: "failed" };
    }
    const ok = result.kind === "delivered" && result.status >= 200 && result.status < 300;
    response
      .writeHead(ok ? 200 : 502, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
      })
      .end(page(ok));
    settle(result);
  }

  return new Promise<RelayBinding>((resolve) => {
    server.once("error", (error: NodeJS.ErrnoException) => {
      settle({ kind: "closed" });
      resolve({
        kind: "unavailable",
        reason: error.code === "EADDRINUSE" ? "port-taken" : "bind-failed",
      });
    });
    server.listen({ host: address.host, port: address.port, exclusive: true }, () => {
      idle = setTimeout(
        () => stopListening({ kind: "timed-out" }),
        options.idleMs ?? RELAY_IDLE_MS,
      );
      idle.unref();
      resolve({ kind: "bound", outcome, close });
    });
  });
}

/** The page the browser shows. No detail: what went wrong is told in Volli. */
function page(ok: boolean): string {
  const line = ok
    ? "Signed in. You can close this tab and go back to Volli."
    : "The sign-in did not finish. Go back to Volli to try again.";
  return `<!doctype html><meta charset="utf-8"><title>Volli</title><p style="font:15px system-ui;margin:3em auto;max-width:28em">${line}</p>`;
}

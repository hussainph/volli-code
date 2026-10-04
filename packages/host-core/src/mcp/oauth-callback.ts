import { createServer, type Server, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import type { OAuthCallback, OAuthCallbackServerOptions } from "@earendil-works/pi-mcp/oauth";

/** Let the callback response flush, but never wait indefinitely on browser TCP. */
export const MCP_OAUTH_CALLBACK_CLOSE_GRACE_MS = 250;

export type McpOAuthCallbackOptions = Pick<
  OAuthCallbackServerOptions,
  "host" | "redirectHost" | "port" | "path" | "timeoutMs"
>;

/**
 * Volli owns the listener lifetime; pi-mcp still owns the OAuth protocol.
 * pi-mcp 0.99.2's callback close only awaits server.close(), which can hang on
 * a browser's speculative TCP connection that has not sent any HTTP. Track
 * sockets from acceptance (not just HTTP requests), and forcibly drain them
 * after a bounded grace period. closeAllConnections() alone misses these too.
 */
export class McpOAuthCallbackServer {
  readonly redirectUrl: string;
  readonly #server: Server;
  readonly #path: string;
  readonly #timeoutMs: number;
  readonly #sockets = new Set<Socket>();
  readonly #pending = new Map<
    string,
    {
      resolve: (callback: OAuthCallback) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  #closing: Promise<void> | undefined;

  private constructor(server: Server, options: McpOAuthCallbackOptions) {
    this.#server = server;
    this.#path = options.path ?? "/callback";
    this.#timeoutMs = options.timeoutMs ?? 5 * 60_000;
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("OAuth callback server did not bind to TCP");
    }
    const host = options.redirectHost ?? options.host ?? "127.0.0.1";
    this.redirectUrl = `http://${host.includes(":") ? `[${host}]` : host}:${address.port}${this.#path}`;
    server.on("connection", (socket) => {
      // A connection accepted just as close starts must not escape the drain.
      if (this.#closing !== undefined) {
        socket.destroy();
        return;
      }
      this.#sockets.add(socket);
      socket.once("close", () => this.#sockets.delete(socket));
    });
  }

  static async listen(options: McpOAuthCallbackOptions = {}): Promise<McpOAuthCallbackServer> {
    let callback: McpOAuthCallbackServer | undefined;
    const server = createServer((request, response) => {
      if (callback !== undefined) callback.#handle(request.url ?? "/", response);
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(options.port ?? 0, options.host ?? "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });
    callback = new McpOAuthCallbackServer(server, options);
    return callback;
  }

  waitForCallback(state: string): Promise<OAuthCallback> {
    if (this.#closing !== undefined)
      return Promise.reject(new Error("OAuth callback server closed"));
    if (this.#pending.has(state)) throw new Error("OAuth state is already pending");
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(state);
        reject(new Error("OAuth callback timed out"));
      }, this.#timeoutMs);
      this.#pending.set(state, { resolve, reject, timer });
    });
  }

  /** Idempotent: abort and finally can both await the same complete teardown. */
  close(): Promise<void> {
    if (this.#closing !== undefined) return this.#closing;
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("OAuth callback server closed"));
    }
    this.#pending.clear();
    this.#closing = new Promise<void>((resolve, reject) => {
      const deadline = setTimeout(() => {
        for (const socket of this.#sockets) socket.destroy();
      }, MCP_OAUTH_CALLBACK_CLOSE_GRACE_MS);
      // Stop accepting first. The timer then drains raw/preconnected sockets
      // as well as incomplete HTTP; completion means resources really closed,
      // not a Promise.race that leaves a listener running in the background.
      this.#server.close((error) => {
        clearTimeout(deadline);
        if (error) reject(error);
        else resolve();
      });
    });
    return this.#closing;
  }

  #reply(response: ServerResponse, status: number, message: string): void {
    response.writeHead(status, {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
      connection: "close",
    });
    response.end(message);
  }

  #handle(rawUrl: string, response: ServerResponse): void {
    let url: URL;
    try {
      url = new URL(rawUrl, this.redirectUrl);
    } catch {
      this.#reply(response, 400, "Invalid callback URL");
      return;
    }
    if (url.pathname !== this.#path) {
      this.#reply(response, 404, "Not found");
      return;
    }
    const state = url.searchParams.get("state");
    const pending = state ? this.#pending.get(state) : undefined;
    if (!state || !pending) {
      this.#reply(response, 400, "Invalid or expired OAuth state");
      return;
    }
    clearTimeout(pending.timer);
    this.#pending.delete(state);
    if (url.searchParams.get("error")) {
      // Third-party error prose is not reflected in the browser or Settings.
      pending.reject(new Error("OAuth authorization failed"));
      this.#reply(response, 200, "Authorization failed. You may close this window.");
      return;
    }
    const code = url.searchParams.get("code");
    if (!code) {
      pending.reject(new Error("OAuth callback did not include an authorization code"));
      this.#reply(response, 400, "Missing authorization code");
      return;
    }
    const iss = url.searchParams.get("iss");
    pending.resolve({ code, state, ...(iss ? { iss } : {}) });
    this.#reply(response, 200, "Authorization complete. You may close this window.");
  }
}

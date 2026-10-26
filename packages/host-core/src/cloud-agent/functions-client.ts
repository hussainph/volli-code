/**
 * Convex's HTTP functions API, as a runner calls it for an agent's verbs:
 * `POST {url}/api/query|mutation|action` with `{ path, args, format: "json" }`
 * and `Authorization: Bearer <token>`.
 *
 * Not the runner's WebSocket link. A Convex client queues mutations while it
 * is disconnected and replays them when it reconnects, which is the opposite
 * of what an agent's board write needs: it fails fast offline, and an
 * agent told "offline" that then saw its write land later could apply it
 * twice. A WebSocket also carries one identity, and each Session acts under
 * its own Agent token. Agent verbs are rare enough that one HTTP request each
 * costs nothing.
 *
 * Every failure is one of two things:
 * - {@link CloudOfflineError}: no answer (the network, a timeout, a 5xx with
 *   no typed body). Its `delivery` says whether the request could have
 *   reached the backend: `not_sent` (the link was down, the address refused
 *   the connection or did not resolve) means nothing happened; `unknown`
 *   means a mutation may have been applied and only its answer was lost.
 * - {@link CloudFunctionError}: the backend answered and refused, with its
 *   typed `code` (`not_found`, `fenced`, …) and its sentence.
 */

/** The three function kinds the HTTP API serves. */
export type CloudFunctionKind = "query" | "mutation" | "action";

/** Why the backend could not be reached. */
export type CloudOfflineReason = "link_down" | "network" | "timeout" | "unavailable";

/**
 * Whether a request that got no answer could have reached the backend:
 * `not_sent` is certain it did not; `unknown` is a lost answer.
 */
export type CloudDelivery = "not_sent" | "unknown";

/** The backend did not answer. Whether anything happened is {@link CloudOfflineError.delivery}. */
export class CloudOfflineError extends Error {
  readonly code = "offline";
  readonly retryable = true;
  constructor(
    readonly reason: CloudOfflineReason,
    message: string,
    readonly delivery: CloudDelivery = "unknown",
  ) {
    super(message);
    this.name = "CloudOfflineError";
  }
}

/** Connection failures that happen before a byte of the request is sent. */
const NOT_SENT_CODES: ReadonlySet<string> = new Set([
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "ENETDOWN",
]);

function errorCode(error: unknown): string | null {
  const cause = (error as { cause?: { code?: unknown } } | null)?.cause;
  return typeof cause?.code === "string" ? cause.code : null;
}

/** The backend answered and refused: its typed `code`, its sentence and any other data it sent. */
export class CloudFunctionError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly data: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.name = "CloudFunctionError";
  }
}

export type CloudFetch = (url: string, init: RequestInit) => Promise<Response>;

export interface CloudFunctionsClient {
  /** Calls `path` (`module:function`) with `args` under `token`, waiting at most `timeoutMs`. */
  call(
    kind: CloudFunctionKind,
    path: string,
    args: Record<string, unknown>,
    token: string,
    options?: { timeoutMs?: number },
  ): Promise<unknown>;
}

export interface CloudFunctionsClientOptions {
  /** The deployment's URL (`https://<deployment>.convex.cloud`). */
  url: string;
  fetch?: CloudFetch;
  /** A call that has not answered by then is `offline` (`timeout`). */
  timeoutMs?: number;
}

/** How long one agent verb's backend call may take before it is given up as offline. */
export const CLOUD_FUNCTION_TIMEOUT_MS = 10_000;

const MAX_MESSAGE = 500;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function createCloudFunctionsClient(
  options: CloudFunctionsClientOptions,
): CloudFunctionsClient {
  const fetchImpl: CloudFetch = options.fetch ?? ((url, init) => fetch(url, init));
  let base = options.url;
  while (base.endsWith("/")) base = base.slice(0, -1);
  const timeoutMs = options.timeoutMs ?? CLOUD_FUNCTION_TIMEOUT_MS;

  return {
    async call(kind, path, args, token, callOptions = {}) {
      // The client's own bound is the most any call waits.
      const wait = Math.min(callOptions.timeoutMs ?? timeoutMs, timeoutMs);
      let response: Response;
      try {
        response = await fetchImpl(`${base}/api/${kind}`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
          body: JSON.stringify({ path, args, format: "json" }),
          signal: AbortSignal.timeout(wait),
        });
      } catch (error) {
        const timedOut = (error as Error).name === "TimeoutError";
        const code = errorCode(error);
        throw new CloudOfflineError(
          timedOut ? "timeout" : "network",
          `${path}: ${timedOut ? `no answer in ${wait} ms` : (error as Error).message}`,
          !timedOut && code !== null && NOT_SENT_CODES.has(code) ? "not_sent" : "unknown",
        );
      }
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        body = null;
      }
      if (isRecord(body) && body["status"] === "success") return body["value"];
      if (isRecord(body) && body["status"] === "error") {
        const data = isRecord(body["errorData"]) ? body["errorData"] : {};
        const message =
          typeof data["message"] === "string"
            ? data["message"]
            : typeof body["errorMessage"] === "string"
              ? body["errorMessage"]
              : `${path} failed.`;
        const code = typeof data["code"] === "string" ? data["code"] : "server_error";
        throw new CloudFunctionError(code, message.slice(0, MAX_MESSAGE), data);
      }
      if (response.status === 401 || response.status === 403) {
        throw new CloudFunctionError("unauthenticated", "Volli Cloud did not accept this token.");
      }
      throw new CloudOfflineError(
        "unavailable",
        `${path}: Volli Cloud answered ${response.status}.`,
      );
    },
  };
}

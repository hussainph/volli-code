/**
 * The runner's HTTP client for `/runner/*` on the deployment's site URL:
 * link with an install token, the device-code link, and the token exchange.
 *
 * Bodies and replies are the shared wire (`@volli/shared/cloud`), checked by
 * its codecs on the way in. A reply the backend answered with one of its own
 * error codes is a {@link RunnerHttpError} carrying that code; anything else
 * that went wrong on the way (the network, a 5xx, a body we cannot read) is
 * `unavailable`, which the caller retries with the same request. Only
 * `invalid_credential` and `revoked` mean the box must be linked again.
 */
import {
  RUNNER_HTTP_PATHS,
  RUNNER_RELINK_CODES,
  parseRunnerDeviceLinkPoll,
  parseRunnerDeviceLinkStart,
  parseRunnerLinkGrant,
  parseRunnerTokenGrant,
  readRunnerHttpError,
  type RunnerDeviceLinkPoll,
  type RunnerDeviceLinkPollRequest,
  type RunnerDeviceLinkStart,
  type RunnerHostFacts,
  type RunnerHttpErrorCode,
  type RunnerLinkGrant,
  type RunnerLinkRequest,
  type RunnerTokenGrant,
  type RunnerTokenRequest,
} from "@volli/shared/cloud";

export type RunnerHttpFailure = RunnerHttpErrorCode | "unavailable";

export class RunnerHttpError extends Error {
  readonly code: RunnerHttpFailure;
  /** The HTTP status, or `null` when no response arrived. */
  readonly status: number | null;
  constructor(code: RunnerHttpFailure, status: number | null, message: string) {
    super(message);
    this.name = "RunnerHttpError";
    this.code = code;
    this.status = status;
  }

  /** Retrying the same request cannot succeed: link the runner again. */
  get relinkRequired(): boolean {
    return (RUNNER_RELINK_CODES as readonly string[]).includes(this.code);
  }
}

export type RunnerFetch = (url: string, init: RequestInit) => Promise<Response>;

export interface RunnerLinkClient {
  link(request: RunnerLinkRequest): Promise<RunnerLinkGrant>;
  startDeviceLink(host: RunnerHostFacts): Promise<RunnerDeviceLinkStart>;
  pollDeviceLink(request: RunnerDeviceLinkPollRequest): Promise<RunnerDeviceLinkPoll>;
  exchange(request: RunnerTokenRequest): Promise<RunnerTokenGrant>;
}

export interface RunnerLinkClientOptions {
  /** The deployment's HTTP actions origin (`https://<deployment>.convex.site`). */
  siteUrl: string;
  fetch?: RunnerFetch;
  /** A request that has not answered by then is `unavailable` (default 30 s). */
  timeoutMs?: number;
}

/** How long one `/runner/*` request may take before it is given up as `unavailable`. */
export const RUNNER_HTTP_TIMEOUT_MS = 30_000;

export function createRunnerLinkClient(options: RunnerLinkClientOptions): RunnerLinkClient {
  const fetchImpl: RunnerFetch = options.fetch ?? ((url, init) => fetch(url, init));
  let origin = options.siteUrl;
  while (origin.endsWith("/")) origin = origin.slice(0, -1);
  const timeoutMs = options.timeoutMs ?? RUNNER_HTTP_TIMEOUT_MS;

  async function post<T>(path: string, body: unknown, parse: (value: unknown) => T): Promise<T> {
    let response: Response;
    try {
      response = await fetchImpl(`${origin}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        // Every token request waits on the one exchange in flight: it must not hang.
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw new RunnerHttpError("unavailable", null, `POST ${path}: ${(error as Error).message}`);
    }
    let value: unknown;
    try {
      value = await response.json();
    } catch {
      throw new RunnerHttpError(
        "unavailable",
        response.status,
        `POST ${path}: ${response.status}, no JSON body`,
      );
    }
    if (!response.ok) {
      const error = readRunnerHttpError(value);
      if (error === null) {
        throw new RunnerHttpError(
          "unavailable",
          response.status,
          `POST ${path}: ${response.status}`,
        );
      }
      throw new RunnerHttpError(error.code, response.status, error.message);
    }
    try {
      return parse(value);
    } catch (error) {
      throw new RunnerHttpError(
        "unavailable",
        response.status,
        `POST ${path}: ${(error as Error).message}`,
      );
    }
  }

  return {
    link: (request) => post(RUNNER_HTTP_PATHS.link, request, parseRunnerLinkGrant),
    startDeviceLink: (host) =>
      post(RUNNER_HTTP_PATHS.linkStart, { host }, parseRunnerDeviceLinkStart),
    pollDeviceLink: (request) =>
      post(RUNNER_HTTP_PATHS.linkPoll, request, parseRunnerDeviceLinkPoll),
    exchange: (request) => post(RUNNER_HTTP_PATHS.token, request, parseRunnerTokenGrant),
  };
}

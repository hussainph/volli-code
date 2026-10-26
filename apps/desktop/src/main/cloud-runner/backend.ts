/**
 * The Mac runner's calls into the backend made as the PERSON, not the
 * runner: registering this Mac and removing it. Convex's HTTP functions API
 * (`POST {url}/api/action` / `/api/mutation`) with the person's access
 * token, as the account's own calls are (`../account/backend.ts`); no Convex
 * client library rides in main for them. Everything the runner says as
 * itself (heartbeats, state) goes over its backend link with a runner token.
 */
import {
  parseRunnerLinkGrant,
  type RunnerHostFacts,
  type RunnerLinkGrant,
} from "@volli/shared/cloud";

import { BackendRefusedError } from "../account/backend";

export interface MacRunnerBackend {
  /** `runners.registerThisMac`: the grant, credential included (sealed by the caller at once). */
  registerThisMac(
    accessToken: string,
    input: {
      host: RunnerHostFacts;
      name: string | null;
      replacesRunnerId: string | null;
      /** Minted per registration and kept until it is answered: a retry is the same registration. */
      registrationId: string;
    },
  ): Promise<RunnerLinkGrant>;
  /** `runners.remove`: revokes the runner; idempotent. */
  removeRunner(accessToken: string, runnerId: string): Promise<void>;
  /** One of the person's runners as `runners.list` shows it; `null` when it is not listed (removed). */
  runnerStatus(
    accessToken: string,
    runnerId: string,
  ): Promise<{ status: string; statusReason: string | null } | null>;
}

/** The request never got an answer from the backend (offline, timeout, a 5xx): retry later. */
export class BackendUnreachableError extends Error {
  readonly name = "BackendUnreachableError";
}

export function convexMacRunnerBackend(options: {
  readonly url: string;
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
}): MacRunnerBackend {
  const base = options.url.replace(/\/+$/u, "");
  const fetchImpl = options.fetch ?? fetch;
  const call = async (
    kind: "action" | "mutation" | "query",
    path: string,
    accessToken: string,
    args: Record<string, unknown>,
  ): Promise<unknown> => {
    let response: Response;
    try {
      response = await fetchImpl(`${base}/api/${kind}`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${accessToken}` },
        body: JSON.stringify({ path, args, format: "json" }),
        signal: AbortSignal.timeout(options.timeoutMs ?? 30_000),
      });
    } catch (error) {
      throw new BackendUnreachableError(`${path}: ${(error as Error).message}`);
    }
    let body: Record<string, unknown> = {};
    try {
      body = ((await response.json()) ?? {}) as Record<string, unknown>;
    } catch {
      body = {};
    }
    if (body["status"] === "success") return body["value"];
    if (body["status"] === "error") {
      const data = body["errorData"] as Record<string, unknown> | undefined;
      const message =
        typeof data?.["message"] === "string"
          ? data["message"]
          : typeof body["errorMessage"] === "string"
            ? body["errorMessage"]
            : "Volli Cloud refused the request.";
      throw new BackendRefusedError(
        message.slice(0, 300),
        typeof data?.["code"] === "string" ? data["code"] : null,
      );
    }
    if (response.status === 401 || response.status === 403) {
      throw new BackendRefusedError("Volli Cloud did not accept this sign-in.", "unauthenticated");
    }
    throw new BackendUnreachableError(`${path}: Volli Cloud answered ${response.status}.`);
  };
  return {
    async registerThisMac(accessToken, input) {
      const value = await call("action", "runners:registerThisMac", accessToken, {
        host: input.host,
        name: input.name,
        ...(input.replacesRunnerId === null ? {} : { replacesRunnerId: input.replacesRunnerId }),
        registrationId: input.registrationId,
      });
      try {
        return parseRunnerLinkGrant(value);
      } catch {
        throw new BackendUnreachableError(
          "Volli Cloud answered with a grant this build cannot read.",
        );
      }
    },
    async removeRunner(accessToken, runnerId) {
      await call("mutation", "runners:remove", accessToken, { runnerId });
    },
    async runnerStatus(accessToken, runnerId) {
      const value = await call("query", "runners:list", accessToken, {});
      if (!Array.isArray(value)) {
        throw new BackendUnreachableError(
          "Volli Cloud answered with a list this build cannot read.",
        );
      }
      const row = (value as Record<string, unknown>[]).find((runner) => runner["id"] === runnerId);
      if (row === undefined) return null;
      return {
        status: typeof row["status"] === "string" ? row["status"] : "unknown",
        statusReason: typeof row["statusReason"] === "string" ? row["statusReason"] : null,
      };
    },
  };
}

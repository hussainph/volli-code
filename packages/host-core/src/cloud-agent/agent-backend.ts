/**
 * An agent's backend calls, as its runner makes them: under that Session's
 * Agent token, failing fast when the backend cannot be reached.
 *
 * **Tokens.** The runner mints one Agent token per Session, lazily on the
 * Session's first backend verb (`agentTokens.mint`, under the runner's own
 * token), keeps it in memory only, and refreshes it at two thirds of its
 * lifetime measured on the backend's clock (as the runner token is). A
 * `fenced`, `revoked` or `unauthenticated` answer drops it and the call is
 * tried once more under a fresh token: a token that merely expired (a sleep)
 * or predates a claim that came back to this runner works again, and a claim
 * that really moved is refused by the mint (`not_claimed`). A Session too new
 * for the backend to know (`unknown_session`: the drain has not sent its
 * creation yet) nudges the drain and retries once before answering
 * {@link NotYetSyncedError}.
 *
 * **Offline.** Board reads and writes never wait for a connection:
 * - while the runner's backend link is not `connected`, every call is
 *   {@link CloudOfflineError} (`not_sent`) before any request is made;
 * - a network failure is offline;
 * - a mutation that timed out is sent once more, with the SAME arguments (and
 *   so the same `commandId`, which the backend's receipts make idempotent),
 *   and if that one gets no answer either, its outcome is `unknown`.
 *
 * **Deadline.** A caller may give an absolute deadline; no call, retry or
 * wait runs past it, so a verb answers inside its door's own bound.
 *
 * The caller mints `commandId` (and the id of anything it creates) before the
 * first attempt, so a retry can never create a second one.
 */
import { parseAgentTokenGrant, type AgentTokenGrant } from "@volli/shared/cloud";

import {
  CLOUD_FUNCTION_TIMEOUT_MS,
  CloudFunctionError,
  CloudOfflineError,
  type CloudFunctionKind,
  type CloudFunctionsClient,
} from "./functions-client";

/** The Session is too new: its runner has not yet sent the backend its creation. Retry shortly. */
export class NotYetSyncedError extends Error {
  readonly code = "not_yet_synced";
  constructor(readonly sessionId: string) {
    super("Volli Cloud has not received this Session's start yet.");
    this.name = "NotYetSyncedError";
  }
}

/** Refresh an Agent token once this fraction of its lifetime has passed. */
export const AGENT_TOKEN_REFRESH_AT = 2 / 3;
/** How long a verb for a brand-new Session waits for the drain before its one retry. */
export const NOT_YET_SYNCED_RETRY_MS = 1_500;
/** A resend or a retry is only worth starting with at least this long left. */
const RETRY_MIN_MS = 1_000;

export interface AgentBackendOptions {
  functions: CloudFunctionsClient;
  /** The runner's own token (its token source), or `null` once its link is lost. */
  runnerToken(): Promise<string | null>;
  /** Whether the runner's backend link is up now. */
  connected(): boolean;
  /** Asks the drain to send this Session's pending facts now: its creation first. */
  nudgeDrain?(sessionId: string): void;
  now?(): number;
  sleep?(ms: number): Promise<void>;
}

/** One call's bound: an absolute time (on {@link AgentBackendOptions.now}) it must finish by. */
export interface AgentCallOptions {
  deadline?: number;
}

export interface AgentBackend {
  action(
    sessionId: string,
    path: string,
    args: Record<string, unknown>,
    options?: AgentCallOptions,
  ): Promise<unknown>;
  query(
    sessionId: string,
    path: string,
    args: Record<string, unknown>,
    options?: AgentCallOptions,
  ): Promise<unknown>;
  mutation(
    sessionId: string,
    path: string,
    args: Record<string, unknown>,
    options?: AgentCallOptions,
  ): Promise<unknown>;
  /**
   * Forgets a Session's token: its attachment ended here, or its claim moved.
   * Receiving wiring: the cloud product store calls it when a Session's last
   * attachment on this runner closes.
   */
  forget(sessionId: string): void;
}

const DROPS_TOKEN: ReadonlySet<string> = new Set(["fenced", "revoked", "unauthenticated"]);

/** Refreshing a runner credential must fit inside the verb's bound too. No agent request is sent on timeout. */
export async function runnerTokenBefore(
  token: () => Promise<string | null>,
  deadline: number,
  now = Date.now,
): Promise<string | null> {
  const wait = deadline - now();
  if (wait <= 0)
    throw new CloudOfflineError(
      "timeout",
      "Out of time before reading the runner token.",
      "not_sent",
    );
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      token(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new CloudOfflineError(
                "timeout",
                "This runner's token source did not answer in time.",
                "not_sent",
              ),
            ),
          wait,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export function createAgentBackend(options: AgentBackendOptions): AgentBackend {
  const now = options.now ?? Date.now;
  const sleep =
    options.sleep ??
    ((ms: number) =>
      new Promise<void>((resolve) => {
        const handle = setTimeout(resolve, ms);
        handle.unref?.();
      }));
  const tokens = new Map<string, { token: string; refreshAt: number }>();
  const minting = new Map<string, Promise<string>>();

  /** The time a call may take before `deadline`, or a refusal when none is left. */
  function budget(deadline: number | undefined): number {
    if (deadline === undefined) return CLOUD_FUNCTION_TIMEOUT_MS;
    const left = deadline - now();
    if (left <= 0) {
      throw new CloudOfflineError("timeout", "Out of time before calling Volli Cloud.", "not_sent");
    }
    return Math.min(CLOUD_FUNCTION_TIMEOUT_MS, left);
  }

  const timeLeft = (deadline: number | undefined) =>
    deadline === undefined ? Number.POSITIVE_INFINITY : deadline - now();

  async function mintOnce(sessionId: string, deadline: number | undefined) {
    const runnerToken = await runnerTokenBefore(options.runnerToken, now() + budget(deadline), now);
    if (runnerToken === null) {
      throw new CloudFunctionError("revoked", "This runner is no longer linked to Volli Cloud.");
    }
    return parseAgentTokenGrant(
      await options.functions.call("action", "agentTokens:mint", { sessionId }, runnerToken, {
        timeoutMs: budget(deadline),
      }),
    );
  }

  async function mint(sessionId: string, deadline: number | undefined): Promise<string> {
    const sentAt = now();
    let grant: AgentTokenGrant;
    try {
      grant = await mintOnce(sessionId, deadline);
    } catch (error) {
      if (!(error instanceof CloudFunctionError) || error.code !== "unknown_session") throw error;
      options.nudgeDrain?.(sessionId);
      if (timeLeft(deadline) < NOT_YET_SYNCED_RETRY_MS + RETRY_MIN_MS) {
        throw new NotYetSyncedError(sessionId);
      }
      await sleep(NOT_YET_SYNCED_RETRY_MS);
      try {
        grant = await mintOnce(sessionId, deadline);
      } catch (retry) {
        if (retry instanceof CloudFunctionError && retry.code === "unknown_session") {
          throw new NotYetSyncedError(sessionId);
        }
        throw retry;
      }
    }
    const lifetime = grant.expiresAt - grant.serverTime;
    tokens.set(sessionId, {
      token: grant.token,
      refreshAt: sentAt + lifetime * AGENT_TOKEN_REFRESH_AT,
    });
    return grant.token;
  }

  async function tokenFor(sessionId: string, deadline: number | undefined): Promise<string> {
    const cached = tokens.get(sessionId);
    if (cached !== undefined && now() < cached.refreshAt) return cached.token;
    let pending = minting.get(sessionId);
    if (pending === undefined) {
      pending = mint(sessionId, deadline).finally(() => minting.delete(sessionId));
      minting.set(sessionId, pending);
    }
    return pending;
  }

  async function send(
    kind: CloudFunctionKind,
    path: string,
    args: Record<string, unknown>,
    token: string,
    deadline: number | undefined,
  ): Promise<unknown> {
    try {
      return await options.functions.call(kind, path, args, token, {
        timeoutMs: budget(deadline),
      });
    } catch (error) {
      if (
        kind !== "mutation" ||
        !(error instanceof CloudOfflineError) ||
        error.reason !== "timeout" ||
        timeLeft(deadline) < RETRY_MIN_MS
      ) {
        throw error;
      }
    }
    // Once more with the same arguments: the backend's receipt for this
    // `commandId` answers a duplicate with the first one's reply.
    try {
      return await options.functions.call(kind, path, args, token, {
        timeoutMs: budget(deadline),
      });
    } catch (error) {
      // The first attempt may have landed whatever this one met.
      if (error instanceof CloudOfflineError && error.delivery === "not_sent") {
        throw new CloudOfflineError(error.reason, error.message, "unknown");
      }
      throw error;
    }
  }

  async function call(
    kind: CloudFunctionKind,
    sessionId: string,
    path: string,
    args: Record<string, unknown>,
    deadline: number | undefined,
  ): Promise<unknown> {
    if (!options.connected()) {
      throw new CloudOfflineError(
        "link_down",
        "This runner is not connected to Volli Cloud.",
        "not_sent",
      );
    }
    const token = await tokenFor(sessionId, deadline);
    try {
      return await send(kind, path, args, token, deadline);
    } catch (error) {
      if (!(error instanceof CloudFunctionError) || !DROPS_TOKEN.has(error.code)) throw error;
      // A refusal is an answer: nothing was applied, so the same call under a
      // fresh token is the same command.
      tokens.delete(sessionId);
      if (timeLeft(deadline) < RETRY_MIN_MS) throw error;
      const fresh = await tokenFor(sessionId, deadline);
      try {
        return await send(kind, path, args, fresh, deadline);
      } catch (retry) {
        if (retry instanceof CloudFunctionError && DROPS_TOKEN.has(retry.code)) {
          tokens.delete(sessionId);
        }
        throw retry;
      }
    }
  }

  return {
    action: (sessionId, path, args, callOptions = {}) =>
      call("action", sessionId, path, args, callOptions.deadline),
    query: (sessionId, path, args, callOptions = {}) =>
      call("query", sessionId, path, args, callOptions.deadline),
    mutation: (sessionId, path, args, callOptions = {}) =>
      call("mutation", sessionId, path, args, callOptions.deadline),
    forget: (sessionId) => {
      tokens.delete(sessionId);
    },
  };
}

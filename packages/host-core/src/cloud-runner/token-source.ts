/**
 * The runner token: what every authenticated call to the backend carries.
 *
 * {@link RunnerTokenSource.token} hands out a cached runner token while it is
 * fresh, and otherwise exchanges the refresh credential for a new one. Each
 * exchange also returns the credential's successor, which is saved BEFORE the
 * token is handed out: the backend ends the old credential's grace at the
 * token's first use, so a token used before its credential is durable could
 * strand the box.
 *
 * Freshness runs on the server's clock: a token is refreshed at two thirds of
 * its lifetime, measured from the `serverTime` its exchange returned, so a box
 * whose clock is wrong still refreshes on time.
 *
 * Concurrent callers share one exchange (two exchanges racing would present
 * the same credential twice). `invalid_credential` and `revoked` end the link:
 * the source reports it once through `onLinkLost` and answers `null` from then
 * on, which the Convex client reads as signed out. Transient failures throw,
 * and the next call tries again.
 *
 * The shape fits `ConvexClient.setAuth(fetchToken)`: `({ forceRefreshToken })`.
 */
import type { RunnerLinkStore } from "./link";
import { RunnerHttpError, type RunnerLinkClient } from "./link-client";

export type RunnerLinkLoss = "unlinked" | "invalid_credential" | "revoked";

export interface RunnerTokenSource {
  token(options?: { forceRefreshToken?: boolean }): Promise<string | null>;
  /** Why the link ended, or `null` while it holds. */
  readonly lost: RunnerLinkLoss | null;
}

export interface RunnerTokenSourceOptions {
  client: RunnerLinkClient;
  store: RunnerLinkStore;
  /** This machine's clock. Only differences against it are used. */
  now?(): number;
  onLinkLost?(reason: RunnerLinkLoss): void;
}

/** Refresh when this fraction of the token's lifetime has passed. */
export const RUNNER_TOKEN_REFRESH_AT = 2 / 3;

export function createRunnerTokenSource(options: RunnerTokenSourceOptions): RunnerTokenSource {
  const now = options.now ?? Date.now;
  let cached: { token: string; refreshAt: number } | null = null;
  let inFlight: Promise<string | null> | null = null;
  let lost: RunnerLinkLoss | null = null;

  // Reached at most once: `token()` answers null before exchanging once the link is lost.
  function loseLink(reason: RunnerLinkLoss): null {
    lost = reason;
    cached = null;
    options.onLinkLost?.(reason);
    return null;
  }

  async function exchange(): Promise<string | null> {
    const identity = await options.store.load();
    if (identity === null) return loseLink("unlinked");
    const sentAt = now();
    let grant;
    try {
      grant = await options.client.exchange({
        runnerId: identity.runnerId,
        credential: identity.credential,
      });
    } catch (error) {
      if (error instanceof RunnerHttpError && error.relinkRequired) {
        return loseLink(error.code as "invalid_credential" | "revoked");
      }
      throw error;
    }
    // Durable first. If this throws, the token is never used and the old
    // credential keeps its grace for the next attempt.
    await options.store.save({
      ...identity,
      credential: grant.credential,
      generation: grant.generation,
    });
    const lifetime = grant.expiresAt - grant.serverTime;
    cached = { token: grant.token, refreshAt: sentAt + lifetime * RUNNER_TOKEN_REFRESH_AT };
    return grant.token;
  }

  return {
    get lost() {
      return lost;
    },
    async token(request = {}) {
      if (lost !== null) return null;
      if (!request.forceRefreshToken && cached !== null && now() < cached.refreshAt) {
        return cached.token;
      }
      inFlight ??= exchange().finally(() => {
        inFlight = null;
      });
      return inFlight;
    },
  };
}

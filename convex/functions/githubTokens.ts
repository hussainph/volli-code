/**
 * A person's GitHub user access token, handed out by {@link mintGithubToken}
 * to the backend's own calls (the setup check, the installations list, the
 * revoke) and, through `/runner/github-token`, to that person's runners.
 *
 * A token is handed out until 30 minutes before it expires
 * (`githubTokenUseUntil`). Then exactly one caller refreshes it: a refresh
 * token is single use, and a refresh also ends the previous access token, so
 * two refreshes racing would strand the connection. The caller that takes
 * the lease (`beginRefresh`, an OCC-serialized mutation) refreshes; the
 * others re-read until the new pair is stored. GitHub refusing the refresh
 * token marks the connection `needs_reconnect`.
 *
 * No query returns a token; only actions open one.
 */

import { v } from "convex/values";

import {
  GITHUB_REFRESH_LEASE_MS,
  decideGithubMint,
  githubLeaseFree,
  githubTokenUseUntil,
  type GithubErrorCode,
} from "@volli/shared/cloud";

import { internal } from "./_generated/api.js";
import type { ActionCtx } from "./_generated/server.js";
import { internalMutation, internalQuery } from "./_generated/server.js";
import { GithubApiError, githubClient } from "./lib/github/client";
import { requireGithubConfig } from "./lib/github/config";
import { randomSecret } from "./lib/github/crypto";
import {
  openToken,
  readPersonKey,
  sealTokens,
  type PersonKey,
  type SealedToken,
} from "./lib/github/seal";
import { sealed } from "./lib/validators";

export type GithubMint =
  | {
      ok: true;
      token: string;
      /** Stop using the token at this moment (the backend refreshes it then). */
      useUntil: number;
      login: string;
      githubUserId: string;
    }
  | {
      ok: false;
      code: Extract<
        GithubErrorCode,
        "not_connected" | "needs_reconnect" | "github_unavailable" | "github_rate_limited"
      >;
      resetAt: number | null;
    };

/** How long a caller that lost the lease waits for the winner's pair. */
const WAIT_STEP_MS = 500;
const WAIT_STEPS = 20;

/** The connection with its sealed tokens and the person's data key. Internal only. */
export const connectionForMint = internalQuery({
  args: { userId: v.string() },
  handler: async (ctx, { userId }) => {
    const connection = await ctx.db
      .query("githubConnections")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .unique();
    if (connection === null) return null;
    return {
      status: connection.status,
      login: connection.login,
      githubUserId: connection.githubUserId,
      accessToken: connection.accessToken,
      refreshToken: connection.refreshToken,
      accessExpiresAt: connection.accessExpiresAt,
      refreshExpiresAt: connection.refreshExpiresAt,
      lease: connection.refreshLease,
      key: await readPersonKey(ctx.db, userId),
    };
  },
});

/** Takes the refresh lease when it is free. Exactly one concurrent caller gets `true`. */
export const beginRefresh = internalMutation({
  args: { userId: v.string(), nonce: v.string() },
  handler: async (ctx, { userId, nonce }): Promise<boolean> => {
    const connection = await ctx.db
      .query("githubConnections")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .unique();
    const now = Date.now();
    if (connection === null || connection.status !== "active") return false;
    // Someone refreshed since this caller read the connection.
    if (now < githubTokenUseUntil(connection.accessExpiresAt)) return false;
    if (!githubLeaseFree(connection.refreshLease, now)) return false;
    await ctx.db.patch(connection._id, {
      refreshLease: { nonce, until: now + GITHUB_REFRESH_LEASE_MS },
    });
    return true;
  },
});

/** Stores the refreshed pair, only while the caller still holds the lease. */
export const completeRefresh = internalMutation({
  args: {
    userId: v.string(),
    nonce: v.string(),
    accessToken: sealed,
    refreshToken: sealed,
    accessExpiresAt: v.number(),
    refreshExpiresAt: v.number(),
  },
  handler: async (ctx, args): Promise<boolean> => {
    const connection = await ctx.db
      .query("githubConnections")
      .withIndex("by_user", (q) => q.eq("userId", args.userId))
      .unique();
    if (connection === null || connection.refreshLease?.nonce !== args.nonce) return false;
    await ctx.db.patch(connection._id, {
      accessToken: args.accessToken,
      refreshToken: args.refreshToken,
      accessExpiresAt: args.accessExpiresAt,
      refreshExpiresAt: args.refreshExpiresAt,
      refreshLease: null,
      updatedAt: Date.now(),
    });
    return true;
  },
});

/** Ends a refresh: `needs_reconnect` when GitHub refused the refresh token, else just the lease. */
export const endRefresh = internalMutation({
  args: { userId: v.string(), nonce: v.string(), needsReconnect: v.boolean() },
  handler: async (ctx, args): Promise<void> => {
    const connection = await ctx.db
      .query("githubConnections")
      .withIndex("by_user", (q) => q.eq("userId", args.userId))
      .unique();
    if (connection === null || connection.refreshLease?.nonce !== args.nonce) return;
    await ctx.db.patch(connection._id, {
      refreshLease: null,
      ...(args.needsReconnect ? { status: "needs_reconnect" as const, updatedAt: Date.now() } : {}),
    });
  },
});

function unavailable(error: unknown): GithubMint {
  if (error instanceof GithubApiError && error.kind === "rate_limited") {
    return { ok: false, code: "github_rate_limited", resetAt: error.resetAt };
  }
  return { ok: false, code: "github_unavailable", resetAt: null };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The refresh itself, by the lease's holder. The lease is released on every
 * way out but a stored pair (which clears it); `null` when the lease ran out
 * and another caller took over, so the caller reads again.
 */
async function refreshHoldingLease(
  ctx: Pick<ActionCtx, "runMutation">,
  userId: string,
  nonce: string,
  key: PersonKey,
  found: { refreshToken: SealedToken | null; login: string; githubUserId: string },
): Promise<GithubMint | null> {
  let needsReconnect = false;
  let stored = false;
  try {
    const refreshToken = await openToken(userId, key, found.refreshToken!, "refresh");
    let pair;
    try {
      pair = await githubClient(requireGithubConfig()).refresh(refreshToken);
    } catch (error) {
      // A spent, expired or revoked refresh token: only a new browser round trip helps.
      needsReconnect = error instanceof GithubApiError && error.oauthError === "bad_refresh_token";
      if (needsReconnect) return { ok: false, code: "needs_reconnect", resetAt: null };
      return unavailable(error);
    }
    // The person's key already exists: the old pair was sealed under it.
    const sealedPair = await sealTokens(userId, key, pair);
    stored = await ctx.runMutation(internal.githubTokens.completeRefresh, {
      userId,
      nonce,
      accessToken: sealedPair.access,
      refreshToken: sealedPair.refresh,
      accessExpiresAt: pair.accessExpiresAt,
      refreshExpiresAt: pair.refreshExpiresAt,
    });
    if (!stored) return null;
    return {
      ok: true,
      token: pair.accessToken,
      useUntil: githubTokenUseUntil(pair.accessExpiresAt),
      login: found.login,
      githubUserId: found.githubUserId,
    };
  } finally {
    if (!stored) {
      await ctx.runMutation(internal.githubTokens.endRefresh, { userId, nonce, needsReconnect });
    }
  }
}

/** A usable user access token for `userId`, refreshing it first when it is due. */
export async function mintGithubToken(
  ctx: Pick<ActionCtx, "runQuery" | "runMutation">,
  userId: string,
): Promise<GithubMint> {
  for (let step = 0; step <= WAIT_STEPS; step += 1) {
    const connection = await ctx.runQuery(internal.githubTokens.connectionForMint, { userId });
    const now = Date.now();
    const decision = decideGithubMint(
      connection === null
        ? null
        : {
            status: connection.status,
            accessExpiresAt: connection.accessExpiresAt,
            refreshExpiresAt: connection.refreshExpiresAt,
            hasTokens:
              connection.accessToken !== null &&
              connection.refreshToken !== null &&
              connection.key !== null,
          },
      now,
    );
    if (decision === "not_connected" || decision === "needs_reconnect") {
      return { ok: false, code: decision, resetAt: null };
    }
    // `decideGithubMint` answered only with tokens and a key present.
    const found = connection!;
    const key = found.key!;
    if (decision === "use") {
      return {
        ok: true,
        token: await openToken(userId, key, found.accessToken!, "access"),
        useUntil: githubTokenUseUntil(found.accessExpiresAt),
        login: found.login,
        githubUserId: found.githubUserId,
      };
    }
    const nonce = randomSecret();
    if (!(await ctx.runMutation(internal.githubTokens.beginRefresh, { userId, nonce }))) {
      if (step === WAIT_STEPS) break;
      await sleep(WAIT_STEP_MS);
      continue;
    }
    const outcome = await refreshHoldingLease(ctx, userId, nonce, key, found);
    if (outcome !== null) return outcome;
    // The lease ran out mid-refresh and another caller took over; read again.
  }
  return { ok: false, code: "github_unavailable", resetAt: null };
}

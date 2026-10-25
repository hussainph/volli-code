/**
 * A test-only module (mounted into convex-test by `github.test.ts`, never
 * deployed): exposes `mintGithubToken` as an action so tests can mint the
 * way the backend's own callers do.
 */

import { v } from "convex/values";

import { internalAction } from "../functions/_generated/server";
import { mintGithubToken, type GithubMint } from "../functions/githubTokens";

export const mint = internalAction({
  args: { userId: v.string() },
  handler: (ctx, { userId }): Promise<GithubMint> => mintGithubToken(ctx, userId),
});

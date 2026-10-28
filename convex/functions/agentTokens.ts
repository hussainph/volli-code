/**
 * Agent tokens: how a runner turns an agent's verified call into a backend
 * call that acts for the Session's owner, without the agent ever holding a
 * backend credential.
 *
 * `mint` is called by a RUNNER (with its runner token) for one Session it
 * claims. It answers a 15-minute ES256 JWT (`agent:<sessionId>`, issuer
 * `AGENT_TOKEN_ISSUER`) signed with the deployment's runner key; the runner
 * keeps it in memory and calls board and Session functions with it.
 * `lib/actorAuth.ts` resolves it to an `agent` Actor and re-checks the claim
 * on every call, so a claim that moves (or a removed runner) ends it before
 * it expires.
 *
 * A token is minted only when, at that moment:
 * - the Session exists (`unknown_session` before its runner's drain has
 *   landed its creation: transient);
 * - this runner holds its claim (`not_claimed` when no runner does or
 *   another one does);
 * - its owner is this runner's owner and an active Member of the Workspace
 *   its project is in now (`forbidden`);
 * - the runner is live and its owner's account active (`revoked`, from
 *   `requireRunner`).
 */

import { ConvexError, v } from "convex/values";

import {
  AGENT_TOKEN_TTL_MS,
  isActiveMember,
  type AgentTokenClaims,
  type AgentTokenErrorCode,
  type AgentTokenGrant,
  type SessionId,
  type TicketId,
  type UserId,
  type WorkspaceId,
} from "@volli/shared/cloud";

import { internal } from "./_generated/api";
import { action, internalQuery } from "./_generated/server";
import { findMembership, isShownProject } from "./lib/auth";
import { projectImporting } from "./lib/jobs";
import { requireRunner } from "./lib/runnerAuth";
import { runnerSigningKey, signAgentToken } from "./lib/runnerSecrets";

function refuse(code: AgentTokenErrorCode, message: string) {
  return new ConvexError({ code, message });
}

/** The claims a token may be minted with, or a typed refusal. Read by {@link mint}. */
export const authorizeMint = internalQuery({
  args: { sessionId: v.string() },
  handler: async (ctx, { sessionId }): Promise<{ sessionId: string; claims: AgentTokenClaims }> => {
    const caller = await requireRunner(ctx);
    const session = await ctx.db
      .query("sessions")
      .withIndex("by_uuid", (q) => q.eq("id", sessionId))
      .unique();
    if (
      session === null ||
      session.deletedAt !== null ||
      // A Session of a project still being imported does not exist yet for anyone.
      (await projectImporting(ctx, session.projectId))
    ) {
      throw refuse("unknown_session", "The backend has not accepted this session yet.");
    }
    const intake = await ctx.db
      .query("sessionIntake")
      .withIndex("by_session", (q) => q.eq("sessionId", sessionId))
      .unique();
    if (
      intake === null ||
      intake.state === "released" ||
      intake.claim.runnerId !== caller.runnerId
    ) {
      throw refuse("not_claimed", "This runner does not hold this session.");
    }
    if (session.ownerUserId !== caller.ownerUserId) {
      throw refuse("forbidden", "This session belongs to someone other than this runner's owner.");
    }
    const project = await ctx.db
      .query("projects")
      .withIndex("by_uuid", (q) => q.eq("id", session.projectId))
      .unique();
    const workspace =
      project === null || !isShownProject(project)
        ? null
        : await ctx.db
            .query("workspaces")
            .withIndex("by_uuid", (q) => q.eq("id", project.workspaceId))
            .unique();
    const membership =
      workspace === null || workspace.deletedAt !== null
        ? null
        : await findMembership(ctx, workspace.id, caller.ownerUserId);
    if (
      workspace === null ||
      !isActiveMember({ userId: caller.ownerUserId }, workspace.id as WorkspaceId, membership)
    ) {
      throw refuse("forbidden", "This session's owner is no longer a member of its workspace.");
    }
    return {
      sessionId,
      claims: {
        own: caller.ownerUserId as UserId,
        rnr: caller.runnerId,
        gen: intake.claim.generation,
        tkt: (session.ticketId ?? null) as TicketId | null,
      },
    };
  },
});

/**
 * An Agent token for one Session this runner claims. Runner-only. Mint lazily
 * on an agent's first backend verb and again at two thirds of its life
 * (on `serverTime`); drop it on `fenced` or `revoked`.
 */
export const mint = action({
  args: { sessionId: v.string() },
  handler: async (ctx, { sessionId }): Promise<AgentTokenGrant> => {
    const authorized = await ctx.runQuery(internal.agentTokens.authorizeMint, { sessionId });
    const signing = await runnerSigningKey();
    if (signing === null) {
      throw refuse("issuer_unconfigured", "This deployment cannot issue agent tokens.");
    }
    const serverTime = Date.now();
    const expiresAt = serverTime + AGENT_TOKEN_TTL_MS;
    const token = await signAgentToken(
      signing,
      authorized.sessionId as SessionId,
      authorized.claims,
      serverTime,
      expiresAt,
    );
    return { token, expiresAt, serverTime };
  },
});

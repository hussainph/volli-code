/**
 * Delivering team secrets to a runner: the resolved set for one claimed
 * Session (or one leased job), opened in memory and handed over.
 *
 * `deliver` is internal on purpose. It returns secret VALUES, so no client
 * may call it: the runner's authenticated door (the `/runner/secrets` HTTP
 * route, which authenticates the runner's own token and arrives with runner
 * sign-in) calls it with the runner id that token proves. Every check that
 * makes a set safe to hand over is here, not in the door:
 *
 * - the runner exists and is not revoked;
 * - it holds the claim: the Session's active intake claim names it, or the
 *   job is leased to it;
 * - a runner only runs its owner's work: the Session's owner is the runner's
 *   owner (`not_your_runner` otherwise), and the personal layers are that
 *   person's;
 * - the owner is still an active Member of the project's CURRENT Workspace;
 * - the owner's "don't inject secrets on this runner" preference
 *   (`runnerPrefs.injectSecrets`) withholds the whole set.
 *
 * The set is resolved by the shared resolver (precedence, then exposure for
 * the purpose) and returned in the `RunnerSecretSet` shape the runner parses
 * (`parseRunnerSecretSet` in `@volli/shared/cloud`). Values are never written
 * anywhere on the way: not to a row, a log or an audit entry.
 */

import { v } from "convex/values";

import {
  RUNNER_SECRET_SET_VERSION,
  SECRET_PURPOSES,
  isActiveMember,
  resolveSecretSet,
  type JobId,
  type ProjectId,
  type RunnerSecretEntry,
  type RunnerSecretSet,
  type SecretClaim,
  type SessionId,
  type UserId,
  type WorkspaceId,
} from "@volli/shared/cloud";

import { internal } from "./_generated/api";
import { internalAction, internalMutation, internalQuery } from "./_generated/server";
import type { QueryCtx } from "./_generated/server";
import { authError, findMembership } from "./lib/auth";
import { dataKeyContext, openValue, rootKeyProvider, valueContext } from "./lib/sealing";
import { layeredSecrets, liveProject, secretsError } from "./lib/secrets";
import { literals } from "./lib/validators";

const claimArg = v.union(
  v.object({ kind: v.literal("session"), sessionId: v.string() }),
  v.object({ kind: v.literal("job"), jobId: v.string() }),
);
const purposeArg = literals(SECRET_PURPOSES);

/** `lastUsedAt` is refreshed at most this often, so Session starts do not churn list subscriptions. */
const LAST_USED_RESOLUTION_MS = 60 * 60 * 1000;

function notClaimed() {
  return secretsError("not_claimed", "This runner does not hold that claim.");
}

async function claimFacts(
  ctx: QueryCtx,
  runnerId: string,
  claim: SecretClaim,
): Promise<{ ownerUserId: UserId; projectId: ProjectId }> {
  const runner = await ctx.db
    .query("runners")
    .withIndex("by_uuid", (q) => q.eq("id", runnerId))
    .unique();
  if (runner === null) throw authError("not_found", "That runner does not exist.");
  if (runner.status === "revoked") {
    throw secretsError("runner_revoked", "This runner has been revoked.");
  }
  let sessionId: string | null;
  let projectId: string | null = null;
  if (claim.kind === "session") {
    const intake = await ctx.db
      .query("sessionIntake")
      .withIndex("by_session", (q) => q.eq("sessionId", claim.sessionId))
      .unique();
    if (intake === null || intake.claim.runnerId !== runnerId || intake.state !== "active") {
      throw notClaimed();
    }
    sessionId = claim.sessionId;
  } else {
    const job = await ctx.db
      .query("runnerJobs")
      .withIndex("by_uuid", (q) => q.eq("id", claim.jobId))
      .unique();
    if (
      job === null ||
      job.runnerId !== runnerId ||
      job.status !== "leased" ||
      job.lease === null ||
      job.lease.expiresAt <= Date.now()
    ) {
      throw notClaimed();
    }
    sessionId = job.sessionId;
    projectId = job.projectId;
  }
  if (sessionId !== null) {
    const session = await ctx.db
      .query("sessions")
      .withIndex("by_uuid", (q) => q.eq("id", sessionId))
      .unique();
    if (session === null || session.deletedAt !== null) {
      throw authError("not_found", "That session does not exist.");
    }
    if (session.ownerUserId !== runner.ownerUserId) {
      throw secretsError("not_your_runner", "A runner only runs its owner's sessions.");
    }
    projectId = session.projectId;
  }
  // A Session claim always names a Session, so a project is known by here.
  return { ownerUserId: runner.ownerUserId as UserId, projectId: projectId! as ProjectId };
}

/** The resolved, still-sealed set for a claim. Internal: `deliver` opens it. */
export const resolve = internalQuery({
  args: { runnerId: v.string(), claim: claimArg, purpose: purposeArg },
  handler: async (ctx, args) => {
    const claim = args.claim as SecretClaim;
    const { ownerUserId, projectId } = await claimFacts(ctx, args.runnerId, claim);
    const project = await liveProject(ctx, projectId);
    if (project === null) throw authError("not_found", "That project does not exist.");
    const workspaceId = project.workspaceId as WorkspaceId;
    const membership = await findMembership(ctx, workspaceId, ownerUserId);
    if (!isActiveMember({ userId: ownerUserId }, workspaceId, membership)) {
      throw authError("not_a_member", "The session's owner is not a member of this workspace.");
    }
    const prefs = await ctx.db
      .query("runnerPrefs")
      .withIndex("by_runner", (q) => q.eq("runnerId", args.runnerId))
      .unique();
    if (prefs !== null && !prefs.injectSecrets) {
      return { withheld: "runner_opt_out" as const, entries: [], keys: [] };
    }
    const winners = resolveSecretSet(
      await layeredSecrets(ctx, { userId: ownerUserId, projectId, workspaceId }),
      args.purpose,
    );
    const keyIds = new Set(winners.flatMap((row) => (row.sealed === null ? [] : [row.sealed.kid])));
    const keys = await Promise.all(
      [...keyIds].map(async (id) => {
        const key = await ctx.db
          .query("secretKeys")
          .withIndex("by_uuid", (q) => q.eq("id", id))
          .unique();
        if (key === null) throw new Error(`Secret key ${id} is missing.`);
        return { id: key.id, owner: key.owner, rootKid: key.rootKid, wrapped: key.wrapped };
      }),
    );
    return {
      withheld: null,
      entries: winners.map((row) => ({
        secretId: row.id,
        scopeKey: row.scopeKey,
        name: row.name,
        kind: row.kind,
        plain: row.plain,
        sealed: row.sealed,
      })),
      keys,
    };
  },
});

/** Records use, at most once per {@link LAST_USED_RESOLUTION_MS} per secret. */
export const markUsed = internalMutation({
  args: { secretIds: v.array(v.string()) },
  handler: async (ctx, args) => {
    const now = Date.now();
    for (const id of args.secretIds) {
      const row = await ctx.db
        .query("secrets")
        .withIndex("by_uuid", (q) => q.eq("id", id))
        .unique();
      if (row === null) continue;
      if (row.lastUsedAt !== null && now - row.lastUsedAt < LAST_USED_RESOLUTION_MS) continue;
      await ctx.db.patch(row._id, { lastUsedAt: now });
    }
  },
});

/**
 * The opened set for a claim. Internal: only the runner's authenticated door
 * calls it, with the runner id its token proves (see the module comment).
 */
export const deliver = internalAction({
  args: { runnerId: v.string(), claim: claimArg, purpose: purposeArg },
  handler: async (ctx, args): Promise<RunnerSecretSet> => {
    const resolved = await ctx.runQuery(internal.secretsDelivery.resolve, args);
    const claim: SecretClaim =
      args.claim.kind === "session"
        ? { kind: "session", sessionId: args.claim.sessionId as SessionId }
        : { kind: "job", jobId: args.claim.jobId as JobId };
    const entries: RunnerSecretEntry[] = [];
    if (resolved.entries.length > 0) {
      const sealedAny = resolved.entries.some((entry) => entry.sealed !== null);
      // Env vars alone need no root key.
      const provider = sealedAny ? rootKeyProvider() : null;
      const dataKeys = new Map<string, Uint8Array>();
      for (const key of resolved.keys) {
        dataKeys.set(
          key.id,
          await provider!.unwrap(key.rootKid, key.wrapped, dataKeyContext(key.id, key.owner)),
        );
      }
      for (const entry of resolved.entries) {
        const value =
          entry.sealed === null
            ? entry.plain!
            : await openValue(
                dataKeys.get(entry.sealed.kid)!,
                entry.sealed.ciphertext,
                valueContext(entry.secretId, entry.scopeKey, entry.name),
              );
        entries.push({ name: entry.name, kind: entry.kind, value });
      }
      await ctx.runMutation(internal.secretsDelivery.markUsed, {
        secretIds: resolved.entries.map((entry) => entry.secretId),
      });
    }
    return {
      version: RUNNER_SECRET_SET_VERSION,
      claim,
      purpose: args.purpose,
      withheld: resolved.withheld,
      entries,
    };
  },
});

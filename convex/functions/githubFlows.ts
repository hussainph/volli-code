/**
 * The browser's return from GitHub, the database half: what the Convex
 * site's callback and setup routes (`githubHttp.ts`) read and write to
 * finish a flow. Each flow finishes once (`done` or `failed`); a replayed
 * URL finds it used.
 */

import type { GenericDatabaseWriter } from "convex/server";
import { v } from "convex/values";

import { GITHUB_ERROR_CODES, type GithubErrorCode } from "@volli/shared/cloud";

import type { DataModel, Doc } from "./_generated/dataModel.js";
import { internalMutation, internalQuery } from "./_generated/server.js";
import { installationFacts, upsertInstallation } from "./lib/github/installations";
import { readPersonKey, storePersonKey } from "./lib/github/seal";
import { literals, sealed } from "./lib/validators";

/** Why a flow cannot be finished now, or `null` when it can. */
export function flowProblem(
  flow: Pick<Doc<"githubFlows">, "status" | "purpose" | "stateHash" | "expiresAt"> | null,
  expected: { purpose: "connect" | "install"; stateHash: string; now: number },
): GithubErrorCode | null {
  if (flow === null || flow.purpose !== expected.purpose || flow.stateHash !== expected.stateHash) {
    return "flow_not_found";
  }
  if (flow.status === "done" || flow.status === "failed") return "flow_used";
  if (expected.now >= flow.expiresAt) return "flow_expired";
  return null;
}

/** A flow as the browser routes need it. Internal only: it carries the PKCE verifier. */
export const forBrowser = internalQuery({
  args: { flowId: v.string() },
  handler: async (ctx, { flowId }) => {
    const flow = await ctx.db
      .query("githubFlows")
      .withIndex("by_uuid", (q) => q.eq("id", flowId))
      .unique();
    if (flow === null) return null;
    const user = await ctx.db
      .query("users")
      .withIndex("by_uuid", (q) => q.eq("id", flow.userId))
      .unique();
    return {
      // Who the connect page names, so a person never confirms someone else's
      // flow: a verified email only, never a name the account chose.
      verifiedEmail: user?.emailVerified === true ? user.primaryEmail : null,
      userId: flow.userId,
      purpose: flow.purpose,
      status: flow.status,
      stateHash: flow.stateHash,
      codeVerifier: flow.codeVerifier,
      expiresAt: flow.expiresAt,
      personKey: await readPersonKey(ctx.db, flow.userId),
    };
  },
});

async function userActive(db: GenericDatabaseWriter<DataModel>, userId: string): Promise<boolean> {
  const user = await db
    .query("users")
    .withIndex("by_uuid", (q) => q.eq("id", userId))
    .unique();
  return user?.status === "active";
}

async function openFlow(ctx: { db: GenericDatabaseWriter<DataModel> }, flowId: string) {
  const flow = await ctx.db
    .query("githubFlows")
    .withIndex("by_uuid", (q) => q.eq("id", flowId))
    .unique();
  if (flow === null || flow.status === "done" || flow.status === "failed") return null;
  return flow;
}

/** How long one confirm holds a connect flow while it exchanges the code. */
const CLAIM_MS = 60 * 1000;

function heldByOther(flow: Doc<"githubFlows">, nonce: string | null, now: number): boolean {
  return flow.claim !== null && flow.claim.until > now && flow.claim.nonce !== nonce;
}

/**
 * Ends a flow as failed, unless another request holds it (`nonce` names the
 * caller's own claim, if it has one).
 */
export const fail = internalMutation({
  args: { flowId: v.string(), code: literals(GITHUB_ERROR_CODES), nonce: v.optional(v.string()) },
  handler: async (ctx, { flowId, code, nonce }): Promise<void> => {
    const flow = await openFlow(ctx, flowId);
    if (flow === null || heldByOther(flow, nonce ?? null, Date.now())) return;
    await ctx.db.patch(flow._id, { status: "failed", error: code, claim: null });
  },
});

/**
 * Takes a connect flow for one confirm, so only one request exchanges its
 * code. `busy` while another holds it.
 */
export const claim = internalMutation({
  args: { flowId: v.string(), stateHash: v.string(), nonce: v.string() },
  handler: async (ctx, args): Promise<GithubErrorCode | "busy" | null> => {
    const now = Date.now();
    const flow = await ctx.db
      .query("githubFlows")
      .withIndex("by_uuid", (q) => q.eq("id", args.flowId))
      .unique();
    const problem = flowProblem(flow, { purpose: "connect", stateHash: args.stateHash, now });
    if (problem !== null) return problem;
    if (heldByOther(flow!, args.nonce, now)) return "busy";
    await ctx.db.patch(flow!._id, { claim: { nonce: args.nonce, until: now + CLAIM_MS } });
    return null;
  },
});

/** How long a request to an organization's owners waits for their approval. */
const GITHUB_REQUEST_TTL_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * An organization member asked an owner to install (or cancelled). The
 * installation's webhook completes it when an owner approves, matched by the
 * requester's GitHub id; an unanswered request expires.
 */
export const markRequested = internalMutation({
  args: { flowId: v.string() },
  handler: async (ctx, { flowId }): Promise<void> => {
    const flow = await openFlow(ctx, flowId);
    if (flow !== null && flow.purpose === "install" && flow.status === "pending") {
      await ctx.db.patch(flow._id, {
        status: "requested",
        expiresAt: Date.now() + GITHUB_REQUEST_TTL_MS,
      });
    }
  },
});

export type CompleteConnectResult =
  | { ok: true }
  | { ok: false; code: GithubErrorCode }
  /** Another write minted the person's data key first: seal again and retry. */
  | { ok: false; code: null };

/**
 * Finishes a connect: one Volli account per GitHub account, the sealed
 * pair stored, the person's `externalAccounts` link, the flow done.
 */
export const completeConnect = internalMutation({
  args: {
    flowId: v.string(),
    stateHash: v.string(),
    nonce: v.string(),
    githubUserId: v.string(),
    login: v.string(),
    name: v.union(v.string(), v.null()),
    emails: v.array(
      v.object({
        email: v.string(),
        primary: v.boolean(),
        verified: v.boolean(),
        visibility: v.union(v.string(), v.null()),
      }),
    ),
    accessToken: sealed,
    refreshToken: sealed,
    accessExpiresAt: v.number(),
    refreshExpiresAt: v.number(),
    newKey: v.union(
      v.object({ id: v.string(), owner: v.string(), rootKid: v.string(), wrapped: v.bytes() }),
      v.null(),
    ),
  },
  handler: async (ctx, args): Promise<CompleteConnectResult> => {
    const now = Date.now();
    const flow = await ctx.db
      .query("githubFlows")
      .withIndex("by_uuid", (q) => q.eq("id", args.flowId))
      .unique();
    const problem = flowProblem(flow, { purpose: "connect", stateHash: args.stateHash, now });
    if (problem !== null) return { ok: false, code: problem };
    if (flow!.claim?.nonce !== args.nonce) return { ok: false, code: "flow_used" };
    const { userId } = flow!;
    // An account whose deletion started meanwhile stores no new tokens.
    if (!(await userActive(ctx.db, userId))) return { ok: false, code: "flow_not_found" };
    const refuse = async (code: GithubErrorCode): Promise<CompleteConnectResult> => {
      await ctx.db.patch(flow!._id, { status: "failed", error: code, claim: null });
      return { ok: false, code };
    };
    const holder = await ctx.db
      .query("githubConnections")
      .withIndex("by_github_user", (q) => q.eq("githubUserId", args.githubUserId))
      .collect();
    const linked = await ctx.db
      .query("externalAccounts")
      .withIndex("by_provider_user", (q) =>
        q.eq("provider", "github").eq("providerUserId", args.githubUserId),
      )
      .collect();
    if ([...holder, ...linked].some((row) => row.userId !== userId)) {
      return refuse("account_already_linked");
    }
    if (!(await storePersonKey(ctx.db, userId, args.accessToken.kid, args.newKey))) {
      return { ok: false, code: null };
    }
    const fields = {
      githubUserId: args.githubUserId,
      accessToken: args.accessToken,
      refreshToken: args.refreshToken,
      accessExpiresAt: args.accessExpiresAt,
      refreshExpiresAt: args.refreshExpiresAt,
      revokedAt: null,
      login: args.login,
      name: args.name,
      emails: args.emails,
      status: "active" as const,
      refreshLease: null,
      updatedAt: now,
    };
    const existing = await ctx.db
      .query("githubConnections")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .unique();
    if (existing === null) await ctx.db.insert("githubConnections", { userId, ...fields });
    else await ctx.db.patch(existing._id, fields);
    // The person's GitHub link, replacing one to another GitHub account.
    const accounts = await ctx.db
      .query("externalAccounts")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect();
    for (const account of accounts) {
      if (account.provider === "github" && account.providerUserId !== args.githubUserId) {
        await ctx.db.delete(account._id);
      }
    }
    const primary = args.emails.find((email) => email.primary)?.email ?? null;
    const own = linked.find((row) => row.userId === userId);
    if (own === undefined) {
      await ctx.db.insert("externalAccounts", {
        userId,
        provider: "github",
        providerUserId: args.githubUserId,
        login: args.login,
        email: primary,
        linkedAt: now,
      });
    } else {
      await ctx.db.patch(own._id, { login: args.login, email: primary });
    }
    await ctx.db.patch(flow!._id, { status: "done", accountLogin: args.login, claim: null });
    return { ok: true };
  },
});

/** Finishes an install the person's own token proved they can see. */
export const completeInstall = internalMutation({
  args: { flowId: v.string(), stateHash: v.string(), installation: installationFacts },
  handler: async (ctx, args): Promise<GithubErrorCode | null> => {
    const now = Date.now();
    const flow = await ctx.db
      .query("githubFlows")
      .withIndex("by_uuid", (q) => q.eq("id", args.flowId))
      .unique();
    const problem = flowProblem(flow, { purpose: "install", stateHash: args.stateHash, now });
    if (problem !== null) return problem;
    if (!(await userActive(ctx.db, flow!.userId))) return "flow_not_found";
    await upsertInstallation(ctx.db, args.installation, { installedByUserId: flow!.userId, now });
    await ctx.db.patch(flow!._id, {
      status: "done",
      installationId: args.installation.installationId,
      accountLogin: args.installation.accountLogin,
    });
    return null;
  },
});

/**
 * The Volli GitHub App, the person's side: connect GitHub, install the App
 * on an account, see the installations a Workspace's projects use, and
 * disconnect.
 *
 * Every browser round trip is a `githubFlows` row the client mints the id
 * of. `beginConnect` / `beginInstall` (actions, for real randomness) store
 * the flow and answer the URL to open; GitHub sends the browser back to the
 * Convex site (`githubHttp.ts`), which finishes the flow; the client follows
 * its own row with {@link flow}. No deep link or loopback server is involved.
 *
 * Installations are global (one per GitHub account, serving every
 * Workspace). Tokens live in `githubConnections`, sealed; see
 * `githubTokens.ts`.
 */

import { v } from "convex/values";

import {
  GITHUB_FLOW_TTL_MS,
  GITHUB_HTTP_PATHS,
  formatFlowState,
  parseId,
  type GithubConnectionStatus,
  type GithubErrorCode,
  type GithubFlowPurpose,
  type GithubFlowStatus,
} from "@volli/shared/cloud";

import { internal } from "./_generated/api.js";
import type { Doc } from "./_generated/dataModel.js";
import {
  action,
  internalAction,
  internalMutation,
  internalQuery,
  query,
  type ActionCtx,
} from "./_generated/server.js";
import { mintGithubToken } from "./githubTokens";
import { requireIdentity, requireMember, requireViewer } from "./lib/auth";
import { GithubApiError, githubClient } from "./lib/github/client";
import { githubError, readGithubConfig, requireGithubConfig } from "./lib/github/config";
import { randomSecret, sha256Base64Url } from "./lib/github/crypto";
import { literals, nullable } from "./lib/validators";

// ── reads ──────────────────────────────────────────────────────────────────

export type GithubConfigSummary =
  | { configured: false }
  | { configured: true; slug: string; webUrl: string };

/** Whether this deployment has a GitHub App, and which. */
export const config = query({
  args: {},
  handler: async (ctx): Promise<GithubConfigSummary> => {
    await requireViewer(ctx);
    const app = readGithubConfig();
    return app === null
      ? { configured: false }
      : { configured: true, slug: app.slug, webUrl: app.webUrl };
  },
});

export type GithubConnectionSummary = {
  status: GithubConnectionStatus;
  githubUserId: string;
  login: string;
  name: string | null;
  updatedAt: number;
};

/** The caller's GitHub connection, never its tokens; `null` when not connected. */
export const connection = query({
  args: {},
  handler: async (ctx): Promise<GithubConnectionSummary | null> => {
    const viewer = await requireViewer(ctx);
    const row = await ctx.db
      .query("githubConnections")
      .withIndex("by_user", (q) => q.eq("userId", viewer.userId))
      .unique();
    if (row === null) return null;
    // A refresh token past its six months reads as needing a reconnect before
    // any mint has found out.
    const expired = row.status === "active" && Date.now() >= row.refreshExpiresAt;
    return {
      status: expired ? "needs_reconnect" : row.status,
      githubUserId: row.githubUserId,
      login: row.login,
      name: row.name,
      updatedAt: row.updatedAt,
    };
  },
});

export type GithubFlowSummary = {
  purpose: GithubFlowPurpose;
  status: GithubFlowStatus;
  error: GithubErrorCode | null;
  installationId: string | null;
  accountLogin: string | null;
  expiresAt: number;
};

/** One of the caller's own flows; `null` for anyone else's or an unknown id. */
export const flow = query({
  args: { flowId: v.string() },
  handler: async (ctx, { flowId }): Promise<GithubFlowSummary | null> => {
    const viewer = await requireViewer(ctx);
    const row = await ctx.db
      .query("githubFlows")
      .withIndex("by_uuid", (q) => q.eq("id", flowId))
      .unique();
    if (row === null || row.userId !== viewer.userId) return null;
    return {
      purpose: row.purpose,
      status: row.status,
      error: row.error,
      installationId: row.installationId,
      accountLogin: row.accountLogin,
      expiresAt: row.expiresAt,
    };
  },
});

// ── starting a flow ────────────────────────────────────────────────────────

/** Stores a new flow for the caller. The id is the client's; reusing one is `flow_used`. */
export const createFlow = internalMutation({
  args: {
    flowId: v.string(),
    purpose: literals(["connect", "install"]),
    workspaceId: nullable(v.string()),
    stateHash: v.string(),
    codeVerifier: nullable(v.string()),
  },
  handler: async (ctx, args): Promise<void> => {
    const viewer =
      args.workspaceId === null
        ? await requireViewer(ctx)
        : (await requireMember(ctx, args.workspaceId)).viewer;
    const flowId = parseId("githubFlow", args.flowId);
    const taken = await ctx.db
      .query("githubFlows")
      .withIndex("by_uuid", (q) => q.eq("id", flowId))
      .unique();
    if (taken !== null) throw githubError("flow_used", "Start again from Volli.");
    if (args.purpose === "install") {
      const linked = await ctx.db
        .query("githubConnections")
        .withIndex("by_user", (q) => q.eq("userId", viewer.userId))
        .unique();
      if (linked === null || linked.status === "revoked") {
        throw githubError("not_connected", "Connect GitHub first.");
      }
      if (linked.status === "needs_reconnect") {
        throw githubError("needs_reconnect", "Reconnect GitHub first.");
      }
    }
    const now = Date.now();
    await ctx.db.insert("githubFlows", {
      id: flowId,
      userId: viewer.userId,
      purpose: args.purpose,
      workspaceId: args.workspaceId,
      stateHash: args.stateHash,
      codeVerifier: args.codeVerifier,
      status: "pending",
      error: null,
      installationId: null,
      accountLogin: null,
      claim: null,
      createdAt: now,
      expiresAt: now + GITHUB_FLOW_TTL_MS,
    });
  },
});

/**
 * Starts connecting the caller's GitHub account: answers the authorize URL
 * to open in the browser (web flow with PKCE). When sign-in already
 * authorized the App, GitHub returns at once without a consent screen.
 */
export const beginConnect = action({
  args: { flowId: v.string() },
  handler: async (ctx, { flowId }): Promise<{ url: string }> => {
    await requireIdentity(ctx);
    const app = requireGithubConfig();
    const secret = randomSecret();
    const verifier = randomSecret();
    await ctx.runMutation(internal.github.createFlow, {
      flowId,
      purpose: "connect",
      workspaceId: null,
      stateHash: await sha256Base64Url(secret),
      codeVerifier: verifier,
    });
    const url = new URL(`${app.webUrl}/login/oauth/authorize`);
    url.searchParams.set("client_id", app.clientId);
    url.searchParams.set("redirect_uri", `${app.siteUrl}${GITHUB_HTTP_PATHS.oauthCallback}`);
    url.searchParams.set("state", formatFlowState(flowId, secret));
    url.searchParams.set("code_challenge", await sha256Base64Url(verifier));
    url.searchParams.set("code_challenge_method", "S256");
    return { url: url.toString() };
  },
});

/**
 * Starts installing the App: answers GitHub's account picker, or the
 * permissions page for one known account (`targetId`, GitHub's numeric id).
 * Needs a connection, which verifies the installation when GitHub returns.
 */
export const beginInstall = action({
  args: {
    flowId: v.string(),
    /** The Workspace the install was started from, when one was (its membership is checked). */
    workspaceId: v.optional(v.string()),
    targetId: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<{ url: string }> => {
    await requireIdentity(ctx);
    const app = requireGithubConfig();
    if (args.targetId !== undefined && !/^[1-9][0-9]{0,19}$/u.test(args.targetId)) {
      throw githubError("flow_not_found", "That GitHub account id is not valid.");
    }
    const secret = randomSecret();
    await ctx.runMutation(internal.github.createFlow, {
      flowId: args.flowId,
      purpose: "install",
      workspaceId: args.workspaceId ?? null,
      stateHash: await sha256Base64Url(secret),
      codeVerifier: null,
    });
    const base = `${app.webUrl}/apps/${encodeURIComponent(app.slug)}/installations`;
    const url = new URL(
      args.targetId === undefined ? `${base}/select_target` : `${base}/new/permissions`,
    );
    if (args.targetId !== undefined) url.searchParams.set("target_id", args.targetId);
    url.searchParams.set("state", formatFlowState(args.flowId, secret));
    return { url: url.toString() };
  },
});

// ── installations ──────────────────────────────────────────────────────────

/** What the installations list needs from the database. */
export const installationsContext = internalQuery({
  args: { workspaceId: v.optional(v.string()) },
  handler: async (ctx, { workspaceId }) => {
    if (workspaceId === undefined) {
      return { userId: (await requireViewer(ctx)).userId, used: [] };
    }
    const { viewer } = await requireMember(ctx, workspaceId);
    const live = await ctx.db
      .query("projects")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId).eq("deletedAt", null))
      .collect();
    const used = new Map<string, number>();
    for (const project of live) {
      const repos = await ctx.db
        .query("projectRepos")
        .withIndex("by_project", (q) => q.eq("projectId", project.id))
        .collect();
      const ids = new Set(
        repos.flatMap((repo) => (repo.installationId === null ? [] : [repo.installationId])),
      );
      for (const id of ids) used.set(id, (used.get(id) ?? 0) + 1);
    }
    return {
      userId: viewer.userId,
      used: [...used].map(([id, count]) => ({ id, projects: count })),
    };
  },
});

export const installationRows = internalQuery({
  args: { installationIds: v.array(v.string()) },
  handler: async (ctx, { installationIds }) => {
    const rows: Doc<"githubInstallations">[] = [];
    for (const installationId of new Set(installationIds)) {
      const row = await ctx.db
        .query("githubInstallations")
        .withIndex("by_installation", (q) => q.eq("installationId", installationId))
        .unique();
      if (row !== null) rows.push(row);
    }
    return rows.map((row) => ({
      installationId: row.installationId,
      accountId: row.accountId,
      accountLogin: row.accountLogin,
      accountType: row.accountType,
      repositorySelection: row.repositorySelection,
      suspended: row.suspendedAt !== null,
      deleted: row.deletedAt !== null,
    }));
  },
});

export type GithubInstallationSummary = {
  installationId: string;
  accountId: string;
  accountLogin: string;
  accountType: "user" | "org";
  repositorySelection: "all" | "selected";
  suspended: boolean;
  /** How many of this Workspace's projects use a repository through it. */
  projects: number;
  /** Whether the caller's own GitHub account can reach it. */
  visible: boolean;
  /** Where its repository selection is changed on GitHub. */
  configureUrl: string;
};

export type GithubInstallationsResult = {
  /** The caller's connection, as far as the list could tell. */
  connection: "active" | GithubErrorCode;
  installations: GithubInstallationSummary[];
};

function configureUrl(
  webUrl: string,
  row: { accountType: string; accountLogin: string; installationId: string },
) {
  return row.accountType === "org"
    ? `${webUrl}/organizations/${encodeURIComponent(row.accountLogin)}/settings/installations/${row.installationId}`
    : `${webUrl}/settings/installations/${row.installationId}`;
}

/**
 * The GitHub accounts a Workspace's projects use (when `workspaceId` names
 * one), and every installation the caller can reach (read live with their
 * token, which also records any installation a missed webhook left out).
 */
export const installations = action({
  args: { workspaceId: v.optional(v.string()) },
  handler: async (ctx, { workspaceId }): Promise<GithubInstallationsResult> => {
    const context = await ctx.runQuery(internal.github.installationsContext, { workspaceId });
    const app = requireGithubConfig();
    const mint = await mintGithubToken(ctx, context.userId);
    const visible = new Set<string>();
    let status: GithubInstallationsResult["connection"] = "active";
    if (mint.ok) {
      try {
        const facts = await githubClient(app).userInstallations(mint.token);
        await ctx.runMutation(internal.githubIngest.recordInstallations, {
          installations: facts,
          installedByUserId: null,
        });
        for (const fact of facts) visible.add(fact.installationId);
      } catch (error) {
        status =
          error instanceof GithubApiError && error.kind === "rate_limited"
            ? "github_rate_limited"
            : "github_unavailable";
      }
    } else {
      status = mint.code;
    }
    const used = new Map(context.used.map((entry) => [entry.id, entry.projects]));
    const rows = await ctx.runQuery(internal.github.installationRows, {
      installationIds: [...used.keys(), ...visible],
    });
    return {
      connection: status,
      installations: rows
        .filter((row) => !row.deleted)
        .map((row) => ({
          installationId: row.installationId,
          accountId: row.accountId,
          accountLogin: row.accountLogin,
          accountType: row.accountType,
          repositorySelection: row.repositorySelection,
          suspended: row.suspended,
          projects: used.get(row.installationId) ?? 0,
          visible: visible.has(row.installationId),
          configureUrl: configureUrl(app.webUrl, row),
        }))
        .toSorted((a, b) => a.accountLogin.localeCompare(b.accountLogin)),
    };
  },
});

// ── disconnecting ──────────────────────────────────────────────────────────

/** Deletes the person's connection and its sealed tokens. */
export const forgetConnection = internalMutation({
  args: { userId: v.string() },
  handler: async (ctx, { userId }): Promise<void> => {
    const row = await ctx.db
      .query("githubConnections")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .unique();
    if (row !== null) await ctx.db.delete(row._id);
    const linked = await ctx.db
      .query("externalAccounts")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect();
    for (const account of linked) {
      if (account.provider === "github") await ctx.db.delete(account._id);
    }
  },
});

export const viewerId = internalQuery({
  args: {},
  handler: async (ctx): Promise<string> => (await requireViewer(ctx)).userId,
});

/**
 * Ends the person's authorization of the App on GitHub (every token it
 * issued, on every runner) and forgets the connection. `github_unavailable`
 * keeps the connection so the person can try again.
 */
async function revokeGithub(ctx: ActionCtx, userId: string): Promise<void> {
  const app = readGithubConfig();
  const mint = await mintGithubToken(ctx, userId);
  if (app !== null && mint.ok) {
    try {
      // A grant GitHub no longer has counts as revoked (`deleteGrant`).
      await githubClient(app).deleteGrant(mint.token);
    } catch {
      throw githubError("github_unavailable", "GitHub is unavailable. Try again.");
    }
  } else if (
    !mint.ok &&
    (mint.code === "github_unavailable" || mint.code === "github_rate_limited")
  ) {
    throw githubError(mint.code, "GitHub is unavailable. Try again.");
  }
  await ctx.runMutation(internal.github.forgetConnection, { userId });
}

/** Disconnect GitHub (Settings → Account). */
export const disconnect = action({
  args: {},
  handler: async (ctx): Promise<null> => {
    const userId = await ctx.runQuery(internal.github.viewerId, {});
    await revokeGithub(ctx, userId);
    return null;
  },
});

/**
 * Account deletion's revoke (scheduled by `accounts.requestDeletion`). If
 * GitHub is unavailable the tokens are still forgotten: the account is
 * going, and the person can revoke the App on GitHub themselves.
 */
export const revokeForUser = internalAction({
  args: { userId: v.string() },
  handler: async (ctx, { userId }): Promise<void> => {
    try {
      await revokeGithub(ctx, userId);
    } catch (error) {
      console.warn(`github: revoking for a deleted account failed: ${(error as Error).message}`);
      await ctx.runMutation(internal.github.forgetConnection, { userId });
    }
  },
});

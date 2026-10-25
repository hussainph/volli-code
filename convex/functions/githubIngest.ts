/**
 * GitHub's side: webhook deliveries applied once, and the reconciles they
 * trigger.
 *
 * {@link ingest} is the one mutation a delivery reaches. It records the
 * delivery id and applies the effect in the same transaction, so a
 * redelivery or a duplicate is a no-op. Installation and repository events
 * are nudges: the effect schedules a reconcile that reads the current state
 * from the API ({@link reconcileInstallation}, {@link reconcileRepo}), so
 * deliveries may arrive in any order. GitHub does not retry a failed
 * delivery, so an hourly {@link sweep} redelivers what never arrived and a
 * daily {@link reconcileAll} catches installations removed while deliveries
 * were missed.
 */

import { v } from "convex/values";

import {
  GITHUB_DELIVERY_TTL_MS,
  decideRepoAccess,
  type GithubDeliveryOutcome,
  type GithubEvent,
} from "@volli/shared/cloud";

import { internal } from "./_generated/api.js";
import type { Doc } from "./_generated/dataModel.js";
import {
  internalAction,
  internalMutation,
  internalQuery,
  type MutationCtx,
} from "./_generated/server.js";
import { mintGithubToken } from "./githubTokens";
import { GithubApiError, githubClient, type GithubRepository } from "./lib/github/client";
import { readGithubConfig } from "./lib/github/config";
import { appJwt } from "./lib/github/crypto";
import {
  findInstallation,
  installationFacts,
  setInstallationRepoAccess,
  upsertInstallation,
} from "./lib/github/installations";
import { json, nullable } from "./lib/validators";

/** How many expired rows one purge removes before it reschedules itself. */
const GITHUB_PURGE_BATCH = 256;
/** How far back the sweep looks for deliveries that failed. */
const GITHUB_SWEEP_WINDOW_MS = 24 * 60 * 60 * 1000;
/** Flows stay readable this long past their expiry, so a client still sees how one ended. */
const FLOW_GRACE_MS = 60 * 60 * 1000;

// ── deliveries ─────────────────────────────────────────────────────────────

async function completeRequestedFlows(
  ctx: MutationCtx,
  requesterId: string,
  installation: Doc<"githubInstallations">,
): Promise<void> {
  const connection = await ctx.db
    .query("githubConnections")
    .withIndex("by_github_user", (q) => q.eq("githubUserId", requesterId))
    .first();
  if (connection === null) return;
  const flows = await ctx.db
    .query("githubFlows")
    .withIndex("by_user_status", (q) => q.eq("userId", connection.userId).eq("status", "requested"))
    .collect();
  for (const flow of flows) {
    await ctx.db.patch(flow._id, {
      status: "done",
      installationId: installation.installationId,
      accountLogin: installation.accountLogin,
    });
  }
}

async function apply(
  ctx: MutationCtx,
  event: GithubEvent,
  now: number,
): Promise<GithubDeliveryOutcome> {
  switch (event.kind) {
    case "installation": {
      const facts = event.installation;
      if (event.action === "deleted") {
        const row = await findInstallation(ctx.db, facts.installationId);
        if (row !== null) await ctx.db.patch(row._id, { deletedAt: now });
        await setInstallationRepoAccess(ctx.db, facts.installationId, "app_removed", now);
        return "applied";
      }
      const row = await upsertInstallation(ctx.db, facts, { installedByUserId: null, now });
      if (event.action === "suspend") {
        await setInstallationRepoAccess(ctx.db, facts.installationId, "app_removed", now);
      }
      if (event.action === "created" && event.requesterId !== null) {
        await completeRequestedFlows(ctx, event.requesterId, row);
      }
      await ctx.scheduler.runAfter(0, internal.githubIngest.reconcileInstallation, {
        installationId: facts.installationId,
      });
      return "applied";
    }
    case "installation_repositories": {
      await upsertInstallation(ctx.db, event.installation, { installedByUserId: null, now });
      await ctx.scheduler.runAfter(0, internal.githubIngest.reconcileInstallation, {
        installationId: event.installation.installationId,
      });
      return "applied";
    }
    case "installation_target": {
      // A nudge: two renames may arrive in either order; the API has the name.
      const row = await findInstallation(ctx.db, event.installationId);
      if (row === null) return "ignored";
      await ctx.scheduler.runAfter(0, internal.githubIngest.reconcileInstallation, {
        installationId: event.installationId,
      });
      return "applied";
    }
    case "repository": {
      const rows = await ctx.db
        .query("projectRepos")
        .withIndex("by_github_repo", (q) => q.eq("githubRepoId", event.githubRepoId))
        .collect();
      // Most repositories in an "All repositories" installation serve no project.
      if (rows.length === 0) return "ignored";
      if (event.action === "deleted") {
        for (const row of rows) {
          await ctx.db.patch(row._id, { githubAccess: "deleted", accessCheckedAt: now });
        }
        return "applied";
      }
      await ctx.scheduler.runAfter(0, internal.githubIngest.reconcileRepo, {
        githubRepoId: event.githubRepoId,
      });
      return "applied";
    }
    case "github_app_authorization": {
      // A nudge too: a revoke delivered late (or GitHub's echo of Volli's own
      // disconnect) must not end a connection made since. The check asks
      // GitHub whether the stored token still works.
      const connection = await ctx.db
        .query("githubConnections")
        .withIndex("by_github_user", (q) => q.eq("githubUserId", event.githubUserId))
        .first();
      if (connection === null) return "ignored";
      await ctx.scheduler.runAfter(0, internal.githubIngest.checkAuthorization, {
        userId: connection.userId,
      });
      return "applied";
    }
    case "ignored":
      return "ignored";
  }
}

function installationIdOf(event: GithubEvent): string | null {
  switch (event.kind) {
    case "installation":
    case "installation_repositories":
      return event.installation.installationId;
    case "installation_target":
      return event.installationId;
    case "repository":
      return event.installationId;
    default:
      return null;
  }
}

/**
 * Applies one verified delivery, once. `event` is `extractGithubEvent`'s
 * answer, made by the webhook route from a body whose signature it checked.
 */
export const ingest = internalMutation({
  args: { deliveryId: v.string(), name: v.string(), event: json },
  handler: async (ctx, args): Promise<"duplicate" | GithubDeliveryOutcome> => {
    const seen = await ctx.db
      .query("githubWebhookDeliveries")
      .withIndex("by_delivery", (q) => q.eq("deliveryId", args.deliveryId))
      .first();
    if (seen !== null) return "duplicate";
    const event = args.event as GithubEvent;
    const now = Date.now();
    const outcome = await apply(ctx, event, now);
    await ctx.db.insert("githubWebhookDeliveries", {
      deliveryId: args.deliveryId,
      event: args.name,
      action: event.action,
      installationId: installationIdOf(event),
      receivedAt: now,
      outcome,
    });
    return outcome;
  },
});

// ── reconciles ─────────────────────────────────────────────────────────────

/** Records installations read from GitHub (the person's visible ones, or the App's own list). */
export const recordInstallations = internalMutation({
  args: { installations: v.array(installationFacts), installedByUserId: nullable(v.string()) },
  handler: async (ctx, args): Promise<void> => {
    const now = Date.now();
    for (const facts of args.installations) {
      await upsertInstallation(ctx.db, facts, { installedByUserId: args.installedByUserId, now });
    }
  },
});

const repositoryArg = v.object({
  githubRepoId: v.string(),
  owner: v.string(),
  name: v.string(),
  defaultBranch: nullable(v.string()),
  archived: v.boolean(),
});

/**
 * Writes an installation's current state and its repositories' access.
 * `complete` is false when the repository list was cut at the page limit:
 * then a repository missing from it is not taken as removed.
 */
export const applyInstallation = internalMutation({
  args: {
    installationId: v.string(),
    installation: nullable(installationFacts),
    repositories: v.array(repositoryArg),
    complete: v.boolean(),
  },
  handler: async (ctx, args): Promise<void> => {
    const now = Date.now();
    if (args.installation === null) {
      const row = await findInstallation(ctx.db, args.installationId);
      if (row !== null && row.deletedAt === null) await ctx.db.patch(row._id, { deletedAt: now });
      await setInstallationRepoAccess(ctx.db, args.installationId, "app_removed", now);
      return;
    }
    const row = await upsertInstallation(ctx.db, args.installation, {
      installedByUserId: null,
      now,
    });
    await ctx.db.patch(row._id, { reconciledAt: now });
    if (args.installation.suspended) {
      await setInstallationRepoAccess(ctx.db, args.installationId, "app_removed", now);
      return;
    }
    const live = { deleted: false, suspended: args.installation.suspended };
    const byId = new Map(args.repositories.map((repo) => [repo.githubRepoId, repo]));
    const touched = new Set<string>();
    // Rows of repositories in the selection, including a reinstall's (a new installation id).
    for (const repo of args.repositories) {
      const rows = await ctx.db
        .query("projectRepos")
        .withIndex("by_github_repo", (q) => q.eq("githubRepoId", repo.githubRepoId))
        .collect();
      for (const project of rows) {
        touched.add(project.id);
        await ctx.db.patch(project._id, {
          installationId: args.installationId,
          owner: repo.owner,
          name: repo.name,
          defaultBranchCache: repo.defaultBranch,
          githubAccess: decideRepoAccess({
            installation: live,
            inInstallation: true,
            repository: { archived: repo.archived, deleted: false },
          }),
          accessCheckedAt: now,
        });
      }
    }
    if (!args.complete) return;
    // Rows this installation held whose repository has left the selection.
    const held = await ctx.db
      .query("projectRepos")
      .withIndex("by_installation", (q) => q.eq("installationId", args.installationId))
      .collect();
    for (const project of held) {
      if (touched.has(project.id) || byId.has(project.githubRepoId ?? "")) continue;
      await ctx.db.patch(project._id, {
        githubAccess: decideRepoAccess({
          installation: live,
          inInstallation: false,
          repository: { archived: false, deleted: false },
        }),
        accessCheckedAt: now,
      });
    }
  },
});

function logFailure(what: string, error: unknown): void {
  const detail = error instanceof GithubApiError ? `${error.kind} ${error.status}` : String(error);
  console.warn(`github: ${what} failed: ${detail}`);
}

/** Reads an installation and its repositories from GitHub and writes what it found. */
export const reconcileInstallation = internalAction({
  args: { installationId: v.string() },
  handler: async (ctx, { installationId }): Promise<void> => {
    const app = readGithubConfig();
    if (app === null) return;
    const client = githubClient(app);
    try {
      const jwt = await appJwt(app.clientId, app.privateKey, Date.now());
      const installation = await client.installation(jwt, installationId);
      let repositories: GithubRepository[] = [];
      let complete = true;
      if (installation !== null && !installation.suspended) {
        const token = await client.installationToken(jwt, installationId);
        const listed = await client.installationRepositories(token);
        repositories = listed.repositories;
        complete = listed.complete;
      } else {
        // A suspended installation cannot mint tokens; its rows keep their names.
        complete = false;
      }
      await ctx.runMutation(internal.githubIngest.applyInstallation, {
        installationId,
        installation,
        repositories,
        complete,
      });
    } catch (error) {
      logFailure(`reconciling installation ${installationId}`, error);
    }
  },
});

export const repoContext = internalQuery({
  args: { githubRepoId: v.string() },
  handler: async (ctx, { githubRepoId }) => {
    const rows = await ctx.db
      .query("projectRepos")
      .withIndex("by_github_repo", (q) => q.eq("githubRepoId", githubRepoId))
      .collect();
    return [
      ...new Set(rows.flatMap((row) => (row.installationId === null ? [] : [row.installationId]))),
    ];
  },
});

/** Writes one repository's current name, default branch and access to every row that uses it. */
export const applyRepo = internalMutation({
  args: {
    githubRepoId: v.string(),
    repository: nullable(repositoryArg),
    installationId: v.string(),
  },
  handler: async (ctx, args): Promise<void> => {
    const now = Date.now();
    const installation = await findInstallation(ctx.db, args.installationId);
    const rows = await ctx.db
      .query("projectRepos")
      .withIndex("by_github_repo", (q) => q.eq("githubRepoId", args.githubRepoId))
      .collect();
    for (const row of rows) {
      if (row.installationId !== args.installationId) continue;
      const repo = args.repository;
      await ctx.db.patch(row._id, {
        ...(repo === null
          ? {}
          : { owner: repo.owner, name: repo.name, defaultBranchCache: repo.defaultBranch }),
        githubAccess: decideRepoAccess({
          // The caller minted an installation token: GitHub has the installation
          // even when no row recorded it yet.
          installation: {
            deleted: installation?.deletedAt != null,
            suspended: installation?.suspendedAt != null,
          },
          inInstallation: repo !== null,
          repository: { archived: repo?.archived ?? false, deleted: false },
        }),
        accessCheckedAt: now,
      });
    }
  },
});

/**
 * Reads one repository through each installation that holds it for a
 * project. Rows are keyed by GitHub's repository id, which survives renames
 * and transfers, so two renames delivered out of order end at the API's name.
 */
export const reconcileRepo = internalAction({
  args: { githubRepoId: v.string() },
  handler: async (ctx, { githubRepoId }): Promise<void> => {
    const app = readGithubConfig();
    if (app === null) return;
    const client = githubClient(app);
    const installationIds = await ctx.runQuery(internal.githubIngest.repoContext, { githubRepoId });
    for (const installationId of installationIds) {
      try {
        const jwt = await appJwt(app.clientId, app.privateKey, Date.now());
        const token = await client.installationToken(jwt, installationId);
        // A repository the installation no longer reaches answers 404.
        const repository = await client.repository(token, githubRepoId);
        await ctx.runMutation(internal.githubIngest.applyRepo, {
          githubRepoId,
          repository,
          installationId,
        });
      } catch (error) {
        logFailure(`reconciling repository ${githubRepoId}`, error);
      }
    }
  },
});

/** Forgets a person's tokens once GitHub no longer honours their authorization. */
export const revokeConnection = internalMutation({
  args: { userId: v.string() },
  handler: async (ctx, { userId }): Promise<void> => {
    const connection = await ctx.db
      .query("githubConnections")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .unique();
    if (connection === null) return;
    const now = Date.now();
    await ctx.db.patch(connection._id, {
      accessToken: null,
      refreshToken: null,
      refreshLease: null,
      status: "revoked",
      revokedAt: now,
      updatedAt: now,
    });
  },
});

/**
 * After `github_app_authorization.revoked`: ends the connection only if its
 * token no longer works (a refused refresh marks it `needs_reconnect`
 * already). A connection made after the revoke keeps working.
 */
export const checkAuthorization = internalAction({
  args: { userId: v.string() },
  handler: async (ctx, { userId }): Promise<void> => {
    const app = readGithubConfig();
    if (app === null) return;
    const mint = await mintGithubToken(ctx, userId);
    if (!mint.ok) return;
    try {
      if (!(await githubClient(app).tokenValid(mint.token))) {
        await ctx.runMutation(internal.githubIngest.revokeConnection, { userId });
      }
    } catch (error) {
      logFailure("checking a revoked authorization", error);
    }
  },
});

// ── the sweeps ─────────────────────────────────────────────────────────────

export const knownDeliveries = internalQuery({
  args: { guids: v.array(v.string()) },
  handler: async (ctx, { guids }): Promise<string[]> => {
    const known: string[] = [];
    for (const guid of guids) {
      const row = await ctx.db
        .query("githubWebhookDeliveries")
        .withIndex("by_delivery", (q) => q.eq("deliveryId", guid))
        .first();
      if (row !== null) known.push(guid);
    }
    return known;
  },
});

/**
 * Redelivers webhook deliveries of the last day that never succeeded and
 * that Volli never recorded (GitHub does not retry on its own).
 */
export const sweep = internalAction({
  args: {},
  handler: async (ctx): Promise<{ redelivered: number }> => {
    const app = readGithubConfig();
    // A deployment without an App (owner setup pending) has nothing to sweep.
    if (app === null) return { redelivered: 0 };
    const client = githubClient(app);
    const jwt = await appJwt(app.clientId, app.privateKey, Date.now());
    const deliveries = await client.deliveries(jwt, Date.now() - GITHUB_SWEEP_WINDOW_MS);
    // A delivery's redeliveries share its guid; one OK attempt is enough.
    const latestFailed = new Map<string, string>();
    const succeeded = new Set<string>();
    for (const delivery of deliveries) {
      if (delivery.ok) succeeded.add(delivery.guid);
      else if (!latestFailed.has(delivery.guid)) latestFailed.set(delivery.guid, delivery.id);
    }
    const candidates = [...latestFailed.keys()].filter((guid) => !succeeded.has(guid));
    const known = new Set(
      candidates.length === 0
        ? []
        : await ctx.runQuery(internal.githubIngest.knownDeliveries, { guids: candidates }),
    );
    let redelivered = 0;
    for (const guid of candidates) {
      if (known.has(guid)) continue;
      try {
        await client.redeliver(jwt, latestFailed.get(guid)!);
        redelivered += 1;
      } catch (error) {
        logFailure(`redelivering ${guid}`, error);
      }
    }
    return { redelivered };
  },
});

export const liveInstallationIds = internalQuery({
  args: {},
  handler: async (ctx): Promise<string[]> => {
    const rows = await ctx.db.query("githubInstallations").collect();
    return rows.filter((row) => row.deletedAt === null).map((row) => row.installationId);
  },
});

/** Compares the App's installations on GitHub with the table: missing ones are removed. */
export const reconcileAll = internalAction({
  args: {},
  handler: async (ctx): Promise<{ removed: number }> => {
    const app = readGithubConfig();
    if (app === null) return { removed: 0 };
    const client = githubClient(app);
    const jwt = await appJwt(app.clientId, app.privateKey, Date.now());
    const present = await client.appInstallations(jwt);
    await ctx.runMutation(internal.githubIngest.recordInstallations, {
      installations: present.installations,
      installedByUserId: null,
    });
    if (!present.complete) return { removed: 0 };
    const ids = new Set(present.installations.map((facts) => facts.installationId));
    let removed = 0;
    for (const installationId of await ctx.runQuery(
      internal.githubIngest.liveInstallationIds,
      {},
    )) {
      if (ids.has(installationId)) continue;
      await ctx.runMutation(internal.githubIngest.applyInstallation, {
        installationId,
        installation: null,
        repositories: [],
        complete: true,
      });
      removed += 1;
    }
    return { removed };
  },
});

/** Removes deliveries past their seven days and flows past their expiry, a batch at a time. */
export const purge = internalMutation({
  args: {},
  handler: async (ctx): Promise<{ removed: number }> => {
    const now = Date.now();
    const deliveries = await ctx.db
      .query("githubWebhookDeliveries")
      .withIndex("by_received", (q) => q.lt("receivedAt", now - GITHUB_DELIVERY_TTL_MS))
      .take(GITHUB_PURGE_BATCH);
    const flows = await ctx.db
      .query("githubFlows")
      .withIndex("by_expiry", (q) => q.lt("expiresAt", now - FLOW_GRACE_MS))
      .take(GITHUB_PURGE_BATCH);
    for (const row of [...deliveries, ...flows]) await ctx.db.delete(row._id);
    if (deliveries.length === GITHUB_PURGE_BATCH || flows.length === GITHUB_PURGE_BATCH) {
      await ctx.scheduler.runAfter(0, internal.githubIngest.purge, {});
    }
    return { removed: deliveries.length + flows.length };
  },
});

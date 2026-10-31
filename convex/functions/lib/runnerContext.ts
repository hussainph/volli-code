/** Shared scope checks for runner briefs and path-free checkout reports. */
import { ConvexError } from "convex/values";

import {
  DEFAULT_GITHUB_HOST,
  githubHostOf,
  githubRemoteUrl,
  normalizeGitRemoteUrl,
  parseId,
  TICKET_STATUSES,
} from "@volli/shared/cloud";

import type { Doc } from "../_generated/dataModel.js";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { findVisibleProject } from "./auth";
import { publicRow } from "./board";
import type { CallingRunner } from "./runnerAuth";

type ReadCtx = Pick<QueryCtx, "db">;
type ProjectRepo = Omit<Doc<"projectRepos">, "_id" | "_creationTime">;

export function contextError(
  code: "invalid_request" | "not_found" | "not_your_runner" | "fenced" | "invalid_repo",
  message: string,
) {
  return new ConvexError({ code, message });
}

/** Membership is resolved through the project's current, live Workspace. */
export async function runnerProject(ctx: ReadCtx, caller: CallingRunner, projectId: string) {
  parseId("project", projectId);
  const project = await findVisibleProject(ctx, caller.ownerUserId, projectId);
  if (project === null) throw contextError("not_found", "That project does not exist.");
  return project;
}

export async function runnerTicket(ctx: ReadCtx, ticketId: string, projectId?: string) {
  parseId("ticket", ticketId);
  const ticket = await ctx.db
    .query("tickets")
    .withIndex("by_uuid", (q) => q.eq("id", ticketId))
    .unique();
  if (
    ticket === null ||
    ticket.deletedAt !== null ||
    (projectId !== undefined && ticket.projectId !== projectId)
  ) {
    throw contextError("not_found", "That ticket does not exist.");
  }
  return ticket;
}

/**
 * Fresh facts for the runner's retention verdict, never a persisted readiness flag.
 * Only the last status transition can date the current Done dwell. A missing or
 * malformed transition must not fall back to an older Done entry. Tickets born
 * in Done use their creation event only when there are no status transitions.
 */
export async function retentionFacts(
  ctx: ReadCtx,
  ticket: Doc<"tickets"> | null,
): Promise<{
  doneEntryAt: number | null;
  prUrl: string | null;
  prState: "open" | "merged" | "closed" | null;
} | null> {
  if (ticket === null) return null;
  let doneEntryAt: number | null = null;
  if (ticket.status === "done") {
    const transition = await ctx.db
      .query("boardEvents")
      .withIndex("by_ticket_kind_seq", (q) =>
        q.eq("ticketId", ticket.id).eq("kind", "status_changed"),
      )
      .order("desc")
      .first();
    const event =
      transition ??
      (await ctx.db
        .query("boardEvents")
        .withIndex("by_ticket_kind_seq", (q) => q.eq("ticketId", ticket.id).eq("kind", "created"))
        .order("desc")
        .first());
    // Migrated payloads are untrusted JSON. Only an observed, matching fact dates a dwell.
    const payload: unknown = event?.payload;
    if (
      event !== null &&
      event.projectId === ticket.projectId &&
      Number.isFinite(event.occurredAt) &&
      event.occurredAt >= 0 &&
      event.occurredAt <= Date.now() &&
      payload !== null &&
      typeof payload === "object" &&
      !Array.isArray(payload)
    ) {
      const fact = payload as Record<string, unknown>;
      if (
        (transition !== null &&
          fact.kind === "status_changed" &&
          fact.to === "done" &&
          fact.from !== "done" &&
          TICKET_STATUSES.some((status) => status === fact.from)) ||
        (transition === null && fact.kind === "created" && fact.status === "done")
      )
        doneEntryAt = event.occurredAt;
    }
  }
  // A ticket may name several repositories' PRs. Any open PR blocks reclaim;
  // selecting a closed primary PR must never conceal another still-open review.
  const pr =
    ticket.pullRequests.find((request) => request.state === "open") ?? ticket.pullRequests[0];
  return { doneEntryAt, prUrl: pr?.url ?? null, prState: pr?.state ?? null };
}

/**
 * Folder projects have no repository row until their first runner reports.
 * The default primary repository's id is the project's UUID, in a separate
 * id namespace. This derivation is durable: changing it would strand local
 * path registrations made before the first report.
 */
function folderRepo(project: Doc<"projects">): ProjectRepo {
  return {
    id: project.id,
    projectId: project.id,
    role: "primary",
    position: "a0",
    provider: "none",
    githubRepoId: null,
    installationId: null,
    owner: null,
    name: project.name,
    baseBranch: null,
    defaultBranchCache: null,
    dirName: "primary",
  };
}

export async function primaryRepo(ctx: ReadCtx, project: Doc<"projects">): Promise<ProjectRepo> {
  const repos = await ctx.db
    .query("projectRepos")
    .withIndex("by_project", (q) => q.eq("projectId", project.id))
    .collect();
  const primary = repos.find((repo) => repo.role === "primary");
  if (primary !== undefined) return publicRow(primary);
  if (repos.length !== 0)
    throw contextError("invalid_repo", "This project has no primary repository.");
  return folderRepo(project);
}

/**
 * Validate an explicit repo, or atomically materialize the default folder repo.
 * An unknown, nondefault id is never adopted, nor is a repo from another project.
 */
export async function reportedRepo(
  ctx: Pick<MutationCtx, "db">,
  project: Doc<"projects">,
  projectRepoId: string,
): Promise<ProjectRepo> {
  parseId("projectRepo", projectRepoId);
  const repo = await ctx.db
    .query("projectRepos")
    .withIndex("by_uuid", (q) => q.eq("id", projectRepoId))
    .unique();
  if (repo !== null) {
    if (repo.projectId !== project.id) {
      throw contextError("invalid_repo", "That repository is not in this project.");
    }
    return publicRow(repo);
  }
  const primary = await primaryRepo(ctx, project);
  if (primary.id !== projectRepoId || projectRepoId !== project.id) {
    throw contextError("invalid_repo", "That repository does not exist.");
  }
  await ctx.db.insert("projectRepos", primary);
  return primary;
}

/**
 * The deployment's GitHub web URL, as `lib/github/config.ts` reads it. Read
 * here without the App's configuration: a remote derives even where no App
 * is set up.
 */
function githubWebUrl(): string {
  let configured = (process.env.GITHUB_WEB_URL ?? "").trim();
  while (configured.endsWith("/")) configured = configured.slice(0, -1);
  return configured === "" ? "https://github.com" : configured;
}

/** The host whose remotes take GitHub's canonical https form on this deployment. */
export function githubRemoteHost(): string {
  return githubHostOf(githubWebUrl()) ?? DEFAULT_GITHUB_HOST;
}

/** A reported `origin` as the backend records it, or `null` when a box could not clone it. */
export function recordableRemoteUrl(raw: string): string | null {
  return normalizeGitRemoteUrl(raw, [githubRemoteHost()]);
}

/**
 * The remote a runner without the person's folder clones: a GitHub
 * repository's derived from its owner and name, a folder repository's the
 * last one a main checkout reported. `null` when none is known.
 */
export function repoRemoteUrl(
  repo: Pick<ProjectRepo, "provider" | "owner" | "name" | "remoteUrl">,
): string | null {
  if (repo.provider === "github" && repo.owner !== null) {
    return githubRemoteUrl(githubWebUrl(), repo.owner, repo.name);
  }
  return repo.remoteUrl ?? null;
}

/** A repository row as runners read it: with its {@link repoRemoteUrl}. */
export function withRemoteUrl(repo: ProjectRepo): ProjectRepo & { remoteUrl: string | null } {
  return { ...repo, remoteUrl: repoRemoteUrl(repo) };
}

/**
 * A repository of this project, or `invalid_repo`. Read-only: the default
 * folder repository (id = the project's id) is accepted before its first
 * report has written its row.
 */
export async function projectRepoOf(
  ctx: ReadCtx,
  project: Doc<"projects">,
  projectRepoId: string,
): Promise<ProjectRepo> {
  parseId("projectRepo", projectRepoId);
  const repo = await ctx.db
    .query("projectRepos")
    .withIndex("by_uuid", (q) => q.eq("id", projectRepoId))
    .unique();
  if (repo !== null) {
    if (repo.projectId !== project.id) {
      throw contextError("invalid_repo", "That repository is not in this project.");
    }
    return publicRow(repo);
  }
  const primary = await primaryRepo(ctx, project);
  if (primary.id !== projectRepoId) {
    throw contextError("invalid_repo", "That repository does not exist.");
  }
  return primary;
}

/** Bound runner-reported git metadata; reports carry no opaque failure JSON or paths. */
export function checkGitMetadata(values: readonly (string | null | undefined)[]): void {
  if (
    values.some(
      (value) =>
        value != null && (value.length > 1024 || value.includes("\0") || /[\r\n]/.test(value)),
    )
  ) {
    throw contextError(
      "invalid_request",
      "Git metadata must be one line of at most 1024 characters.",
    );
  }
}

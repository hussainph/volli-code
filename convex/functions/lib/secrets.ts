/**
 * Team secrets, the parts the client functions (`secrets.ts`) and runner
 * delivery (`secretsDelivery.ts`) share: the target argument, who may read
 * and write a target, the live project and Workspace a target belongs to,
 * the four rows a resolved set reads, and the metadata a client sees.
 *
 * The rules are the pure functions in `@volli/shared/cloud` (`secrets.ts`).
 */

import type { GenericDatabaseReader } from "convex/server";
import { ConvexError, v, type Infer } from "convex/values";

import {
  SECRET_EXPOSURES,
  SECRET_KINDS,
  canReadSecrets,
  canWriteSecrets,
  isTeamSecretName,
  parseId,
  readActor,
  secretLayer,
  secretScopeKey,
  secretTargetOf,
  type Actor,
  type UnknownActor,
  type MembershipFacts,
  type ProjectId,
  type SecretExposure,
  type SecretKind,
  type SecretLayer,
  type SecretScopeLevel,
  type SecretTarget,
  type UserId,
  type WorkspaceId,
} from "@volli/shared/cloud";

import type { DataModel, Doc } from "../_generated/dataModel.js";
import { authError, findMembership, isShownProject, type Viewer } from "./auth";
import { literals, nullable } from "./validators";

type Reader = { db: GenericDatabaseReader<DataModel> };

export type SecretsErrorCode =
  | "invalid_argument"
  | "limit_exceeded"
  | "conflict"
  | "not_claimed"
  | "not_your_runner"
  | "runner_revoked";

export function secretsError(code: SecretsErrorCode, message: string) {
  return new ConvexError({ code, message });
}

/** Where a client sets or lists secrets. A personal target is always the viewer's own. */
export const targetArg = v.union(
  v.object({ scope: v.literal("workspace"), workspaceId: v.string() }),
  v.object({ scope: v.literal("project"), projectId: v.string() }),
  v.object({ scope: v.literal("personal"), projectId: nullable(v.string()) }),
);
export type TargetArg = Infer<typeof targetArg>;

export const kindArg = literals(SECRET_KINDS);
export const exposureArg = literals(SECRET_EXPOSURES);

function idOrInvalid<K extends "workspace" | "project" | "secret">(kind: K, value: string) {
  try {
    return parseId(kind, value);
  } catch {
    throw secretsError("invalid_argument", `A ${kind} id is a lowercase UUID.`);
  }
}

export function secretIdArg(value: string) {
  return idOrInvalid("secret", value);
}

/** The viewer's target from a client's argument. */
export function targetFor(viewer: Viewer, arg: TargetArg): SecretTarget {
  switch (arg.scope) {
    case "workspace":
      return { scope: "workspace", workspaceId: idOrInvalid("workspace", arg.workspaceId) };
    case "project":
      return { scope: "project", projectId: idOrInvalid("project", arg.projectId) };
    case "personal":
      return {
        scope: "personal",
        userId: viewer.userId,
        projectId: arg.projectId === null ? null : idOrInvalid("project", arg.projectId),
      };
  }
}

export function nameArg(name: string): string {
  if (!isTeamSecretName(name)) {
    throw secretsError(
      "invalid_argument",
      "A secret name is an uppercase environment variable name, and not one that steers processes (PATH, LD_*, VOLLI_*, *_PROXY, GIT_EDITOR, …).",
    );
  }
  return name;
}

/** The target a stored row names. A row whose scope and key disagree is corruption. */
export function rowTarget(row: Doc<"secrets">): SecretTarget {
  const target = secretTargetOf(row.scope, row.scopeKey);
  if (target === null) throw new Error(`Secret ${row.id} has a malformed scope key.`);
  return target;
}

/** A live project in a live Workspace, or `null`. */
export async function liveProject(ctx: Reader, projectId: string): Promise<Doc<"projects"> | null> {
  const project = await ctx.db
    .query("projects")
    .withIndex("by_uuid", (q) => q.eq("id", projectId))
    .unique();
  if (project === null || !isShownProject(project)) return null;
  return (await liveWorkspace(ctx, project.workspaceId)) === null ? null : project;
}

export async function liveWorkspace(
  ctx: Reader,
  workspaceId: string,
): Promise<Doc<"workspaces"> | null> {
  const workspace = await ctx.db
    .query("workspaces")
    .withIndex("by_uuid", (q) => q.eq("id", workspaceId))
    .unique();
  return workspace === null || workspace.deletedAt !== null ? null : workspace;
}

/** The Workspace a target belongs to now: a project's CURRENT one. `null` for personal-global. */
export interface TargetPlace {
  workspaceId: WorkspaceId | null;
  projectId: ProjectId | null;
  membership: MembershipFacts | null;
}

function absent(what: string) {
  return authError("not_found", `That ${what} does not exist.`);
}

async function placeOf(ctx: Reader, viewer: Viewer, target: SecretTarget): Promise<TargetPlace> {
  let workspaceId: string | null;
  let projectId: string | null = null;
  if (target.scope === "workspace") {
    if ((await liveWorkspace(ctx, target.workspaceId)) === null) throw absent("workspace");
    workspaceId = target.workspaceId;
  } else if (target.projectId === null) {
    workspaceId = null;
  } else {
    const project = await liveProject(ctx, target.projectId);
    if (project === null) throw absent("project");
    workspaceId = project.workspaceId;
    projectId = project.id;
  }
  return {
    workspaceId: workspaceId as WorkspaceId | null,
    projectId: projectId as ProjectId | null,
    membership: workspaceId === null ? null : await findMembership(ctx, workspaceId, viewer.userId),
  };
}

function refuse(viewer: Viewer, target: SecretTarget): never {
  // Someone else's personal secrets: whether any exist is theirs to know.
  if (target.scope === "personal" && target.userId !== viewer.userId) {
    throw authError("not_found", "Those secrets do not exist.");
  }
  throw authError("not_a_member", "You are not a member of this workspace.");
}

/** The target's place, when the viewer may read its secrets' metadata. */
export async function requireReadable(
  ctx: Reader,
  viewer: Viewer,
  target: SecretTarget,
): Promise<TargetPlace> {
  const place = await placeOf(ctx, viewer, target);
  if (!canReadSecrets(viewer, target, place.workspaceId, place.membership)) refuse(viewer, target);
  return place;
}

/** The target's place, when the viewer may set, change or remove its secrets. */
export async function requireWritable(
  ctx: Reader,
  viewer: Viewer,
  target: SecretTarget,
): Promise<TargetPlace> {
  const place = await requireReadable(ctx, viewer, target);
  if (!canWriteSecrets(viewer, target, place.workspaceId, place.membership)) {
    throw authError("forbidden", "Only workspace owners and admins can change workspace secrets.");
  }
  return place;
}

/**
 * Who owns the data key a target's values are sealed under: the Workspace for
 * Workspace and project secrets, the person for personal ones.
 */
export function keyOwnerOf(target: SecretTarget, place: TargetPlace): string {
  return target.scope === "personal" ? `u:${target.userId}` : `w:${place.workspaceId!}`;
}

export async function findSecret(
  ctx: Reader,
  scopeKey: string,
  name: string,
): Promise<Doc<"secrets"> | null> {
  return ctx.db
    .query("secrets")
    .withIndex("by_scope_name", (q) => q.eq("scopeKey", scopeKey).eq("name", name))
    .unique();
}

export async function secretsAt(ctx: Reader, scopeKey: string): Promise<Doc<"secrets">[]> {
  return ctx.db
    .query("secrets")
    .withIndex("by_scope_name", (q) => q.eq("scopeKey", scopeKey))
    .collect();
}

/**
 * The rows a Session in `projectId` (in `workspaceId`) owned by `userId`
 * reads, each tagged with its layer. Unsorted; resolve with the shared resolver.
 */
export async function layeredSecrets(
  ctx: Reader,
  facts: { userId: UserId; projectId: ProjectId; workspaceId: WorkspaceId },
): Promise<Array<Doc<"secrets"> & { layer: SecretLayer }>> {
  const targets: SecretTarget[] = [
    { scope: "personal", userId: facts.userId, projectId: facts.projectId },
    { scope: "personal", userId: facts.userId, projectId: null },
    { scope: "project", projectId: facts.projectId },
    { scope: "workspace", workspaceId: facts.workspaceId },
  ];
  const rows = await Promise.all(
    targets.map(async (target) =>
      (await secretsAt(ctx, secretScopeKey(target))).map((row) =>
        Object.assign(row, { layer: secretLayer(target) }),
      ),
    ),
  );
  return rows.flat();
}

/** What a client sees of a secret: never a sealed value; an env var's plain value. */
export interface SecretSummary {
  secretId: string;
  scope: SecretScopeLevel;
  layer: SecretLayer;
  workspaceId: string | null;
  projectId: string | null;
  name: string;
  kind: SecretKind;
  /** Env vars only. A secret's value is never returned. */
  value: string | null;
  last4: string | null;
  exposure: SecretExposure;
  createdBy: Actor | UnknownActor;
  updatedAt: number;
  lastUsedAt: number | null;
  valueVersion: number;
}

export function summarize(row: Doc<"secrets">): SecretSummary {
  const target = rowTarget(row);
  return {
    secretId: row.id,
    scope: row.scope,
    layer: secretLayer(target),
    workspaceId: target.scope === "workspace" ? target.workspaceId : null,
    projectId: target.scope === "workspace" ? null : target.projectId,
    name: row.name,
    kind: row.kind,
    value: row.kind === "env" ? row.plain : null,
    last4: row.kind === "secret" ? row.last4 : null,
    exposure: row.exposure,
    createdBy: readActor(row.createdBy),
    updatedAt: row.updatedAt,
    lastUsedAt: row.lastUsedAt,
    valueVersion: row.valueVersion,
  };
}

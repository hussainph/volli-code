/**
 * The Workspace and Member writes the modules share: creating a Workspace
 * (the personal one at sign-up included), joining one, and keeping its seat
 * count true.
 *
 * Every write names a person: the Actor is the `person` arm for the
 * signed-in viewer, and `auditLog` records it beside what changed. Seats are
 * Members with `status = active`: suspended and departed Members are not
 * billed. {@link syncSeats} recounts them in the same transaction as every
 * Member change.
 */

import type { GenericDatabaseReader, GenericDatabaseWriter } from "convex/server";
import { ConvexError } from "convex/values";

import {
  DEFAULT_WORKSPACE_POLICY,
  newId,
  parseId,
  type Actor,
  type IdKind,
  type MemberRole,
  type UserId,
  type WorkspaceId,
} from "@volli/shared/cloud";

import type { DataModel, Doc } from "../_generated/dataModel.js";
import { audit } from "./audit";
import type { Viewer } from "./auth";

export type WorkspaceErrorCode =
  | "invalid_argument"
  | "id_taken"
  | "revision_conflict"
  | "last_owner"
  | "self"
  | "already_member"
  | "already_invited"
  | "suspended"
  | "invite_invalid"
  | "invite_expired"
  | "invite_email_mismatch";

export function workspaceError(
  code: WorkspaceErrorCode,
  message: string,
): ConvexError<{ code: WorkspaceErrorCode; message: string }> {
  return new ConvexError({ code, message });
}

type Reader = { db: GenericDatabaseReader<DataModel> };
type Writer = { db: GenericDatabaseWriter<DataModel> };

/** The plan every new Workspace starts on. */
const FREE_PLAN = "free";

const MAX_WORKSPACE_NAME_LENGTH = 64;

/** The signed-in person as the Actor of a write they made. */
export function personActor(viewer: Viewer): Actor {
  return { kind: "person", userId: viewer.userId };
}

/** `value` as an id of `kind`, or `invalid_argument`. */
export function idArg<K extends IdKind>(kind: K, value: string) {
  try {
    return parseId(kind, value);
  } catch {
    throw workspaceError("invalid_argument", `A ${kind} id is a lowercase UUID.`);
  }
}

function isControlCharacter(char: string): boolean {
  const point = char.codePointAt(0)!;
  return point < 0x20 || (point >= 0x7f && point < 0xa0);
}

/** A trimmed Workspace name, or `invalid_argument`. Length counts characters, not code units. */
export function workspaceName(raw: string): string {
  const name = raw.trim();
  const chars = Array.from(name);
  if (
    chars.length === 0 ||
    chars.length > MAX_WORKSPACE_NAME_LENGTH ||
    chars.some(isControlCharacter)
  ) {
    throw workspaceError(
      "invalid_argument",
      `A workspace name is 1 to ${MAX_WORKSPACE_NAME_LENGTH} characters.`,
    );
  }
  return name;
}

/** A valid Workspace name made from a person's display name, whatever their profile holds. */
function personalWorkspaceName(displayName: string): string {
  const cleaned = Array.from(displayName)
    .filter((char) => !isControlCharacter(char))
    .join("")
    .trim();
  const name = Array.from(cleaned).slice(0, MAX_WORKSPACE_NAME_LENGTH).join("").trim();
  return name === "" ? "My workspace" : name;
}

/** The URL slug a name suggests: lowercase ASCII words joined by `-`. */
function slugify(name: string): string {
  const slug = name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
  return slug === "" ? "workspace" : slug;
}

async function slugTaken(ctx: Reader, slug: string): Promise<boolean> {
  const row = await ctx.db
    .query("workspaces")
    .withIndex("by_slug", (q) => q.eq("slug", slug))
    .first();
  return row !== null;
}

/**
 * A slug no Workspace holds: the name's own, or that plus a growing piece of
 * the Workspace id. A slug is kept on rename, so links that name it keep
 * working.
 */
async function uniqueSlug(ctx: Reader, name: string, workspaceId: string): Promise<string> {
  const base = slugify(name);
  if (!(await slugTaken(ctx, base))) return base;
  const compact = workspaceId.replace(/-/g, "");
  for (let length = 6; length < compact.length; length += 6) {
    const candidate = `${base}-${compact.slice(0, length)}`;
    if (!(await slugTaken(ctx, candidate))) return candidate;
  }
  // The full id is unique among Workspaces, so its slug form is free.
  return `${base}-${compact}`;
}

export async function findWorkspace(
  ctx: Reader,
  workspaceId: string,
): Promise<Doc<"workspaces"> | null> {
  return await ctx.db
    .query("workspaces")
    .withIndex("by_uuid", (q) => q.eq("id", workspaceId))
    .unique();
}

/** The membership row itself (any status), for the writes that change it. */
export async function findMemberRow(
  ctx: Reader,
  workspaceId: string,
  userId: string,
): Promise<Doc<"workspaceMembers"> | null> {
  return await ctx.db
    .query("workspaceMembers")
    .withIndex("by_workspace_user", (q) => q.eq("workspaceId", workspaceId).eq("userId", userId))
    .unique();
}

async function activeMembers(ctx: Reader, workspaceId: string): Promise<Doc<"workspaceMembers">[]> {
  return await ctx.db
    .query("workspaceMembers")
    .withIndex("by_workspace_status", (q) =>
      q.eq("workspaceId", workspaceId).eq("status", "active"),
    )
    .collect();
}

/** The Workspace's policy row, or `null` before the first write (readers use the defaults). */
export async function policyRow(
  ctx: Reader,
  workspaceId: string,
): Promise<Doc<"workspacePolicies"> | null> {
  return await ctx.db
    .query("workspacePolicies")
    .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
    .unique();
}

/**
 * Recounts the Workspace's seats (active Members) and stores the count, in the
 * same transaction as the Member change that calls it. Recounting rather than
 * incrementing means the count cannot drift. This is the one place a seat
 * change is seen; the billing seat push hangs off it.
 */
export async function syncSeats(ctx: Writer, workspaceId: string): Promise<number> {
  const count = (await activeMembers(ctx, workspaceId)).length;
  const workspace = await findWorkspace(ctx, workspaceId);
  if (workspace !== null && workspace.activeMemberCount !== count) {
    await ctx.db.patch(workspace._id, { activeMemberCount: count });
  }
  return count;
}

/** The number of active owners: the Workspace must always keep one. */
export async function activeOwnerCount(ctx: Reader, workspaceId: string): Promise<number> {
  return (await activeMembers(ctx, workspaceId)).filter((member) => member.role === "owner").length;
}

/**
 * Creates a Workspace with `owner` as its one active owner, on the Free plan
 * and the default policy. The caller has checked `workspaceId` is free.
 */
export async function createWorkspace(
  ctx: Writer,
  owner: Viewer,
  input: { workspaceId: WorkspaceId; name: string; via: "signup" | "create" },
): Promise<Doc<"workspaces">> {
  const now = Date.now();
  const actor = personActor(owner);
  const slug = await uniqueSlug(ctx, input.name, input.workspaceId);
  const docId = await ctx.db.insert("workspaces", {
    id: input.workspaceId,
    name: input.name,
    slug,
    iconKey: null,
    createdByUserId: owner.userId,
    planKey: FREE_PLAN,
    activeMemberCount: 0,
    createdAt: now,
    deletedAt: null,
    purgeAfter: null,
  });
  await ctx.db.insert("workspacePolicies", {
    workspaceId: input.workspaceId,
    ...DEFAULT_WORKSPACE_POLICY,
    revision: 0,
    updatedByUserId: owner.userId,
    updatedAt: now,
  });
  await audit(ctx, {
    workspaceId: input.workspaceId,
    actor,
    kind: "workspace.created",
    targetKind: "workspace",
    targetId: input.workspaceId,
    at: now,
    detail: { name: input.name, slug },
  });
  await joinWorkspace(ctx, actor, {
    workspaceId: input.workspaceId,
    userId: owner.userId,
    role: "owner",
    invitedByUserId: null,
    via: input.via,
    inviteId: null,
  });
  return (await ctx.db.get(docId))!;
}

/** The person's own Workspace at sign-up, named after them. */
export async function createPersonalWorkspace(
  ctx: Writer,
  viewer: Viewer,
): Promise<Doc<"workspaces">> {
  return await createWorkspace(ctx, viewer, {
    workspaceId: newId("workspace"),
    name: personalWorkspaceName(viewer.user.displayName),
    via: "signup",
  });
}

/**
 * Makes `userId` an active Member with `role`: a new row, or a departed
 * Member's row brought back (their history stays theirs). The caller has ruled
 * out an active or suspended membership. `billingTier` follows the plan: one
 * tier per Workspace for now.
 */
export async function joinWorkspace(
  ctx: Writer,
  actor: Actor,
  input: {
    workspaceId: string;
    userId: UserId;
    role: MemberRole;
    invitedByUserId: UserId | null;
    via: "signup" | "create" | "invite";
    inviteId: string | null;
  },
): Promise<Doc<"workspaceMembers">> {
  const now = Date.now();
  const workspace = (await findWorkspace(ctx, input.workspaceId))!;
  const existing = await findMemberRow(ctx, input.workspaceId, input.userId);
  const fields = {
    role: input.role,
    status: "active" as const,
    billingTier: workspace.planKey,
    joinedAt: now,
    suspendedAt: null,
    leftAt: null,
    invitedByUserId: input.invitedByUserId,
  };
  let docId;
  if (existing === null) {
    docId = await ctx.db.insert("workspaceMembers", {
      id: newId("member"),
      workspaceId: input.workspaceId,
      userId: input.userId,
      ...fields,
    });
  } else {
    docId = existing._id;
    await ctx.db.patch(docId, fields);
  }
  const member = (await ctx.db.get(docId))!;
  await syncSeats(ctx, input.workspaceId);
  await audit(ctx, {
    workspaceId: input.workspaceId,
    actor,
    kind: existing === null ? "member.joined" : "member.rejoined",
    targetKind: "member",
    targetId: member.id,
    at: now,
    detail: { userId: input.userId, role: input.role, via: input.via, inviteId: input.inviteId },
  });
  return member;
}

/** The users behind a set of ids, for lists that name people. */
export async function usersById(
  ctx: Reader,
  userIds: Iterable<string>,
): Promise<Map<string, Doc<"users">>> {
  const users = new Map<string, Doc<"users">>();
  for (const userId of new Set(userIds)) {
    const user = await ctx.db
      .query("users")
      .withIndex("by_uuid", (q) => q.eq("id", userId))
      .unique();
    if (user !== null) users.set(userId, user);
  }
  return users;
}

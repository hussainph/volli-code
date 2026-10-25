/**
 * The Workspace and Member writes every module shares: creating a Workspace
 * (the personal one at sign-up included), joining one, keeping its seat count
 * true, invite tokens, and the audit row each change leaves.
 *
 * Every write here names a person: the Actor is the `person` arm for the
 * signed-in viewer, and `auditLog` records it beside what changed (never a
 * token). Seats are Members with `status = active` (L1: suspended and departed
 * Members are not billed); {@link syncSeats} recounts them in the same
 * transaction as every Member change.
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
import { normalizeEmail, type Viewer } from "./auth";

export type WorkspaceErrorCode =
  | "invalid_argument"
  | "id_taken"
  | "revision_conflict"
  | "last_owner"
  | "self"
  | "already_member"
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
export const FREE_PLAN = "free";

/** How long an invite (email or link) stays acceptable. */
export const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export const MAX_WORKSPACE_NAME_LENGTH = 64;

/** The signed-in person as the Actor of a write they made. */
export function personActor(viewer: Viewer): Actor {
  return { kind: "person", userId: viewer.userId };
}

function hasControlCharacter(value: string): boolean {
  for (const char of value) {
    const point = char.codePointAt(0)!;
    if (point < 0x20 || point === 0x7f) return true;
  }
  return false;
}

/** A trimmed Workspace name, or `invalid_argument`. */
export function workspaceName(raw: string): string {
  const name = raw.trim();
  if (name === "" || name.length > MAX_WORKSPACE_NAME_LENGTH || hasControlCharacter(name)) {
    throw workspaceError(
      "invalid_argument",
      `A workspace name is 1 to ${MAX_WORKSPACE_NAME_LENGTH} characters.`,
    );
  }
  return name;
}

/** The URL slug a name suggests: lowercase ASCII words joined by `-`. */
export function slugify(name: string): string {
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
 * A slug no Workspace holds: the name's own, or that plus a short piece of
 * the Workspace id. Slugs are kept on rename, because 0.5's web URLs name them.
 */
async function uniqueSlug(ctx: Reader, name: string, workspaceId: string): Promise<string> {
  const base = slugify(name);
  if (!(await slugTaken(ctx, base))) return base;
  const compact = workspaceId.replace(/-/g, "");
  for (let length = 6; length <= compact.length; length += 6) {
    const candidate = `${base}-${compact.slice(0, length)}`;
    if (!(await slugTaken(ctx, candidate))) return candidate;
  }
  // A full 32-hex suffix collides only if a slug was written that way on purpose.
  throw workspaceError("id_taken", "Could not find a free address for this workspace.");
}

/** `value` as an id of `kind`, or `invalid_argument`. */
export function idArg<K extends IdKind>(kind: K, value: string) {
  try {
    return parseId(kind, value);
  } catch {
    throw workspaceError("invalid_argument", `A ${kind} id is a lowercase UUID.`);
  }
}

export async function policyRow(
  ctx: Reader,
  workspaceId: string,
): Promise<Doc<"workspacePolicies"> | null> {
  return await ctx.db
    .query("workspacePolicies")
    .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
    .unique();
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

export async function activeMembers(
  ctx: Reader,
  workspaceId: string,
): Promise<Doc<"workspaceMembers">[]> {
  return await ctx.db
    .query("workspaceMembers")
    .withIndex("by_workspace_status", (q) =>
      q.eq("workspaceId", workspaceId).eq("status", "active"),
    )
    .collect();
}

/**
 * Recounts the Workspace's seats (active Members) and stores the count. Every
 * Member change calls this in its own transaction (L1 §5.3); billing's seat
 * push hangs off this one seam when it lands.
 */
export async function syncSeats(ctx: Reader & Writer, workspaceId: string): Promise<number> {
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

export interface AuditEntry {
  workspaceId: string | null;
  actor: Actor;
  kind: string;
  targetKind: "workspace" | "member" | "invite" | "policy";
  targetId: string;
  at: number;
  /** What changed. Never a secret or a token. */
  detail: Record<string, unknown>;
}

export async function audit(ctx: Writer, entry: AuditEntry): Promise<void> {
  await ctx.db.insert("auditLog", { id: newId("audit"), ...entry });
}

/**
 * Creates a Workspace with `owner` as its one active owner, on the Free plan
 * and the default policy. The caller has checked `workspaceId` is free.
 */
export async function createWorkspace(
  ctx: Reader & Writer,
  owner: Viewer,
  input: { workspaceId: WorkspaceId; name: string; personal: boolean },
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
    detail: { name: input.name, slug, personal: input.personal },
  });
  await joinWorkspace(ctx, actor, {
    workspaceId: input.workspaceId,
    userId: owner.userId,
    role: "owner",
    invitedByUserId: null,
    via: input.personal ? "signup" : "create",
  });
  return (await ctx.db.get(docId))!;
}

/**
 * The person's own Workspace at sign-up, named after them (Linear model: no
 * Workspace types, inviting someone just adds a Member).
 */
export async function createPersonalWorkspace(
  ctx: Reader & Writer,
  viewer: Viewer,
): Promise<Doc<"workspaces">> {
  const name = viewer.user.displayName.trim().slice(0, MAX_WORKSPACE_NAME_LENGTH) || "My workspace";
  return await createWorkspace(ctx, viewer, {
    workspaceId: newId("workspace"),
    name,
    personal: true,
  });
}

/**
 * Makes `userId` an active Member with `role`: a new row, or a departed
 * Member's row brought back (their history stays theirs). The caller has ruled
 * out an active or suspended membership. `billingTier` follows the plan
 * (0.3: one tier per Workspace, L1 §1.3).
 */
export async function joinWorkspace(
  ctx: Reader & Writer,
  actor: Actor,
  input: {
    workspaceId: string;
    userId: UserId;
    role: MemberRole;
    invitedByUserId: UserId | null;
    via: "signup" | "create" | "invite";
    inviteId?: string;
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
    detail: {
      userId: input.userId,
      role: input.role,
      via: input.via,
      ...(input.inviteId === undefined ? {} : { inviteId: input.inviteId }),
    },
  });
  return member;
}

// ── invite tokens ──────────────────────────────────────────────────────────

const TOKEN_BYTES = 32;

/**
 * A fresh invite token: 32 random bytes, base64url. Only its hash is stored;
 * the token itself is returned once, to the inviter, to build the link.
 */
export function mintInviteToken(): string {
  const bytes = new Uint8Array(TOKEN_BYTES);
  crypto.getRandomValues(bytes);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** The stored form of an invite token: its sha256, lowercase hex. */
export async function hashInviteToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export type InviteState = "pending" | "accepted" | "revoked" | "expired";

export function inviteState(invite: Doc<"workspaceInvites">, now: number): InviteState {
  if (invite.revokedAt !== null) return "revoked";
  if (invite.acceptedAt !== null) return "accepted";
  if (invite.expiresAt <= now) return "expired";
  return "pending";
}

/** A plausible email address, normalized, or `invalid_argument`. */
export function inviteEmail(raw: string): string {
  const email = normalizeEmail(raw);
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw workspaceError("invalid_argument", "That is not an email address.");
  }
  return email;
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

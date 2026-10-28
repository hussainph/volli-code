/**
 * Session visibility, written: what a new Session starts as, the one-way
 * share flip, and the board-event filter a feed reads through.
 *
 * The decisions are the pure functions in `@volli/shared/cloud`
 * (`sessionVisibilityAtCreation`, `decideSessionShare`, `inheritedShare`,
 * `boardEventSessionId`, `canSeeSession`); this module only reads and writes
 * the rows they decide about. Reads are scoped through `requireSessionScope`
 * / `requireSessionVisible` in `./auth`, which apply the Workspace's
 * `shareAll` policy at read time.
 *
 * Wiring:
 * - `visibilityForNewSession` is what every Session-creating write must call
 *   for its `visibility`, `visibilityReason` and `sharedAt`, so a creator never
 *   picks them itself. Its callers arrive with Session intake's first accept,
 *   `sessions.create` and the migration import.
 * - `shareSession` is the owner's "Share" (`sessionVisibility.share`).
 * - `boardEventVisibility` / `visibleBoardEvents` is what every read of board
 *   events that may name a Session filters through: the activity feeds
 *   (`lib/activity.ts`) and a ticket's history (`board.ticketEvents`).
 */

import type { GenericDatabaseReader, GenericDatabaseWriter } from "convex/server";
import { ConvexError } from "convex/values";

import {
  boardEventSessionId,
  canSeeSession,
  decideSessionShare,
  inheritedShare,
  sessionVisibilityAtCreation,
  type MembershipFacts,
  type PolicyFacts,
  type SessionRole,
  type SessionVisibilityFacts,
} from "@volli/shared/cloud";

import type { DataModel, Doc } from "../_generated/dataModel.js";
import { audit } from "./audit";
import { authError, projectImporting, sessionFacts, type SessionScope, type Viewer } from "./auth";
import { personActor } from "./workspaces";

type Reader = { db: GenericDatabaseReader<DataModel> };
type Writer = { db: GenericDatabaseWriter<DataModel> };

export type VisibilityErrorCode = "parent_not_found" | "share_parent" | "too_many_descendants";

function visibilityError(
  code: VisibilityErrorCode,
  message: string,
): ConvexError<{ code: VisibilityErrorCode; message: string }> {
  return new ConvexError({ code, message });
}

async function sessionRow(ctx: Reader, sessionId: string): Promise<Doc<"sessions"> | null> {
  return ctx.db
    .query("sessions")
    .withIndex("by_uuid", (q) => q.eq("id", sessionId))
    .unique();
}

/**
 * The visibility fields a new Session is written with, from its role: ticket
 * work is shared, an ad-hoc chat or Board Session private, and a subagent
 * takes its parent's. A subagent's parent must be a live Session of the same
 * project with the same owner (a subagent acts for its parent's owner), or
 * `parent_not_found`. `sharedAt` is `createdAt` for a Session born shared.
 */
export async function visibilityForNewSession(
  ctx: Reader,
  input: {
    projectId: string;
    ownerUserId: string;
    role: SessionRole;
    parentSessionId: string | null;
    createdAt: number;
  },
): Promise<SessionVisibilityFacts> {
  if (input.role !== "subagent") {
    return sessionVisibilityAtCreation({ role: input.role }, input.createdAt);
  }
  const parent =
    input.parentSessionId === null ? null : await sessionRow(ctx, input.parentSessionId);
  if (
    parent === null ||
    parent.deletedAt !== null ||
    parent.projectId !== input.projectId ||
    parent.ownerUserId !== input.ownerUserId
  ) {
    throw visibilityError(
      "parent_not_found",
      "A subagent's parent session must exist in its project, with the same owner.",
    );
  }
  return sessionVisibilityAtCreation({ role: "subagent", parent }, input.createdAt);
}

/** A bound on the subagents one share walks; delegation depth and fan-out keep real trees far smaller. */
export const MAX_SHARED_DESCENDANTS = 500;

/**
 * The owner shares a root Session they can see: it flips `private → shared`
 * and so does every private subagent beneath it (`inherited`), since a
 * subagent of a shared Session is shared. One `session.shared` audit row
 * records it. Sharing a shared Session changes nothing and writes nothing;
 * anyone but the owner is `forbidden`; a private subagent is `share_parent`
 * (it follows its parent). There is no way back to private.
 */
export async function shareSession(
  ctx: Writer,
  viewer: Viewer,
  session: Doc<"sessions">,
  workspaceId: string,
  now: number,
): Promise<{ changed: boolean; session: Doc<"sessions"> }> {
  const decision = decideSessionShare(viewer, sessionFacts(session), now);
  if (decision.kind === "refused") {
    throw decision.code === "subagent"
      ? visibilityError("share_parent", "A subagent is shared with its parent session.")
      : authError("forbidden", "Only the session's owner can share it.");
  }
  if (decision.kind === "already_shared") return { changed: false, session };

  await ctx.db.patch(session._id, decision.patch);
  // Breadth-first over subagents. `seen` guards a corrupt parent cycle; the
  // bound counts every subagent walked, shared or not, and a refusal rolls the
  // whole transaction back.
  const seen = new Set([session.id]);
  let descendants = 0;
  let frontier = [session.id];
  // A subagent in another project still being imported is left alone (and
  // not counted): that project takes no writes until its import commits.
  const hidden = new Map<string, boolean>();
  const inHiddenProject = async (child: Doc<"sessions">): Promise<boolean> => {
    if (child.projectId === session.projectId) return false;
    if (!hidden.has(child.projectId)) {
      hidden.set(child.projectId, await projectImporting(ctx, child.projectId));
    }
    return hidden.get(child.projectId)!;
  };
  while (frontier.length > 0) {
    const next: string[] = [];
    for (const parentId of frontier) {
      const children = await ctx.db
        .query("sessions")
        .withIndex("by_parent", (q) => q.eq("parentSessionId", parentId))
        .collect();
      for (const child of children) {
        if (child.role !== "subagent" || seen.has(child.id)) continue;
        if (await inHiddenProject(child)) continue;
        seen.add(child.id);
        if (seen.size > MAX_SHARED_DESCENDANTS + 1) {
          throw visibilityError(
            "too_many_descendants",
            "This session has too many subagents to share at once.",
          );
        }
        next.push(child.id);
        const patch = inheritedShare(child, now);
        if (patch === null) continue;
        descendants += 1;
        await ctx.db.patch(child._id, patch);
      }
    }
    frontier = next;
  }
  await audit(ctx, {
    workspaceId,
    actor: personActor(viewer),
    kind: "session.shared",
    targetKind: "session",
    targetId: session.id,
    at: now,
    detail: { reason: decision.patch.visibilityReason, descendants },
  });
  return { changed: true, session: { ...session, ...decision.patch } };
}

/** Who is reading board events, and under which Workspace policy: one Workspace's active membership. */
export interface BoardEventReader {
  viewer: Viewer;
  membership: MembershipFacts;
  policy: PolicyFacts;
}

/**
 * The check for one board event at a time, across any projects of the
 * reader's Workspace (the activity feed reads events lazily, one by one): an
 * event that names a Session is visible only when that Session is live,
 * belongs to the event's project, and the reader can see it (owner, shared,
 * or `shareAll`); every other board event is visible to an active Member,
 * which the caller has already checked. Each named Session is read once.
 * A Session id carried only as attribution (an agent Actor, a `session`
 * origin) does not hide the change (see `boardEventSessionId`).
 */
export function boardEventVisibility(
  ctx: Reader,
  reader: BoardEventReader,
): (event: { projectId: string; payload: object }) => Promise<boolean> {
  const verdicts = new Map<string, boolean>();
  const workspace = { workspaceId: reader.membership.workspaceId };
  return async (event) => {
    const sessionId = boardEventSessionId(event.payload);
    if (sessionId === null) return true;
    const key = `${event.projectId}:${sessionId}`;
    let verdict = verdicts.get(key);
    if (verdict === undefined) {
      const session = await sessionRow(ctx, sessionId);
      verdict =
        session !== null &&
        session.deletedAt === null &&
        session.projectId === event.projectId &&
        canSeeSession(
          reader.viewer,
          sessionFacts(session),
          workspace,
          reader.membership,
          reader.policy,
        );
      verdicts.set(key, verdict);
    }
    return verdict;
  };
}

/** The board events of one project the scope's viewer may see, in order ({@link boardEventVisibility}). */
export async function visibleBoardEvents<E extends { projectId: string; payload: object }>(
  ctx: Reader,
  scope: SessionScope,
  events: readonly E[],
): Promise<E[]> {
  const canSee = boardEventVisibility(ctx, scope);
  const visible: E[] = [];
  for (const event of events) {
    if (await canSee(event)) visible.push(event);
  }
  return visible;
}

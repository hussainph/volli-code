/**
 * Who can see a Session, and the owner's "Share".
 *
 * Ticket work is shared with the Workspace from the start; an ad-hoc chat or
 * Board Session is private to its owner, and a subagent follows its parent.
 * The owner may share a private Session (and its subagents with it) at any
 * time; that flip is one way, and a subagent is never shared on its own. An owner or admin may also turn on `shareAll` (the
 * Workspace policy, `workspaces.setPolicy`), which shows every private Session
 * to every active Member while it stays on, without rewriting any Session.
 *
 * A Session the viewer cannot see reads as `not_found`, so its existence is
 * private too.
 */

import { v } from "convex/values";

import {
  decideSessionShare,
  sessionAudience,
  type PolicyFacts,
  type SessionAudience,
  type SessionVisibility,
  type SessionVisibilityReason,
} from "@volli/shared/cloud";

import { mutation, query } from "./_generated/server";
import type { Doc } from "./_generated/dataModel.js";
import { requireSessionVisible, sessionFacts, type Viewer } from "./lib/auth";
import { shareSession } from "./lib/visibility";

export type SessionVisibilityState = {
  sessionId: string;
  visibility: SessionVisibility;
  visibilityReason: SessionVisibilityReason;
  sharedAt: number | null;
  /** Who sees it right now: the owner alone, or the Workspace (the Session is shared, or `shareAll` is on). */
  audience: SessionAudience;
  /** The viewer may share it: they own it, it is still private, and it is not a subagent (those follow their parent). */
  canShare: boolean;
};

function stateOf(
  viewer: Viewer,
  session: Doc<"sessions">,
  policy: PolicyFacts,
): SessionVisibilityState {
  return {
    sessionId: session.id,
    visibility: session.visibility,
    visibilityReason: session.visibilityReason,
    sharedAt: session.sharedAt,
    audience: sessionAudience(session, policy),
    canShare: decideSessionShare(viewer, sessionFacts(session), 0).kind === "share",
  };
}

/** A visible Session's visibility, as the Workspace's current policy makes it. */
export const get = query({
  args: { sessionId: v.string() },
  handler: async (ctx, args): Promise<SessionVisibilityState> => {
    const { viewer, session, policy } = await requireSessionVisible(ctx, args.sessionId);
    return stateOf(viewer, session, policy);
  },
});

/**
 * Shares a private Session with the Workspace (its owner only), along with
 * every private subagent beneath it. One way: there is no unshare. Sharing a
 * shared Session returns its state and writes nothing, so a retry is safe and
 * the mutation needs no `commandId`. A private subagent is `share_parent`.
 */
export const share = mutation({
  args: { sessionId: v.string() },
  handler: async (ctx, args): Promise<SessionVisibilityState> => {
    const { viewer, session, project, policy } = await requireSessionVisible(ctx, args.sessionId);
    const result = await shareSession(ctx, viewer, session, project.workspaceId, Date.now());
    return stateOf(viewer, result.session, policy);
  },
});

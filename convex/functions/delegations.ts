/** Viewer-authorized delegation read model. Cross-runner starts belong to N4. */
import { v } from "convex/values";
import { query } from "./_generated/server";
import { PERSON_OR_AGENT, requireActor } from "./lib/actorAuth";
import { requireSessionScope, requireSessionVisible } from "./lib/auth";

/** All children of a visible parent, in start order, without Convex row ids. */
export const forParent = query({
  args: { sessionId: v.string() },
  handler: async (ctx, { sessionId }) => {
    const { viewer } = await requireActor(ctx, PERSON_OR_AGENT);
    const { session: parent } = await requireSessionVisible(ctx, sessionId, viewer);
    const scope = await requireSessionScope(ctx, parent.projectId, viewer);
    const slots = await ctx.db
      .query("delegations")
      .withIndex("by_parent_status", (q) => q.eq("parentSessionId", parent.id))
      .collect();
    const rows = [];
    for (const slot of slots) {
      const child = await ctx.db
        .query("sessions")
        .withIndex("by_uuid", (q) => q.eq("id", slot.childSessionId))
        .unique();
      if (child === null || !scope.canSee(child)) continue;
      rows.push({
        childSessionId: slot.childSessionId,
        parentSessionId: slot.parentSessionId,
        ticketId: slot.ticketId,
        toolCallId: slot.toolCallId,
        depth: slot.depth,
        status: slot.status,
        answerRef: slot.answerRef,
        createdAt: slot.createdAt,
        settledAt: slot.settledAt,
        title: child.title,
        visibility: child.visibility,
        placeRunnerId: child.placeRunnerId,
      });
    }
    return rows.toSorted(
      (a, b) => a.createdAt - b.createdAt || a.childSessionId.localeCompare(b.childSessionId),
    );
  },
});

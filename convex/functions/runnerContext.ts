/** A runner's first-attach brief and checkout facts. No machine paths leave the runner. */
import { v } from "convex/values";

import { parseId } from "@volli/shared/cloud";

import { query } from "./_generated/server";
import { publicRow } from "./lib/board";
import { requireRunner } from "./lib/runnerAuth";
import {
  contextError,
  primaryRepo,
  retentionFacts,
  runnerProject,
  runnerTicket,
} from "./lib/runnerContext";
import { nullable } from "./lib/validators";

/**
 * A known Session must belong to this runner's owner and still be claimed by
 * this runner. Optional identity hints must agree with its durable identity.
 *
 * A local birth can attach before its first accept: in that case projectId
 * is required and membership authorizes the read, not a caller-supplied owner.
 * This query never creates a Session or reserves its id. The first accept
 * independently checks the birth and creates the claim.
 *
 * The caller records the brief durably once, then reuses it on reattachment.
 */
export const forSession = query({
  args: {
    sessionId: v.string(),
    projectId: v.optional(v.string()),
    ticketId: v.optional(nullable(v.string())),
  },
  handler: async (ctx, args) => {
    const caller = await requireRunner(ctx);
    parseId("session", args.sessionId);
    const session = await ctx.db
      .query("sessions")
      .withIndex("by_uuid", (q) => q.eq("id", args.sessionId))
      .unique();
    let projectId = args.projectId;
    let ticketId = args.ticketId ?? null;
    if (session !== null) {
      if (session.deletedAt !== null)
        throw contextError("not_found", "That session does not exist.");
      if (session.ownerUserId !== caller.ownerUserId) {
        throw contextError("not_your_runner", "This runner does not run that owner's work.");
      }
      const intake = await ctx.db
        .query("sessionIntake")
        .withIndex("by_session", (q) => q.eq("sessionId", session.id))
        .unique();
      if (
        intake === null ||
        intake.state === "released" ||
        intake.claim.runnerId !== caller.runnerId
      ) {
        throw contextError("fenced", "This runner no longer holds the session's claim.");
      }
      if (
        (args.projectId !== undefined && args.projectId !== session.projectId) ||
        (args.ticketId !== undefined && args.ticketId !== session.ticketId)
      ) {
        throw contextError("invalid_request", "The requested context does not match this session.");
      }
      projectId = session.projectId;
      ticketId = session.ticketId;
    }
    if (projectId === undefined) {
      throw contextError("invalid_request", "A new session's context needs its project id.");
    }
    const project = await runnerProject(ctx, caller, projectId);
    const ticket = ticketId === null ? null : await runnerTicket(ctx, ticketId, project.id);
    const body =
      ticket === null
        ? null
        : await ctx.db
            .query("ticketBodies")
            .withIndex("by_ticket", (q) => q.eq("ticketId", ticket.id))
            .unique();
    return {
      sessionId: args.sessionId,
      ownerUserId: caller.ownerUserId,
      project: publicRow(project),
      ticket: ticket === null ? null : publicRow(ticket),
      body: ticket === null ? null : (body?.body ?? ""),
      ticketPrefix: project.ticketPrefix,
      primaryRepo: await primaryRepo(ctx, project),
      retention: await retentionFacts(ctx, ticket),
    };
  },
});

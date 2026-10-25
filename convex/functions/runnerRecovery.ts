/**
 * What a runner's restart resume (VC-450) reads from the backend before it
 * continues a turn its lost process cut short: whether another Session on
 * the same Ticket moved on since the loss, wherever that Session runs.
 *
 * The runner's own ledger only holds the Sessions this machine ran. A
 * sibling a person continued from another runner is known here, from its
 * accepted facts, so the "superseded" rule must be asked of this read too.
 * The rule itself is the shared one (`ticketSiblingMovedOn`, `@volli/shared`),
 * applied to each sibling's newest accepted commands and receipts. Nothing a
 * sibling said leaves this function: the runner gets one answer per sibling.
 *
 * Every read is bounded. An answer this read cannot give inside its bounds is
 * `null` (or `complete: false` for the sibling list), never a guess: the
 * runner then leaves the turn for the person.
 */
import { v } from "convex/values";

import { ticketSiblingMovedOn, type CommandReceipt, type SessionCommand } from "@volli/shared";
import { canSeeSession, parseId, type UserId, type WorkspaceId } from "@volli/shared/cloud";

import type { Doc } from "./_generated/dataModel.js";
import { query, type QueryCtx } from "./_generated/server";
import { findMembership, findPolicy, sessionFacts } from "./lib/auth";
import { requireRunner } from "./lib/runnerAuth";
import { contextError, runnerProject, runnerTicket } from "./lib/runnerContext";
import { readStoredFact } from "./lib/sessionIntake";
import { nullable } from "./lib/validators";

/** Sibling Sessions judged per read, most recently active first. */
export const RECOVERY_SIBLING_LIMIT = 16;
/** A sibling's newest command facts read. */
export const RECOVERY_COMMAND_WINDOW = 32;
/** A sibling's newest receipt facts read. */
export const RECOVERY_RECEIPT_WINDOW = 64;

/**
 * The siblings of one Session on its Ticket, as this runner's owner can see
 * them, each answered `movedOn` since `since` (epoch ms, the loss).
 *
 * A known Session must be the owner's and still claimed by this runner: a
 * runner that lost the claim must not continue the Session at all. A local
 * birth no accept has registered yet is authorized by project membership and
 * its Ticket, as `runnerContext.forSession` authorizes its first brief.
 */
export const ticketSiblings = query({
  args: {
    sessionId: v.string(),
    projectId: v.string(),
    ticketId: nullable(v.string()),
    since: v.number(),
  },
  handler: async (ctx, args) => {
    const caller = await requireRunner(ctx);
    parseId("session", args.sessionId);
    const session = await ctx.db
      .query("sessions")
      .withIndex("by_uuid", (q) => q.eq("id", args.sessionId))
      .unique();
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
        intake.state !== "active" ||
        intake.claim.runnerId !== caller.runnerId
      ) {
        throw contextError("fenced", "This runner no longer holds the session's claim.");
      }
      if (args.projectId !== session.projectId || args.ticketId !== session.ticketId) {
        throw contextError("invalid_request", "The requested context does not match this session.");
      }
    }
    const project = await runnerProject(ctx, caller, args.projectId);
    if (args.ticketId === null) return { siblings: [], complete: true };
    await runnerTicket(ctx, args.ticketId, project.id);
    const workspace = { workspaceId: project.workspaceId as WorkspaceId };
    const membership = await findMembership(ctx, project.workspaceId, caller.ownerUserId);
    const policy = await findPolicy(ctx, project.workspaceId);
    const viewer = { userId: caller.ownerUserId as UserId };
    const ticketId = args.ticketId;
    const rows = await ctx.db
      .query("sessions")
      .withIndex("by_ticket_activity", (q) => q.eq("ticketId", ticketId))
      .order("desc")
      .take(RECOVERY_SIBLING_LIMIT + 2);
    const candidates = rows.filter((row) => row.id !== args.sessionId);
    const complete = candidates.length <= RECOVERY_SIBLING_LIMIT;
    const siblings: { sessionId: string; movedOn: boolean | null }[] = [];
    for (const row of candidates.slice(0, RECOVERY_SIBLING_LIMIT)) {
      if (
        row.deletedAt !== null ||
        row.projectId !== project.id ||
        !canSeeSession(viewer, sessionFacts(row), workspace, membership, policy)
      ) {
        continue;
      }
      siblings.push({ sessionId: row.id, movedOn: await movedOnSince(ctx, row, args.since) });
    }
    return { siblings, complete };
  },
});

/**
 * The shared rule over a sibling's newest accepted commands, or `null` when
 * the window cannot settle it: every command it read is newer than `since`,
 * so an older start a person made after the loss may lie beyond it.
 */
async function movedOnSince(
  ctx: Pick<QueryCtx, "db">,
  session: Doc<"sessions">,
  since: number,
): Promise<boolean | null> {
  const commandRows = await ctx.db
    .query("sessionEvents")
    .withIndex("by_session_kind", (q) =>
      q.eq("sessionId", session.id).eq("kind", "command.recorded"),
    )
    .order("desc")
    .take(RECOVERY_COMMAND_WINDOW + 1);
  const receiptRows = await ctx.db
    .query("sessionEvents")
    .withIndex("by_session_kind", (q) =>
      q.eq("sessionId", session.id).eq("kind", "command.receipt.recorded"),
    )
    .order("desc")
    .take(RECOVERY_RECEIPT_WINDOW);
  const commands: SessionCommand[] = [];
  for (const row of commandRows.slice(0, RECOVERY_COMMAND_WINDOW).toReversed()) {
    const read = readStoredFact(row);
    // A command fact this build cannot read could be a start: no answer.
    if (read.quarantine !== null || !read.kindKnown) return null;
    if (read.event.payload.kind === "command.recorded") commands.push(read.event.payload.command);
  }
  const receipts: CommandReceipt[] = [];
  for (const row of receiptRows.toReversed()) {
    const read = readStoredFact(row);
    // An unreadable receipt only loses a rejection, which reads as moved on.
    if (read.quarantine === null && read.kindKnown) {
      if (read.event.payload.kind === "command.receipt.recorded")
        receipts.push(read.event.payload.receipt);
    }
  }
  const movedOn = ticketSiblingMovedOn(
    { turnActive: session.turnActive, commands, receipts },
    since,
  );
  if (movedOn) return true;
  const truncated = commandRows.length > RECOVERY_COMMAND_WINDOW;
  const oldest = commands[0];
  return truncated && (oldest === undefined || oldest.createdAt > since) ? null : false;
}

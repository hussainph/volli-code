/**
 * Needs-you attention items: the ONE writer of `attentionItems`.
 *
 * Every producer raises and clears through here: the Session fold
 * (`sessionDerived.ts`: Engine attention, interactions, blocked signals,
 * quarantined facts), board events (`BoardWrite.append` → {@link onBoardEvents}:
 * review requests), runners (credential reuse in `runners.ts`, `volli notify`
 * through `attention.raiseFromRunner`), people (`attention.markSeen`) and the
 * access sweep (`attention.sweepAccess`). Later producers (mentions,
 * environment failures, billing) call {@link raiseAttention} and
 * {@link clearAttention} too.
 *
 * PUSH HOOK (push notifications, not built yet): {@link raiseAttention} and
 * {@link clearAttentionItem} (behind every clear) are where the push fan-out
 * gets scheduled, and nowhere else. A raise that inserts a row or reopens a
 * cleared one is an edge; a raise that rewrites an item that is already open
 * is not; a clear is the retraction every device follows (an item answered on
 * one device disappears everywhere). The fan-out must re-check
 * {@link attentionVisibility} before it sends: a producer that raises for a
 * Session's owner does not re-check their membership. Nothing is scheduled
 * yet: no push table or function ships before its caller.
 *
 * Reads go through {@link attentionVisibility}: an item is shown to the
 * person it names while they are an active Member of its project's CURRENT
 * Workspace (`canSeeAttention`, looked up at read time). The sweep only keeps
 * stored rows honest for counts and pushes; it is never what hides an item.
 */

import type { GenericDatabaseReader, GenericDatabaseWriter } from "convex/server";

import {
  canSeeAttention,
  renderTicketKey,
  reviewAttentionId,
  reviewFactsAfter,
  reviewRequestee,
  reviewTicketIds,
  runnerAlertAttentionId,
  sessionAttentionId,
  type Actor,
  type AttentionClearedReason,
  type AttentionSource,
  type BoardEventDraft,
  isActiveMember,
  quarantineSourceId,
  type MembershipFacts,
  type RunnerAlert,
  type UserId,
  type WorkspaceId,
} from "@volli/shared/cloud";

export { SESSION_BLOCKED_SOURCE_ID } from "@volli/shared/cloud";

import type { DataModel, Doc } from "../_generated/dataModel.js";
import { findMembership, isShownProject } from "./auth";

type Reader = { db: GenericDatabaseReader<DataModel> };
type Writer = { db: GenericDatabaseWriter<DataModel> };

// ── the writer ─────────────────────────────────────────────────────────────────

/** One item as a producer raises it. The id is the producer's frozen derivation. */
export interface AttentionDraft {
  id: string;
  userId: string;
  projectId: string | null;
  /** A billing item's Workspace; omitted for every other item. */
  workspaceId?: string | null;
  ticketId: string | null;
  sessionId: string | null;
  source: AttentionSource;
  sourceId: string;
  kind: string;
  title: string;
  detail: string | null;
  raisedAt: number;
}

/** What a raise did: `raised` is an edge (a new item, or a cleared one open again). */
export type RaiseOutcome = "raised" | "updated";

export async function findAttention(
  ctx: Reader,
  id: string,
): Promise<Doc<"attentionItems"> | null> {
  return ctx.db
    .query("attentionItems")
    .withIndex("by_uuid", (q) => q.eq("id", id))
    .unique();
}

/**
 * Raises an item, or brings an existing one up to date. Who it belongs to and
 * where (person, project, ticket, Session) are fixed at the first raise; the
 * content and `raisedAt` follow the latest raise. An item that was cleared
 * opens again unseen; one that is still open keeps its `seenAt`.
 */
export async function raiseAttention(ctx: Writer, draft: AttentionDraft): Promise<RaiseOutcome> {
  const content = {
    source: draft.source,
    sourceId: draft.sourceId,
    kind: draft.kind,
    title: draft.title,
    detail: draft.detail,
    raisedAt: draft.raisedAt,
    clearedAt: null,
    clearedReason: null,
  };
  const existing = await findAttention(ctx, draft.id);
  if (existing === null) {
    await ctx.db.insert("attentionItems", {
      id: draft.id,
      userId: draft.userId,
      projectId: draft.projectId,
      ...(draft.workspaceId === undefined ? {} : { workspaceId: draft.workspaceId }),
      ticketId: draft.ticketId,
      sessionId: draft.sessionId,
      seenAt: null,
      ...content,
    });
    return "raised";
  }
  const reopened = existing.clearedAt !== null;
  await ctx.db.patch(existing._id, reopened ? { ...content, seenAt: null } : content);
  return reopened ? "raised" : "updated";
}

/** Clears an open item; a missing or already cleared one is left as it is. Reports whether it cleared. */
export async function clearAttention(
  ctx: Writer,
  id: string,
  reason: AttentionClearedReason,
  at: number,
): Promise<boolean> {
  return clearAttentionItem(ctx, await findAttention(ctx, id), reason, at);
}

/** Clears an item already read; every clear ends here. */
export async function clearAttentionItem(
  ctx: Writer,
  item: Doc<"attentionItems"> | null,
  reason: AttentionClearedReason,
  at: number,
): Promise<boolean> {
  if (item === null || item.clearedAt !== null) return false;
  await ctx.db.patch(item._id, { clearedAt: at, clearedReason: reason });
  return true;
}

/** Marks the person's own open item seen. A `notify` item has done its job once seen, so it clears. */
export async function markAttentionSeen(
  ctx: Writer,
  item: Doc<"attentionItems">,
  at: number,
): Promise<boolean> {
  if (item.clearedAt !== null) return false;
  if (item.source === "notify") return clearAttentionItem(ctx, item, "resolved", at);
  if (item.seenAt !== null) return false;
  await ctx.db.patch(item._id, { seenAt: at });
  return true;
}

// ── Session items ──────────────────────────────────────────────────────────────

/** A Session's item, for its owner, in its project and ticket. */
export async function raiseSessionAttention(
  ctx: Writer,
  session: Doc<"sessions">,
  item: {
    source: AttentionSource;
    sourceId: string;
    kind: string;
    title: string | undefined;
    detail: string | null;
    raisedAt: number;
  },
): Promise<RaiseOutcome> {
  return raiseAttention(ctx, {
    id: sessionAttentionId(session.id, item.sourceId),
    userId: session.ownerUserId,
    projectId: session.projectId,
    ticketId: session.ticketId,
    sessionId: session.id,
    source: item.source,
    sourceId: item.sourceId,
    kind: item.kind,
    title: item.title ?? item.kind,
    detail: item.detail,
    raisedAt: item.raisedAt,
  });
}

export async function clearSessionAttention(
  ctx: Writer,
  sessionId: string,
  sourceId: string,
  reason: "resolved" | "superseded",
  at: number,
): Promise<void> {
  await clearAttention(ctx, sessionAttentionId(sessionId, sourceId), reason, at);
}

/** A fact the backend could not read or fold is loud: its owner sees it in Needs you. */
export async function raiseQuarantine(
  ctx: Writer,
  session: Doc<"sessions">,
  envelope: { sequence: number; kind: string; occurredAt: number },
  quarantine: { code: string; detail: string },
): Promise<void> {
  await raiseSessionAttention(ctx, session, {
    source: "runner_alert",
    sourceId: quarantineSourceId(envelope.sequence),
    kind: "event_quarantined",
    title: "A session event could not be read",
    detail: `${envelope.kind || "(no kind)"} at ${envelope.sequence}: ${quarantine.detail}`,
    raisedAt: envelope.occurredAt,
  });
}

// ── review requests (board events) ─────────────────────────────────────────────

/**
 * Re-derives the review requests of every ticket a board write's events
 * touched (`reviewTicketIds`): the ticket's requested person (its assignee,
 * while it sits in Needs Review, unless they made the change, and only while
 * they are an active Member of the project's Workspace) has one open
 * `review_requested` item and nobody else does. Leaving the column clears it
 * as `resolved`; a new assignee or an archive clears the old one as
 * `superseded`. Called by `BoardWrite.append`, the one place a board write
 * appends events (the migration import copies history and derives nothing).
 */
export async function onBoardEvents(
  ctx: Writer,
  write: { projectId: string; actor: Actor; at: number; events: readonly BoardEventDraft[] },
): Promise<void> {
  const ticketIds = reviewTicketIds(write.events);
  if (ticketIds.length === 0) return;
  const project = await ctx.db
    .query("projects")
    .withIndex("by_uuid", (q) => q.eq("id", write.projectId))
    .unique();
  if (project === null) return;
  const members = new Map<string, boolean>();
  const isMember = async (userId: UserId): Promise<boolean> => {
    if (!members.has(userId)) {
      const membership = await findMembership(ctx, project.workspaceId, userId);
      members.set(
        userId,
        isActiveMember({ userId }, project.workspaceId as WorkspaceId, membership),
      );
    }
    return members.get(userId)!;
  };
  for (const ticketId of ticketIds) {
    const ticket = await ctx.db
      .query("tickets")
      .withIndex("by_uuid", (q) => q.eq("id", ticketId))
      .unique();
    if (ticket === null || ticket.projectId !== write.projectId) continue;
    const facts = reviewFactsAfter(
      {
        status: ticket.status,
        assigneeUserId: ticket.assigneeUserId as UserId | null,
        archived: ticket.archivedAt !== null || ticket.deletedAt !== null,
      },
      ticketId,
      write.events,
    );
    const asked = reviewRequestee(facts, write.actor);
    // Nobody who cannot see the ticket is asked to review it.
    const requestee = asked !== null && (await isMember(asked)) ? asked : null;
    const open = await ctx.db
      .query("attentionItems")
      .withIndex("by_ticket", (q) =>
        q.eq("ticketId", ticketId).eq("source", "review_requested").eq("clearedAt", null),
      )
      .collect();
    for (const item of open) {
      if (item.userId === requestee) continue;
      await clearAttentionItem(
        ctx,
        item,
        facts.status === "needs_review" ? "superseded" : "resolved",
        write.at,
      );
    }
    if (requestee === null) continue;
    const id = reviewAttentionId(ticketId, requestee);
    if (open.some((item) => item.id === id)) continue;
    await raiseAttention(ctx, {
      id,
      userId: requestee,
      projectId: write.projectId,
      ticketId,
      sessionId: null,
      source: "review_requested",
      sourceId: ticketId,
      kind: "review_requested",
      title: `${renderTicketKey(project, ticket.number)} needs your review`,
      detail: ticket.title,
      raisedAt: write.at,
    });
  }
}

// ── runner alerts ──────────────────────────────────────────────────────────────

const RUNNER_ALERT_TEXT: Record<RunnerAlert, (name: string) => { title: string; detail: string }> =
  {
    credential_reuse: (name) => ({
      title: `${name} was disconnected`,
      detail:
        "Its credential was used from two places, which can mean it was copied. Remove the runner and link it again to keep using it.",
    }),
  };

/** A runner alert for the runner's owner. It belongs to no project, so only its person sees it. */
export async function raiseRunnerAlert(
  ctx: Writer,
  runner: Pick<Doc<"runners">, "id" | "ownerUserId" | "name">,
  alert: RunnerAlert,
  at: number,
): Promise<void> {
  await raiseAttention(ctx, {
    id: runnerAlertAttentionId(runner.id, alert),
    userId: runner.ownerUserId,
    projectId: null,
    ticketId: null,
    sessionId: null,
    source: "runner_alert",
    sourceId: runner.id,
    kind: alert,
    ...RUNNER_ALERT_TEXT[alert](runner.name),
    raisedAt: at,
  });
}

export async function clearRunnerAlert(
  ctx: Writer,
  runnerId: string,
  alert: RunnerAlert,
  at: number,
): Promise<void> {
  await clearAttention(ctx, runnerAlertAttentionId(runnerId, alert), "resolved", at);
}

// ── access ───────────────────────────────────────────────────────────────────

/** The Workspace an item belongs to: its project's current one, a billing item's own, or none. */
type ItemScope = { workspaceId: WorkspaceId } | null;

/**
 * Where items live, for many items in one transaction: each project and
 * Workspace is read once. `gone` is an item whose project or Workspace was
 * deleted (or never existed).
 */
function itemScopes(ctx: Reader): (item: Doc<"attentionItems">) => Promise<ItemScope | "gone"> {
  const projects = new Map<string, ItemScope | "gone">();
  const workspaces = new Map<string, boolean>();
  const liveWorkspace = async (workspaceId: string): Promise<boolean> => {
    let live = workspaces.get(workspaceId);
    if (live === undefined) {
      const row = await ctx.db
        .query("workspaces")
        .withIndex("by_uuid", (q) => q.eq("id", workspaceId))
        .unique();
      live = row !== null && row.deletedAt === null;
      workspaces.set(workspaceId, live);
    }
    return live;
  };
  return async (item) => {
    const projectId = item.projectId;
    const workspaceId = item.workspaceId ?? null;
    if (projectId === null) {
      if (workspaceId === null) return null;
      return (await liveWorkspace(workspaceId))
        ? { workspaceId: workspaceId as WorkspaceId }
        : "gone";
    }
    let scope = projects.get(projectId);
    if (scope === undefined) {
      const project = await ctx.db
        .query("projects")
        .withIndex("by_uuid", (q) => q.eq("id", projectId))
        .unique();
      scope =
        project === null || !isShownProject(project) || !(await liveWorkspace(project.workspaceId))
          ? "gone"
          : { workspaceId: project.workspaceId as WorkspaceId };
      projects.set(projectId, scope);
    }
    return scope;
  };
}

/**
 * Who sees what, for one person over many items: projects, Workspaces and
 * memberships are each looked up once. An item whose project or Workspace is
 * gone is shown to nobody.
 */
export function attentionVisibility(
  ctx: Reader,
  viewer: { userId: UserId },
): (item: Doc<"attentionItems">) => Promise<boolean> {
  const scopeOf = itemScopes(ctx);
  const memberships = new Map<string, MembershipFacts | null>();
  const membershipOf = async (workspaceId: string): Promise<MembershipFacts | null> => {
    if (!memberships.has(workspaceId)) {
      memberships.set(workspaceId, await findMembership(ctx, workspaceId, viewer.userId));
    }
    return memberships.get(workspaceId)!;
  };
  return async (item) => {
    if (item.userId !== viewer.userId) return false;
    const scope = await scopeOf(item);
    if (scope === "gone") return false;
    const membership = scope === null ? null : await membershipOf(scope.workspaceId);
    return canSeeAttention(viewer, { userId: item.userId as UserId }, scope, membership);
  };
}

/** Whether an item lives in `workspaceId`: through its project's current Workspace, or its own. */
export function inWorkspace(
  ctx: Reader,
  workspaceId: string,
): (item: Doc<"attentionItems">) => Promise<boolean> {
  const scopeOf = itemScopes(ctx);
  return async (item) => {
    const scope = await scopeOf(item);
    return scope !== null && scope !== "gone" && scope.workspaceId === workspaceId;
  };
}

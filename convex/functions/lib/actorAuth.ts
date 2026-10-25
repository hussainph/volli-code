/**
 * Who is acting: a person through a client, or an agent through its runner.
 *
 * {@link requireActor} is how a function that agents may call starts. It
 * resolves the caller to the `viewer` every membership check reads and the
 * Actor every write records:
 *
 * - **A person** (a sign-in token) resolves to their own `users` row and a
 *   `person` Actor, exactly as {@link requireViewer} does.
 * - **An agent** (an Agent token, `agent:<sessionId>`, minted by
 *   `agentTokens.mint` for its runner) resolves to the Session OWNER as the
 *   viewer and an `agent` Actor naming the Session. Every call re-checks what
 *   the token was minted under, so nothing waits for it to expire:
 *   - the Session still exists and is still the token's owner's;
 *   - the claim is still the same runner at the same generation (a transfer to
 *     another runner, or a release, is `fenced`);
 *   - the runner is not removed and still belongs to that owner, and the
 *     owner's account is active (`revoked`).
 *
 *   Membership is then checked on the owner like any person's, by the same
 *   helpers, so an agent can do exactly what its owner can and no more.
 *
 * A function that leaves `agent` out of `allow` is person-only: an agent is
 * `not_a_person` there, as a runner token is everywhere a person is wanted.
 * Person-only by default is the safe failure: every helper that resolves its
 * own viewer ({@link requireViewer}) refuses agents, so only a function that
 * asks for {@link requireActor} and passes the viewer on admits one.
 */

import type { GenericDatabaseReader, UserIdentity } from "convex/server";
import { ConvexError } from "convex/values";

import {
  readAgentTokenClaims,
  sessionIdFromAgentSubject,
  type AgentActor,
  type PersonActor,
  type RunnerId,
  type SessionId,
  type TicketId,
  type UserId,
} from "@volli/shared/cloud";

import type { DataModel, Doc } from "../_generated/dataModel.js";
import { authError, requireIdentity, requireViewer, type Viewer } from "./auth";
import { isAgentIdentity } from "./runnerAuth";

export type CallerKind = "person" | "agent";

/** Who may call a function: a person only, or a person or an agent. */
export const PERSON_ONLY: readonly CallerKind[] = Object.freeze(["person"]);
export const PERSON_OR_AGENT: readonly CallerKind[] = Object.freeze(["person", "agent"]);

/** The Session an agent caller acts in, as its token and the claim say. */
export interface AgentScope {
  sessionId: SessionId;
  session: Doc<"sessions">;
  ticketId: TicketId | null;
  runnerId: RunnerId;
}

/** A resolved caller: the viewer membership is checked on, and the Actor writes record. */
export type Caller =
  | { kind: "person"; viewer: Viewer; actor: PersonActor; agent: null }
  | { kind: "agent"; viewer: Viewer; actor: AgentActor; agent: AgentScope };

export type AgentAuthErrorCode = "fenced" | "revoked";

function agentError(code: AgentAuthErrorCode, message: string) {
  return new ConvexError({ code, message });
}

type ReadCtx = {
  auth: { getUserIdentity(): Promise<UserIdentity | null> };
  db: GenericDatabaseReader<DataModel>;
};

/** The caller, if `allow` admits its kind; `not_a_person` for an agent where only people may act. */
export async function requireActor(
  ctx: ReadCtx,
  allow: readonly CallerKind[] = PERSON_ONLY,
): Promise<Caller> {
  const identity = await requireIdentity(ctx);
  if (!isAgentIdentity(identity)) {
    const viewer = await requireViewer(ctx);
    return {
      kind: "person",
      viewer,
      actor: { kind: "person", userId: viewer.userId },
      agent: null,
    };
  }
  if (!allow.includes("agent")) {
    throw authError("not_a_person", "Only a person can do this, not an agent.");
  }
  return resolveAgent(ctx, identity);
}

async function resolveAgent(ctx: ReadCtx, identity: UserIdentity): Promise<Caller> {
  const sessionId = sessionIdFromAgentSubject(identity.subject);
  const claims = readAgentTokenClaims(identity as unknown as Record<string, unknown>);
  if (sessionId === null || claims === null) {
    throw authError("unauthenticated", "This agent token is not one this backend issues.");
  }
  const session = await ctx.db
    .query("sessions")
    .withIndex("by_uuid", (q) => q.eq("id", sessionId))
    .unique();
  if (session === null || session.deletedAt !== null) {
    throw authError("not_found", "That session does not exist.");
  }
  if (session.ownerUserId !== claims.own) {
    throw agentError("fenced", "This session's owner changed since its agent token was minted.");
  }
  const intake = await ctx.db
    .query("sessionIntake")
    .withIndex("by_session", (q) => q.eq("sessionId", sessionId))
    .unique();
  if (
    intake === null ||
    intake.state === "released" ||
    intake.claim.runnerId !== claims.rnr ||
    intake.claim.generation !== claims.gen
  ) {
    throw agentError("fenced", "Another runner holds this session now.");
  }
  const runner = await ctx.db
    .query("runners")
    .withIndex("by_uuid", (q) => q.eq("id", claims.rnr))
    .unique();
  if (runner === null || runner.revokedAt !== null || runner.ownerUserId !== claims.own) {
    throw agentError("revoked", "This session's runner was removed from its account.");
  }
  const owner = await ctx.db
    .query("users")
    .withIndex("by_uuid", (q) => q.eq("id", claims.own))
    .unique();
  if (owner === null || owner.status !== "active") {
    throw agentError("revoked", "This session's owner's account is closing or closed.");
  }
  const ticketId = (session.ticketId ?? null) as TicketId | null;
  const userId = owner.id as UserId;
  return {
    kind: "agent",
    viewer: { userId, user: owner },
    actor: { kind: "agent", userId, sessionId, ticketId },
    agent: { sessionId, session, ticketId, runnerId: claims.rnr },
  };
}

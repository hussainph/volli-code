/**
 * The Agent token: how an agent's verb reaches the backend without the agent
 * ever holding a backend credential.
 *
 * An agent holds only its attachment's Session token, good at its own
 * runner's socket. The runner turns a verified call into a backend call under
 * an Agent token: a short-lived ES256 JWT the backend mints (`agentTokens.mint`)
 * for ONE Session that the calling runner claims and whose owner owns that
 * runner. The token lives in runner memory only. Its subject is
 * `agent:<sessionId>`; the backend resolves it to an `agent` Actor acting for
 * the Session owner, and re-checks the claim on every call, so a claim that
 * moved to another runner (or a removed runner) ends it at once.
 *
 * The issuer is its own, beside the runner token's, and signed with the same
 * deployment key: an Agent token can never pass for a Runner token (or the
 * other way round), because a function tells them apart by issuer before it
 * reads a single claim.
 */

import { readId, type RunnerId, type SessionId, type TicketId, type UserId } from "./ids";

/** The `iss` of every Agent token. Names the role, as the runner token's does. */
export const AGENT_TOKEN_ISSUER = "https://agents.volli.app";
/** The `aud` of every Agent token. */
export const AGENT_TOKEN_AUDIENCE = "volli-agent";
/** How long an Agent token lives. The runner refreshes it at two thirds of that, on server time. */
export const AGENT_TOKEN_TTL_MS = 15 * 60_000;

const AGENT_SUBJECT_PREFIX = "agent:";

/** The token subject for an agent: `agent:<sessionId>`. */
export function agentSubject(sessionId: SessionId): string {
  return `${AGENT_SUBJECT_PREFIX}${sessionId}`;
}

/** The Session an Agent token subject names, or `null` when it names none. */
export function sessionIdFromAgentSubject(subject: string): SessionId | null {
  if (!subject.startsWith(AGENT_SUBJECT_PREFIX)) return null;
  return readId("session", subject.slice(AGENT_SUBJECT_PREFIX.length));
}

/** The claims an Agent token carries beside `iss`, `aud`, `sub`, `iat` and `exp`. */
export interface AgentTokenClaims {
  /** The Session owner the agent acts for. */
  own: UserId;
  /** The runner that claimed the Session when the token was minted. */
  rnr: RunnerId;
  /** The claim generation it was minted under: a later claim (a transfer) fences it. */
  gen: number;
  /** The Session's ticket, or `null` for a project Session. */
  tkt: TicketId | null;
}

/**
 * The claims of a verified identity, or `null` when any is missing or not of
 * its shape. The backend verified the signature; this checks the shape it
 * signed, so a token from an older build reads as unusable rather than as
 * some other owner.
 */
export function readAgentTokenClaims(identity: Record<string, unknown>): AgentTokenClaims | null {
  const own = readId("user", identity["own"]);
  const rnr = readId("runner", identity["rnr"]);
  const gen = identity["gen"];
  const tkt = identity["tkt"];
  if (own === null || rnr === null) return null;
  if (typeof gen !== "number" || !Number.isInteger(gen) || gen < 0) return null;
  if (tkt === null || tkt === undefined) return { own, rnr, gen, tkt: null };
  const ticketId = readId("ticket", tkt);
  return ticketId === null ? null : { own, rnr, gen, tkt: ticketId };
}

/** What `agentTokens.mint` answers. */
export interface AgentTokenGrant {
  token: string;
  /** When it expires, on the backend's clock (ms). */
  expiresAt: number;
  /** The backend's clock when it was minted, so a runner with a wrong clock still refreshes on time. */
  serverTime: number;
}

/** Why the backend refused to mint an Agent token (or to honour one). */
const AGENT_TOKEN_ERROR_CODES = [
  // No Session by that id has reached the backend yet (the drain has not
  // landed its `session.create`): transient, retry after the drain.
  "unknown_session",
  // No runner holds the Session, or another one does (or the claim moved
  // since the token was minted).
  "not_claimed",
  "fenced",
  // The Session's owner is not this runner's owner, or no longer a member.
  "forbidden",
  // The runner was removed or its owner's account is closing.
  "revoked",
  // The deployment has no signing key: no runner can get a token.
  "issuer_unconfigured",
] as const;
export type AgentTokenErrorCode = (typeof AGENT_TOKEN_ERROR_CODES)[number];

/** Reads an `agentTokens.mint` reply; throws on anything else. */
export function parseAgentTokenGrant(value: unknown): AgentTokenGrant {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("An agent token grant must be an object");
  }
  const fields = value as Record<string, unknown>;
  const { token, expiresAt, serverTime } = fields;
  if (typeof token !== "string" || token === "" || token.length > 8_192) {
    throw new TypeError("An agent token grant needs its token");
  }
  if (typeof expiresAt !== "number" || typeof serverTime !== "number" || expiresAt <= serverTime) {
    throw new TypeError("An agent token grant needs expiresAt after serverTime");
  }
  return { token, expiresAt, serverTime };
}

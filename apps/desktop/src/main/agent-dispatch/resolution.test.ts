/**
 * Who the socket door decides its caller is (VC-163).
 *
 * This is the file where "no environment variable means the user" died. The
 * three cases below are the whole of the new contract, and each one used to
 * resolve differently:
 *
 * - a valid token → the authenticated session actor (was: any claim believed)
 * - a claim with no token → `unauthenticated` (was: `session`, believed)
 * - no claim at all → `unauthenticated` (was: `user`, the highest trust in the
 *   system, granted for absence of evidence)
 */

import { describe, expect, it } from "vite-plus/test";

import type { AgentRequest } from "@volli/shared";

import { doorActor, requestActor } from "./resolution";
import type { EnvSessionIdentity } from "./context";

const SESSION: EnvSessionIdentity = {
  id: "session-1",
  projectId: "project-one",
  ticketId: "ticket-one",
};

function request(env: AgentRequest["ctx"]["env"]): AgentRequest {
  return { v: 1, cmd: "board", args: {}, ctx: { cwd: "/repo/volli", env } };
}

/** A door whose registry says `token-1` was minted for `session-1`. */
const verify = (token: string | undefined): string | null =>
  token === "token-1" ? "session-1" : null;

describe("doorActor", () => {
  it("authenticates the Session a valid token was minted for", () => {
    expect(doorActor(request({ session: "session-1", token: "token-1" }), verify)).toEqual({
      kind: "session",
      sessionId: "session-1",
    });
  });

  // A token names its own Session, so it authenticates with no claim beside it.
  // The claim is the weaker half of the pair and was never the evidence.
  it("authenticates a token presented with no claim at all", () => {
    expect(doorActor(request({ token: "token-1" }), verify)).toEqual({
      kind: "session",
      sessionId: "session-1",
    });
  });

  // Costs a map lookup and touches neither database nor Session Engine — which
  // is what lets the `hook` hot path be admitted without the identity
  // resolution its dispatch entry deliberately skips.
  it("needs no resolved identity to answer", () => {
    expect(doorActor(request({}), verify)).toEqual({ kind: "unauthenticated" });
  });
});

describe("requestActor", () => {
  it("returns the authenticated session actor for an authenticated door", () => {
    const actor = requestActor({ kind: "session", sessionId: "session-1" }, SESSION);

    expect(actor).toEqual({
      ok: true,
      actor: { kind: "session", sessionId: "session-1", ticketId: "ticket-one" },
    });
  });

  // The ticket's first named test: a forged `VOLLI_SESSION` with no token
  // resolves to the unauthenticated actor — not to a session, and not to the
  // user. Both halves matter. Resolving to `session` would make the token
  // decorative; resolving to `user` would restore the exact grant-by-absence
  // this ticket exists to remove.
  it("resolves a forged session claim with no token as unauthenticated", () => {
    const door = doorActor(request({ session: "session-1" }), verify);

    expect(door).toEqual({ kind: "unauthenticated" });
    // And the attribution follows it, even though the claimed Session resolves
    // perfectly well: `envSession` is what the CLAIM named, never evidence for
    // it.
    expect(requestActor(door, SESSION)).toEqual({
      ok: true,
      actor: { kind: "unauthenticated" },
    });
  });

  it("resolves a claim carrying a forged token as unauthenticated", () => {
    const door = doorActor(
      request({ session: "session-1", token: "token-for-another-session" }),
      verify,
    );

    expect(door).toEqual({ kind: "unauthenticated" });
  });

  // A token that authenticates a DIFFERENT Session than the one claimed is not
  // an authentication of either. Believing the token over the claim would let a
  // caller act on its own authority while addressing another Session's context;
  // believing the claim over the token is the forgery above.
  it("refuses to reconcile a token and a claim that disagree", () => {
    const door = doorActor(request({ session: "session-2", token: "token-1" }), verify);

    expect(door).toEqual({ kind: "unauthenticated" });
  });

  it("no longer attributes an absent environment as the user", () => {
    const actor = requestActor(doorActor(request({}), verify), null);

    expect(actor).toEqual({ ok: true, actor: { kind: "unauthenticated" } });
    if (actor.ok) expect(actor.actor.kind).not.toBe("user");
  });

  // A valid token for a Session the Engine can no longer resolve is a real
  // error rather than a downgrade: the caller IS authenticated, so telling it
  // "you are anonymous" would misdescribe what went wrong and hide a Session
  // that ended underneath a live attachment.
  it("reports a valid token whose Session no longer resolves", () => {
    const door = doorActor(request({ session: "session-1", token: "token-1" }), verify);

    expect(requestActor(door, null)).toMatchObject({
      ok: false,
      response: { error: { code: "SESSION_NOT_FOUND" } },
    });
  });
});

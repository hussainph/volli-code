/**
 * Per-attachment session tokens: what turns `VOLLI_SESSION`'s claim into an
 * authenticated session actor at the socket door (VC-92 §6.2, built in VC-163).
 *
 * ## What this defends, stated honestly
 *
 * Before this existed, `requestActor` read `VOLLI_SESSION` out of the request
 * environment and believed it — and read its ABSENCE as the `user`, the
 * highest-trust actor in the system, granted on no evidence at all. A token
 * closes two specific holes and no others:
 *
 * 1. **An injected string.** Prose that reaches a model and tells it to export
 *    someone else's `VOLLI_SESSION` now buys nothing: the id without the token
 *    is not that Session.
 * 2. **Cross-session confusion.** An environment inherited from an outer Volli,
 *    a copied variable, a stale export — all of them named a Session that was
 *    not the caller. (The inherited case is closed from the other side too:
 *    `VOLLI_SESSION_TOKEN` is in `scrubInheritedSessionEnv`'s contract list.)
 *
 * **It does not defend against a hostile process running as the same user.**
 * That process can read this token out of any environment it can see, exactly
 * as it can read the socket path out of the shim — and the socket is a
 * filesystem object owned by that same user. No secret placed in a same-uid
 * environment can fix a same-uid threat, and pretending otherwise would be
 * worse than the honest limit, because it would invite putting dangerous verbs
 * behind it.
 *
 * That residue is precisely why VC-92 put the control tier on the Agent Tool
 * Surface rather than behind this check. A named tool call is bound to the
 * attachment it came through, in-process, and never crosses a socket; there is
 * no credential to steal because there is no credential. This registry raises
 * the floor for the coordination tier. Absence raises the ceiling for the
 * control tier, and only absence could.
 *
 * ## Why memory, and not the database
 *
 * A token's life is one attachment's life, and no attachment survives the
 * process that hosts it: a PTY is a child of this Electron process, and a
 * structured attachment is a live runtime binding inside it. A durable token
 * would therefore outlive every process that could ever present it — a
 * credential nothing will revoke, sitting in a file, for a Session that ended
 * months ago. Losing the whole table on quit is not a limitation of this
 * design; it is the correct lifetime expressed as storage.
 */

import { randomBytes } from "node:crypto";

export interface SessionTokenRegistry {
  /**
   * Mint this attachment's token, retiring any it already held.
   *
   * Re-minting rather than reusing is what keeps the table bounded to live
   * attachments: a reattachment gets a new value and the old one stops working
   * in the same step, so no token is left behind with nothing to revoke it.
   */
  mint(input: { sessionId: string; attachmentId: string }): string;
  /** Retire an attachment's token. A no-op for an attachment that held none. */
  revoke(attachmentId: string): void;
  /**
   * The Session id a token authenticates, or `null` for anything else —
   * absent, empty, forged, or revoked. Callers treat `null` as the
   * unauthenticated actor, never as a reason to fall back to the caller's
   * claim.
   */
  verify(token: string | undefined): string | null;
}

/** 256 bits, hex-encoded: far past guessing, and safe in an environment variable. */
const TOKEN_BYTES = 32;

export function createSessionTokenRegistry(): SessionTokenRegistry {
  /** token → session id. The lookup direction the door asks in. */
  const sessions = new Map<string, string>();
  /** attachment → its current token, so a revoke needs no scan. */
  const byAttachment = new Map<string, string>();

  return {
    mint({ sessionId, attachmentId }) {
      const previous = byAttachment.get(attachmentId);
      if (previous !== undefined) sessions.delete(previous);
      const token = randomBytes(TOKEN_BYTES).toString("hex");
      sessions.set(token, sessionId);
      byAttachment.set(attachmentId, token);
      return token;
    },
    revoke(attachmentId) {
      const token = byAttachment.get(attachmentId);
      if (token === undefined) return;
      sessions.delete(token);
      byAttachment.delete(attachmentId);
    },
    verify(token) {
      // No constant-time compare, and the reason is the threat model above
      // rather than an oversight: this is a hash lookup of a 256-bit random
      // value by a caller who, if hostile and same-uid, can read the token
      // itself. A timing oracle is not the cheapest attack available to anyone
      // who can reach this socket.
      if (token === undefined || token.length === 0) return null;
      return sessions.get(token) ?? null;
    },
  };
}

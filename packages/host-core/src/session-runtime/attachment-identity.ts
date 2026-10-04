/**
 * The Volli identity one attachment's commands run under, built ONCE per
 * attachment and handed to every door that needs it (VC-270).
 *
 * Two doors need it today: the `execute` tool's execution environment, and
 * the background shell port. Both export `VOLLI_SESSION`, `VOLLI_TICKET` and
 * `VOLLI_SESSION_TOKEN` into a child, and the token is the landmine:
 * `SessionTokenRegistry.mint` RETIRES the attachment's previous token on
 * every call, so two doors that each minted their own would leave the
 * first-minted one — already exported into a running `execute` — silently
 * refused at the socket. `volli` calls from the execute tool would start
 * failing the moment a shell started. So the identity is memoized here by
 * attachment id, and the two doors resolve the same object.
 *
 * Release is the execution environment's cleanup, which runs on every path
 * an attachment ends by; the shell port's dispose kills its shells before
 * that cleanup and needs no revoke of its own.
 */

import type { PiSessionEnvIdentity } from "@volli/agent-runtime";

export interface AttachmentIdentities {
  /** The identity for this attachment: minted on first resolve, the same object after. */
  resolve(input: {
    sessionId: string;
    attachmentId: string;
    ticketId: string | null;
  }): PiSessionEnvIdentity;
  /** Revoke the attachment's token and forget the identity. */
  release(attachmentId: string): void;
}

export interface AttachmentIdentityDependencies {
  mint(input: { sessionId: string; attachmentId: string }): string;
  revoke(attachmentId: string): void;
  /** The Ticket's display id (e.g. `VC-270`), or `null` when the Ticket cannot be named. */
  ticketDisplayIdOf(ticketId: string): string | null;
}

export function createAttachmentIdentities(
  deps: AttachmentIdentityDependencies,
): AttachmentIdentities {
  const byAttachment = new Map<string, PiSessionEnvIdentity>();
  return {
    resolve(input) {
      const known = byAttachment.get(input.attachmentId);
      if (known !== undefined) return known;
      const identity: PiSessionEnvIdentity = {
        sessionId: input.sessionId,
        // Minted per ATTACHMENT, so a structured Session's shell authenticates
        // exactly as a spawned PTY's does (VC-163) — and the token dies with
        // the attachment rather than with the Session.
        sessionToken: deps.mint({ sessionId: input.sessionId, attachmentId: input.attachmentId }),
        // Looked up per attachment, so a Ticket renamed by a prefix change is
        // right on the next attach.
        ticketDisplayId: input.ticketId === null ? null : deps.ticketDisplayIdOf(input.ticketId),
      };
      byAttachment.set(input.attachmentId, identity);
      return identity;
    },
    release(attachmentId) {
      byAttachment.delete(attachmentId);
      deps.revoke(attachmentId);
    },
  };
}

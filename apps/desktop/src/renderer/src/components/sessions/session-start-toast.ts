/**
 * The `session started` toast (VC-13 decision 2). A start that lands over the
 * agent socket must never navigate or steal focus. The title names the launched
 * Session; its description identifies the ticket and door-derived starter.
 * Only the action in `main.tsx` opens the Session. A live roster selector lets
 * a title arriving after the notice update in place, without another toast,
 * fetch, adoption or new subscription to the host.
 */
import type { SessionStartedNotice } from "../../../../ipc/contract";
import { sessionTitleOf, useProjectSessionsStore } from "@renderer/stores/project-sessions";

export interface SessionStartToastModel {
  message: string;
  description: string;
  /** Where the toast's "Open session" action goes. Always present — main resolved the ticket. */
  target: { projectId: string; ticketId: string; sessionId: string };
}

/**
 * The actor phrase preserves door-derived provenance: the human is "you", a
 * driving Session is named by its own ticket when main could resolve one, and
 * automation is automation. A launched Session's title never names its starter.
 *
 * Exhaustive over the actor kinds rather than defaulting to "you" (VC-163).
 * `unauthenticated` cannot reach this toast today — the two remaining
 * `session.start` doors produce a Session or the person at the keyboard — but
 * the type permits it, and a default branch would have announced a caller Volli
 * could not identify as the person reading the toast. That is the whole of what
 * VC-92 §6 ruled dead, and it costs one branch to keep it dead here too.
 */
function actorPhrase(notice: SessionStartedNotice): string {
  switch (notice.actor) {
    case "session":
      return notice.actorTicket === null ? "another Session" : notice.actorTicket;
    case "automation":
      return "automation";
    case "unauthenticated":
      return "an unauthenticated caller";
    case "user":
      return "you";
  }
}

/** Shapes a notice and the matching roster title; never infers caller identity from the title. */
export function sessionStartToastModel(
  notice: SessionStartedNotice,
  title?: string | null,
): SessionStartToastModel {
  return {
    message: title?.trim() ? title : "Session started",
    description: `Started on ${notice.ticketDisplayId} by ${actorPhrase(notice)}`,
    target: {
      projectId: notice.projectId,
      ticketId: notice.ticketId,
      sessionId: notice.sessionId,
    },
  };
}

/** The existing project roster owns identity, including late/renamed titles.
 * Main renders this as the toast title; the notice's authenticated provenance
 * and exact action target stay in the model, independent of the roster.
 */
export function SessionStartToastTitle({ notice }: { notice: SessionStartedNotice }): string {
  const title = useProjectSessionsStore((state) =>
    sessionTitleOf(state.byProject[notice.projectId], notice.sessionId),
  );
  return sessionStartToastModel(notice, title).message;
}

/**
 * The `session started` toast (VC-13 decision 2). A start that lands over the
 * agent socket must never navigate or steal focus. The title names the launched
 * Session; its description identifies the ticket and door-derived starter.
 * Only the action in `main.tsx` opens the Session. A missing title gets one
 * exact-Session projection read; the existing activity intake follows late
 * titles even when this window has never loaded the project's roster.
 */
import { useEffect, useState } from "react";
import type { SessionStartedNotice } from "../../../../ipc/contract";
import { chatTransportFor } from "@renderer/chat/transport";
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

/** Follow one identity without adopting its chat or seeding a partial project.
 * The shared activity intake remains the only host subscription. */
export function SessionStartToastTitle({ notice }: { notice: SessionStartedNotice }): string {
  const title = useProjectSessionsStore((state) =>
    sessionTitleOf(state.byProject[notice.projectId], notice.sessionId),
  );
  const [fallback, setFallback] = useState<{
    projectId: string;
    sessionId: string;
    title: string | null;
  } | null>(null);
  const { projectId, sessionId } = notice;
  useEffect(() => {
    let active = true;
    let receivedActivity = false;
    const update = (next: string | null) => {
      if (!active) return;
      setFallback((previous) =>
        previous?.projectId === projectId &&
        previous.sessionId === sessionId &&
        previous.title === next
          ? previous
          : { projectId, sessionId, title: next },
      );
    };
    // Subscribe before the read: a later pushed row outranks an older read
    // that was already in flight, including an explicitly missing title.
    const off = useProjectSessionsStore.getState().subscribeActivity((activity) => {
      if (
        activity.projectId !== projectId ||
        activity.row.kind !== "chat" ||
        activity.row.record.sessionId !== sessionId
      )
        return;
      receivedActivity = true;
      update(activity.row.record.title);
    });
    if (
      sessionTitleOf(useProjectSessionsStore.getState().byProject[projectId], sessionId) === null
    ) {
      void chatTransportFor(projectId)
        .rpc.session.projection.query({ sessionId })
        .then((result) => {
          const session = result.projection.session;
          if (!receivedActivity && session?.id === sessionId && session.projectId === projectId) {
            update(session.title);
          }
        })
        .catch((error: unknown) => {
          // This background read refines an already truthful fallback, not a
          // requested mutation; leave that fallback and the shared intake live.
          if (active) console.warn("[session-start-toast] couldn't read Session title", error);
        });
    }
    return () => {
      active = false;
      off();
    };
  }, [projectId, sessionId]);
  const matchingFallback =
    fallback?.projectId === projectId && fallback.sessionId === sessionId ? fallback.title : null;
  return sessionStartToastModel(notice, title ?? matchingFallback).message;
}

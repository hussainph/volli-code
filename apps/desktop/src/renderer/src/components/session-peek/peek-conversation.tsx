/**
 * VC-30 — "View conversation", for a Session named by a sidebar row.
 *
 * The peek card is a fold of a Session's tail; this is the whole conversation,
 * one press further in, and it is the SAME overlay a subagent opens in
 * (`chat/session-peek-dialog.tsx` + `chat/subagent-peek-dialog.tsx`, #610):
 * the shared chrome, `adoptChatSession`, and the real `ChatPlane`. Nothing here
 * re-implements a transcript, a composer or a delivery rule — the plane owns
 * all three, and a second implementation of them is exactly the drift #610's
 * chrome was extracted to prevent.
 *
 * WHAT IS GENERALISED, AND WHY IT IS A SECOND COMPONENT. The subagent overlay
 * is handed an `IslandAgent` and its parent's scope, because the Activity
 * Island has both. A sidebar row has neither: it has a Session id. So the
 * scope, the title and the state word are DERIVED from the stores that already
 * know them — the resident projection once the Session is adopted, and the two
 * row caches (`ticket-session-records`, `project-sessions`) before it lands, so
 * the overlay opens with the row's own words rather than with a blank header
 * while a stream connects.
 *
 * ADOPT ON OPEN, LEAVE THE CLIENT RESIDENT ON CLOSE. Disposal is not
 * reference-counted: closing this must not tear down a client an already-open
 * tab is reading (the subagent overlay records the same rule).
 *
 * ESCAPE IS ISOLATED. The peek card behind this listens for Escape on the
 * window; the dialog's own `onEscapeKeyDown` stops the event at the document,
 * so closing the conversation does not also dismiss the card that opened it.
 * That is chrome behaviour, inherited rather than restated here.
 *
 * READING IS THE CALLER'S. Viewing a conversation reads the Session (D6), but
 * the mark belongs to the surface that owns the row's read state — the rail
 * writes `ticket-session-records`, the bands write `project-sessions` — so this
 * component never calls `setRead`.
 */
import * as React from "react";
import type { ChatSessionRecord, SessionActivityState, SessionListingRow } from "@volli/shared";

import { ChatPlane } from "@renderer/components/chat/chat-plane";
import { SessionPeekDialog } from "@renderer/components/chat/session-peek-dialog";
import { SESSION_ACTIVITY_LABEL } from "@renderer/components/ui/session-activity-status";
import { useChatSessionsStore } from "@renderer/stores/chat-sessions";
import {
  useProjectSessionsStore,
  type ProjectSessionRows,
} from "@renderer/stores/project-sessions";
import { useTicketSessionRecordsStore } from "@renderer/stores/ticket-session-records";

export interface PeekConversationProps {
  /** The Session whose conversation is open. `null` draws nothing at all. */
  sessionId: string | null;
  onClose(): void;
}

/** What the overlay needs about the Session, from whichever store answered. */
interface ConversationSubject {
  projectId: string;
  ticketId: string | null;
  /** `null` for a Session nobody has named yet — the header says so in words. */
  title: string | null;
  /** The row's own activity word, when the answer came from a cached row. */
  activity: SessionActivityState | null;
}

/** The chat row for `sessionId` in either row cache, or `null`. */
function cachedChatRecord(
  sessionId: string,
  byTicket: Readonly<Record<string, readonly SessionListingRow[]>>,
  byProject: Readonly<Record<string, ProjectSessionRows>>,
): ChatSessionRecord | null {
  for (const rows of Object.values(byTicket)) {
    for (const row of rows) {
      if (row.kind === "chat" && row.record.sessionId === sessionId) return row.record;
    }
  }
  for (const rows of Object.values(byProject)) {
    const record = rows.chat.find((candidate) => candidate.sessionId === sessionId);
    if (record !== undefined) return record;
  }
  return null;
}

/**
 * The state word in the header, in the rows' own vocabulary
 * (`SESSION_ACTIVITY_LABEL`) so the overlay and the row it was opened from say
 * the same thing about the same Session.
 *
 * The resident projection is read in main's own precedence
 * (`session-control/chat-attachment.ts`): a question outranks a running turn,
 * which outranks rest. A Session whose stream has not answered yet falls back
 * to the row's recorded activity, and a Session no store can describe says
 * nothing rather than guessing.
 */
function stateWordOf(subject: ConversationSubject | null, waiting: boolean, working: boolean) {
  if (waiting) return SESSION_ACTIVITY_LABEL.waiting;
  if (working) return SESSION_ACTIVITY_LABEL.working;
  if (subject?.activity != null) return SESSION_ACTIVITY_LABEL[subject.activity];
  return undefined;
}

const noOpenFile = (): void => {};

export function PeekConversation({
  sessionId,
  onClose,
}: PeekConversationProps): React.ReactElement | null {
  const adopt = useChatSessionsStore((state) => state.adoptChatSession);
  const projection = useChatSessionsStore((state) =>
    sessionId === null ? null : (state.sessions[sessionId]?.projection ?? null),
  );
  const byTicket = useTicketSessionRecordsStore((state) => state.byTicket);
  const byProject = useProjectSessionsStore((state) => state.byProject);

  // An explicit intent, so the Session is adopted — the peek itself never does
  // (plan §1.1): the transcript and the composer below are the resident
  // client's, exactly as they are in a tab.
  React.useEffect(() => {
    if (sessionId === null) return;
    adopt(sessionId);
  }, [adopt, sessionId]);

  const cached = React.useMemo(
    () => (sessionId === null ? null : cachedChatRecord(sessionId, byTicket, byProject)),
    [byProject, byTicket, sessionId],
  );

  if (sessionId === null) return null;

  const session = projection?.session ?? null;
  const subject: ConversationSubject | null =
    session !== null
      ? {
          projectId: session.projectId,
          ticketId: session.ticketId,
          title: session.title,
          activity: null,
        }
      : cached !== null
        ? {
            projectId: cached.projectId,
            ticketId: cached.ticketId,
            title: cached.title,
            activity: cached.activity,
          }
        : null;

  const waiting =
    projection !== null &&
    (projection.interactions.active.length > 0 || projection.attention.primary !== null);
  const working = projection !== null && projection.turnActive && projection.liveExecutor !== null;

  return (
    <SessionPeekDialog
      open
      title={subject?.title ?? "Conversation"}
      // A Session with no title is still a conversation; the header says the
      // generic noun rather than an empty line.
      state={stateWordOf(subject, waiting, working)}
      onClose={onClose}
    >
      <ChatPlane
        // Keyed by Session: switching rows must not carry one Session's plane
        // state onto another's.
        key={sessionId}
        constrainComposer
        sessionId={sessionId}
        // Empty only while no store can name the scope, which is a Session this
        // window has never listed — the plane degrades to no project catalog
        // rather than claiming a project it was not told.
        projectId={subject?.projectId ?? ""}
        ticketId={subject?.ticketId ?? null}
        onOpenFile={noOpenFile}
      />
    </SessionPeekDialog>
  );
}

/**
 * VC-30 — what one peek costs: a single fold of a Session's durable tail.
 *
 * ONE PULL, NO SUBSCRIPTION, NO ADOPTION. Reading a peek must be cheaper than
 * opening the Session, or the peek is just a slower way to open it: there is no
 * `session.subscribe`, no resident client and no `adoptChatSession` anywhere in
 * this file. Adoption happens later and only on an explicit intent — a pin, a
 * reply, or viewing the conversation (plan §1.1, §3.3).
 *
 * WHAT IS CACHED, AND WHAT INVALIDATES IT. One answer per Session for the life
 * of the mount, so sweeping back along a band redraws cards it has already read
 * without asking again. The cache is keyed by the Session AND by an activity
 * token the caller supplies — its listing row's `lastActivityAt`, which main
 * pushes on every fold (`volli:session-activity`). So a Session that has done
 * something since the last read is re-read, and one that has not is not.
 *
 * A LATE ANSWER IS DROPPED. The pointer moves faster than a fold: by the time a
 * pull settles the card may be about another Session entirely, so the result is
 * applied only while it is still the one being asked for.
 */
import * as React from "react";
import type { SessionPeekContent } from "@volli/shared";

export interface PeekContentState {
  content: SessionPeekContent | null;
  loading: boolean;
  /** The fold failed, or answered with no such Session. The card says so. */
  failed: boolean;
}

const IDLE: PeekContentState = { content: null, loading: false, failed: false };

export function usePeekContent(
  sessionId: string | null,
  read: (sessionId: string) => Promise<SessionPeekContent | null>,
  activityToken: number,
): PeekContentState {
  const cache = React.useRef(new Map<string, SessionPeekContent | null>());
  const [state, setState] = React.useState<PeekContentState>(IDLE);
  const key = sessionId === null ? null : `${sessionId}:${activityToken}`;

  React.useEffect(() => {
    if (sessionId === null || key === null) {
      setState(IDLE);
      return;
    }
    const cached = cache.current.get(key);
    if (cached !== undefined) {
      setState({ content: cached, loading: false, failed: cached === null });
      return;
    }
    let live = true;
    setState({ content: null, loading: true, failed: false });
    void read(sessionId).then(
      (content) => {
        cache.current.set(key, content);
        if (!live) return;
        setState({ content, loading: false, failed: content === null });
      },
      () => {
        if (!live) return;
        setState({ content: null, loading: false, failed: true });
      },
    );
    return () => {
      live = false;
    };
  }, [key, read, sessionId]);

  return state;
}

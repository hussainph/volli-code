/**
 * Who started ONE Session, asked from anywhere a single Session is drawn
 * (VC-131).
 *
 * ── WHY A HOOK AND NOT A PROP ─────────────────────────────────────────────
 * Provenance rides on the Session LISTING row, which is the right home for it:
 * it is a fact about the Session rather than about the attachment that renders
 * it. But two surfaces draw a Session with no listing row anywhere near them —
 * a tab strip is handed tab descriptors, and the command palette is handed
 * store records — and threading the fact down through those shapes would mean
 * teaching every intermediate structure a word about Automations. This is the
 * same fact, read at the leaf, out of the store that already holds it.
 *
 * ── WHICH STORE ───────────────────────────────────────────────────────────
 * `stores/project-sessions.ts`, because it is the one cache that answers for
 * EVERY Session in a project — a ticket's and the project's own — and because
 * it is push-fed: a Run that starts while the window is open arrives on the
 * activity channel, so a tab that was opened before its Run record landed gains
 * its bolt without anything re-fetching. `ticket-session-records` would answer
 * for a ticket's Sessions only, and unmounts with the rail.
 *
 * The baseline is ENSURED rather than assumed. A surface that draws Sessions
 * may well be the first thing on screen for a project (Home opens on a Session
 * tab), and `ensure` is idempotent and shared — a project already fetched
 * costs a resolved promise and no IPC.
 *
 * ── THE RESTING CASE IS FREE ──────────────────────────────────────────────
 * The map behind this is sparse: a project nobody has automated holds an empty
 * object, `sessionProvenanceOf` turns a miss into the one frozen
 * {@link PERSON_STARTED}, and a frozen constant is stable by identity — so a
 * person-started Session re-renders nothing and draws nothing. That is the
 * "no persistent visual weight" criterion holding at the leaf, not just in the
 * rail it was written about.
 */
import * as React from "react";
import { PERSON_STARTED, sessionProvenanceOf, type SessionProvenance } from "@volli/shared";

import {
  EMPTY_PROJECT_SESSION_ROWS,
  useProjectSessionsStore,
} from "@renderer/stores/project-sessions";

/**
 * One Session's provenance, or the resting case while nothing is known.
 *
 * `sessionId` is nullable so a component that renders several kinds of thing
 * can call it unconditionally for the ones that are not Sessions at all — the
 * same shape `useTerminalTabState` already takes on the ticket strip.
 */
export function useSessionProvenance(
  projectId: string | null,
  sessionId: string | null,
): SessionProvenance {
  const ensure = useProjectSessionsStore((state) => state.ensure);
  React.useEffect(() => {
    // Only for a real Session. A strip is mostly tabs that are not Sessions at
    // all — a Body tab, a file, a diff — and none of them should be the reason
    // a project's Session listing gets fetched.
    if (projectId === null || sessionId === null) return;
    void ensure(projectId);
  }, [ensure, projectId, sessionId]);
  return useProjectSessionsStore((state) => {
    if (projectId === null || sessionId === null) return PERSON_STARTED;
    const rows = state.byProject[projectId] ?? EMPTY_PROJECT_SESSION_ROWS;
    return sessionProvenanceOf(rows.provenance, sessionId);
  });
}

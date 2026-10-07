/**
 * Which project a Session belongs to, from what this window holds (VC-713).
 *
 * A Session on a remote host goes over that project's Workspace link, and a
 * surface that only knows a Session id (a tab, a rename, a read mark, a peek)
 * has to know where it lives before it reaches for `window.api`, which serves
 * This Mac's Sessions only. The chat store records the project of every
 * Session it starts or adopts; a Session it never did is found in the
 * listings it was opened from. One it cannot place is This Mac's.
 */
import { remoteHostNameNow } from "@renderer/components/hosts/use-remote-project";
import { useProjectSessionsStore } from "@renderer/stores/project-sessions";
import { useTicketSessionRecordsStore } from "@renderer/stores/ticket-session-records";

const recorded = new Map<string, string>();

/** Records a Session's project (the chat store, on create, promotion and adopt). */
export function rememberSessionProject(sessionId: string, projectId: string): void {
  recorded.set(sessionId, projectId);
}

/** Forgets a Session's recorded project (its last view closed). */
export function forgetSessionProject(sessionId: string): void {
  recorded.delete(sessionId);
}

/** The Session's project, or `null` when nothing in this window names it. */
export function projectOfSession(sessionId: string): string | null {
  const known = recorded.get(sessionId);
  if (known !== undefined) return known;
  for (const [projectId, rows] of Object.entries(useProjectSessionsStore.getState().byProject)) {
    if (rows.chat.some((row) => row.sessionId === sessionId)) return projectId;
  }
  for (const rows of Object.values(useTicketSessionRecordsStore.getState().byTicket)) {
    for (const row of rows) {
      if (row.kind === "chat" && row.record.sessionId === sessionId) return row.record.projectId;
    }
  }
  return null;
}

/** The remote host a Session runs on, or `null` for This Mac's (and always with `cloud` off). */
export function remoteHostOfSession(sessionId: string): string | null {
  return remoteHostNameNow(projectOfSession(sessionId));
}

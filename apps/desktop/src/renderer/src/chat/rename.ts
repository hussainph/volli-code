/**
 * Renaming one chat Session — the single path every chat surface renames
 * through (the ticket tab strip, the ticket Sessions rail), the way
 * `renameTerminalSession` is that path for a terminal one.
 *
 * The two optimistic writes below are not a latency nicety, which is the whole
 * reason this is a shared function rather than an inline call: `volli:session-
 * rename` submits `session.retitle` straight to the engine, bypassing the
 * runtime's publish, so NO live chat subscriber is told the title changed. The
 * ledger fold self-heals on the next projection read — an unrelated refresh
 * away — and until then these writes are the only thing moving the labels.
 */
import { errorMessage } from "@volli/shared";

import { toastError } from "@renderer/lib/toast";
import { useChatSessionsStore } from "@renderer/stores/chat-sessions";
import { useTicketSessionRecordsStore } from "@renderer/stores/ticket-session-records";

/**
 * Retitles a chat Session everywhere it is named and persists it. No-ops on a
 * blank title. Resolves `true` when the write stuck, `false` on a no-op or a
 * failure (which also toasts — CLAUDE.md: never silently swallow a mutation).
 */
export async function renameChatSession(sessionId: string, title: string): Promise<boolean> {
  const trimmed = title.trim();
  if (trimmed.length === 0) return false;

  useChatSessionsStore.getState().retitle(sessionId, trimmed);
  retitleCachedRecords(sessionId, trimmed);

  // The same door the terminal path uses, called directly rather than through
  // its `persistRename` wrapper: that wrapper lives in terminal/session-
  // lifecycle.ts, which imports the engine registry (and with it the restty
  // WebGPU engine) — four lines are not worth pulling a terminal renderer into
  // the chat core.
  try {
    const result = await window.api.sessions.rename({ sessionId, title: trimmed });
    if (result.ok) return true;
    toastError(`Rename failed: ${result.error}`);
    return false;
  } catch (error) {
    toastError(`Rename failed: ${errorMessage(error)}`);
    return false;
  }
}

/**
 * The rail draws from the durable listing cache, which is keyed by ticket — and
 * a rename can come from a Session whose ticket the caller doesn't name (a tab
 * strip knows only the tab id, and a ticketless chat Session has no ticket at
 * all). Finding the holder by id keeps this callable as `(sessionId, title)`;
 * a Session belongs to at most one ticket, so at most one list moves.
 */
function retitleCachedRecords(sessionId: string, title: string): void {
  const records = useTicketSessionRecordsStore.getState();
  for (const [ticketId, rows] of Object.entries(records.byTicket)) {
    if (rows.some((row) => row.kind === "chat" && row.record.sessionId === sessionId)) {
      records.renameLocally(ticketId, sessionId, title);
    }
  }
}

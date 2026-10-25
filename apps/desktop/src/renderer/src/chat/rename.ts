/**
 * Renaming one chat Session — the single path every chat surface renames
 * through (the ticket tab strip, the ticket Sessions rail), the way
 * `renameTerminalSession` is that path for a terminal one.
 *
 * `volli:session-rename` submits `session.retitle` straight to the engine.
 * The durable `session.retitled` it commits reaches every open chat stream and
 * the listing fold through the host's post-commit wake bus (VC-790) — and so
 * does a retitle main makes on its own (VC-81's auto-title) or the CLI makes —
 * so nothing here has to tell anyone else. The writes below are this
 * window's own action showing at once, ahead of that round trip, and put back
 * if the store refuses it.
 */
import { errorMessage } from "@volli/shared";

import { notAvailableOn } from "@renderer/components/hosts/use-remote-project";
import { remoteHostOfSession } from "@renderer/lib/session-project";
import { toastError } from "@renderer/lib/toast";
import { useChatSessionsStore } from "@renderer/stores/chat-sessions";
import { useTicketSessionRecordsStore } from "@renderer/stores/ticket-session-records";

/**
 * Retitles a chat Session everywhere it is named and persists it. No-ops on a
 * blank title. Resolves `true` when the write stuck, `false` on a no-op or a
 * failure (which also toasts — CLAUDE.md: never silently swallow a mutation).
 *
 * A failure puts the old title back. That is not symmetry for its own sake: a
 * rename the durable store refused commits nothing, so no stream frame or
 * listing row is on the way to correct the optimistic label, and every chat
 * surface would go on asserting a title the ledger does not have.
 *
 * `refineFrom` is the automatic path's rider (VC-81): the first user message,
 * passed ONLY by the heuristic auto-title so main can derive a sharper title
 * behind this write. Every human rename omits it, which is what holds title
 * calls at zero for a Session a person named.
 */
export async function renameChatSession(
  sessionId: string,
  title: string,
  refineFrom?: string,
): Promise<boolean> {
  const trimmed = title.trim();
  if (trimmed.length === 0) return false;
  // A Session on a remote host is retitled by its host (VC-713): this Mac's
  // `volli:session-rename` writes only its own ledger. The automatic title is
  // the host's to make, so it is skipped quietly; a person's rename is told.
  const host = remoteHostOfSession(sessionId);
  if (host !== null) {
    if (refineFrom === undefined) toastError(`Rename: ${notAvailableOn(host)}`);
    return false;
  }

  const previous = titlesOf(sessionId);
  writeTitle(sessionId, trimmed, previous);

  // The same door the terminal path uses, called directly rather than through
  // its `persistRename` wrapper: that wrapper lives in terminal/session-
  // lifecycle.ts, which imports the engine registry (and with it xterm.js and
  // its stylesheet) — four lines are not worth pulling a terminal renderer into
  // the chat core.
  try {
    const result = await window.api.sessions.rename({
      sessionId,
      title: trimmed,
      ...(refineFrom !== undefined && refineFrom.trim().length > 0 ? { refineFrom } : {}),
    });
    if (result.ok) return true;
    toastError(`Rename failed: ${result.error}`);
  } catch (error) {
    toastError(`Rename failed: ${errorMessage(error)}`);
  }
  restoreTitle(sessionId, trimmed, previous);
  return false;
}

/**
 * Where one chat Session's title is written, and what each surface says now.
 *
 * `slice` is null for a Session no chat client is resident for — there is no
 * projection to retitle, and inventing one would put a Session on screen that
 * nothing has described. `rows` names the ticket lists holding it: the rail
 * draws from the durable listing cache, which is keyed by ticket, and a rename
 * can come from a Session whose ticket the caller doesn't name (a tab strip
 * knows only the tab id, and a ticketless chat Session has no ticket at all).
 * Finding the holders by id keeps this callable as `(sessionId, title)`.
 */
interface ChatTitleSites {
  slice: string | null;
  rows: readonly { ticketId: string; title: string }[];
}

function titlesOf(sessionId: string): ChatTitleSites {
  const slice =
    useChatSessionsStore.getState().sessions[sessionId]?.projection?.session.title ?? null;
  const rows: { ticketId: string; title: string }[] = [];
  for (const [ticketId, entries] of Object.entries(
    useTicketSessionRecordsStore.getState().byTicket,
  )) {
    for (const entry of entries) {
      if (entry.kind === "chat" && entry.record.sessionId === sessionId) {
        rows.push({ ticketId, title: entry.record.title });
      }
    }
  }
  return { slice, rows };
}

/** Writes `title` to every site {@link titlesOf} found. */
function writeTitle(sessionId: string, title: string, sites: ChatTitleSites): void {
  useChatSessionsStore.getState().retitle(sessionId, title);
  for (const { ticketId } of sites.rows) {
    useTicketSessionRecordsStore.getState().renameLocally(ticketId, sessionId, title);
  }
}

/**
 * Puts `previous` back, per site, and only where the site still shows this
 * call's own optimistic title: a newer rename that landed while this one was in
 * flight already replaced it, and clobbering that with our stale title would
 * undo a rename that succeeded (the terminal path guards the same way — see
 * `terminal/session-lifecycle.ts`).
 */
function restoreTitle(sessionId: string, optimistic: string, previous: ChatTitleSites): void {
  const now = titlesOf(sessionId);
  if (previous.slice !== null && now.slice === optimistic) {
    useChatSessionsStore.getState().retitle(sessionId, previous.slice);
  }
  for (const row of previous.rows) {
    const current = now.rows.find((candidate) => candidate.ticketId === row.ticketId);
    if (current?.title === optimistic) {
      useTicketSessionRecordsStore.getState().renameLocally(row.ticketId, sessionId, row.title);
    }
  }
}

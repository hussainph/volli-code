/**
 * Renaming one chat Session — the single path every chat surface renames
 * through (the ticket tab strip, the ticket Sessions rail), the way
 * `renameTerminalSession` is that path for a terminal one.
 *
 * The two optimistic writes below are not a latency nicety, which is the whole
 * reason this is a shared function rather than an inline call: `volli:session-
 * rename` submits `session.retitle` straight to the engine, bypassing the
 * runtime's publish, so no live chat subscriber is told the title changed at the
 * moment it changes. The ledger fold self-heals on the next projection read — an
 * unrelated refresh away — and until then these writes are the only thing moving
 * the labels.
 *
 * The bypass is no longer free elsewhere, and this is the comment that used to
 * undersell it: those three unpublished events are a hole in every live
 * subscriber's stream, and `SessionRuntime` now has to re-read the ledger to
 * deliver past one (`#closeStreamGap`). Before it did, the hole was permanent —
 * a chat titling itself mid-turn swallowed its own `turn.completed` and sat
 * "working" forever. Publishing from here would be the better fix; until then,
 * nothing about this path may assume a subscriber saw it.
 */
import { errorMessage } from "@volli/shared";

import { toastError } from "@renderer/lib/toast";
import { useChatSessionsStore } from "@renderer/stores/chat-sessions";
import { useTicketSessionRecordsStore } from "@renderer/stores/ticket-session-records";

/**
 * A new renderer chat has no durable title until its first delivered message.
 * Any string, including a human-entered `Chat 1`, is an explicit title and is
 * never eligible for automatic replacement.
 */
export function isUntitledChatSession(title: string | null): boolean {
  return title === null;
}

/**
 * Retitles a chat Session everywhere it is named and persists it. No-ops on a
 * blank title. Resolves `true` when the write stuck, `false` on a no-op or a
 * failure (which also toasts — CLAUDE.md: never silently swallow a mutation).
 *
 * A failure puts the old title back. That is not symmetry for its own sake: the
 * optimistic writes above are the ONLY thing moving these labels, so a rename
 * the durable store refused would otherwise leave every chat surface asserting
 * a title the ledger does not have, with nothing on the way to correct it.
 */
export async function renameChatSession(sessionId: string, title: string): Promise<boolean> {
  const trimmed = title.trim();
  if (trimmed.length === 0) return false;

  const previous = titlesOf(sessionId);
  writeTitle(sessionId, trimmed, previous);

  // The same door the terminal path uses, called directly rather than through
  // its `persistRename` wrapper: that wrapper lives in terminal/session-
  // lifecycle.ts, which imports the engine registry (and with it the restty
  // WebGPU engine) — four lines are not worth pulling a terminal renderer into
  // the chat core.
  try {
    const result = await window.api.sessions.rename({ sessionId, title: trimmed });
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

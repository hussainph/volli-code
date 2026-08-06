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

/** The creation default (`Chat ${n}`) and its bare fallback — never a title a person chose. */
const DEFAULT_CHAT_TITLE_PATTERN = /^Chat \d+$/;

/** A chat's untouched creation title — the only title an auto-title may replace. */
export function isDefaultChatTitle(title: string): boolean {
  return title === "Chat" || DEFAULT_CHAT_TITLE_PATTERN.test(title);
}

/** How much of a message's first line survives into a title before it is cut. */
const AUTO_TITLE_MAX_LENGTH = 48;

/**
 * A title guessed from a message, or `null` when nothing usable survives.
 *
 * Only the first line with visible content is read — a prompt's subject lives
 * in its opening sentence, and pulling from further down would title a chat
 * off its own body. Runs of whitespace collapse to one space so a pasted,
 * wrapped paragraph reads as prose rather than as its literal line breaks.
 */
export function autoTitleFromMessage(text: string): string | null {
  for (const line of text.split(/\r?\n/)) {
    const collapsed = line.replace(/\s+/g, " ").trim();
    if (collapsed.length === 0) continue;
    if (collapsed.length <= AUTO_TITLE_MAX_LENGTH) return collapsed;
    const cut = collapsed.slice(0, AUTO_TITLE_MAX_LENGTH);
    const wordBoundary = cut.lastIndexOf(" ");
    return `${wordBoundary === -1 ? cut : cut.slice(0, wordBoundary)}…`;
  }
  return null;
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

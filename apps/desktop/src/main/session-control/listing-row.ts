import type { SessionListingRow, SessionProjection } from "@volli/shared";

import { chatSessionRecord } from "./chat-attachment";
import { terminalSessionRecord } from "./terminal-attachment";

/**
 * One Session, as the renderer's listings see it.
 *
 * PRECEDENCE: a Session that has ever opened a terminal attachment renders as
 * its terminal row, byte-for-byte what `terminalSessionRecord` always returned;
 * only an attachment-less or structured-only Session renders as a chat row.
 * Neither of those two functions has an opinion about the other, which is why
 * the precedence between them needs exactly one home.
 *
 * It lives here rather than inside `data-ipc.ts` because it now has two
 * callers, and they must not be allowed to disagree: the `volli:session-list`
 * fetch builds the rows a listing starts from, and `activity-watch.ts` builds
 * the rows that are pushed into it afterwards. A push shaped even slightly
 * differently from the fetch would make a Session change appearance the moment
 * it moved, which is precisely the bug a push channel exists to remove.
 */
export function sessionListingRow(session: SessionProjection): SessionListingRow {
  const terminal = terminalSessionRecord(session);
  return terminal !== null
    ? { kind: "terminal", record: terminal }
    : { kind: "chat", record: chatSessionRecord(session) };
}

/** {@link sessionListingRow} over a whole listing. */
export function sessionListingRows(sessions: readonly SessionProjection[]): SessionListingRow[] {
  return sessions.map(sessionListingRow);
}

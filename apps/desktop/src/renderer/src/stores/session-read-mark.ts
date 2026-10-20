/**
 * One person's read mark, optimistically (VC-30).
 *
 * ── WHY IT IS SHARED ──────────────────────────────────────────────────────
 * Two caches hold a Session's row — `project-sessions.ts` for a project's
 * listing and `ticket-session-records.ts` for a ticket's rail — and a mark has
 * to move whichever one the person is looking at before main answers, because
 * the dot has to answer the keypress in the same frame. Both had the same four
 * beats written out by hand: stamp locally, call the door, toast the refusal,
 * put the old state back. Two copies of one rule are two chances for the toast
 * to say different things about the same failure.
 *
 * The caches differ only in HOW a row is read and written, which is what the
 * two ports are. Everything else — the clock, the message, the revert, and the
 * decision below about when a revert is still honest — lives here once.
 *
 * ── THE REVERT IS CONDITIONAL ─────────────────────────────────────────────
 * The optimistic stamp is local only: main owns the receipt's clock. So while
 * this write is in flight, an authoritative `volli:session-activity` upsert can
 * land on the very same row — main's own answer, carrying main's stamp. An
 * unconditional revert would then overwrite a FACT with a value this call
 * merely guessed at before it failed.
 *
 * So the revert asks first: is the row still exactly what this call wrote? If
 * it is, nobody else has spoken and the old state is the honest answer. If it
 * is not, somebody authoritative already did, and their word stands.
 */
import { errorMessage, type SessionReadState } from "@volli/shared";

import { notAvailableOn } from "@renderer/components/hosts/use-remote-project";
import { remoteHostOfSession } from "@renderer/lib/session-project";
import { toastError } from "@renderer/lib/toast";

export interface SessionReadMarkPorts {
  /**
   * The row's read state right now, or the resting state when this cache holds
   * no such row. Re-read AFTER the round-trip, so it must answer from live
   * store state rather than from a snapshot.
   */
  readState: () => SessionReadState;
  /** Writes the row's read state. A no-op when this cache holds no such row. */
  write: (read: SessionReadState) => void;
}

/**
 * Marks a Session read or unread: optimistic locally, durable in main, and
 * reverted only if the failure leaves this call's own guess still standing.
 *
 * Never rejects. A refused or thrown write is toasted (AGENTS.md: surface every
 * failed mutation), which is the whole report a caller gets.
 */
export async function markSessionRead(
  input: { sessionId: string; unread: boolean },
  ports: SessionReadMarkPorts,
): Promise<void> {
  // A remote Session's read receipt is its host's (VC-713), and this Mac's
  // `volli:session-read-set` writes only its own: say so, and mark nothing.
  const host = remoteHostOfSession(input.sessionId);
  if (host !== null) {
    toastError(`Couldn't mark the session: ${notAvailableOn(host)}`);
    return;
  }
  const previous = ports.readState();
  // The stamp the dot needs NOW. Main records its own when it answers, and the
  // push replaces this with it.
  const optimistic: SessionReadState = input.unread
    ? { unreadSince: Date.now() }
    : { unreadSince: null };
  ports.write(optimistic);
  try {
    const result = await window.api.sessions.setRead({
      sessionId: input.sessionId,
      unread: input.unread,
    });
    if (result.ok) return;
    toastError(`Couldn't mark the session: ${result.error}`);
  } catch (error) {
    toastError(`Couldn't mark the session: ${errorMessage(error)}`);
  }
  // An authoritative row landed mid-flight: it is main's answer, not ours to
  // undo. See the header.
  if (ports.readState().unreadSince !== optimistic.unreadSince) return;
  ports.write(previous);
}

/**
 * When a Session becomes unread, and when merely looking at it clears that
 * again (VC-30 × VC-108).
 *
 * Two edges, one module, because they are the same rule read from both sides:
 *
 *   1. A turn ENDED while the Session was not in front of a focused window ⇒
 *      it is unread. Something happened and nobody saw it.
 *   2. A Session BECAME in front of a focused window ⇒ it is read. Somebody is
 *      looking at it now, so the dot has nothing left to say (coordinator
 *      amendment A1 — without it, a person who never navigates away keeps
 *      seeing a dot for a chat they are staring at).
 *
 * ── WHY MAIN DECIDES ──────────────────────────────────────────────────────
 * Both halves need a fact the renderer cannot answer honestly. "Is this window
 * focused" is Electron's (`active-targets.ts` says so in its own header: a
 * renderer's `document.hasFocus()` silences alerts on another Space), and "did
 * a turn just end" is visible in one place only — the activity watch's
 * `observe` port, which is the choke point every durable Session write in this
 * process already passes through. So the decision is made once, where it is
 * true, and everything downstream is a projection of the stamp it writes.
 *
 * ── WHY IT RIDES `activity-watch` ─────────────────────────────────────────
 * `automations/run-attention.ts`' reasoning, unchanged: this needs exactly the
 * projection that watch already folds, at exactly that moment, so a port costs
 * one call and no bookkeeping — against a per-Session subscription held open
 * for the life of the app.
 *
 * ── WHAT A RELAUNCH KNOWS ─────────────────────────────────────────────────
 * The phase memory below is per PROCESS, so the FIRST sighting of a Session
 * seeds and stays silent — `turnJustEnded(null, …)` is false by construction.
 * A process that just started must not mark yesterday's finished turns unread;
 * the receipt it already has is the durable answer for those. The one Session
 * whose baseline is a fact rather than an assumption is one this process
 * minted, and {@link SessionReadWatch.observeBirth} records it, exactly as the
 * run-attention watch does.
 *
 * ── TERMINAL COMPANIONS ───────────────────────────────────────────────────
 * Nothing special is written for them, and nothing needs to be: a manual
 * terminal companion has no turns, so no fold of it can ever satisfy
 * `turnJustEnded` and it is never marked unread automatically (§3.5). A person
 * can still mark one by hand through the IPC door; this rule simply never
 * speaks for them.
 *
 * ── EVERY FAILURE IS SWALLOWED ────────────────────────────────────────────
 * Like the watch it hangs off: this is an observer bolted onto the write path,
 * and a receipt that throws must never fail the command that triggered it.
 */
import {
  sessionTurnPhaseOf,
  turnJustEnded,
  type SessionProjection,
  type SessionTurnPhase,
} from "@volli/shared";
import { hostLogger } from "../log/root";

const log = hostLogger("session-read-watch");

export interface SessionReadWatchPorts {
  /**
   * Session ids on screen in a FOCUSED window right now — the notification
   * runtime's `ActiveTargetRegistry`, which is already the app's one answer to
   * "is this already in front of the person" (VC-295 rule 5).
   *
   * Asked per edge rather than handed a set, because the set moves with every
   * window focus and every tab change, and a snapshot taken at construction
   * would be wrong by the first turn boundary.
   */
  focusedSessionIds(): ReadonlySet<string>;
  /** Marks a Session unread as of `at`, unless it already is (`markSessionUnread`). */
  markUnread(sessionId: string, at: number): void;
  /**
   * Marks a Session read and republishes its row (A1). Called only for a
   * Session that came into view; the host decides whether that is a write at
   * all, because a Session that is already read must not cost a broadcast.
   */
  markRead(sessionId: string): void;
  /** Diagnostics seam. Defaults to the host log. */
  onError?: (error: unknown) => void;
}

export interface SessionReadWatch {
  /** One folded Session, from the activity watch. Synchronous and total. */
  observe(projection: SessionProjection): void;
  /**
   * A Session this process just minted, from the activity watch's own create.
   *
   * It records the only phase a Session that did not exist a moment ago can be
   * in — no turn, no outcome — so its first real fold is measured against a
   * fact instead of being swallowed as an unknown baseline. Idempotent, and it
   * never overwrites: a create REPLAYED during recovery must not rewrite the
   * phase a live Session is actually in.
   */
  observeBirth(sessionId: string): void;
  /**
   * The Sessions now in front of a focused window (A1). Every unread one among
   * them is read, because the person is looking at it.
   *
   * Given the whole set rather than one id: the fact that moved is "what the
   * focused windows are showing", and two windows can show two Sessions.
   * Marking is idempotent at the port, so re-announcing an unchanged set costs
   * nothing but is also never needed — the registry announces on change.
   */
  observeFocused(sessionIds: ReadonlySet<string>): void;
}

export function createSessionReadWatch(ports: SessionReadWatchPorts): SessionReadWatch {
  const onError =
    ports.onError ?? ((error: unknown) => log.warn("session read watch failed", { error }));
  /**
   * The last turn phase seen per Session — and NO ENTRY for one this process
   * has never folded. The two are deliberately different answers: `get()`
   * returning `undefined` is what makes the first sighting seed rather than
   * fire, which is the whole discipline this shares with `run-attention.ts`.
   *
   * Bounded by the Sessions this process wrote to during this run, and nothing
   * evicts from it: dropping an entry would make the next fold read as a first
   * sighting and MISS a real edge, which is the expensive direction.
   */
  const phases = new Map<string, SessionTurnPhase>();

  return {
    observe(projection) {
      try {
        const sessionId = projection.session.id;
        const phase = sessionTurnPhaseOf(projection);
        const previous = phases.get(sessionId) ?? null;
        phases.set(sessionId, phase);
        if (!turnJustEnded(previous, phase)) return;
        // In front of somebody right now: they watched it finish, so there is
        // nothing unread about it. This is the same comparison the notification
        // dispatcher makes before it shouts, asked of the same registry.
        if (ports.focusedSessionIds().has(sessionId)) return;
        // The Session's own clock, not ours: the stamp answers "how long has
        // this been waiting on me", and the turn ended when the ledger says it
        // did rather than when this fold got around to it.
        ports.markUnread(sessionId, projection.lastActivityAt);
      } catch (error) {
        onError(error);
      }
    },
    observeBirth(sessionId) {
      if (phases.has(sessionId)) return;
      phases.set(sessionId, { turnActive: false, lastTurnOutcome: null });
    },
    observeFocused(sessionIds) {
      // One try PER SESSION, not one around the loop: two windows can show two
      // Sessions, and a receipt that throws for the first must not decide that
      // the second stays unread while somebody is looking straight at it.
      for (const sessionId of sessionIds) {
        try {
          ports.markRead(sessionId);
        } catch (error) {
          onError(error);
        }
      }
    },
  };
}

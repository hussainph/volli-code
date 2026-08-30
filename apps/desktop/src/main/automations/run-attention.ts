/**
 * Notify when an unattended Run needs a person — VC-112's Notification rule,
 * built in VC-133.
 *
 * The whole rule, in the order it is decided:
 *
 *   1. Did this Session just ENTER `waiting` or `error`? (`sessionPersonNeed`)
 *   2. Was the Run that opened it unattended? (`AutomationRun.attendance`)
 *   3. Does this machine want to be told? (VC-75's `needs-you` preference)
 *
 * ── WHY A TRANSITION AND NOT A STATE ──────────────────────────────────────
 * VC-112 says a Session that ENTERS one of those states, and the verb is the
 * specification. A Session sitting at a permission prompt is in `waiting` for
 * as long as nobody answers it, and every durable fact written anywhere near it
 * re-folds this observer; a rule written on the state rather than the edge would
 * post a fresh notification each time, which is how a feature meant to rescue
 * people becomes the reason they mute it.
 *
 * So the previous need per Session is remembered and only a change into a need
 * speaks. Three consequences worth naming, because each is an acceptance
 * criterion falling out rather than a clause someone had to write:
 *
 *  - **Never on start.** A starting Run is `starting`/`working`, which is
 *    `null` here. There is no edge to fire on.
 *  - **Never on finish.** A finished Run is `idle`, also `null`. The only edges
 *    are INTO a need, never out of one.
 *  - **`waiting` → `error` does speak**, because the person's errand changed:
 *    they were going to answer a question and now there is nothing to answer.
 *
 * ── WHY IT RIDES `activity-watch` ─────────────────────────────────────────
 * That decorator is already the single choke point every durable Session write
 * in this process passes through, and it already folds the affected Session's
 * projection on a short coalescing timer. This observer needs exactly that
 * projection at exactly that moment, so taking a port on it costs one call and
 * no new bookkeeping — versus a per-Session subscription held open for the life
 * of the app, or a poll, which is what the alternatives are.
 *
 * It also gives the rule a property worth stating: only Sessions something
 * WROTE to are folded. A Session left in `waiting` when the app closed is not
 * re-announced on the next launch, because nothing has written to it — the
 * notification tracks live transitions, and the digest surface VC-75 owns is
 * the right home for "what is waiting on me right now".
 *
 * ── EVERY FAILURE IS SWALLOWED ────────────────────────────────────────────
 * Like the watch it hangs off and the watchdog beside it: this is an observer
 * bolted onto the write path, and a notification that throws must never be able
 * to fail the command that triggered it.
 */
import {
  sessionPersonNeed,
  shortSessionId,
  notificationAllowed,
  type AutomationRunAttendance,
  type NotificationPreferences,
  type SessionPersonNeed,
  type SessionProjection,
} from "@volli/shared";

export interface RunAttentionPorts {
  /**
   * Whether the Run that opened this Session was unattended, or `null` when no
   * Run owns it — a chat a person opened, and the overwhelmingly common case.
   *
   * Asked per observed Session rather than handed a set, because the answer is
   * one indexed point query (`idx_automation_runs_session`) and a set would
   * have to be rebuilt on every Run.
   */
  attendanceOf(sessionId: string): AutomationRunAttendance | null;
  /** This machine's answer, re-read per notification so a change takes effect at once. */
  preferences(): NotificationPreferences;
  /** The person's channel. */
  notify(input: { title: string; body: string }): void;
  /** Diagnostics seam. Defaults to `console.warn`. */
  onError?: (error: unknown) => void;
}

export interface RunAttentionWatch {
  /**
   * One folded Session, from the activity watch. Synchronous and total: it
   * never throws, so the caller can hand it every fold without a guard.
   */
  observe(projection: SessionProjection): void;
  /** Drops a Session's remembered state. Used when it is gone, and by tests. */
  forget(sessionId: string): void;
}

/**
 * The sentence a person reads on their lock screen.
 *
 * Two rules, both learned from the criterion that this must not become noise:
 *
 *  - **The title says which of the two errands it is**, because they need
 *    different things — one is answerable, the other is broken — and a title
 *    that said "Automation needs you" for both would make the reader open the
 *    app to find out which.
 *  - **The body names the work**, using the Session's own title. A Run titles
 *    its Session after its Automation (`run.ts`), so in the ordinary case this
 *    IS the Automation's name; when it is not — an Unbound Run, an auto-titled
 *    Session — the title is still the most specific thing that exists, and the
 *    short Session id is the last resort rather than a guess.
 */
export function runAttentionNotification(
  need: SessionPersonNeed,
  session: { id: string; title: string | null },
): { title: string; body: string } {
  const subject = session.title ?? `Session ${shortSessionId(session.id)}`;
  return need === "waiting"
    ? { title: "An Automation is waiting on you", body: `${subject} stopped to ask.` }
    : { title: "An Automation stopped", body: `${subject} could not keep running.` };
}

export function createRunAttentionWatch(ports: RunAttentionPorts): RunAttentionWatch {
  const onError =
    ports.onError ?? ((error: unknown) => console.warn("[volli] run attention:", error));
  /**
   * The last need seen per Session — `null` for one that needs nobody.
   *
   * Bounded by the Sessions this process has written to, and never evicted for
   * a live one: a dropped entry costs a duplicate notification, which is the
   * failure this map exists to prevent, so `forget` is called only where the
   * Session genuinely went away.
   */
  const seen = new Map<string, SessionPersonNeed | null>();

  return {
    observe(projection) {
      try {
        const sessionId = projection.session.id;
        const need = sessionPersonNeed(projection);
        const previous = seen.get(sessionId) ?? null;
        seen.set(sessionId, need);
        // Not an edge into a need: either nothing is needed, or the same thing
        // was already needed and has already been announced.
        if (need === null || need === previous) return;
        // Attendance decides before the preference is even read: an attended
        // Run must never notify, whatever the switches say, because a person is
        // already there (VC-112). A Session no Run owns is a chat somebody
        // opened, and the same reasoning applies to it more strongly still.
        if (ports.attendanceOf(sessionId) !== "unattended") return;
        // VC-75's seam, not a second setting of our own. An unattended Run that
        // needs a person IS "an agent needs my input" — the event that pane has
        // named since before this ticket.
        if (!notificationAllowed(ports.preferences(), "needs-you")) return;
        ports.notify(runAttentionNotification(need, projection.session));
      } catch (error) {
        onError(error);
      }
    },
    forget(sessionId) {
      seen.delete(sessionId);
    },
  };
}

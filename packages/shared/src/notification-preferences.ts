/**
 * Which native notifications a person wants — the preference VC-75 owns, with
 * only as much of it built as VC-133 needs to read through (VC-112, VC-133).
 *
 * ── WHY THIS EXISTS IN A TICKET THAT IS NOT VC-75 ─────────────────────────
 * VC-133's acceptance criterion is explicit: the unattended-Run rule must read
 * "through VC-75's notification preferences rather than introducing a second,
 * parallel setting." VC-75 is marked "needs shaping" and has no decided shape,
 * so the alternative was an Automations-only mute switch — which is exactly the
 * second, parallel setting the criterion forbids, and which VC-75 would then
 * have had to absorb or contradict.
 *
 * So this ruling shapes VC-75's automation half and nothing else. What is
 * settled here is the VOCABULARY and the READ; what is deliberately left to
 * VC-75 is the write, the Settings UI, and the digest surface that is the other
 * (and larger) half of that ticket.
 *
 * ── THE SHAPE, AND WHY IT IS THIS ONE ─────────────────────────────────────
 * `Settings → Notifications` has been on screen since before this ticket, drawn
 * as an `Unavailable` preview (`settings/panes/notifications-pane.tsx`), and it
 * already names four events. That pane's own doc comment states the honesty
 * rule it was written under — "the events listed are the ones main genuinely
 * posts today; inventing a fifth would make this a wish rather than a preview."
 *
 * {@link NOTIFICATION_EVENTS} is that list, moved from the pane to here so the
 * preview and the policy cannot drift into two different sets of switches. The
 * pane now imports it. Nothing is invented: the four are still exactly what main
 * posts, and VC-133 adds no fifth — an unattended Run that needs a person is
 * `needs-you`, because that is what it is.
 *
 * ── A MASTER SWITCH PLUS PER-EVENT SWITCHES ───────────────────────────────
 * Two levels, because the pane already drew two and because they answer
 * different questions: "not now, at all" is a different act from "not this
 * kind". {@link notificationAllowed} is the one place they are combined, so no
 * call site can honour one and forget the other.
 *
 * ── EVERYTHING DEFAULTS TO ON ─────────────────────────────────────────────
 * Not a preference so much as a compatibility rule: main posts all four of these
 * today with nothing consulted in between, so anything other than on-by-default
 * would make this ticket silently switch off notifications people already get.
 * A preference nobody has expressed must reproduce today's behaviour exactly.
 */

/**
 * The notification events a person can govern — what main genuinely posts.
 *
 * Keep this honest as call sites are added, the way the pane's own comment
 * asked while it held the list: an id here with no `notificationAllowed` caller
 * behind it is a switch that silently does nothing.
 *
 *  - `needs-you` — an agent is blocked on a person. VC-133's unattended Run
 *    entering `waiting` or `error` is this event, and so is VC-86's wedge
 *    report.
 *  - `finished` — a session finished.
 *  - `swept` — Volli reclaimed a worktree (the retention watch).
 *  - `update` — a staged update is ready.
 */
export const NOTIFICATION_EVENTS = ["needs-you", "finished", "swept", "update"] as const;

export type NotificationEvent = (typeof NOTIFICATION_EVENTS)[number];

export function isNotificationEvent(value: unknown): value is NotificationEvent {
  return typeof value === "string" && (NOTIFICATION_EVENTS as readonly string[]).includes(value);
}

/**
 * One person's answer for this machine.
 *
 * `events` is a total `Record` rather than a list of the muted ones, so a reader
 * never has to decide what an absent key means and a new event added to
 * {@link NOTIFICATION_EVENTS} fails to compile until it has been given a
 * default. JSON-safe by construction — booleans and plain objects, no optional
 * fields (docs/BOUNDARIES.md standing rule 3) — because this crosses the IPC
 * seam the moment VC-75 gives it a Settings surface.
 */
export interface NotificationPreferences {
  /** The master switch. `false` silences every event regardless of its own. */
  enabled: boolean;
  events: Record<NotificationEvent, boolean>;
}

/**
 * On, everywhere. See the module doc: this must reproduce today's behaviour,
 * because today nothing is consulted and all four post unconditionally.
 *
 * Frozen and shared rather than rebuilt per read: it is the answer for every
 * machine nobody has ever visited the pane on, which is all of them until VC-75
 * ships the write half.
 */
export const DEFAULT_NOTIFICATION_PREFERENCES: NotificationPreferences = Object.freeze({
  enabled: true,
  events: Object.freeze({
    "needs-you": true,
    finished: true,
    swept: true,
    update: true,
  }),
}) as NotificationPreferences;

/**
 * Whether this event may be posted — the master switch AND its own.
 *
 * The single combining rule, so a call site cannot honour "Notify me" and miss
 * the per-event switch beneath it, which is the bug a two-level preference
 * invites and the reason this is a function rather than two field reads.
 */
export function notificationAllowed(
  preferences: NotificationPreferences,
  event: NotificationEvent,
): boolean {
  return preferences.enabled && preferences.events[event];
}

/**
 * A stored blob read in today's vocabulary, degrading toward ON.
 *
 * Tolerant for the reason every durable read in this codebase is (CLAUDE.md):
 * the row outlives the build that wrote it, and a hand-edited or future-shaped
 * blob must not be able to silence an app permanently in a way whose only
 * symptom is that nothing ever happens.
 *
 * **The degrade direction is the opposite of `enabledAutomationIds`', and
 * deliberately so.** That one fails closed because a wrong guess there FIRES
 * something nobody armed; a wrong guess here only ever costs a notification
 * somebody can dismiss. The failure worth having is the loud one, because the
 * quiet one is invisible: a person who stops being told their Runs are blocked
 * has no way to discover that a corrupt row is why.
 *
 * Field by field, so a blob that spells half of itself readably keeps that half
 * — unlike the automations set, where a partial read would be a guess about
 * which records a person switched on.
 */
export function parseNotificationPreferences(raw: unknown): NotificationPreferences {
  if (typeof raw !== "object" || raw === null) return DEFAULT_NOTIFICATION_PREFERENCES;
  const candidate = raw as { enabled?: unknown; events?: unknown };
  const events =
    typeof candidate.events === "object" && candidate.events !== null
      ? (candidate.events as Record<string, unknown>)
      : {};
  return {
    enabled: typeof candidate.enabled === "boolean" ? candidate.enabled : true,
    events: Object.fromEntries(
      NOTIFICATION_EVENTS.map((event) => [
        event,
        typeof events[event] === "boolean" ? events[event] : true,
      ]),
    ) as Record<NotificationEvent, boolean>,
  };
}

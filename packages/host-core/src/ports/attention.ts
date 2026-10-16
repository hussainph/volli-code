/**
 * Raising attention with a person (VC-554).
 *
 * Attention is host data: the host decides that a Run finished unattended or
 * a Session has been silent too long, and records it. Putting it in front of
 * a person is a client's job, and only a client can do it: desktop raises a
 * native notification through `apps/desktop/src/main/notifications/runtime.ts`,
 * which keeps the preferences, the focused-target suppression and the click
 * routing exactly as they were.
 *
 * The same client also answers which Sessions are in front of a focused
 * window. The read rule and the alert suppression must ask one source, or a
 * turn could be loud and unread at the same time.
 */
import type { NotificationOutcome, NotificationRequest } from "@volli/shared";

export interface AttentionDeliveryPort {
  /**
   * Posts one alert and says what became of it. Never throws. Background
   * observers ignore the outcome; `volli notify` reports it to the agent that
   * asked.
   */
  deliver(request: NotificationRequest): NotificationOutcome;
  /** The Sessions in front of a focused client window right now. */
  focusedSessionIds(): ReadonlySet<string>;
}

const NOTHING_FOCUSED: ReadonlySet<string> = new Set();

/**
 * A host with no client to deliver through: every alert is `unsupported`, and
 * nothing is in front of anyone, so every finished turn stays unread.
 */
export const HEADLESS_ATTENTION: AttentionDeliveryPort = {
  deliver: () => ({ delivered: false, reason: "unsupported" }),
  focusedSessionIds: () => NOTHING_FOCUSED,
};

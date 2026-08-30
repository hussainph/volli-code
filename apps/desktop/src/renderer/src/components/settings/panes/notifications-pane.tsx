/**
 * Settings → Notifications — designed, and now half plumbed (VC-75, VC-133).
 *
 * Volli already POSTS native notifications: a finished retention sweep, a
 * staged update, a session signal. What did not exist was any preference
 * governing them — main constructed a `Notification` and showed it, with
 * nothing consulted in between.
 *
 * **What VC-133 changed, and what it deliberately did not.** That ticket's rule
 * — notify an unattended Run when its Session enters `waiting` or `error` — was
 * required to read through THESE preferences rather than ship a second,
 * parallel Automations-only switch. So the vocabulary and the read now exist
 * (`@volli/shared`'s `notification-preferences.ts`, `main/notification-
 * preferences.ts`), and the `needs-you` event genuinely governs that one call
 * site. What is still missing is the WRITE: nothing sets the `app_state` key,
 * so every read answers the all-on defaults and these switches are still a
 * preview.
 *
 * Finishing it is VC-75's: a durable `set` command (docs/BOUNDARIES.md rule 5,
 * the way `automation.set-enabled` is), this pane bound to it, and the other
 * three events honoured at their own call sites.
 *
 * Shown rather than hidden because the absence is itself the surprising part:
 * an app that sends OS notifications and offers no way to turn them off looks
 * like it lost the setting, not like it never had one. Saying so is better
 * than an empty rail slot.
 *
 * The ids come from the shared vocabulary rather than a local copy, so the
 * preview and the policy cannot come to offer different switches. Only the
 * LABELS live here — wording is this surface's business.
 */
import { BellIcon } from "@phosphor-icons/react/dist/csr/Bell";
import { NOTIFICATION_EVENTS, type NotificationEvent } from "@volli/shared";

import { PrefRow, PrefSection, Unavailable } from "@renderer/components/settings/kit";
import { Switch } from "@renderer/components/ui/switch";

/**
 * How each event reads in a row. A total `Record`, so an event added to
 * {@link NOTIFICATION_EVENTS} fails to compile here until it has been given
 * words — which is what keeps "the events listed are the ones main genuinely
 * posts" true without anybody having to remember it.
 */
const EVENT_LABELS: Record<NotificationEvent, string> = {
  "needs-you": "An agent needs my input",
  finished: "A session finishes",
  swept: "Volli reclaims a worktree",
  update: "An update is ready",
};

export function NotificationsPane() {
  return (
    <Unavailable
      what="Notification preferences"
      meanwhile="To turn notifications off, open System Settings and select Notifications."
    >
      <PrefSection title="Notifications" icon={BellIcon}>
        <PrefRow label="Notify me">
          <Switch checked />
        </PrefRow>
        {NOTIFICATION_EVENTS.map((event) => (
          <PrefRow key={event} label={EVENT_LABELS[event]}>
            <Switch checked />
          </PrefRow>
        ))}
      </PrefSection>
    </Unavailable>
  );
}

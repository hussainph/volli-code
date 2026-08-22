/**
 * Settings → Notifications — designed, not yet plumbed.
 *
 * Volli already POSTS native notifications: a finished retention sweep, a
 * staged update, a session signal. What does not exist is any preference
 * governing them — main constructs a `Notification` and shows it, with nothing
 * consulted in between. Wiring these switches means an `app_state` policy, a
 * reader on the main side, and a decision at each of the four call sites.
 *
 * Shown rather than hidden because the absence is itself the surprising part:
 * an app that sends OS notifications and offers no way to turn them off looks
 * like it lost the setting, not like it never had one. Saying so is better
 * than an empty rail slot.
 *
 * The events listed are the ones main genuinely posts today. Inventing a
 * fifth would make this a wish rather than a preview.
 */
import { BellIcon } from "@phosphor-icons/react/dist/csr/Bell";

import { PrefRow, PrefSection, Unavailable } from "@renderer/components/settings/kit";
import { Switch } from "@renderer/components/ui/switch";

/** What main actually posts. Keep this honest as call sites are added. */
const EVENTS: readonly { id: string; label: string }[] = [
  { id: "needs-you", label: "An agent needs my input" },
  { id: "finished", label: "A session finishes" },
  { id: "swept", label: "Volli reclaims a worktree" },
  { id: "update", label: "An update is ready" },
];

export function NotificationsPane() {
  return (
    <Unavailable
      what="Notification preferences"
      meanwhile="Turn Volli's notifications off in System Settings → Notifications for now."
    >
      <PrefSection title="Notifications" icon={BellIcon}>
        <PrefRow label="Notify me">
          <Switch checked />
        </PrefRow>
        {EVENTS.map((event) => (
          <PrefRow key={event.id} label={event.label}>
            <Switch checked />
          </PrefRow>
        ))}
      </PrefSection>
    </Unavailable>
  );
}

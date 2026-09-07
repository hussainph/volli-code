/**
 * Settings → Notifications — the preview, finished (VC-75's write half, built
 * in VC-295).
 *
 * This pane spent two tickets as an `Unavailable` preview whose own comment
 * said why: the vocabulary and the read existed, nothing wrote the preference,
 * and only one call site in main consulted it. All three are now true — a
 * validated `notifications.set` command writes the machine-local record, one
 * delivery path reads it for every alert the app posts, and the categories
 * below are the ones a producer actually maps to (`@volli/shared`'s
 * `notification-catalog.ts`, whose test fails if a switch loses its last
 * producer).
 *
 * ── WHAT CHANGED IN THE WORDS, AND WHY ────────────────────────────────────
 * "A session finishes" is gone. No production source ever posted it, so the
 * switch was a control that did nothing; the completion Volli genuinely
 * observes is a merged pull request, and that is what the row now says. The
 * stored id is still `finished` — renaming it would silently reset every
 * machine's choice for a wording change.
 *
 * ── WHAT THIS PAGE IS ALLOWED TO CLAIM ABOUT THE OS ───────────────────────
 * Two facts, and no third. Electron answers `Notification.isSupported()`, and
 * it reports a delivery that FAILED. It does not give this app a reliable read
 * of the OS authorization state, so nothing here says "Allowed" or "Denied" —
 * a denied notification's `show()` succeeds in silence, and a page that
 * inferred permission from it would be confidently wrong in exactly the case
 * somebody came here to diagnose. So: the switches are Volli's answer, the
 * hint says the system owns the rest, and a reported failure is shown as the
 * fault it is with the one route that fixes it.
 *
 * The view is only ever set from what the WRITE returned (main reads the row
 * back), so a switch on this page cannot show a value the database did not
 * accept.
 */
import * as React from "react";
import { BellIcon } from "@phosphor-icons/react/dist/csr/Bell";
import { WarningCircleIcon } from "@phosphor-icons/react/dist/csr/WarningCircle";
import { errorMessage, NOTIFICATION_EVENTS, type NotificationEvent } from "@volli/shared";

import type { NotificationSettingsView } from "../../../../../ipc/contract";
import { PrefRow, PrefSection } from "@renderer/components/settings/kit";
import { Notice } from "@renderer/components/ui/notice";
import { Switch } from "@renderer/components/ui/switch";
import { toastError } from "@renderer/lib/toast";

/**
 * How each category reads in a row. A total `Record`, so an event added to
 * {@link NOTIFICATION_EVENTS} fails to compile here until it has been given
 * words — the same mechanism that kept the preview honest, now guarding a page
 * whose switches do something.
 *
 * The hints name the PRODUCERS, because that is the only way a person can tell
 * what a category will cost them. They are the one exception CLAUDE.md's
 * "let controls talk" rule leaves room for: a mute switch's blast radius is not
 * visible in its label, and getting it wrong is silence.
 */
const EVENT_ROWS: Record<NotificationEvent, { label: string; hint: React.ReactNode }> = {
  "needs-you": {
    label: "An agent needs my input",
    hint: (
      <>
        An unattended Automation Run that stops to ask or breaks, a session the watchdog finds
        wedged, and a terminal harness that reports it is waiting on a human.
      </>
    ),
  },
  finished: {
    label: "A pull request merges",
    hint: <>Volli watches the pull request on a ticket&rsquo;s branch and says when it lands.</>,
  },
  swept: {
    label: "Volli reclaims a worktree",
    hint: <>A ticket&rsquo;s folder removed after its time in Done. The branch is kept.</>,
  },
  update: {
    label: "An update is ready",
    hint: (
      <>
        Sent when a downloaded update is waiting to install. With a Volli window open, the
        sidebar&rsquo;s update badge announces it instead.
      </>
    ),
  },
};

const SYSTEM_SETTINGS_ROUTE = "System Settings → Notifications → Volli Code";

export function NotificationsPane() {
  const [view, setView] = React.useState<NotificationSettingsView | null>(null);
  const [saving, setSaving] = React.useState(false);

  React.useEffect(() => {
    let cancelled = false;
    void window.api.notifications
      .settings()
      .then((result) => {
        if (cancelled) return;
        // A failed read leaves the rows disabled rather than showing switches
        // whose position nothing stands behind.
        if (result.ok) setView(result.settings);
        else toastError(`Couldn't read notification settings: ${result.error}`);
      })
      .catch((error: unknown) => {
        if (!cancelled) toastError(`Couldn't read notification settings: ${errorMessage(error)}`);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function choose(event: NotificationEvent | null, next: boolean): Promise<void> {
    if (saving) return;
    setSaving(true);
    try {
      const result = await window.api.notifications.set(event, next);
      if (!result.ok) {
        // The switch stays where it was: nothing was stored, so nothing on
        // screen may move.
        toastError(`Couldn't change notifications: ${result.error}`);
        return;
      }
      setView(result.settings);
    } catch (error) {
      toastError(`Couldn't change notifications: ${errorMessage(error)}`);
    } finally {
      setSaving(false);
    }
  }

  const preferences = view?.preferences ?? null;
  const disabled = preferences === null || saving;
  const failure = view?.deliveryFailure ?? null;

  return (
    <>
      {view !== null && !view.supported ? (
        <Notice
          tone="error"
          icon={WarningCircleIcon}
          title="This system can't show notifications"
          detail="Volli has nowhere to post these, so the switches below have no effect here."
        />
      ) : null}
      {failure !== null ? (
        <Notice
          tone="error"
          icon={WarningCircleIcon}
          title="The system didn't deliver the last notification"
          detail={`${failure.message} Check that Volli Code is allowed to notify in ${SYSTEM_SETTINGS_ROUTE}.`}
        />
      ) : null}

      <PrefSection title="Notifications" icon={BellIcon}>
        <PrefRow
          label="Notify me"
          htmlFor="notify-me"
          hint={
            <>
              Volli asks the system to show these; the system decides whether they appear, and{" "}
              {SYSTEM_SETTINGS_ROUTE} is where that is allowed or refused. An alert for a session or
              ticket you already have open and focused isn&rsquo;t sent — that window is already
              showing it.
            </>
          }
        >
          <Switch
            id="notify-me"
            checked={preferences?.enabled ?? false}
            disabled={disabled}
            onCheckedChange={(next) => void choose(null, next)}
          />
        </PrefRow>
        {NOTIFICATION_EVENTS.map((event) => (
          <PrefRow
            key={event}
            label={EVENT_ROWS[event].label}
            htmlFor={`notify-${event}`}
            hint={EVENT_ROWS[event].hint}
          >
            <Switch
              id={`notify-${event}`}
              checked={preferences?.events[event] ?? false}
              // Off under a master switch that is off, exactly as the delivery
              // rule reads it (`enabled && events[event]`): a category switch
              // that could still be moved while nothing can be posted would be
              // offering a choice with no effect.
              disabled={disabled || preferences?.enabled === false}
              onCheckedChange={(next) => void choose(event, next)}
            />
          </PrefRow>
        ))}
      </PrefSection>
    </>
  );
}

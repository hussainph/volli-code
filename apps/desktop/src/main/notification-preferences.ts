/**
 * Where this machine's notification preferences are stored, and how they are
 * read (VC-75's automation half, shaped by VC-112/VC-133).
 *
 * The storage half only. The vocabulary, the defaults and the combining rule
 * live in `@volli/shared`'s `notification-preferences.ts`, which is also where
 * the reasoning for all three is written down; this file owns the `app_state`
 * key and nothing else.
 *
 * ── WHY `app_state`, LIKE THE AUTOMATIONS ENABLED SET ─────────────────────
 * A notification is posted by ONE machine to ONE person sitting at it, so the
 * preference governing it is machine-local by nature rather than by convenience
 * — the same tier as an Automation's enablement (`automations/enablement.ts`)
 * and a column's arming. Nothing in a project directory could carry it, and
 * when the Automation record moves to an account this does not go with it: it
 * names a host.
 *
 * ── THERE IS NO WRITER HERE YET, AND THAT IS THE POINT ────────────────────
 * VC-133 needs to READ a preference so its rule is not a second, parallel
 * setting; it does not need to write one, and writing one would be building
 * VC-75's Settings surface inside a ticket about Automations. So this is a
 * read-only door over a key nothing sets yet, and every read therefore answers
 * `DEFAULT_NOTIFICATION_PREFERENCES` — which is deliberately "everything on",
 * i.e. exactly today's behaviour.
 *
 * **What VC-75 inherits** is a seam with one shape already decided: add the
 * write (as an ordinary durable command per docs/BOUNDARIES.md rule 5, the way
 * `automation.set-enabled` is — machine-local storage is not a licence to skip
 * the seam), point `settings/panes/notifications-pane.tsx` at it, and every
 * existing `notificationAllowed` call site starts honouring the switches with
 * no further change. The other three events in `NOTIFICATION_EVENTS` are
 * already named and already posted by main; wiring them is that ticket's work.
 */
import type Database from "better-sqlite3";
import {
  DEFAULT_NOTIFICATION_PREFERENCES,
  parseNotificationPreferences,
  type NotificationPreferences,
} from "@volli/shared";

import { getAppState } from "./db/app-state-repo";

/**
 * The `app_state` key. A frozen string: it names a durable row, so changing it
 * would not error — it would silently reset everyone's preferences to the
 * defaults, which for this record means quietly turning every notification back
 * on.
 */
export const NOTIFICATION_PREFERENCES_KEY = "volli:notification-preferences";

/**
 * This machine's preferences, or the all-on defaults.
 *
 * Every failure path lands on the defaults rather than on silence — an
 * unwritten key, unparseable JSON, and a blob whose shape this build does not
 * recognise. `parseNotificationPreferences` explains why that direction: the
 * loud failure is dismissable, while the quiet one is undiscoverable.
 */
export function readNotificationPreferences(db: Database.Database): NotificationPreferences {
  const stored = getAppState(db, NOTIFICATION_PREFERENCES_KEY);
  if (stored === undefined) return DEFAULT_NOTIFICATION_PREFERENCES;
  try {
    return parseNotificationPreferences(JSON.parse(stored));
  } catch {
    return DEFAULT_NOTIFICATION_PREFERENCES;
  }
}

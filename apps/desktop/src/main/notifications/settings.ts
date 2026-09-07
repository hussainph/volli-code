/**
 * What Settings → Notifications reads, and the one command that writes it
 * (VC-295, finishing VC-75's write half).
 *
 * ── A COMMAND, NOT A `appState.set` ───────────────────────────────────────
 * The renderer already has a generic `app_state` write; pointing the pane at it
 * would have been three lines. It is not used, for the reason
 * docs/BOUNDARIES.md rule 5 gives: a domain surface takes a validated command
 * with IPC as dumb transport, so the vocabulary is checked in ONE place that
 * every client — this renderer, and whatever host serves this core later — has
 * to pass through. A generic string→string write cannot refuse a category that
 * does not exist; this can, and does.
 *
 * ── THE VIEW IS READ BACK, NEVER ECHOED ───────────────────────────────────
 * {@link NotificationSettings.set} returns what the ROW says after the write,
 * not the request it was handed. That is what lets the pane show only accepted
 * values: a failed write throws (the renderer toasts and the switch stays where
 * it was), and an accepted one is reported by the same read every later launch
 * will do.
 *
 * ── WHAT THIS DOES NOT CLAIM ──────────────────────────────────────────────
 * There is no permission field. Electron exposes `Notification.isSupported()`
 * and a `failed` event on a notification it could not deliver; it does not
 * expose the OS's authorization state to this app in any form we can trust
 * across platforms and versions. So the view carries exactly two delivery
 * facts — whether the platform supports native alerts at all, and the most
 * recent delivery Electron said failed — and Settings explains that the OS owns
 * the rest. Inventing "Allowed" from a successful `show()` would be a claim the
 * app cannot make: `show()` on a denied notification succeeds silently.
 *
 * The failure latch is PROCESS-LOCAL on purpose. It describes this launch's
 * delivery, not a preference, and a stored one would outlive the state that
 * caused it — a person who fixed their System Settings would be told forever
 * about a refusal from last week.
 */
import type Database from "better-sqlite3";
import {
  isNotificationEvent,
  type NotificationEvent,
  type NotificationPreferences,
  type NotificationProducer,
} from "@volli/shared";

import {
  readNotificationPreferences,
  writeNotificationPreferences,
} from "../notification-preferences";

/** The most recent delivery Electron reported as failed, for this launch. */
export interface NotificationDeliveryFailure {
  producer: NotificationProducer;
  message: string;
  at: number;
}

/** Everything the pane draws. JSON-safe: it crosses the IPC seam whole. */
export interface NotificationSettingsView {
  preferences: NotificationPreferences;
  /** `Notification.isSupported()` — the one platform fact Electron answers. */
  supported: boolean;
  deliveryFailure: NotificationDeliveryFailure | null;
}

/**
 * One switch move. `event: null` is the master switch — a separate arm rather
 * than a magic category id, so "not now, at all" and "not this kind" stay the
 * two different acts they are.
 */
export interface NotificationPreferenceUpdate {
  event: NotificationEvent | null;
  enabled: boolean;
}

/** A refusal a person reads. Mirrors `AgentObservabilityError`'s role. */
export class NotificationSettingsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotificationSettingsError";
  }
}

export interface NotificationSettingsPorts {
  db: Database.Database;
  /** `Notification.isSupported()`, injected so tests never touch Electron. */
  supported(): boolean;
  now(): number;
}

export interface NotificationSettings {
  view(): NotificationSettingsView;
  /** The read the delivery path makes, per alert. */
  preferences(): NotificationPreferences;
  /** Applies one switch move and answers with the stored result. Throws on a bad request. */
  set(update: NotificationPreferenceUpdate): NotificationSettingsView;
  /** Records what Electron said about a delivery that did not land. */
  noteDeliveryFailure(input: { producer: NotificationProducer; message: string }): void;
}

export function createNotificationSettings(ports: NotificationSettingsPorts): NotificationSettings {
  let deliveryFailure: NotificationDeliveryFailure | null = null;

  const view = (): NotificationSettingsView => ({
    preferences: readNotificationPreferences(ports.db),
    supported: ports.supported(),
    deliveryFailure,
  });

  return {
    view,
    preferences: () => readNotificationPreferences(ports.db),
    set(update) {
      if (typeof update.enabled !== "boolean") {
        throw new NotificationSettingsError("A notification switch is on or off.");
      }
      if (update.event !== null && !isNotificationEvent(update.event)) {
        throw new NotificationSettingsError(
          `This build has no "${String(update.event)}" notification category.`,
        );
      }
      // Read-modify-write over the TOLERANT read, so a row written by another
      // build (or corrupted) becomes a whole, readable record rather than
      // being extended in its broken shape.
      const current = readNotificationPreferences(ports.db);
      const next: NotificationPreferences =
        update.event === null
          ? { enabled: update.enabled, events: { ...current.events } }
          : {
              enabled: current.enabled,
              events: { ...current.events, [update.event]: update.enabled },
            };
      writeNotificationPreferences(ports.db, next, ports.now());
      return view();
    },
    noteDeliveryFailure(input) {
      deliveryFailure = { producer: input.producer, message: input.message, at: ports.now() };
    },
  };
}

/**
 * The preference seam VC-133 reads through and VC-75 will finish.
 *
 * The assertions that matter most are the two about DEGRADING: this record's
 * whole failure mode is going quiet in a way nobody can discover, so every
 * unreadable input has to come back louder rather than safer.
 */
import { describe, expect, it } from "vite-plus/test";

import {
  DEFAULT_NOTIFICATION_PREFERENCES,
  NOTIFICATION_EVENTS,
  isNotificationEvent,
  notificationAllowed,
  parseNotificationPreferences,
} from "./notification-preferences";

describe("notification preference vocabulary", () => {
  it("names the four events main actually posts", () => {
    expect([...NOTIFICATION_EVENTS]).toEqual(["needs-you", "finished", "swept", "update"]);
  });

  it("recognises its own events and nothing else", () => {
    for (const event of NOTIFICATION_EVENTS) expect(isNotificationEvent(event)).toBe(true);
    expect(isNotificationEvent("automations")).toBe(false);
    expect(isNotificationEvent(null)).toBe(false);
    expect(isNotificationEvent(7)).toBe(false);
  });

  it("defaults every event to on, because that is today's behaviour", () => {
    // Not a taste call. Main posts all four unconditionally today, so anything
    // else here would make this seam silently switch off notifications people
    // already receive.
    expect(DEFAULT_NOTIFICATION_PREFERENCES.enabled).toBe(true);
    for (const event of NOTIFICATION_EVENTS) {
      expect(notificationAllowed(DEFAULT_NOTIFICATION_PREFERENCES, event)).toBe(true);
    }
  });
});

describe("notificationAllowed", () => {
  it("requires the master switch AND the event's own", () => {
    const prefs = parseNotificationPreferences({
      enabled: true,
      events: { "needs-you": false },
    });
    expect(notificationAllowed(prefs, "needs-you")).toBe(false);
    expect(notificationAllowed(prefs, "finished")).toBe(true);
  });

  it("lets the master switch silence an event that is switched on", () => {
    const prefs = parseNotificationPreferences({ enabled: false, events: { "needs-you": true } });
    expect(notificationAllowed(prefs, "needs-you")).toBe(false);
  });
});

describe("parseNotificationPreferences", () => {
  it("reads a complete record", () => {
    const prefs = parseNotificationPreferences({
      enabled: false,
      events: { "needs-you": false, finished: false, swept: true, update: false },
    });
    expect(prefs).toEqual({
      enabled: false,
      events: { "needs-you": false, finished: false, swept: true, update: false },
    });
  });

  it("degrades every unreadable shape toward ON", () => {
    // The opposite direction from `enabledAutomationIds`, deliberately: a wrong
    // guess there FIRES something nobody armed, while a wrong guess here only
    // costs a notification somebody can dismiss. The failure worth having is
    // the loud one, because the quiet one is invisible.
    for (const raw of [null, undefined, 7, "on", [], { events: "yes" }]) {
      expect(parseNotificationPreferences(raw)).toEqual(DEFAULT_NOTIFICATION_PREFERENCES);
    }
  });

  it("keeps the readable half of a partly-unreadable record", () => {
    // Field by field, unlike the automations set: a half-readable blob here has
    // no way to fire anything, so salvaging what it does say beats discarding a
    // preference the person expressed.
    const prefs = parseNotificationPreferences({
      enabled: "maybe",
      events: { "needs-you": false, finished: 3 },
    });
    expect(prefs.enabled).toBe(true);
    expect(prefs.events["needs-you"]).toBe(false);
    expect(prefs.events.finished).toBe(true);
  });

  it("fills every event a stored record never mentioned", () => {
    // A record written by an older build knows fewer events than this one. The
    // missing ones must read as on rather than as undefined, or a `Record`
    // consumer would silence them by accident.
    const prefs = parseNotificationPreferences({ enabled: true, events: {} });
    for (const event of NOTIFICATION_EVENTS) expect(prefs.events[event]).toBe(true);
  });
});

/**
 * The storage half of the notification preferences (VC-75's seam, read by
 * VC-133). The vocabulary's own rules are tested in `@volli/shared`; what is
 * tested here is the key and the degrade path around it.
 */
import { afterEach, describe, expect, it } from "vite-plus/test";
import { DEFAULT_NOTIFICATION_PREFERENCES, notificationAllowed } from "@volli/shared";

import { setAppState } from "./db/app-state-repo";
import { openTestDb } from "./db/test-helpers";
import type { TestDb } from "./db/test-helpers";
import {
  NOTIFICATION_PREFERENCES_KEY,
  readNotificationPreferences,
} from "./notification-preferences";

let ctx: TestDb;
afterEach(() => ctx?.cleanup());

describe("readNotificationPreferences", () => {
  it("answers the all-on defaults when nobody has written the key", () => {
    // Which is every machine today: VC-133 reads this seam, and VC-75 owns the
    // write. Anything other than "everything on" would make that ticket
    // silently switch off notifications people already receive.
    ctx = openTestDb();
    expect(readNotificationPreferences(ctx.db)).toEqual(DEFAULT_NOTIFICATION_PREFERENCES);
    expect(notificationAllowed(readNotificationPreferences(ctx.db), "needs-you")).toBe(true);
  });

  it("reads a stored record back", () => {
    ctx = openTestDb();
    setAppState(
      ctx.db,
      NOTIFICATION_PREFERENCES_KEY,
      JSON.stringify({
        enabled: true,
        events: { "needs-you": false, finished: true, swept: true, update: true },
      }),
      1000,
    );
    expect(notificationAllowed(readNotificationPreferences(ctx.db), "needs-you")).toBe(false);
    expect(notificationAllowed(readNotificationPreferences(ctx.db), "finished")).toBe(true);
  });

  it("degrades unparseable bytes toward ON rather than toward silence", () => {
    // A row that cannot be read must not be able to mute an app permanently in
    // a way whose only symptom is that nothing ever happens.
    ctx = openTestDb();
    setAppState(ctx.db, NOTIFICATION_PREFERENCES_KEY, "{not json", 1000);
    expect(readNotificationPreferences(ctx.db)).toEqual(DEFAULT_NOTIFICATION_PREFERENCES);
  });

  it("degrades a readable blob of the wrong shape the same way", () => {
    ctx = openTestDb();
    setAppState(ctx.db, NOTIFICATION_PREFERENCES_KEY, JSON.stringify("off"), 1000);
    expect(readNotificationPreferences(ctx.db)).toEqual(DEFAULT_NOTIFICATION_PREFERENCES);
  });
});

/**
 * The write half of the notification preferences (VC-295) — the part that had
 * never existed, and the reason Settings → Notifications was a preview.
 *
 * The assertions that carry the acceptance criteria: a write is READ BACK from
 * the row rather than echoed, a second service over the same database sees it
 * (which is what "survives restart" means for a machine-local record), and an
 * unreadable old row still answers all-on.
 */
import { afterEach, describe, expect, it } from "vite-plus/test";
import { DEFAULT_NOTIFICATION_PREFERENCES } from "@volli/shared";

import { setAppState } from "../db/app-state-repo";
import { openTestDb, type TestDb } from "../db/test-helpers";
import { NOTIFICATION_PREFERENCES_KEY } from "../notification-preferences";
import { createNotificationSettings, NotificationSettingsError } from "./settings";

let ctx: TestDb;
afterEach(() => ctx?.cleanup());

function settings(options: { supported?: boolean } = {}) {
  ctx ??= openTestDb();
  return createNotificationSettings({
    db: ctx.db,
    supported: () => options.supported ?? true,
    now: () => 1000,
  });
}

describe("notification settings view", () => {
  it("answers all-on for a machine nobody has ever chosen on", () => {
    ctx = openTestDb();
    expect(settings().view()).toEqual({
      preferences: DEFAULT_NOTIFICATION_PREFERENCES,
      supported: true,
      deliveryFailure: null,
    });
  });

  it("reports that this platform posts no native alerts, without claiming a permission", () => {
    ctx = openTestDb();
    // Electron answers `isSupported()` and nothing else. The view carries that
    // one fact; an "allowed"/"denied" field would be an invention.
    expect(settings({ supported: false }).view().supported).toBe(false);
  });
});

describe("setting a preference", () => {
  it("writes the master switch and answers with what the row now says", () => {
    ctx = openTestDb();
    const service = settings();
    const view = service.set({ event: null, enabled: false });
    expect(view.preferences.enabled).toBe(false);
    // Read back from the database, not echoed from the request.
    expect(service.view().preferences.enabled).toBe(false);
  });

  it("survives a restart — a fresh service over the same database sees the choice", () => {
    ctx = openTestDb();
    settings().set({ event: "swept", enabled: false });
    const afterRelaunch = settings().view().preferences;
    expect(afterRelaunch.events.swept).toBe(false);
    expect(afterRelaunch.events["needs-you"]).toBe(true);
  });

  it("changes one category and leaves the others exactly as they were", () => {
    ctx = openTestDb();
    const service = settings();
    service.set({ event: "needs-you", enabled: false });
    const view = service.set({ event: "update", enabled: false });
    expect(view.preferences.events).toEqual({
      "needs-you": false,
      finished: true,
      swept: true,
      update: false,
    });
    expect(view.preferences.enabled).toBe(true);
  });

  it("turns a category back on", () => {
    ctx = openTestDb();
    const service = settings();
    service.set({ event: "finished", enabled: false });
    expect(service.set({ event: "finished", enabled: true }).preferences.events.finished).toBe(
      true,
    );
  });

  it("refuses a category this build does not offer, and writes nothing", () => {
    ctx = openTestDb();
    const service = settings();
    expect(() => service.set({ event: "sessions" as never, enabled: false })).toThrow(
      NotificationSettingsError,
    );
    expect(service.view().preferences).toEqual(DEFAULT_NOTIFICATION_PREFERENCES);
  });

  it("refuses a value that is not a switch position", () => {
    ctx = openTestDb();
    const service = settings();
    expect(() => service.set({ event: null, enabled: "off" as never })).toThrow(
      NotificationSettingsError,
    );
    expect(service.view().preferences.enabled).toBe(true);
  });

  it("heals an unreadable old row instead of inheriting it", () => {
    // Degrading toward ON is the read rule; a write on top of a corrupt blob
    // must leave a record every later read can parse.
    ctx = openTestDb();
    setAppState(ctx.db, NOTIFICATION_PREFERENCES_KEY, "{not json", 1);
    const service = settings();
    expect(service.view().preferences).toEqual(DEFAULT_NOTIFICATION_PREFERENCES);
    const view = service.set({ event: "swept", enabled: false });
    expect(view.preferences).toEqual({
      enabled: true,
      events: { "needs-you": true, finished: true, swept: false, update: true },
    });
    expect(settings().view().preferences.events.swept).toBe(false);
  });
});

describe("a delivery Electron reported as failed", () => {
  it("is shown with the producer and when it happened", () => {
    ctx = openTestDb();
    const service = settings();
    service.noteDeliveryFailure({ producer: "run-attention", message: "delivery failed" });
    expect(service.view().deliveryFailure).toEqual({
      producer: "run-attention",
      message: "delivery failed",
      at: 1000,
    });
  });

  it("keeps only the most recent one", () => {
    ctx = openTestDb();
    const service = settings();
    service.noteDeliveryFailure({ producer: "run-attention", message: "first" });
    service.noteDeliveryFailure({ producer: "update-ready", message: "second" });
    expect(service.view().deliveryFailure?.message).toBe("second");
  });

  it("is process-local, not a durable setting", () => {
    // It describes this launch's OS delivery, not a choice: a fresh service
    // starts with nothing to report.
    ctx = openTestDb();
    settings().noteDeliveryFailure({ producer: "run-attention", message: "first" });
    expect(settings().view().deliveryFailure).toBeNull();
  });
});

describe("preferences()", () => {
  it("is the read the delivery path uses, and it follows a write immediately", () => {
    ctx = openTestDb();
    const service = settings();
    expect(service.preferences().events["needs-you"]).toBe(true);
    service.set({ event: "needs-you", enabled: false });
    expect(service.preferences().events["needs-you"]).toBe(false);
  });
});

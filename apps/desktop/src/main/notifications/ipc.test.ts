/**
 * The door Settings → Notifications speaks through (VC-295).
 *
 * What matters here is that a refusal is DATA a person can read (the pane shows
 * it and leaves the switch alone) and that every channel is claimed even when
 * the database never opened — an unregistered `invoke` does not fail, it hangs,
 * and a Settings page that never answers is worse than one that says why.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { NotificationTarget } from "@volli/shared";

import type { VolliIpcChannel } from "../../ipc/contract";

const { handlers } = vi.hoisted(() => ({
  handlers: new Map<string, (...args: never[]) => unknown>(),
}));

vi.mock("electron", () => ({
  ipcMain: {
    handle(channel: string, handler: (...args: never[]) => unknown) {
      handlers.set(channel, handler);
    },
  },
}));

import { openTestDb, type TestDb } from "../db/test-helpers";
import { createNotificationSettings, type NotificationSettings } from "./settings";
import { registerNotificationIpcHandlers } from "./ipc";

let ctx: TestDb;
let settings: NotificationSettings;
let pending: (() => NotificationTarget | null) & { calls: number };

/** A `takePendingActivation` port that counts how often it was asked. */
function pendingPort(target: NotificationTarget | null): (() => NotificationTarget | null) & {
  calls: number;
} {
  const port = Object.assign(
    () => {
      port.calls += 1;
      return target;
    },
    { calls: 0 },
  );
  return port;
}

async function invoke(channel: VolliIpcChannel, ...args: unknown[]): Promise<unknown> {
  const handler = handlers.get(channel);
  if (handler === undefined) throw new Error(`No handler registered for ${channel}`);
  return (handler as (event: unknown, ...rest: unknown[]) => unknown)({ sender: {} }, ...args);
}

beforeEach(() => {
  handlers.clear();
  ctx = openTestDb();
  settings = createNotificationSettings({
    db: ctx.db,
    supported: () => true,
    now: () => 1000,
  });
  pending = pendingPort(null);
});

afterEach(() => ctx.cleanup());

describe("registerNotificationIpcHandlers", () => {
  it("answers a read with the whole view", async () => {
    registerNotificationIpcHandlers({ settings, takePendingActivation: pending });
    expect(await invoke("volli:notifications-get")).toEqual({
      ok: true,
      settings: {
        preferences: {
          enabled: true,
          events: { "needs-you": true, finished: true, swept: true, update: true },
        },
        supported: true,
        deliveryFailure: null,
      },
    });
  });

  it("writes a switch and answers with the stored result", async () => {
    registerNotificationIpcHandlers({ settings, takePendingActivation: pending });
    const result = (await invoke("volli:notifications-set", {
      event: "swept",
      enabled: false,
    })) as { ok: true; settings: { preferences: { events: Record<string, boolean> } } };
    expect(result.ok).toBe(true);
    expect(result.settings.preferences.events.swept).toBe(false);
    expect(settings.preferences().events.swept).toBe(false);
  });

  it("returns a refusal as data rather than rejecting", async () => {
    registerNotificationIpcHandlers({ settings, takePendingActivation: pending });
    expect(await invoke("volli:notifications-set", { event: "sessions", enabled: false })).toEqual({
      ok: false,
      error: 'This build has no "sessions" notification category.',
    });
  });

  it("refuses a malformed request before it reaches the command", async () => {
    registerNotificationIpcHandlers({ settings, takePendingActivation: pending });
    expect(await invoke("volli:notifications-set", { enabled: "yes" })).toEqual({
      ok: false,
      error: "Invalid notification preference",
    });
    expect(await invoke("volli:notifications-set")).toEqual({
      ok: false,
      error: "Invalid notification preference",
    });
  });

  it("hands over a target parked while no window existed", async () => {
    pending = pendingPort({ kind: "update" });
    registerNotificationIpcHandlers({ settings, takePendingActivation: pending });
    expect(await invoke("volli:notifications-pending-activation")).toEqual({
      ok: true,
      target: { kind: "update" },
    });
    expect(pending.calls).toBe(1);
  });

  it("claims every channel with an honest refusal when the database never opened", async () => {
    registerNotificationIpcHandlers({ settings: null, takePendingActivation: pending });
    expect(await invoke("volli:notifications-get")).toEqual({
      ok: false,
      error: "Notification settings are unavailable.",
    });
    expect(await invoke("volli:notifications-set", { event: null, enabled: false })).toEqual({
      ok: false,
      error: "Notification settings are unavailable.",
    });
  });

  it("carries the recorded database reason into that refusal", async () => {
    registerNotificationIpcHandlers({
      settings: null,
      takePendingActivation: pending,
      unavailableReason: "Notification settings are unavailable. Disk is full.",
    });
    expect(await invoke("volli:notifications-get")).toEqual({
      ok: false,
      error: "Notification settings are unavailable. Disk is full.",
    });
  });
});

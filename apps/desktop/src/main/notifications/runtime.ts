/**
 * Where the notification pieces meet Electron (VC-295).
 *
 * The same shape as `retention-runtime.ts`: everything with a decision in it —
 * the preference read and write, the category map, the focused-target rule, the
 * click routing — is pure and unit-tested next door, and this module is the
 * wiring that hands those parts `Notification`, `BrowserWindow` and `app`. It
 * is deliberately outside the coverage gate for the same reason `index.ts` is:
 * there is nothing here to get wrong that a test could see, and everything here
 * needs a real Electron to run.
 *
 * One runtime per process, built by `index.ts` right after the database handle
 * is known. It survives a degraded database: with no db there are no stored
 * preferences, so `readNotificationPreferences`' all-on default is used and
 * alerts keep working exactly as they did before this ticket. A broken database
 * must not also silence the app's only voice.
 */
import { app, BrowserWindow, Notification } from "electron";
import type Database from "better-sqlite3";
import {
  DEFAULT_NOTIFICATION_PREFERENCES,
  parseNotificationTarget,
  type NotificationTarget,
} from "@volli/shared";

import type { VolliIpcEvent } from "../../ipc/contract";
import { createActiveTargetRegistry } from "./active-targets";
import { createNotificationActivation } from "./activation";
import {
  createNotificationDispatcher,
  type NativeAlert,
  type NotificationRequest,
} from "./dispatch";
import { createNotificationSettings, type NotificationSettings } from "./settings";

export interface NotificationRuntime {
  /** The Settings service, or null when the database never opened. */
  settings: NotificationSettings | null;
  /** The one door: posts an alert, or silently does not. Never throws. */
  deliver(request: NotificationRequest): void;
  /** One window's on-screen target, as the renderer reported it (unvalidated). */
  reportActiveTarget(windowId: number, raw: unknown): void;
  /** Drops a closed window's reported target. */
  forgetWindow(windowId: number): void;
  /** The target of a click that arrived with no window open, taken once. */
  takePendingActivation(): NotificationTarget | null;
  /**
   * How to open a window when a click finds none. Bound late because the
   * window factory is built well after this runtime is (the run-attention
   * watch needs delivery before the first window exists).
   */
  bindWindowOpener(open: () => void): void;
}

/** Wraps Electron's `Notification` in the four signals the dispatcher uses. */
function nativeAlert(input: { title: string; body: string }): NativeAlert {
  const notification = new Notification({ title: input.title, body: input.body });
  return {
    onClick: (listener) => void notification.on("click", listener),
    onClose: (listener) => void notification.on("close", listener),
    onFailed: (listener) =>
      void notification.on("failed", (_event, error: string) =>
        listener(error === "" ? "The system did not deliver the notification." : error),
      ),
    show: () => notification.show(),
    close: () => notification.close(),
  };
}

/**
 * The process's runtime, for the two app-side singletons that cannot be handed
 * one (`retention-runtime.ts` is built lazily by whichever entrypoint asks
 * first, so it has no constructor argument to receive this in).
 *
 * Set by {@link createNotificationRuntime}, which `index.ts` calls exactly once
 * per launch. {@link deliverNotification} is the door those singletons use, and
 * it is the SAME door — not a second path around the preferences.
 */
let activeRuntime: NotificationRuntime | null = null;

/**
 * Posts an alert through this process's runtime.
 *
 * Before the runtime exists (which in production is only during the first
 * moments of boot) there is nothing to post through, and the alert is logged
 * rather than dropped in silence — a notification is never worth crashing a
 * background pass for.
 */
export function deliverNotification(request: NotificationRequest): void {
  if (activeRuntime === null) {
    console.warn(`[volli] notification before boot (${request.producer}): ${request.title}`);
    return;
  }
  activeRuntime.deliver(request);
}

/** Test seam: drops the process runtime so each test starts from nothing. */
export function resetNotificationRuntimeForTest(): void {
  activeRuntime = null;
}

export function createNotificationRuntime(options: {
  db: Database.Database | null;
}): NotificationRuntime {
  const settings =
    options.db === null
      ? null
      : createNotificationSettings({
          db: options.db,
          supported: () => Notification.isSupported(),
          now: () => Date.now(),
        });
  const registry = createActiveTargetRegistry({ windows: () => BrowserWindow.getAllWindows() });
  let openWindow: (() => void) | null = null;
  const activation = createNotificationActivation({
    windows: () =>
      BrowserWindow.getAllWindows().map((window) => ({
        isDestroyed: () => window.isDestroyed() || window.webContents.isDestroyed(),
        isMinimized: () => window.isMinimized(),
        isFocused: () => window.isFocused(),
        restore: () => window.restore(),
        show: () => window.show(),
        focus: () => window.focus(),
        send: (target) =>
          window.webContents.send("volli:notification-activated" satisfies VolliIpcEvent, target),
      })),
    focusApp: () => app.focus({ steal: true }),
    openWindow: () => openWindow?.(),
  });
  const dispatcher = createNotificationDispatcher({
    // Re-read per alert, so a switch takes effect on the next notification
    // rather than the next launch. With no database this is the all-on default,
    // which is exactly the behaviour that shipped before the preference existed.
    preferences: () => settings?.preferences() ?? DEFAULT_NOTIFICATION_PREFERENCES,
    supported: () => Notification.isSupported(),
    focusedTargets: () => registry.focusedTargets(),
    create: nativeAlert,
    activate: (target) => activation.activate(target),
    onDeliveryFailure: (failure) => {
      console.warn(`[volli] notification not delivered (${failure.producer}): ${failure.message}`);
      settings?.noteDeliveryFailure(failure);
    },
  });

  const runtime: NotificationRuntime = {
    settings,
    deliver: (request) => void dispatcher.deliver(request),
    reportActiveTarget: (windowId, raw) => registry.report(windowId, parseNotificationTarget(raw)),
    forgetWindow: (windowId) => registry.forget(windowId),
    takePendingActivation: () => activation.takePending(),
    bindWindowOpener: (open) => {
      openWindow = open;
    },
  };
  activeRuntime = runtime;
  return runtime;
}

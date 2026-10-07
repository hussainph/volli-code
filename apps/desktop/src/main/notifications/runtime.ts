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
import type { AttentionDeliveryPort } from "@volli/host-core/ports";
import {
  DEFAULT_NOTIFICATION_PREFERENCES,
  parseNotificationTarget,
  type NotificationTarget,
} from "@volli/shared";

import type { NotificationSettingsView, VolliIpcEvent } from "../../ipc/contract";
import { createActiveTargetRegistry } from "./active-targets";
import { createNotificationActivation } from "./activation";
import {
  createNotificationDispatcher,
  type NativeAlert,
  type NotificationOutcome,
  type NotificationRequest,
} from "./dispatch";
import { createNotificationSettings, type NotificationSettings } from "./settings";
import { hostLogger } from "@volli/host-core/log";

const log = hostLogger("notifications");

/**
 * Desktop's attention delivery (VC-554): host-core's `AttentionDeliveryPort`
 * is answered by `deliver` and `focusedSessionIds` here, which raise a native
 * notification and read the focused windows' targets.
 */
export interface NotificationRuntime extends AttentionDeliveryPort {
  /** The Settings service, or null when the database never opened. */
  settings: NotificationSettings | null;
  /**
   * The one door: posts an alert and says what became of it. Never throws.
   *
   * The outcome is RETURNED rather than swallowed because one caller is a
   * person's own request (`volli notify`), and a verb that reported success
   * over a refused delivery would be lying to the agent that asked (round 2).
   * Every other caller is a background observer and ignores it.
   */
  deliver(request: NotificationRequest): NotificationOutcome;
  /** One window's on-screen target, as the renderer reported it (unvalidated). */
  reportActiveTarget(windowId: number, raw: unknown): void;
  /**
   * Drops a closed window's reported target AND its click subscription: a
   * window that is gone is showing nothing and listening to nothing.
   */
  forgetWindow(windowId: number): void;
  /** This window's renderer has subscribed to notification clicks. */
  markRendererReady(windowId: number): void;
  /**
   * This window's page is being replaced or has died (a reload, a navigation,
   * a renderer crash). Its click subscription and its reported target both
   * belonged to the page that is gone: the next page subscribes and reports
   * afresh, and until it does the window is showing nothing and hearing
   * nothing.
   */
  forgetRenderer(windowId: number): void;
  /**
   * The Sessions in front of a FOCUSED window right now (VC-30).
   *
   * The unread rule's other half. `ActiveTargetRegistry` is already the app's
   * one answer to "is this in front of the person" — it pairs what each
   * renderer reports with Electron's focus — and the read rule must ask the
   * same question the alert suppression asks, or a turn could be loud and
   * unread at the same time. So it is exposed here rather than re-derived from
   * a second source.
   */
  focusedSessionIds(): ReadonlySet<string>;
  /**
   * Called whenever that set CHANGES: a window's target moved, a window took or
   * lost focus, a window went away (VC-30 A1 — viewing clears unread).
   *
   * Bound late, like {@link NotificationRuntime.bindWindowOpener}, and for the
   * same reason: this runtime is built right after the database handle is known,
   * while the read receipt repo and the Session Engine that publishes a row are
   * composed well after it. One listener, replaced if bound twice.
   */
  onFocusedSessionsChanged(listener: (sessionIds: ReadonlySet<string>) => void): void;
  /** The target of a click that arrived with no window open, taken once. */
  takePendingActivation(): NotificationTarget | null;
  /**
   * How to open a window when a click finds none. Bound late because the
   * window factory is built well after this runtime is (the run-attention
   * watch needs delivery before the first window exists).
   */
  bindWindowOpener(open: () => void): void;
}

/** Wraps Electron's `Notification` in the five signals the dispatcher uses. */
function nativeAlert(input: { title: string; body: string }): NativeAlert {
  const notification = new Notification({ title: input.title, body: input.body });
  return {
    onClick: (listener) => void notification.on("click", listener),
    onClose: (listener) => void notification.on("close", listener),
    onShow: (listener) => void notification.on("show", listener),
    onFailed: (listener) =>
      void notification.on("failed", (_event, error: string) =>
        listener(error === "" ? "The system did not deliver the notification." : error),
      ),
    show: () => notification.show(),
    close: () => notification.close(),
  };
}

/** The Settings view, to every live window (see `broadcast.ts` for the shape). */
function broadcastNotificationSettings(view: NotificationSettingsView): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (window.webContents.isDestroyed()) continue;
    window.webContents.send("volli:notification-settings" satisfies VolliIpcEvent, view);
  }
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
export function deliverNotification(request: NotificationRequest): NotificationOutcome {
  if (activeRuntime === null) {
    log.warn("notification before boot", { producer: request.producer, title: request.title });
    return { delivered: false, reason: "failed" };
  }
  return activeRuntime.deliver(request);
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
          // Every window, the whole view: a Settings page already open follows
          // a failure that lands behind it, and two windows on the page agree.
          onChange: broadcastNotificationSettings,
        });
  let focusedSessionsListener: ((sessionIds: ReadonlySet<string>) => void) | null = null;
  const registry = createActiveTargetRegistry({
    windows: () => BrowserWindow.getAllWindows(),
    onFocusedSessions: (sessionIds) => focusedSessionsListener?.(sessionIds),
  });
  // Focus belongs to `app`, not to the registry: a window that was already
  // showing a finished chat changes nothing about what it SHOWS when the person
  // comes back to it, and A1 is precisely about that case. Both edges are
  // watched — taking focus is what makes a Session read, losing it is what lets
  // the next turn be unread again.
  app.on("browser-window-focus", () => registry.noteFocusChanged());
  app.on("browser-window-blur", () => registry.noteFocusChanged());
  let openWindow: (() => void) | null = null;
  const activation = createNotificationActivation({
    windows: () =>
      BrowserWindow.getAllWindows().map((window) => ({
        id: window.id,
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
      log.warn("notification not delivered", {
        producer: failure.producer,
        error: failure.message,
      });
      settings?.noteDeliveryFailure(failure);
    },
    onDeliveryShown: () => settings?.noteDeliveryShown(),
  });

  const runtime: NotificationRuntime = {
    settings,
    deliver: (request) => dispatcher.deliver(request),
    reportActiveTarget: (windowId, raw) => registry.report(windowId, parseNotificationTarget(raw)),
    forgetWindow: (windowId) => {
      registry.forget(windowId);
      activation.forgetWindow(windowId);
    },
    focusedSessionIds: () => registry.focusedSessionIds(),
    onFocusedSessionsChanged: (listener) => {
      focusedSessionsListener = listener;
    },
    markRendererReady: (windowId) => activation.markRendererReady(windowId),
    forgetRenderer: (windowId) => {
      registry.forget(windowId);
      activation.forgetRenderer(windowId);
    },
    takePendingActivation: () => activation.takePending(),
    bindWindowOpener: (open) => {
      openWindow = open;
    },
  };
  activeRuntime = runtime;
  return runtime;
}

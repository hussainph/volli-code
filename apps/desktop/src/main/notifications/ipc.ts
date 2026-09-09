/**
 * The door {@link NotificationSettings} speaks to Settings through.
 *
 * Thin, like `../observability/ipc.ts`: two guarded requests plus the parked
 * click, and no policy of its own. What a category is, and what a write does to
 * the row, are the service's decisions — which is what keeps that service
 * testable without Electron.
 *
 * Both preference channels answer with the whole view rather than an
 * acknowledgement, so there is no way for the pane to hold a picture of a
 * setting the write did not produce. A refusal from the service throws, and the
 * registry's envelope turns it into `{ ok: false, error }` carrying the
 * service's own sentence — the one that names the category this build does not
 * have.
 *
 * The pending-activation channel is deliberately here rather than on a data
 * door: it is the second half of a notification click, and a click's target is
 * not planning data.
 */
import type { WebContents } from "electron";

import { NOTIFICATION_CHANNELS, NOTIFICATION_IPC } from "../ipc-descriptors";
import type {
  NotificationIpcChannel,
  NotificationSettingsResult,
  NotificationSettingsView,
} from "../../ipc/contract";
import type { NotificationTarget } from "@volli/shared";

import {
  registerDegradedIpcHandlers,
  registerGuardedIpcHandlers,
  type IpcHandlerTable,
} from "../ipc-registry";
import type { NotificationSettings } from "./settings";

const answer = (settings: NotificationSettingsView): NotificationSettingsResult => ({
  ok: true,
  settings,
});

/**
 * Registers the surface, or the honest refusal.
 *
 * `settings` is null when the database never opened. The channels are still
 * claimed, for the reason every other degraded surface claims its own: an
 * unregistered `invoke` channel does not fail, it hangs.
 */
export function registerNotificationIpcHandlers(ports: {
  settings: NotificationSettings | null;
  takePendingActivation: () => NotificationTarget | null;
  /** The asking window's renderer is now listening for notification clicks. */
  markRendererReady: (sender: WebContents) => void;
  unavailableReason?: string;
}): void {
  const unavailable = ports.unavailableReason ?? "Notification settings are unavailable.";
  const settings = ports.settings;
  // The parked click is registered FIRST and unconditionally, and the two
  // preference channels are degraded around it (round 2). Alerts keep working
  // without a database — `readNotificationPreferences` answers all-on — so a
  // click on one has to keep working too; refusing this channel would strand a
  // deep link on precisely the launch where the app is already degraded.
  //
  // The ask is also the subscription: a renderer registers its listener and
  // then collects, so this call is the one moment main can know that window can
  // receive a click at all.
  const pending: IpcHandlerTable<"volli:notifications-pending-activation"> = {
    "volli:notifications-pending-activation": (sender) => {
      ports.markRendererReady(sender);
      return { ok: true, target: ports.takePendingActivation() };
    },
  };
  registerGuardedIpcHandlers(
    {
      "volli:notifications-pending-activation":
        NOTIFICATION_IPC["volli:notifications-pending-activation"],
    },
    pending,
  );
  if (settings === null) {
    registerDegradedIpcHandlers(
      NOTIFICATION_CHANNELS.filter(
        (channel) => channel !== "volli:notifications-pending-activation",
      ),
      unavailable,
    );
    return;
  }
  const handlers: IpcHandlerTable<
    Exclude<NotificationIpcChannel, "volli:notifications-pending-activation">
  > = {
    "volli:notifications-get": () => answer(settings.view()),
    "volli:notifications-set": (update) => answer(settings.set(update)),
  };
  registerGuardedIpcHandlers(
    {
      "volli:notifications-get": NOTIFICATION_IPC["volli:notifications-get"],
      "volli:notifications-set": NOTIFICATION_IPC["volli:notifications-set"],
    },
    handlers,
  );
}

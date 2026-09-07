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
  unavailableReason?: string;
}): void {
  const unavailable = ports.unavailableReason ?? "Notification settings are unavailable.";
  if (ports.settings === null) {
    registerDegradedIpcHandlers(NOTIFICATION_CHANNELS, unavailable);
    return;
  }
  const settings = ports.settings;
  const handlers: IpcHandlerTable<NotificationIpcChannel> = {
    "volli:notifications-get": () => answer(settings.view()),
    "volli:notifications-set": (update) => answer(settings.set(update)),
    "volli:notifications-pending-activation": () => ({
      ok: true,
      target: ports.takePendingActivation(),
    }),
  };
  registerGuardedIpcHandlers(NOTIFICATION_IPC, handlers);
}

/**
 * The door {@link WebAccessSettings} speaks to the renderer through.
 *
 * Thin on purpose, like `../model-access/ipc.ts`: four guarded requests in, a
 * settings view out, and no policy of its own. Every decision about what an
 * endpoint may be and whether a key can be held lives in the owner, which is
 * why the owner is testable without Electron.
 *
 * **This module logs nothing, and that is a requirement rather than an
 * omission.** One of these calls carries an API key. The rest of main is free to
 * `console.warn` a failure; a surface where the argument may be a credential is
 * not, because the interesting failures are exactly the ones where a person
 * would want the argument printed.
 *
 * There is no event channel and no state pushed the other way. Web Access is a
 * setting a person edits on one page, and every answer here is the whole view —
 * so a window that changed it knows, and a window that did not asks next time it
 * opens the page. What that costs is a second window showing a stale provider
 * until reopened; what it buys is one direction of travel for the surface that
 * handles the secret.
 */

import { WEB_ACCESS_CHANNELS, WEB_ACCESS_IPC } from "../ipc-descriptors";
import type { WebAccessIpcChannel, WebAccessResult } from "../../ipc/contract";

import {
  registerDegradedIpcHandlers,
  registerGuardedIpcHandlers,
  type IpcHandlerTable,
} from "../ipc-registry";
import type { WebAccessSettings, WebAccessSettingsView } from "./settings";

/**
 * Every handler answers with the whole view rather than an acknowledgement: one
 * round trip, and no way for the page to hold a picture of a setting the write
 * did not actually produce. A refusal from the owner throws instead, and the
 * registry's envelope turns it into `{ ok: false, error }` carrying the owner's
 * own sentence — which is the one a person needs to read.
 */
const answer = (settings: WebAccessSettingsView): WebAccessResult => ({ ok: true, settings });

/**
 * Registers the surface, or the honest refusal.
 *
 * `settings` is null when the database never opened. The channels are still
 * claimed, because an unregistered `invoke` channel does not fail — it hangs,
 * and a Settings page that never answers is worse than one that says why.
 */
export function registerWebAccessIpcHandlers(
  settings: WebAccessSettings | null,
  unavailableReason: string = "Web access settings are unavailable.",
): void {
  if (settings === null) {
    registerDegradedIpcHandlers(WEB_ACCESS_CHANNELS, unavailableReason);
    return;
  }

  const handlers: IpcHandlerTable<WebAccessIpcChannel> = {
    "volli:web-access-get": () => answer(settings.view()),
    "volli:web-access-set-provider": (provider, searxngUrl) =>
      answer(settings.setProvider({ provider, searxngUrl })),
    "volli:web-access-set-key": (provider, key) => answer(settings.saveKey(provider, key)),
    "volli:web-access-clear-key": (provider) => answer(settings.clearKey(provider)),
  };
  registerGuardedIpcHandlers(WEB_ACCESS_IPC, handlers);
}

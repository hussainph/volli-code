/**
 * The door {@link ModelAccessSignInService} speaks to the renderer through.
 *
 * Thin on purpose: four guarded requests in, one ordered event channel out, and
 * no policy of its own. Everything about *what* a sign-in does lives in the
 * service, which is why the service can be tested without Electron; everything
 * about *which window* is watching lives here, which is the one fact the
 * service is deliberately blind to.
 *
 * **This module logs nothing, and that is a requirement rather than an
 * omission.** One of these calls carries an API key. The rest of main is free
 * to `console.warn` a failure; a surface where the argument may be a credential
 * is not, because the interesting failures are exactly the ones where a person
 * would want the argument printed.
 *
 * The owner mapping is per page and identity-based. A page that goes away
 * mid-flow — its window closed, a reload, a renderer crash — takes its attempts
 * with it, and the flow's abort closes any loopback callback server it started.
 * Otherwise a login parked on a question nobody can see would hold the
 * provider's one attempt slot (and its fixed callback port) until the window
 * closed, and the row on the reloaded page, which no longer knows the attempt
 * id, would refuse to start (VC-831).
 */

import type { WebContents } from "electron";
import { MODEL_ACCESS_CHANNELS, MODEL_ACCESS_IPC } from "../ipc-descriptors";
import type { ModelAccessSignInUpdate } from "@volli/shared";
import type { ModelAccessIpcChannel, Result, VolliIpcEvent } from "../../ipc/contract";

import {
  registerDegradedIpcHandlers,
  registerGuardedIpcHandlers,
  type IpcHandlerTable,
} from "../ipc-registry";
import { ModelAccessSignInService, type SignInOwner } from "@volli/host-core/session-runtime";
import { onDocumentGone } from "../document-lifetime";

const SIGN_IN_EVENT = "volli:model-access-sign-in" satisfies VolliIpcEvent;

/**
 * Registers the surface, or the honest refusal.
 *
 * `service` is null when the Pi runtime never came up. The channels are still
 * claimed, because an unregistered `invoke` channel does not fail — it hangs,
 * and a Sign in button that never returns is worse than one that says why.
 *
 * `unavailableReason` is that refusal's text. The caller that knows WHY the
 * runtime is down (a database that never opened, a Node-ABI mismatch behind
 * it — VC-76) passes the classified reason; the fallback stays for a caller
 * with nothing better to say.
 */
export function registerModelAccessIpcHandlers(
  service: ModelAccessSignInService | null,
  unavailableReason: string = "The agent runtime is unavailable.",
): void {
  if (service === null) {
    registerDegradedIpcHandlers(MODEL_ACCESS_CHANNELS, unavailableReason);
    return;
  }

  /**
   * One owner per page, kept by identity because that is what the service
   * compares. A fresh object per call would make every attempt unabandonable.
   * The entry goes with the page, so a reloaded page gets a fresh owner.
   */
  const owners = new Map<WebContents, SignInOwner>();
  const ownerFor = (sender: WebContents): SignInOwner => {
    const existing = owners.get(sender);
    if (existing !== undefined) return existing;
    // Once its page is gone an owner says nothing more: the abandoned attempt
    // still settles, but the page that would hear it is a reloaded one that
    // never began it, and would hold its unclaimed updates forever.
    let pageGone = false;
    const owner: SignInOwner = {
      send: (update: ModelAccessSignInUpdate): void => {
        if (pageGone || sender.isDestroyed()) return;
        sender.send(SIGN_IN_EVENT, update);
      },
    };
    owners.set(sender, owner);
    onDocumentGone(sender, () => {
      pageGone = true;
      owners.delete(sender);
      service.abandonOwner(owner);
    });
    return owner;
  };

  const handlers: IpcHandlerTable<ModelAccessIpcChannel> = {
    "volli:model-access-sign-in-begin": (providerId, type, sender) =>
      service.begin(providerId, type, ownerFor(sender)),
    "volli:model-access-sign-in-respond": (attemptId, promptId, value): Result =>
      service.respond(attemptId, promptId, value),
    "volli:model-access-sign-in-cancel": (attemptId): Result => service.cancel(attemptId),
    "volli:model-access-sign-out": (providerId): Promise<Result> => service.signOut(providerId),
  };
  registerGuardedIpcHandlers(MODEL_ACCESS_IPC, handlers);
}

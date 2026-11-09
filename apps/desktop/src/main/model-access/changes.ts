/**
 * Accepted Model Access changes invalidate every other desktop renderer's held
 * catalogue. This notice has no payload: credentials and addressed sign-in
 * prompts never belong on a broadcast wire.
 */
import { BrowserWindow } from "electron";
import type { SessionRouterHandlers } from "@volli/session-rpc";
import { withMainSpan } from "@volli/host-core/log";
import type { VolliIpcEvent } from "../../ipc/contract";
import { currentRendererId } from "../renderer-call";

const CHANGED_EVENT = "volli:model-access-changed" satisfies VolliIpcEvent;

export function broadcastModelAccessChanged(excludeRendererId?: number): void {
  withMainSpan({ door: "broadcast", operation: CHANGED_EVENT }, () => {
    for (const window of BrowserWindow.getAllWindows()) {
      const contents = window.webContents;
      if (contents.isDestroyed() || contents.id === excludeRendererId) continue;
      contents.send(CHANGED_EVENT);
    }
  });
}

type ModelAccessChangeHandlers = Pick<
  SessionRouterHandlers,
  "modelAccess.inspect" | "modelAccess.setDefault" | "modelAccess.setHiddenModels"
>;

/**
 * The desktop RPC edge's notification half. The original handlers still own
 * validation and persistence; refused writes never publish. The writer already
 * invalidates from its accepted response, so only peers hear this notice.
 */
export function withModelAccessChangeNotifications<T extends ModelAccessChangeHandlers>(
  handlers: T,
): T {
  return {
    ...handlers,
    "modelAccess.inspect": async (input, call) => {
      const snapshot = await handlers["modelAccess.inspect"](input, call);
      // A completed refresh can replace the catalogue and repair preferences.
      if (input.refresh === true) broadcastModelAccessChanged(currentRendererId());
      return snapshot;
    },
    "modelAccess.setDefault": async (input, call) => {
      const saved = await handlers["modelAccess.setDefault"](input, call);
      broadcastModelAccessChanged(currentRendererId());
      return saved;
    },
    "modelAccess.setHiddenModels": async (input, call) => {
      await handlers["modelAccess.setHiddenModels"](input, call);
      broadcastModelAccessChanged(currentRendererId());
    },
  };
}

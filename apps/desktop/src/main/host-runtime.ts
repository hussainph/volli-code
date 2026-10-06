/** Desktop's actual host edge, shared by boot and recorded-port composition tests. */
import type { HostCore } from "@volli/host-core";
import { quitAlreadyRefused, refuseQuit } from "./quit-gate";
import type {
  RecoveredSessionServices,
  SessionRuntimeLifecycle,
} from "@volli/host-core/session-runtime";

export function createDesktopHostRuntime<Services>(options: {
  host: HostCore;
  lifecycle: Pick<SessionRuntimeLifecycle<Services>, "ready" | "close">;
  bindReady(ready: RecoveredSessionServices<Services>): void;
  stopProducers(): void;
  closeSocket(): Promise<boolean | void>;
}) {
  const owner = {
    start: async () => {
      options.bindReady(await options.lifecycle.ready());
    },
    stopProducers: options.stopProducers,
    // Desktop's accepted quit has always joined only the Session lifecycle
    // beside the socket. Shell/Automation/detached joins belong to hostd.
    close: () => options.lifecycle.close(),
    closeSocket: options.closeSocket,
  };
  return {
    async start(): Promise<RecoveredSessionServices<Services>> {
      await options.host.start(owner);
      return options.lifecycle.ready();
    },
  };
}

/**
 * The menu-bar branch's two seams (VC-577), present only with the `cloud`
 * flag on. `branch` is asked after the destructive-work confirms have
 * answered; `enter` runs only for an attempt they did not refuse.
 */
export interface MenuBarQuitPort {
  branch(): "quit" | "menu-bar";
  enter(): void;
}

/**
 * Former synchronous listeners.
 *
 * **Flag off (`menuBar` absent): today's order, byte for byte** — including
 * the two unconditional stops (Automations, repack) on a refused attempt.
 *
 * **Flag on:** the confirms run first and unchanged; a refused attempt then
 * stops nothing. An accepted one either enters menu-bar mode — refused
 * through {@link refuseQuit}, so the coordinator and every listener behind it
 * stand down, and Automations keep running — or takes the same quit, with the
 * two stops moved behind the decision.
 */
export function prepareDesktopQuit(
  event: { preventDefault(): void },
  ports: {
    stopAutomations(): void;
    unsavedQuit(event: { preventDefault(): void }): void;
    terminalQuit(event: { preventDefault(): void }): void;
    abortRepack(): void;
    menuBar?: MenuBarQuitPort;
  },
): void {
  const menuBar = ports.menuBar;
  if (menuBar === undefined) {
    ports.stopAutomations();
    ports.unsavedQuit(event);
    ports.terminalQuit(event);
    ports.abortRepack();
    return;
  }
  ports.unsavedQuit(event);
  ports.terminalQuit(event);
  if (quitAlreadyRefused(event)) return;
  if (menuBar.branch() === "menu-bar") {
    refuseQuit(event);
    menuBar.enter();
    return;
  }
  ports.stopAutomations();
  ports.abortRepack();
}

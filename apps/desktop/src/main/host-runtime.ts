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
  /**
   * Asked after the unsaved-drafts confirm and before the terminal one: when
   * this attempt would enter menu-bar mode and Sessions are using Browser
   * Tabs, whether to close them. False refuses the quit (the person's Cancel).
   */
  confirmEnter(): boolean;
  enter(): void;
  /** A noted logout, restart or shutdown: nothing interactive may refuse this quit. */
  systemShuttingDown(): boolean;
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
 *
 * **Flag on, system logout/restart/shutdown noted:** nothing interactive runs,
 * because a refusal (or a modal left waiting) would cancel the person's
 * power-off. The confirms' teardown still happens — `systemShutdownTeardown`
 * kills every terminal and asks the windows to flush their drafts — and the
 * quit is accepted.
 */
export function prepareDesktopQuit(
  event: { preventDefault(): void },
  ports: {
    stopAutomations(): void;
    unsavedQuit(event: { preventDefault(): void }): void;
    terminalQuit(event: { preventDefault(): void }): void;
    abortRepack(): void;
    menuBar?: MenuBarQuitPort;
    /** Flag on, system shutdown: the confirms' teardown without the confirms. */
    systemShutdownTeardown?(): void;
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
  if (menuBar.systemShuttingDown()) {
    ports.systemShutdownTeardown?.();
    ports.stopAutomations();
    ports.abortRepack();
    return;
  }
  ports.unsavedQuit(event);
  // Asked before the terminal confirm, whose accept kills every PTY: a Cancel
  // here must leave the app exactly as it was. Only asks when this attempt
  // would enter menu-bar mode and Sessions are using Browser Tabs.
  if (!quitAlreadyRefused(event) && !menuBar.confirmEnter()) refuseQuit(event);
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

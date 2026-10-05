/** Desktop's actual host edge, shared by boot and recorded-port composition tests. */
import type { HostCore } from "@volli/host-core";
import type {
  RecoveredSessionServices,
  SessionRuntimeLifecycle,
} from "@volli/host-core/session-runtime/lifecycle";

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

/** Former synchronous listeners, in their original order even on a refused quit. */
export function prepareDesktopQuit(
  event: { preventDefault(): void },
  ports: {
    stopAutomations(): void;
    unsavedQuit(event: { preventDefault(): void }): void;
    terminalQuit(event: { preventDefault(): void }): void;
    abortRepack(): void;
  },
): void {
  ports.stopAutomations();
  ports.unsavedQuit(event);
  ports.terminalQuit(event);
  ports.abortRepack();
}

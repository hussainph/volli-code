/**
 * The Agent Runtime's view of the network and of sleep, from Electron (VC-443).
 *
 * The runtime is plain TypeScript and asks through a port; this is the one
 * implementation that can answer, because `net.isOnline()` and `powerMonitor`
 * exist only in main. Written against the two objects rather than importing
 * them, so it runs in plain Node under test and `index.ts` hands in the real
 * ones.
 *
 * Main has no "online" event to wait on — `navigator.onLine` and its events
 * belong to renderers — so a wait for the network re-asks `net.isOnline()` on
 * an interval, and re-asks at once on the two moments a Mac most often gets its
 * network back: waking from sleep and being unlocked. Polling runs only while a
 * turn is actually waiting, and costs one cheap platform call per tick.
 */

import type { ConnectivityPort } from "@volli/agent-runtime";

/** How often a turn waiting for the network re-asks whether it is back. */
export const ONLINE_POLL_MS = 2_000;

type PowerEvent = "resume" | "unlock-screen";

/** The slice of Electron's `net` and `powerMonitor` this reads. */
export interface ConnectivityPlatform {
  net: { isOnline(): boolean };
  powerMonitor: {
    on(event: PowerEvent, listener: () => void): unknown;
    removeListener(event: PowerEvent, listener: () => void): unknown;
  };
}

export function createConnectivityPort(
  platform: ConnectivityPlatform,
  pollMs: number = ONLINE_POLL_MS,
): ConnectivityPort {
  const isOnline = (): boolean => platform.net.isOnline();
  return {
    isOnline,
    waitUntilOnline(signal) {
      return new Promise<void>((resolve, reject) => {
        if (signal.aborted) {
          reject(new Error("Stopped waiting for the network."));
          return;
        }
        if (isOnline()) {
          resolve();
          return;
        }
        const stop = (): void => {
          clearInterval(poll);
          platform.powerMonitor.removeListener("resume", check);
          platform.powerMonitor.removeListener("unlock-screen", check);
          signal.removeEventListener("abort", abandon);
        };
        const check = (): void => {
          if (!isOnline()) return;
          stop();
          resolve();
        };
        const abandon = (): void => {
          stop();
          reject(new Error("Stopped waiting for the network."));
        };
        const poll = setInterval(check, pollMs);
        platform.powerMonitor.on("resume", check);
        platform.powerMonitor.on("unlock-screen", check);
        signal.addEventListener("abort", abandon, { once: true });
      });
    },
    onResume(listener) {
      platform.powerMonitor.on("resume", listener);
      return () => {
        platform.powerMonitor.removeListener("resume", listener);
      };
    },
  };
}

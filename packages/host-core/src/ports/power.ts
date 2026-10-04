/**
 * The machine's sleep and wake (VC-554).
 *
 * The OS's own announcements are the only honest source: Node's monotonic
 * clocks keep counting across macOS sleep. Desktop passes Electron's
 * `powerMonitor` itself, which satisfies this shape, so every listener is
 * attached exactly where it was before. The session watchdog's suspend clock,
 * the scheduled-resume host's wake pass and the network wait in
 * `ConnectivityPort` (`@volli/agent-runtime`) all read it.
 *
 * Network reachability is not here: that is `ConnectivityPort`, which a host
 * builds from this port and its own network reading.
 */

/** The announcements host code reads. `suspend` opens a sleep; the rest prove the machine awake. */
export type PowerEvent = "suspend" | "resume" | "unlock-screen" | "user-did-become-active";

/** An emitter of {@link PowerEvent}s. Electron's `powerMonitor` satisfies it. */
export interface PowerPort {
  on(event: PowerEvent, listener: () => void): unknown;
  removeListener(event: PowerEvent, listener: () => void): unknown;
}

/**
 * A host that is never told about sleep: a server that does not suspend. The
 * watchdog then counts every silence as silence, which is true on such a host.
 */
export const NO_POWER_EVENTS: PowerPort = {
  on: () => undefined,
  removeListener: () => undefined,
};

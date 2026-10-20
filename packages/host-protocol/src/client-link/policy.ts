/**
 * The client host link's numbers (VC-670): how fast a dead socket is found,
 * how long a handshake may take, and how reconnects back off. One place, so
 * the UI's grace period (VC-615) and the tests read the same values.
 */

export interface HostLinkTiming {
  /** Inbound silence after which the link pings the host. */
  readonly heartbeatIntervalMs: number;
  /** How long a ping may go unanswered (by any frame) before the socket is declared dead. */
  readonly heartbeatTimeoutMs: number;
  /** From the start of an attempt to a validated welcome: credential, socket, hello, welcome. */
  readonly handshakeTimeoutMs: number;
  /** The delay before the first retry; each failure after it doubles it. */
  readonly backoffBaseMs: number;
  /** No retry ever waits longer than this. */
  readonly backoffCapMs: number;
}

/**
 * The defaults. A dead socket is found within
 * `heartbeatIntervalMs + heartbeatTimeoutMs` (7 s) of the last frame the host
 * sent, and at once after a wake, which probes with only the timeout (2 s).
 * Retries wait 0.25–0.5 s after the first failure, doubling to a 5–10 s
 * ceiling: never stock tRPC's 30 s, and jittered so a fleet of clients does
 * not reconnect in lockstep after a host restart. The handshake allows what
 * the listener allows a hello (10 s).
 */
export const HOST_LINK_TIMING: HostLinkTiming = Object.freeze({
  heartbeatIntervalMs: 5_000,
  heartbeatTimeoutMs: 2_000,
  handshakeTimeoutMs: 10_000,
  backoffBaseMs: 500,
  backoffCapMs: 10_000,
});

/**
 * The wait before the next attempt, after `failures` consecutive failed ones
 * (at least 1). The ceiling doubles from the base to the cap; `random` (in
 * [0, 1)) places the wait in the upper half of it, so the wait is never under
 * half the ceiling and never over the cap.
 */
export function hostLinkBackoffDelay(
  failures: number,
  timing: Pick<HostLinkTiming, "backoffBaseMs" | "backoffCapMs">,
  random: () => number = Math.random,
): number {
  const exponent = Math.min(Math.max(failures, 1) - 1, 30);
  const ceiling = Math.min(timing.backoffCapMs, timing.backoffBaseMs * 2 ** exponent);
  return Math.round(ceiling / 2 + (ceiling / 2) * Math.min(Math.max(random(), 0), 1));
}

/** Every number a positive integer, and the base within the cap. */
export function validateHostLinkTiming(timing: HostLinkTiming): void {
  for (const [name, value] of Object.entries(timing)) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new Error(`Host link timing ${name} must be a positive integer`);
    }
  }
  if (timing.backoffBaseMs > timing.backoffCapMs) {
    throw new Error("Host link backoffBaseMs must not exceed backoffCapMs");
  }
}

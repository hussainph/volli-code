/**
 * The headless runner's answers to host-core's ports. A box has no window and
 * no person at it:
 *
 * - **events**: no client is connected to the box, so a broadcast is dropped.
 *   Only its topic is logged, never its payload (it can carry ticket text).
 *   The person's clients follow Volli Cloud, not this process.
 * - **attention**: `HEADLESS_ATTENTION`. A cloud Session's attention reaches its
 *   owner through the backend (`attention.raiseFromRunner`), not a local alert.
 * - **power**: `NO_POWER_EVENTS`; a server does not sleep.
 * - **connectivity**: `ALWAYS_ONLINE`.
 * - **client** and **trash**: absent; host-core refuses those requests with its
 *   typed "needs the desktop app" errors.
 */
import { ALWAYS_ONLINE } from "@volli/agent-runtime";

import type { HostCorePorts } from "../index";
import { HEADLESS_ATTENTION } from "../ports/attention";
import { NO_POWER_EVENTS } from "../ports/power";

/** The process log a headless runner writes: structured lines, never a credential. */
export interface HeadlessRunnerLogger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

export function headlessRunnerPorts(logger: HeadlessRunnerLogger): HostCorePorts {
  return {
    log: {
      error: (message, fields) => logger.error(message, { source: "host-core", ...fields }),
      warn: (message, fields) => logger.warn(message, { source: "host-core", ...fields }),
    },
    events: {
      publish: (topic) => logger.debug("event dropped: no client on this runner", { topic }),
    },
    attention: {
      deliver: (request) => {
        const outcome = HEADLESS_ATTENTION.deliver(request);
        logger.info("attention not delivered: no client on this runner", {
          producer: request.producer,
        });
        return outcome;
      },
      focusedSessionIds: () => HEADLESS_ATTENTION.focusedSessionIds(),
    },
    power: NO_POWER_EVENTS,
    connectivity: ALWAYS_ONLINE,
  };
}

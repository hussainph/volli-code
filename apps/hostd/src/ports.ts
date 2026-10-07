/**
 * hostd's answers to host-core's ports (`packages/host-core/README.md`,
 * "Ports"). A headless host has no window and no person at the machine:
 *
 * - **events**: no client is connected until the host protocol lands (M2), so
 *   a broadcast is dropped. Its topic is logged at `debug`; never its
 *   payload, which can carry ticket text.
 * - **attention**: `HEADLESS_ATTENTION` (every alert `unsupported`, nothing
 *   focused), plus one `info` line naming what would have been raised.
 * - **power**: `NO_POWER_EVENTS`; a server does not sleep.
 * - **connectivity**: `ALWAYS_ONLINE`.
 * - **client** and **trash**: absent. host-core refuses those requests with
 *   its typed "needs the desktop app" errors, and never deletes instead.
 */

import { ALWAYS_ONLINE } from "@volli/agent-runtime";
import { HEADLESS_ATTENTION, NO_POWER_EVENTS } from "@volli/host-core/ports";
import type { HostCorePorts } from "@volli/host-core";
import type { DataChangeScope } from "@volli/shared";

import type { HostdLogger } from "./log";

/**
 * `onDataChanged` hears every `data-changed` a host-core writer announces: the
 * board's change feed stamps them (VC-565), so a Client following the feed
 * learns of an agent's write as of a person's. No window is told: none exists.
 */
export function headlessPorts(
  logger: HostdLogger,
  onDataChanged: (scope: DataChangeScope) => void = () => {},
): HostCorePorts {
  return {
    log: {
      error: (msg, fields) => logger.error(msg, { source: "host-core", ...fields }),
      warn: (msg, fields) => logger.warn(msg, { source: "host-core", ...fields }),
    },
    events: {
      publish: (topic, payload) => {
        if (topic === "data-changed") onDataChanged(payload as DataChangeScope);
        logger.debug("event dropped: no client connected", { topic });
      },
    },
    attention: {
      deliver: (request) => {
        const outcome = HEADLESS_ATTENTION.deliver(request);
        logger.info("attention not delivered: no client connected", {
          producer: request.producer,
          title: request.title,
        });
        return outcome;
      },
      focusedSessionIds: () => HEADLESS_ATTENTION.focusedSessionIds(),
    },
    power: NO_POWER_EVENTS,
    connectivity: ALWAYS_ONLINE,
  };
}

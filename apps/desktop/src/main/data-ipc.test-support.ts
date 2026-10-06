/**
 * TEST-ONLY: `registerDataIpcHandlers` with the host's real handler map built
 * from the move ports a case states (VC-668).
 *
 * `volli:ticket-move` projects `handlers["ticket.move"]`, which production
 * builds once in `index.ts`. Cases that observe a move's interrupt or armed
 * arrival keep stating them as plain callbacks; this builds the one map from
 * them, publishing on the same window bus production's map does. It uses the
 * production entry, not `@volli/host-core/testing`, which only `*.test.ts`
 * files may import (`host-core-testing-boundary.test.ts`).
 */
import type { DbHandle } from "@volli/host-core";
import { createHostHandlers } from "@volli/host-core/handlers";
import type { TicketMovedNotice } from "@volli/shared";

import { windowEventBus } from "./broadcast";
import { registerDataIpcHandlers as register } from "./data-ipc";

type Options = Parameters<typeof register>[1];

export type TestDataIpcOptions = Omit<Options, "handlers"> & {
  handlers?: Options["handlers"];
  interruptTicketSessions?: (ticketId: string) => string[] | Promise<string[]>;
  onDeliberateMove?: (notice: TicketMovedNotice) => void;
};

/** A database that never opened answers every channel unavailable; it needs no map. */
const NO_BOARD: Options["handlers"] = {
  "ticket.move": () => {
    throw new Error("No board: the database did not open");
  },
};

export function registerDataIpcHandlers(handle: DbHandle, options: TestDataIpcOptions): void {
  const { interruptTicketSessions, onDeliberateMove, handlers, ...rest } = options;
  register(handle, {
    ...rest,
    handlers:
      handlers ??
      (handle.ok
        ? createHostHandlers(
            {
              events: windowEventBus,
              attention: { deliver: () => ({ delivered: true }) },
            } as never,
            {
              db: handle.db,
              dataDir: "/volli-test-userdata",
              runtime: null,
              sessions: null,
              modelAccess: null,
              experiments: null,
              // Only the armed-arrival half of the Automations service is read.
              automations: {
                kind: "live",
                execution: {
                  kind: "unavailable",
                  pendingArmedRuns: {
                    noteDeliberateMove: (notice: TicketMovedNotice) => onDeliberateMove?.(notice),
                  },
                },
              } as never,
              busyWorktreeSites: rest.busyWorktreeSites ?? (async () => []),
              ...(interruptTicketSessions === undefined ? {} : { interruptTicketSessions }),
              ...(rest.detachedWork === undefined ? {} : { detachedWork: rest.detachedWork }),
            },
          )
        : NO_BOARD),
  });
}

// Runtime half of the IPC request contract (issue #98). The type half lives in
// ipc.ts; this module may be imported at runtime by MAIN ONLY — the preload
// stays type-only on @volli/shared (the pack config keeps main and preload
// dependency-disjoint; see CAUTION in apps/desktop/vite.config.ts).

import type { DataIpcChannel, IpcArgs } from "./ipc";
import { isTicketStatus } from "./ticket";

/**
 * One request's runtime descriptor: the validator over the raw
 * `ipcRenderer.invoke` argument tuple, and the exact `{ ok: false }` error
 * string returned when it rejects. The mapped table type below forces every
 * guard's predicate to match its channel's contract `args` — a guard that
 * checks the wrong shape is a compile error, not silent drift.
 */
export interface IpcRequestDescriptor<C extends DataIpcChannel> {
  guard: (args: unknown[]) => args is IpcArgs<C>;
  invalidError: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * The data-IPC descriptor table — exactly one entry per contract channel
 * (exhaustiveness is compile-checked in both directions). `DATA_CHANNELS`
 * derives from its keys, so the degraded-DB registration can no longer skip a
 * channel and leave a renderer `invoke()` hanging.
 */
export const DATA_IPC: { readonly [C in DataIpcChannel]: IpcRequestDescriptor<C> } = {
  "volli:data-bootstrap": {
    guard: (args): args is [] => args.length === 0,
    invalidError: "Invalid request",
  },
  "volli:ticket-move": {
    guard: (args): args is IpcArgs<"volli:ticket-move"> => {
      if (args.length !== 1) return false;
      const [input] = args;
      return (
        isRecord(input) &&
        typeof input["projectId"] === "string" &&
        typeof input["ticketId"] === "string" &&
        isTicketStatus(input["toStatus"]) &&
        typeof input["toIndex"] === "number" &&
        Number.isInteger(input["toIndex"])
      );
    },
    invalidError: "Invalid ticket move",
  },
  "volli:app-state-set": {
    guard: (args): args is IpcArgs<"volli:app-state-set"> =>
      args.length === 2 && args.every((entry) => typeof entry === "string"),
    invalidError: "Invalid app state",
  },
};

/** Every channel the data-IPC surface owns, derived — never hand-synced. */
export const DATA_CHANNELS = Object.keys(DATA_IPC) as readonly DataIpcChannel[];

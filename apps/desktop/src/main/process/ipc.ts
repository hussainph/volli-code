/**
 * The renderer's doors onto the orphan process sweep (VC-341).
 *
 * Three channels, and the split is the safety property: a scan is read-only, a
 * reap may only name items from the revision the service itself minted, and the
 * automatic-reaping preference is neither. A pid never comes back from the
 * renderer as authority — the service holds the proposal, and re-proves every
 * candidate's identity against the live process table before it signals.
 */
import type Database from "better-sqlite3";
import type { AutoReapPolicy } from "@volli/shared";

import type {
  OrphanProcessIpcChannel,
  OrphanProcessPolicyResult,
  OrphanProcessReapInput,
  OrphanProcessReapResult,
  OrphanProcessScanResult,
} from "../../ipc/contract";
import type { DbHandle } from "../data-ipc";
import { ORPHAN_PROCESS_CHANNELS, ORPHAN_PROCESS_IPC } from "../ipc-descriptors";
import { registerDegradedIpcHandlers, registerGuardedIpcHandlers } from "../ipc-registry";
import type { IpcHandlerTable } from "../ipc-registry";
import { getAutoReapPolicy, setAutoReapPolicy } from "./auto-reap-settings";
import type { OrphanProcessService } from "./orphan-processes";

export function registerOrphanProcessIpcHandlers(
  handle: DbHandle,
  service: OrphanProcessService | null,
  now: () => number = Date.now,
): void {
  if (!handle.ok || service === null) {
    registerDegradedIpcHandlers(
      ORPHAN_PROCESS_CHANNELS,
      handle.ok ? "The process sweep is not available this launch." : handle.error,
    );
    return;
  }
  const db: Database.Database = handle.db;
  const handlers: IpcHandlerTable<OrphanProcessIpcChannel> = {
    // The envelope in `ipc-registry.ts` turns a throw into `{ ok: false,
    // error }`, so a failed scan or a superseded revision reaches the pane as
    // the sentence the service wrote rather than as a hung invoke.
    "volli:orphan-processes-scan": async (): Promise<OrphanProcessScanResult> => ({
      ok: true,
      inventory: await service.scan(),
      policy: getAutoReapPolicy(db),
    }),
    "volli:orphan-processes-reap": async (
      input: OrphanProcessReapInput,
    ): Promise<OrphanProcessReapResult> => ({ ok: true, report: await service.reap(input) }),
    "volli:orphan-processes-policy": (policy: AutoReapPolicy): OrphanProcessPolicyResult => ({
      ok: true,
      policy: setAutoReapPolicy(db, policy, now()),
    }),
  };
  registerGuardedIpcHandlers(ORPHAN_PROCESS_IPC, handlers);
}

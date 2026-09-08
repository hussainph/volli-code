import type Database from "better-sqlite3";

import type {
  PiSessionOrphanIpcChannel,
  PiSessionOrphanReclaimInput,
  PiSessionOrphanReclaimResult,
  PiSessionOrphanScanResult,
} from "../ipc/contract";
import type { DbHandle } from "./data-ipc";
import { PI_SESSION_ORPHAN_CHANNELS, PI_SESSION_ORPHAN_IPC } from "./ipc-descriptors";
import { registerDegradedIpcHandlers, registerGuardedIpcHandlers } from "./ipc-registry";
import type { IpcHandlerTable } from "./ipc-registry";
import { PiSessionOrphanService } from "./pi-session-orphans";

/**
 * Registers the read-only Pi inventory and its separate confirmed reclaim.
 * The service owns the latest scan revision, so the renderer never turns a
 * path string into deletion authority by echoing it back.
 */
export function registerPiSessionOrphanIpcHandlers(
  handle: DbHandle,
  sessionsRoot: string,
  createService: (db: Database.Database, root: string) => PiSessionOrphanService = (db, root) =>
    new PiSessionOrphanService(db, root),
): void {
  if (!handle.ok) {
    registerDegradedIpcHandlers(PI_SESSION_ORPHAN_CHANNELS, handle.error);
    return;
  }

  const service = createService(handle.db, sessionsRoot);
  const handlers: IpcHandlerTable<PiSessionOrphanIpcChannel> = {
    "volli:pi-session-orphans-scan": async (): Promise<PiSessionOrphanScanResult> => ({
      ok: true,
      inventory: await service.scan(),
    }),
    "volli:pi-session-orphans-reclaim": async (
      input: PiSessionOrphanReclaimInput,
    ): Promise<PiSessionOrphanReclaimResult> => ({
      ok: true,
      report: await service.reclaim(input),
    }),
  };
  registerGuardedIpcHandlers(PI_SESSION_ORPHAN_IPC, handlers);
}

/**
 * The Settings door onto whether a turn a deliberate quit cut short resumes on
 * its own at the next launch (VC-1245). Two guarded requests over one
 * host-level `app_state` row; the decision itself is the restart-resume
 * verdict's, which reads the row at each launch.
 */
import type { QuitResumeIpcChannel, QuitResumeResult } from "../../ipc/contract";
import type { DbHandle } from "../data-ipc";
import { QUIT_RESUME_CHANNELS, QUIT_RESUME_IPC } from "../ipc-descriptors";
import {
  registerDegradedIpcHandlers,
  registerGuardedIpcHandlers,
  type IpcHandlerTable,
} from "../ipc-registry";
import {
  readAutoResumeAfterQuit,
  writeAutoResumeAfterQuit,
} from "@volli/host-core/session-runtime";

/** Registers the door, or its refusal when the database never opened. */
export function registerQuitResumeIpcHandlers(
  handle: DbHandle,
  now: () => number = Date.now,
): void {
  if (!handle.ok) {
    registerDegradedIpcHandlers(QUIT_RESUME_CHANNELS, handle.error);
    return;
  }
  const db = handle.db;
  const handlers: IpcHandlerTable<QuitResumeIpcChannel> = {
    "volli:quit-resume-get": (): QuitResumeResult => ({
      ok: true,
      autoResume: readAutoResumeAfterQuit(db),
    }),
    "volli:quit-resume-set": (autoResume: boolean): QuitResumeResult => ({
      ok: true,
      autoResume: writeAutoResumeAfterQuit(db, autoResume, now()),
    }),
  };
  registerGuardedIpcHandlers(QUIT_RESUME_IPC, handlers);
}

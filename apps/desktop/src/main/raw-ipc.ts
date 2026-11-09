/**
 * The raw IPC channels' door (VC-1090): `ipcMain.handle`/`ipcMain.on` for a
 * channel the guarded registry (`ipc-registry.ts`) does not own — terminals,
 * folder pickers, secrets, notification targets.
 *
 * Each call is timed as main-thread work under its channel, so a handler that
 * holds the event loop is named in the stall log instead of landing in
 * `unattributed`. An invoke (`handle`) is a door call: its own trace, like
 * every guarded channel. A fire-and-forget send (`on`: a terminal ack, a
 * visibility flip, sent per data event or per navigation) only gets the stall
 * span — no trace minted per send.
 *
 * Logs only: the listener runs unchanged and its result is returned as is.
 */
import { ipcMain, type IpcMainEvent, type IpcMainInvokeEvent } from "electron";
import { withMainSpan, withTrace } from "@volli/host-core/log";

/** `ipcMain.handle(channel, listener)`, each call inside its own `ipc` door trace. */
export function handleRawIpc<Args extends unknown[]>(
  channel: string,
  listener: (event: IpcMainInvokeEvent, ...args: Args) => unknown,
): void {
  ipcMain.handle(channel, (event, ...args: unknown[]) =>
    withTrace(null, { door: "ipc", operation: channel }, () => listener(event, ...(args as Args))),
  );
}

/** `ipcMain.on(channel, listener)`, each send timed as an `ipc` span. */
export function onRawIpc<Args extends unknown[]>(
  channel: string,
  listener: (event: IpcMainEvent, ...args: Args) => void,
): void {
  ipcMain.on(channel, (event, ...args: unknown[]) =>
    withMainSpan({ door: "ipc", operation: channel }, () => listener(event, ...(args as Args))),
  );
}

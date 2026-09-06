/**
 * The Session cursor overlay's preload (VC-239): the one bridge between main
 * and the small app-owned page that draws the cursor over a Browser Tab.
 *
 * Deliberately not the app preload. That bridge is the whole product API and
 * this page needs five verbs; giving it the rest would hand a view that sits
 * over untrusted pages far more than it can use. Sandboxed, context-isolated,
 * and importing only `electron`, like the app preload.
 */
import { contextBridge, ipcRenderer } from "electron";

import {
  CURSOR_ASK_TO_LEAVE_CHANNEL,
  CURSOR_SETTLED_CHANNEL,
  CURSOR_SIZE_CHANNEL,
  CURSOR_STATE_CHANNEL,
  CURSOR_TAKE_OVER_CHANNEL,
  type CursorOverlayBridge,
  type CursorOverlaySize,
  type CursorOverlayState,
} from "../ipc/cursor-contract";

const bridge: CursorOverlayBridge = {
  onState: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, state: CursorOverlayState): void =>
      listener(state);
    ipcRenderer.on(CURSOR_STATE_CHANNEL, handler);
    return () => ipcRenderer.removeListener(CURSOR_STATE_CHANNEL, handler);
  },
  settled: (seq: number) => ipcRenderer.send(CURSOR_SETTLED_CHANNEL, seq),
  resized: (size: CursorOverlaySize) => ipcRenderer.send(CURSOR_SIZE_CHANNEL, size),
  takeOver: () => ipcRenderer.send(CURSOR_TAKE_OVER_CHANNEL),
  askToLeave: () => ipcRenderer.send(CURSOR_ASK_TO_LEAVE_CHANNEL),
};

contextBridge.exposeInMainWorld("volliCursor", bridge);

import type { BrowserWindow } from "electron";

export const broadcast = (window: BrowserWindow): void => window.webContents.send("fixture");

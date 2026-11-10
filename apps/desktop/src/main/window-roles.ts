/** Explicit ownership of app windows; Browser Tabs and DevTools are never app callers. */
import type { BrowserWindow, WebContents } from "electron";

type AppWindowRole = "main" | "settings";
const ownedWindows = new Map<number, { window: BrowserWindow; role: AppWindowRole }>();

/** Register at creation, before loading a renderer. Closing revokes its IPC identity. */
export function registerAppWindow(window: BrowserWindow, role: AppWindowRole): void {
  const contentsId = window.webContents.id;
  const entry = { window, role };
  ownedWindows.set(contentsId, entry);
  window.once("closed", () => {
    if (ownedWindows.get(contentsId) === entry) ownedWindows.delete(contentsId);
  });
}

export function getAppContentsRole(sender: Pick<WebContents, "id">): AppWindowRole | null {
  return ownedWindows.get(sender.id)?.role ?? null;
}

export function isSettingsContents(sender: Pick<WebContents, "id">): boolean {
  return getAppContentsRole(sender) === "settings";
}

/** The workbench windows, excluding Settings and all unowned BrowserWindows. */
export function mainWindows(): BrowserWindow[] {
  return [...ownedWindows.values()]
    .filter(({ role }) => role === "main")
    .map(({ window }) => window);
}

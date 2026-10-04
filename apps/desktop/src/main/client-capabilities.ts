/**
 * The desktop client's capabilities, for host code (VC-554).
 *
 * host-core asks for what only a person's machine can do through
 * `ClientCapabilityPort`; this is the Electron answer, and each method is the
 * call desktop already makes: `shell.openExternal`, `shell.showItemInFolder`,
 * `clipboard` and a native `Menu`. Policy stays with the caller — the http(s)
 * filter on window-opened links, for one, is the window handler's, not this
 * port's.
 */
import { BrowserWindow, clipboard, Menu, shell, type MenuItemConstructorOptions } from "electron";
import type { ClientCapabilityPort, ClientMenuItem } from "@volli/host-core/ports";

function menuTemplate(
  items: readonly ClientMenuItem[],
  choose: (id: string) => void,
): MenuItemConstructorOptions[] {
  return items.map((item) =>
    item.kind === "separator"
      ? { type: "separator" }
      : {
          label: item.label,
          enabled: item.enabled ?? true,
          click: () => choose(item.id),
        },
  );
}

export function createElectronClientCapabilities(): ClientCapabilityPort {
  return {
    openExternal: (url) => shell.openExternal(url),
    revealInFolder: (path) => shell.showItemInFolder(path),
    writeClipboardText: (text) => clipboard.writeText(text),
    readClipboardText: () => clipboard.readText(),
    showMenu: (items) =>
      new Promise((resolve) => {
        const menu = Menu.buildFromTemplate(menuTemplate(items, (id) => resolve(id)));
        const window = BrowserWindow.getFocusedWindow();
        menu.popup({
          ...(window === null ? {} : { window }),
          // The close callback can arrive before the chosen item's click
          // (macOS performs the action after the menu closes), so a
          // dismissal is only settled a turn later; a chosen id wins.
          callback: () => setTimeout(() => resolve(null), 0),
        });
      }),
  };
}

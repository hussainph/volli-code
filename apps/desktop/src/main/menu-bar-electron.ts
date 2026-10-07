/**
 * The Electron half of menu-bar mode (VC-577): a Tray, the Dock, the power
 * blocker and the Tray's one confirm. Thin on purpose — every decision is in
 * `menu-bar-host.ts`, which this only renders and actuates.
 */
import {
  dialog,
  Menu,
  nativeImage,
  powerSaveBlocker,
  Tray,
  type MenuItemConstructorOptions,
} from "electron";
import { diagSpan } from "./diag-stalls";
import type { HostLiveWork } from "@volli/host-core/sessions";

import {
  closeAgentTabsCopy,
  quitWithLiveWorkCopy,
  type MenuBarTrayPort,
  type TrayItemId,
  type TrayModel,
} from "./menu-bar-host";

/** Builds the Tray's menu from the model; each item calls back by id. */
export function trayMenuTemplate(
  model: TrayModel,
  onItem: (id: TrayItemId) => void,
): MenuItemConstructorOptions[] {
  const template: MenuItemConstructorOptions[] = [];
  for (const item of model.items) {
    if (item.separatorBefore === true) template.push({ type: "separator" });
    template.push({
      label: item.label,
      enabled: item.enabled,
      ...(item.checked === undefined ? {} : { type: "checkbox" as const, checked: item.checked }),
      click: () => onItem(item.id),
    });
  }
  return template;
}

/**
 * A title-only status item: the running count is the glyph. No icon asset
 * ships for it yet, and an empty image keeps the item native (system font,
 * system highlight, light and dark menu bars) without inventing one.
 */
export function electronMenuBarTray(onItem: (id: TrayItemId) => void): MenuBarTrayPort {
  let tray: Tray | null = null;
  const render = (model: TrayModel): void => {
    const live = tray;
    if (live === null || live.isDestroyed()) return;
    diagSpan("tray.setTitle", () => live.setTitle(model.title));
    diagSpan("tray.setToolTip", () => live.setToolTip(model.tooltip));
    const menu = diagSpan("tray.buildMenu", () =>
      Menu.buildFromTemplate(trayMenuTemplate(model, onItem)),
    );
    diagSpan("tray.setContextMenu", () => live.setContextMenu(menu));
  };
  return {
    show(model) {
      if (tray === null || tray.isDestroyed()) {
        tray = diagSpan("tray.new", () => new Tray(nativeImage.createEmpty()));
      }
      render(model);
    },
    update: render,
    destroy() {
      if (tray !== null && !tray.isDestroyed()) tray.destroy();
      tray = null;
    },
  };
}

/** Keeps the Mac out of idle sleep while a menu-bar host is running turns. */
export function electronMenuBarPower(): { hold(): void; release(): void } {
  let id: number | null = null;
  return {
    hold() {
      if (id !== null) return;
      id = powerSaveBlocker.start("prevent-app-suspension");
    },
    release() {
      if (id === null) return;
      if (powerSaveBlocker.isStarted(id)) powerSaveBlocker.stop(id);
      id = null;
    },
  };
}

/**
 * Tray → "Quit Volli" with live work. Native and unparented: there is no
 * window to sheet it from. "Wait and Quit" is the default and the cancel, so
 * Esc never stops a turn.
 */
export function confirmMenuBarQuit(work: HostLiveWork): "quit" | "wait" {
  const copy = quitWithLiveWorkCopy(work);
  const choice = dialog.showMessageBoxSync({
    type: "warning",
    buttons: ["Quit Anyway", "Wait and Quit"],
    defaultId: 1,
    cancelId: 1,
    message: copy.message,
    detail: copy.detail,
  });
  return choice === 0 ? "quit" : "wait";
}

/**
 * Menu-bar entry over Browser Tabs a running agent is using (VC-577): they
 * close with the windows. Busy-terminal style; Cancel is the default and the
 * Esc answer, so nothing closes without a deliberate choice.
 */
export function confirmCloseAgentTabs(count: number): "close" | "cancel" {
  const copy = closeAgentTabsCopy(count);
  const choice = dialog.showMessageBoxSync({
    type: "warning",
    buttons: ["Close Tabs and Keep Running", "Cancel"],
    defaultId: 1,
    cancelId: 1,
    message: copy.message,
    detail: copy.detail,
  });
  return choice === 0 ? "close" : "cancel";
}

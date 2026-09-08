import { app, BrowserWindow, dialog, Menu, type MenuItemConstructorOptions } from "electron";
import { writeFile } from "node:fs/promises";
import { errorMessage } from "@volli/shared";
import {
  DATA_EXPORT_ACTION_LABEL,
  DATA_EXPORT_CONTENTS,
  DATA_EXPORT_LIMITS,
  DATA_EXPORT_MENU_LABEL,
} from "../data-export-copy";
import type { UiZoomCommand, VolliIpcEvent } from "../ipc/contract";
import type { DbHandle } from "./data-ipc";
import { buildExportDocument, defaultExportFilename, serializeExportDocument } from "./db/export";

/**
 * Installs the application menu. Everything is the standard macOS template
 * EXCEPT the three zoom items in the View menu.
 *
 * Why we replace the built-in `zoomIn`/`zoomOut`/`resetZoom` roles: those roles
 * scale the ENTIRE renderer page, including the renderer-painted 36px chrome
 * band (ChromeBar). But the native macOS traffic lights sit at a fixed
 * `trafficLightPosition` and do NOT scale — so page zoom grows/shrinks the
 * chrome band away from the lights and the SidebarTrigger drifts out of
 * alignment with them. Instead these items just fire a `volli:ui-zoom-command`
 * event; the renderer applies CSS `zoom` to the content row BELOW the chrome
 * band, leaving the band (and thus its alignment with the native lights) at
 * native scale.
 */
function sendZoom(cmd: UiZoomCommand): void {
  BrowserWindow.getFocusedWindow()?.webContents.send(
    "volli:ui-zoom-command" satisfies VolliIpcEvent,
    cmd,
  );
}

/**
 * File > Export data as JSON… and Settings → Storage: prompts for a save
 * location, then writes a full `buildExportDocument` dump there. A degraded db
 * (open/migrate failed at boot — the same `DbHandle` the data/artifact IPC
 * handlers degrade against) surfaces immediately rather than opening a dialog
 * for a write that can never happen. Every failure — a degraded db or a write
 * error — goes through `dialog.showErrorBox`, never swallowed (CLAUDE.md).
 *
 * The save dialog carries the limits (VC-283). This is the last surface before
 * a file exists, and macOS renders `message` above the filename field, so the
 * sentence that says this document cannot be restored sits in front of the
 * person at the moment they choose where to keep it — not only in the Settings
 * confirm they may never have opened.
 */
export async function exportDatabase(dbHandle: DbHandle): Promise<void> {
  if (!dbHandle.ok) {
    // Already a complete sentence naming the failure (db-open-failure.ts's
    // CONTRACT); the box's own title supplies the "export" half.
    dialog.showErrorBox("Export Failed", dbHandle.error);
    return;
  }
  const now = new Date();
  const win = BrowserWindow.getFocusedWindow();
  const saveDialogOptions: Electron.SaveDialogOptions = {
    title: DATA_EXPORT_ACTION_LABEL,
    message: `${DATA_EXPORT_LIMITS} ${DATA_EXPORT_CONTENTS}`,
    defaultPath: defaultExportFilename(now),
    filters: [{ name: "JSON", extensions: ["json"] }],
  };
  const result = win
    ? await dialog.showSaveDialog(win, saveDialogOptions)
    : await dialog.showSaveDialog(saveDialogOptions);
  if (result.canceled || !result.filePath) return;

  try {
    const document = buildExportDocument(dbHandle.db, {
      appVersion: app.getVersion(),
      now: now.getTime(),
    });
    await writeFile(result.filePath, serializeExportDocument(document), "utf8");
  } catch (error) {
    dialog.showErrorBox("Export Failed", errorMessage(error));
  }
}

export function registerAppMenu(
  dbHandle: DbHandle,
  options: {
    installAgentTools?: () => Promise<void>;
    uninstallAgentTools?: () => Promise<void>;
  } = {},
): void {
  const agentToolsItems: MenuItemConstructorOptions[] = [];
  if (options.installAgentTools) {
    agentToolsItems.push({
      label: "Install Volli CLI & Agent Skills…",
      click: () => {
        void options.installAgentTools?.().catch(() => {
          // The installer itself surfaces an error box.
        });
      },
    });
  }
  if (options.uninstallAgentTools) {
    agentToolsItems.push({
      label: "Remove Volli CLI & Agent Skills…",
      click: () => {
        void options.uninstallAgentTools?.().catch(() => {
          // The uninstaller itself surfaces an error box.
        });
      },
    });
  }
  if (agentToolsItems.length > 0) {
    agentToolsItems.push({ type: "separator" });
  }

  const template: MenuItemConstructorOptions[] = [
    { role: "appMenu" },
    {
      label: "File",
      submenu: [
        ...agentToolsItems,
        {
          label: DATA_EXPORT_MENU_LABEL,
          click: () => {
            void exportDatabase(dbHandle);
          },
        },
        { type: "separator" },
        { role: "close" },
      ],
    },
    { role: "editMenu" },
    {
      label: "View",
      submenu: [
        { role: "reload" },
        { role: "forceReload" },
        { role: "toggleDevTools" },
        { type: "separator" },
        {
          label: "Actual Size",
          accelerator: "CmdOrCtrl+0",
          click: () => sendZoom("reset"),
        },
        {
          label: "Zoom In",
          accelerator: "CmdOrCtrl+Plus",
          click: () => sendZoom("in"),
        },
        // ⌘= alias so users can zoom in without holding Shift (⌘= is the
        // unshifted key that produces ⌘+ / "Plus"). Hidden from the menu but
        // its accelerator still fires (`acceleratorWorksWhenHidden`), so the
        // visible "Zoom In" item keeps the canonical ⌘⇧= label.
        {
          label: "Zoom In",
          accelerator: "CmdOrCtrl+=",
          visible: false,
          acceleratorWorksWhenHidden: true,
          click: () => sendZoom("in"),
        },
        {
          label: "Zoom Out",
          accelerator: "CmdOrCtrl+-",
          click: () => sendZoom("out"),
        },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    { role: "windowMenu" },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

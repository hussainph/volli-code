import { BrowserWindow, Menu, type MenuItemConstructorOptions } from "electron";
import type { UiZoomCommand, VolliIpcEvent } from "@volli/shared";

/**
 * Installs the application menu. Everything is the standard macOS template
 * EXCEPT the three zoom items in the View menu.
 *
 * Why we replace the built-in `zoomIn`/`zoomOut`/`resetZoom` roles: those roles
 * scale the ENTIRE renderer page, including the renderer-painted 40px chrome
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

export function registerAppMenu(): void {
  const template: MenuItemConstructorOptions[] = [
    { role: "appMenu" },
    { role: "fileMenu" },
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

/**
 * The window a launch shows while the database an older build wrote is
 * upgraded (VC-1105). The upgrade runs in a worker; this window is what the
 * person sees instead of nothing, and main stays free to draw it, move it and
 * quit.
 *
 * It opens before the database can be read, so nothing stored decides its
 * look: the mode is the system's and the edge is the default canvas, exactly
 * what a first-ever launch paints (`resolveFirstPaint` with nothing stored).
 * It has no preload and no bridge; its page reads the mode from the query.
 */
import { BrowserWindow, nativeTheme } from "electron";
import { revealWindow, type quietWindowPolicy } from "@volli/host-core/maintenance";

import { PACKAGED_RENDERER_UPDATING_URL } from "./app-protocol";
import { resolveFirstPaint } from "./window-theme";

export interface UpdatingWindowOptions {
  /** `ELECTRON_RENDERER_URL` in a dev run; absent, the packaged page. */
  readonly devRendererUrl: string | undefined;
  readonly policy: ReturnType<typeof quietWindowPolicy>;
}

/** The page URL for a mode: the dev server's in a dev run, the bundle's otherwise. */
export function updatingPageUrl(
  appearance: "light" | "dark",
  devRendererUrl: string | undefined,
): string {
  const url = new URL(
    devRendererUrl === undefined
      ? PACKAGED_RENDERER_UPDATING_URL
      : new URL("/updating.html", devRendererUrl).toString(),
  );
  url.searchParams.set("appearance", appearance);
  return url.toString();
}

/** Opens the window; it shows itself once painted. `close` is safe to call more than once. */
export function openUpdatingWindow(options: UpdatingWindowOptions): { close(): void } {
  const paint = resolveFirstPaint({
    hint: null,
    canvas: null,
    appearance: null,
    systemPrefersDark: nativeTheme.shouldUseDarkColors,
  });
  const window = new BrowserWindow({
    width: 420,
    height: 240,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    title: "Volli Code",
    // No title bar and no window buttons: nothing here is for the person to
    // act on, and the app's own window replaces this one when the upgrade is
    // done. Quitting still works; an upgrade cut short is a crash the open
    // already recovers from.
    titleBarStyle: "hidden",
    backgroundColor: paint.background,
    show: false,
    focusable: options.policy.focusable,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: options.policy.backgroundThrottling,
    },
  });
  if (process.platform === "darwin") window.setWindowButtonVisibility(false);
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  window.once("ready-to-show", () => {
    if (!window.isDestroyed()) revealWindow(window, options.policy);
  });
  void window.loadURL(updatingPageUrl(paint.appearance, options.devRendererUrl));
  return {
    close: () => {
      if (!window.isDestroyed()) window.destroy();
    },
  };
}

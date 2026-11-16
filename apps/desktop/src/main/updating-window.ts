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
import type { FirstPaintHint } from "../ipc/contract";
import { resolveFirstPaint } from "./window-theme";

export interface UpdatingWindowOptions {
  /** `ELECTRON_RENDERER_URL` in a dev run; absent, the packaged page. */
  readonly devRendererUrl: string | undefined;
  readonly policy: ReturnType<typeof quietWindowPolicy>;
  /** A quit is waiting for the upgrade (VC-1208): the page says so. */
  readonly quitPending?: boolean;
}

/** The upgrade window, as the launch and the quit hold it. */
export interface UpdatingWindow {
  /** Safe to call more than once. */
  close(): void;
  /** Brings it forward, as a second launch or a Dock click asks. */
  reveal(): void;
  /** Says the quit waits for the upgrade, and brings it forward. */
  quitting(): void;
}

/**
 * The page URL for a first paint: the dev server's in a dev run, the bundle's
 * otherwise. The page paints the window's own background itself: a
 * transparent page shows Chromium's default canvas for its mode, not the
 * window's. `check` is a routine launch's database check in the app's own
 * window (VC-1203); the upgrade window names no work.
 */
export function updatingPageUrl(
  paint: FirstPaintHint,
  devRendererUrl: string | undefined,
  work: "upgrade" | "check" = "upgrade",
  then?: "quit",
): string {
  const url = new URL(
    devRendererUrl === undefined
      ? PACKAGED_RENDERER_UPDATING_URL
      : new URL("/updating.html", devRendererUrl).toString(),
  );
  url.searchParams.set("appearance", paint.appearance);
  url.searchParams.set("background", paint.background);
  if (work === "check") url.searchParams.set("work", "check");
  if (then === "quit") url.searchParams.set("then", "quit");
  return url.toString();
}

/**
 * Which page a launch's first window shows, as the log names it (VC-1208):
 * the upgrade's, the routine check's, or the app's own.
 */
export function launchWindowPage(url: string): "upgrade" | "check" | "app" {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "app";
  }
  if (parsed.pathname !== "/updating.html") return "app";
  return parsed.searchParams.get("work") === "check" ? "check" : "upgrade";
}

/** Opens the window; it shows itself once painted. `close` is safe to call more than once. */
export function openUpdatingWindow(options: UpdatingWindowOptions): UpdatingWindow {
  const paint = resolveFirstPaint({
    hint: null,
    canvas: null,
    appearance: null,
    systemPrefersDark: nativeTheme.shouldUseDarkColors,
  });
  const open = (quitPending: boolean): BrowserWindow => {
    const created = new BrowserWindow({
      width: 420,
      height: 240,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      title: "Volli Code",
      // No title bar and no window buttons: nothing here is for the person to
      // act on, and the app's own window replaces this one when the upgrade is
      // done. A quit waits for the upgrade with this window up (VC-1208).
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
    if (process.platform === "darwin") created.setWindowButtonVisibility(false);
    created.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    created.webContents.on("will-navigate", (event) => event.preventDefault());
    created.once("ready-to-show", () => {
      if (!created.isDestroyed()) revealWindow(created, options.policy);
    });
    void created.loadURL(
      updatingPageUrl(paint, options.devRendererUrl, "upgrade", quitPending ? "quit" : undefined),
    );
    return created;
  };
  let window = open(options.quitPending === true);
  let closed = false;
  const reveal = (): void => {
    if (!window.isDestroyed()) revealWindow(window, options.policy);
  };
  return {
    close: () => {
      closed = true;
      if (!window.isDestroyed()) window.destroy();
    },
    reveal,
    quitting: () => {
      if (closed) return;
      // Closed by the person (a menu's Close Window): a quit still gets its window.
      if (window.isDestroyed()) {
        window = open(true);
        return;
      }
      void window.loadURL(updatingPageUrl(paint, options.devRendererUrl, "upgrade", "quit"));
      reveal();
    },
  };
}

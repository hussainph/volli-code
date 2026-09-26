/**
 * What an app-renderer reset means for the Browser planes already on the window
 * (VC-424).
 *
 * A Browser Tab's native view is a sibling of the app page rather than a child
 * of it, so a replaced or crashed app renderer leaves every attached view
 * composited over a page that has never heard of those tabs. The renderer's own
 * hide is React cleanup, which a page reset never runs. Main is the only party
 * that still knows, so main is where the planes come off.
 *
 * The whole rule lives here rather than as closures inside `index.ts`'s
 * bootstrap, so what actually matters is reachable by a test: WHICH events park
 * planes, that each window's events park only that window's planes, that a
 * window on its way out is left alone, and that a failure to park cannot become
 * a crash inside an Electron event handler.
 */
import type { BrowserWindow } from "electron";

/** What this rule asks of the Browser host: the planes on one window. */
export interface BrowserPlaneResetHost {
  parkPlanesOn(window: BrowserWindow): string[];
}

/**
 * The two `webContents` events that say this window's app page is gone, as
 * Electron 44 declares them. A zero-argument listener is deliberate: neither
 * event's payload is part of this decision.
 */
export interface RendererResetEvents {
  on(event: "did-navigate", listener: () => void): void;
  on(event: "render-process-gone", listener: () => void): void;
}

/**
 * Parks this window's Browser planes whenever its app page is replaced or dies.
 *
 * `did-navigate` rather than `did-start-navigation`, and that is the difference
 * between a fix and a new bug. A started navigation is not a page that went
 * away: a main-frame navigation can be superseded, cancelled or refused before
 * it commits, and the running React tree survives it — planes swept off then
 * would leave a live pane blank, since the renderer's controller believes the
 * plane is already visible and would not show it again until its pane remounted.
 * `did-navigate` is the committed main-frame navigation, which Electron does not
 * emit for in-page navigations, so a hash change or a history push keeps the
 * panes that own their planes. It also arrives at commit, before the new
 * document's scripts run, so the sweep cannot undo a fresh page's own show.
 *
 * `render-process-gone` is the other half: a crashed renderer commits nothing,
 * so nothing else would ever say the page is gone.
 *
 * A window that is already destroyed is skipped. There is no fresh UI on it to
 * protect, and parking asks the host for its off-screen stage — which it may
 * rebuild, and a new `BaseWindow` is not something to create while the app is
 * tearing down. (An accepted quit still ends in `app.exit(0)`, so this guards
 * the state rather than the exit.)
 *
 * Failures are logged, not raised: nothing is waiting on this cleanup, the one
 * surface that could show a toast is the page that just went away, and the
 * planes have already left the window by the time the host can fail (VC-278).
 * Raising instead would put the throw inside an Electron event handler.
 */
export function parkBrowserPlanesOnRendererReset(input: {
  host: BrowserPlaneResetHost;
  window: BrowserWindow;
  /** The window's own `webContents` — the app page, never a Browser Tab's. */
  contents: RendererResetEvents;
  log: (message: string) => void;
}): void {
  const park = (why: string): void => {
    if (input.window.isDestroyed()) return;
    try {
      input.host.parkPlanesOn(input.window);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      input.log(
        `[volli] could not park every Browser plane after the app renderer ${why}: ${detail}`,
      );
    }
  };
  input.contents.on("did-navigate", () => park("navigated"));
  input.contents.on("render-process-gone", () => park("crashed"));
}

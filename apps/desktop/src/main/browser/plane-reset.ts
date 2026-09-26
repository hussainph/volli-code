/**
 * What an app-renderer reset means for the Browser planes already on the window
 * (VC-424).
 *
 * A Browser Tab's native view is a sibling of the app page rather than a child
 * of it, so a main-frame reload or a crashed app renderer leaves every attached
 * view composited over a page that has never heard of those tabs. The renderer's
 * own hide is React cleanup, which a page reset never runs. Main is the only
 * party that still knows, so main is where the planes come off.
 *
 * Functions over a narrow seam rather than closures inside `index.ts`'s
 * bootstrap, so the two rules that matter are reachable by a test: WHICH
 * navigations count as the page going away, and that a failure to park one
 * plane cannot become a crash in an Electron event handler.
 */
import type { BrowserWindow } from "electron";

/** What this rule asks of the Browser host: the planes on one window. */
export interface BrowserPlaneResetHost {
  parkPlanesOn(window: BrowserWindow): string[];
}

/** One navigation, as `did-start-navigation` describes it. */
export interface RendererNavigation {
  isMainFrame: boolean;
  isSameDocument: boolean;
}

/**
 * Whether a navigation replaces the app page, which is the only kind that
 * strands a plane.
 *
 * A subframe navigation and a same-document one (a hash change, a history push)
 * keep the React tree that owns the panes, so their planes are still spoken for
 * — sweeping them off would take a live pane off screen that nothing will show
 * again until the person switches workspaces.
 */
export function replacesAppRenderer(navigation: RendererNavigation): boolean {
  return navigation.isMainFrame && !navigation.isSameDocument;
}

/**
 * Parks every plane on one window as its page resets, and reports rather than
 * raises when the host cannot.
 *
 * Log-only is deliberate, and it is the exception AGENTS.md documents rather
 * than a swallowed mutation: nobody asked for this cleanup, and the one surface
 * that could show a toast is the page that has just been replaced or died. The
 * failure that is possible here — a tab that came off the window but could not
 * be parked on the stage (VC-278) — has also already achieved the thing this
 * call exists for, since the view leaves the window first.
 *
 * Returns the tabs taken off the window, for a caller that wants to say so.
 */
export function parkBrowserPlanes(input: {
  host: BrowserPlaneResetHost;
  window: BrowserWindow;
  /** How the page went away, for the log line: "reloaded", "crashed". */
  why: string;
  log: (message: string) => void;
}): string[] {
  try {
    return input.host.parkPlanesOn(input.window);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    input.log(
      `[volli] could not park every Browser plane after the app renderer ${input.why}: ${detail}`,
    );
    return [];
  }
}

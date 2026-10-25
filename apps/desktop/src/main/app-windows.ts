/**
 * The app's windows as menu-bar mode and the doors that bring one back see
 * them (VC-577): which count as open, the draft flush before a window is
 * destroyed without an unload, and the reveal each return path takes.
 *
 * Menu-bar entry hides the windows it is about to destroy and stops counting
 * them as open, so a reopen during the (bounded) flush reuses a hidden window
 * instead of finding a doomed one; each is destroyed only from its own
 * renderer's flush ack. The returns — activation, a second launch, a
 * notification click — go through the menu-bar host once it exists, which
 * also leaves the mode; outside it each is exactly "open a window if none
 * exists".
 *
 * No Electron import: the windows, the factory and the reveal are ports.
 */
import { hostLogger } from "@volli/host-core/log";

import type { VolliIpcEvent } from "../ipc/contract";
import {
  MENU_BAR_FLUSH_OVERDUE_MS,
  type ClientStateFlush,
  type FlushOutcome,
} from "./client-state-flush";
import type { MenuBarHost, MenuBarHostPorts } from "./menu-bar-host";

const log = hostLogger("menu-bar");

/** A `BrowserWindow`, as far as this module touches one. */
export interface AppWindow {
  readonly id: number;
  isDestroyed(): boolean;
  hide(): void;
  destroy(): void;
  readonly webContents: {
    isDestroyed(): boolean;
    send(channel: string, ...args: unknown[]): void;
  };
}

export interface AppWindowsPorts<W extends AppWindow> {
  /** Every window, a hidden one included (`BrowserWindow.getAllWindows`). */
  all(): readonly W[];
  /** The app window factory. */
  create(): void;
  /** Shows a window under the native-window policy (`revealWindow`). */
  reveal(window: W): void;
  /** The flush-and-ack barrier `volli:client-state-flushed` acknowledges. */
  flush: ClientStateFlush;
}

export interface AppWindows {
  /**
   * Every window's pending drafts, a hidden menu-bar one included: a system
   * shutdown's flush, resolved once all acked or `timeoutMs` ran out.
   */
  flushAll(timeoutMs: number): Promise<FlushOutcome>;
  /** The menu-bar host's `windows` port. */
  readonly menuBarPort: MenuBarHostPorts["windows"];
  /**
   * The app was activated (Dock, Spotlight, ⌘Tab): a noted logout did not
   * happen, and with no open window one comes back through the menu-bar host.
   */
  activated(menuBar: Pick<MenuBarHost, "noteActivated" | "reveal">): void;
  /**
   * A notification clicked with every window closed asks for one: through the
   * menu-bar host once it exists, so a click on a windowless host also brings
   * the Dock icon back; before that, a window if none exists.
   */
  openForNotification(menuBar: Pick<MenuBarHost, "reveal"> | null): void;
}

export function createAppWindows<W extends AppWindow>(ports: AppWindowsPorts<W>): AppWindows {
  // Windows menu-bar entry hid and will destroy once their drafts are flushed.
  const retiring = new WeakSet<W>();
  const live = (): W[] =>
    ports.all().filter((window) => !window.isDestroyed() && !retiring.has(window));
  const flushState = (
    windows: readonly W[],
    timeoutMs: number,
    onAcked?: (window: W) => void,
  ): Promise<FlushOutcome> =>
    ports.flush.flush(
      windows.map((window) => ({
        isDestroyed: () => window.isDestroyed() || window.webContents.isDestroyed(),
        requestFlush: (requestId: string) =>
          window.webContents.send("volli:client-state-flush" satisfies VolliIpcEvent, requestId),
        ...(onAcked === undefined ? {} : { onAcked: () => onAcked(window) }),
      })),
      timeoutMs,
    );

  return {
    flushAll: (timeoutMs) => flushState(ports.all(), timeoutMs),
    menuBarPort: {
      count: () => live().length,
      // `destroy`, not `close`: the quit's own unsaved-drafts and terminal
      // confirms already answered, and a window `close` would ask again.
      // `destroy` skips `beforeunload`, so each renderer is asked to flush
      // its pending drafts first, and each window is destroyed only from its
      // own ack. Hidden at once, so the person sees the quit take effect.
      // Menu-bar entry is not power-off: a window that has not acked is never
      // destroyed — past the overdue mark it is logged and stays hidden until
      // a reveal reuses it or a real quit tears it down.
      closeAll: () => {
        const closing = live();
        for (const window of closing) {
          retiring.add(window);
          window.hide();
        }
        void flushState(closing, MENU_BAR_FLUSH_OVERDUE_MS, (window) => {
          log.info("window draft flush acknowledged", { windowId: window.id });
          // Native destruction must not run inside the acknowledgement IPC
          // checkpoint (the same compositor-teardown hazard as VC-536 exit).
          // Keep this Immediate referenced; a reveal before it runs owns the
          // retained renderer again, so both guards belong inside the callback.
          setImmediate(() => {
            if (!retiring.has(window) || window.isDestroyed()) return;
            retiring.delete(window);
            log.info("destroying acknowledged window", { windowId: window.id });
            window.destroy();
            log.info("acknowledged window destroyed", { windowId: window.id });
          });
        }).then(({ unanswered }) => {
          if (unanswered > 0) {
            log.warn("windows still saving drafts; kept hidden, not destroyed", { unanswered });
          }
        });
      },
      // A hidden window still waiting on its flush is reused rather than
      // duplicated: its renderer, and its unsaved drafts, are still there.
      open: () => {
        const retained = ports
          .all()
          .find((window) => !window.isDestroyed() && retiring.has(window));
        if (retained === undefined) {
          ports.create();
          return;
        }
        retiring.delete(retained);
        ports.reveal(retained);
      },
    },
    activated: (menuBar) => {
      // The next ⌘Q keeps its turns again. Inert with the flag off — only the
      // flag-on quit branch reads that latch.
      menuBar.noteActivated();
      // On macOS it's common to re-create a window when the Dock icon is
      // clicked and there are no other windows open. A menu-bar host also
      // leaves menu-bar mode and shows its Dock icon again; otherwise the
      // reveal is exactly this re-creation. A window menu-bar entry hid while
      // its drafts flush does not count as open (flag off: there is none).
      if (live().length === 0) menuBar.reveal();
    },
    openForNotification: (menuBar) => {
      if (menuBar !== null) menuBar.reveal();
      else if (ports.all().length === 0) ports.create();
    },
  };
}

/** What a second launch does with the first window, when there is one. */
export interface LaunchWindow {
  isMinimized(): boolean;
  restore(): void;
  focus(): void;
}

/**
 * A second launch of the app (`second-instance`). With a window: restore,
 * show and focus it — never focus under the quiet policy, whose smoke window
 * must not take it. With none: flag off, today's early return; flag on, a
 * menu-bar host (or one whose every window was closed) answers with a window,
 * once one is bound.
 */
export function answerSecondInstance<W extends LaunchWindow>(
  window: W | undefined,
  ports: {
    cloudEnabled(): boolean;
    /** Bound once the window factory exists; until then a second launch has nothing to open. */
    revealForLaunch: (() => void) | null;
    /** `revealWindow`, then `sealQuietAppActivation`, under the native-window policy. */
    show(window: W): void;
    /** The quiet native-window policy is on. */
    quiet: boolean;
  },
): void {
  if (window === undefined) {
    if (ports.cloudEnabled()) ports.revealForLaunch?.();
    return;
  }
  if (window.isMinimized()) window.restore();
  ports.show(window);
  // show() normally gives focus on its own; keep the explicit focus on this
  // path without letting a quiet smoke take it.
  if (!ports.quiet) window.focus();
}

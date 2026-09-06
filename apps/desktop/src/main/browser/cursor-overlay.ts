/**
 * The Session cursor overlay (VC-239): one small, transparent, app-owned
 * `WebContentsView` main places over the ON-SCREEN Browser Tab, drawing the
 * cursor of whichever Session holds it.
 *
 * Why a view at all. The page is a native `WebContentsView` composited above
 * the app's own UI (VC-251), so nothing React draws can appear over it; and
 * the cursor must never enter the page, which could read, hide or fake it and
 * would be changed by it. A sibling view above the page is the one place left.
 * It is kept SMALL — sized to the drawing the overlay page reports — because
 * Electron has no click-through for child views (electron/electron#49039):
 * every pixel of this view is a pixel the person cannot click the page
 * through, so it covers the cursor and its label and nothing else. A
 * full-size transparent child window was rejected for the macOS Sequoia
 * regression that marks the covered window hidden (electron/electron#51718).
 *
 * How it moves. The view's bounds are animated by Electron (`View.setBounds`
 * with `animate`, Electron 44) on the app's own distance-scaled glide, and
 * the click is dispatched only when the glide has landed — the port's
 * controller awaits {@link TabCursorDriver.moveTo}. A tab that is not on
 * screen gets no view and no delay: its cursor state is kept, so switching
 * to that tab shows the cursor at its last position, but nothing waits on a
 * drawing nobody can see. If the overlay page does not acknowledge a state
 * within the glide's ceiling plus slack, the action goes ahead anyway; a
 * drawing must never hold up the work.
 *
 * It yields with the plane. The host tells it about every attach, detach and
 * layout; a detached plane (a menu, a dialog, the floating sidebar, another
 * workspace) removes the view, and reattachment puts it back at the cursor's
 * last position. It never appears in `browser_screenshot` or in a frozen
 * frame, because both capture the page's own pixels.
 *
 * What it knows about Sessions it learns from the host's hold events and
 * `heldBy`: the colour, the name, and when a hold begins (label pinned for a
 * moment) or ends (fade; a takeover hands off instead). It is told nothing by
 * the model and nothing by the page.
 */

import type { Rectangle } from "electron";
import {
  SESSION_CURSOR_GLIDE_MAX_MS,
  SESSION_CURSOR_LABEL_PIN_MS,
  pointDistance,
  sessionCursorGlideMs,
  type BrowserTabHolder,
  type BrowserTabSessionHolder,
} from "@volli/shared";

import {
  CURSOR_ASK_TO_LEAVE_CHANNEL,
  CURSOR_SETTLED_CHANNEL,
  CURSOR_TIP_INSET,
  CURSOR_SIZE_CHANNEL,
  CURSOR_STATE_CHANNEL,
  CURSOR_TAKE_OVER_CHANNEL,
  type CursorOverlaySize,
  type CursorOverlayState,
  type SessionCursorGesture,
} from "../../ipc/cursor-contract";
import type { TabCursorDriver, TabCursorGesture } from "./cdp-controller";
import type { BrowserHoldEvent } from "./tab-host";

/**
 * The overlay's own in-memory partition: no `persist:`, nothing shared with
 * the app renderer's default session or with any Browser Tab's. The page it
 * loads is the app's, but it sits over untrusted pages, and a partition of
 * its own is the cheapest way to make sure nothing of theirs is reachable
 * from it or through it.
 */
export const CURSOR_OVERLAY_PARTITION = "volli-cursor";

/** The view before the page has reported a size: the arrow and its ring. */
const DEFAULT_SIZE: CursorOverlaySize = { width: 44, height: 44 };

/** How long past the glide's ceiling to wait for a page that does not answer. */
const ACK_SLACK_MS = 100;

/** How long the exit takes to finish before a tab's state is forgotten. */
const EXIT_MS = 220;

/** The view, as the overlay needs it — a structural subset of `WebContentsView`. */
export interface CursorOverlayView {
  webContents: {
    id: number;
    send(channel: string, payload: unknown): void;
    isDestroyed(): boolean;
  };
  setBounds(
    bounds: Rectangle,
    options?: { animate?: { duration: number; easing: "ease-out" } },
  ): void;
}

/**
 * The window's content view, as the overlay needs it. The child it adds is
 * its own view; typed as `never` so a `BrowserWindow` (whose methods take a
 * `View`) and a test double both satisfy it without a cast at the seam.
 */
export interface CursorOverlayWindow {
  isDestroyed(): boolean;
  contentView: {
    addChildView(view: never): void;
    removeChildView(view: never): void;
  };
}

/** What the overlay asks of the host: the plane, the holds, the holder. */
export interface CursorOverlayHost {
  attachedTabId(): string | null;
  pageBoundsOf(tabId: string): Rectangle | null;
  zoomFactorOf(tabId: string): number;
  heldBy(tabId: string): BrowserTabHolder | null;
  onHoldChange(listener: (event: BrowserHoldEvent) => void): () => void;
  onPlaneChange(listener: (attachedTabId: string | null) => void): () => void;
  takeOver(tabId: string): unknown;
  askToLeave(tabId: string): unknown;
}

/** `ipcMain`, narrowed to the one shape the page's answers arrive through. */
export interface CursorOverlayIpc {
  on(
    channel: string,
    listener: (event: { sender: { id: number } }, ...args: unknown[]) => void,
  ): void;
  removeListener(
    channel: string,
    listener: (event: { sender: { id: number } }, ...args: unknown[]) => void,
  ): void;
}

export interface CursorOverlayDependencies {
  host: CursorOverlayHost;
  ipc: CursorOverlayIpc;
  /** Builds and loads the view on first need; production binds a `WebContentsView` on the cursor page. */
  createView: () => CursorOverlayView;
  getWindow: () => CursorOverlayWindow | null;
  /** The system's reduced-motion preference, read per glide. */
  prefersReducedMotion: () => boolean;
  /** Injectable clock for tests; production leaves it to `setTimeout`. */
  wait?: (ms: number) => Promise<void>;
}

interface TabCursorState {
  point: { x: number; y: number } | null;
  gesture: SessionCursorGesture;
  pressKey: number;
  /** Epoch ms until which the label stays pinned; 0 for not pinned. */
  labelPinnedUntil: number;
  /** Exiting: fading (release, turn end) or handing off (takeover). */
  exit: "fade" | "handoff" | null;
  /** The holder last drawn, so an exit keeps the colour of the hold that ended. */
  lastHolder: BrowserTabSessionHolder | undefined;
}

export interface CursorOverlay {
  /** The port's cursor for one tab. */
  driverFor(tabId: string): TabCursorDriver;
  /** Tears the view down and stops listening. */
  dispose(): void;
}

const realWait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export function createCursorOverlay(deps: CursorOverlayDependencies): CursorOverlay {
  const wait = deps.wait ?? realWait;
  const states = new Map<string, TabCursorState>();
  let view: CursorOverlayView | null = null;
  let attachedTo: CursorOverlayWindow | null = null;
  let size: CursorOverlaySize = DEFAULT_SIZE;
  let seq = 0;
  /** Resolvers waiting on the page to acknowledge a pushed state, by seq. */
  const acks = new Map<number, () => void>();
  /** Where the view was last placed, for the distance the glide scales on. */
  let lastPlaced: { x: number; y: number } | null = null;
  /** Timers that re-render after a pin expires or an exit finishes. */
  const timers = new Set<ReturnType<typeof setTimeout>>();

  const stateOf = (tabId: string): TabCursorState => {
    let state = states.get(tabId);
    if (state === undefined) {
      state = {
        point: null,
        gesture: null,
        pressKey: 0,
        labelPinnedUntil: 0,
        exit: null,
        lastHolder: undefined,
      };
      states.set(tabId, state);
    }
    return state;
  };

  const later = (ms: number, run: () => void): void => {
    const timer = setTimeout(() => {
      timers.delete(timer);
      run();
    }, ms);
    timers.add(timer);
  };

  const ensureView = (): CursorOverlayView => {
    if (view === null) view = deps.createView();
    return view;
  };

  const detachView = (): void => {
    if (view === null || attachedTo === null) return;
    if (!attachedTo.isDestroyed()) attachedTo.contentView.removeChildView(view as never);
    attachedTo = null;
  };

  const attachView = (window: CursorOverlayWindow): void => {
    const live = ensureView();
    if (attachedTo === window) return;
    detachView();
    window.contentView.addChildView(live as never);
    attachedTo = window;
  };

  /** The tab whose cursor may be drawn: on screen, held by a Session, with a point — or exiting. */
  const drawable = (): {
    tabId: string;
    state: TabCursorState;
    holder: BrowserTabSessionHolder;
  } | null => {
    const tabId = deps.host.attachedTabId();
    if (tabId === null) return null;
    const state = states.get(tabId);
    if (state === undefined || state.point === null) return null;
    const holder = deps.host.heldBy(tabId);
    if (holder?.kind !== "session") {
      // A hold that just ended still draws its exit, in the colour it had.
      return state.exit === null || state.lastHolder === undefined
        ? null
        : { tabId, state, holder: state.lastHolder };
    }
    state.lastHolder = holder;
    return { tabId, state, holder };
  };

  /** Where the view goes for a point on a tab, in window content coordinates. */
  const placement = (tabId: string, point: { x: number; y: number }): Rectangle | null => {
    const page = deps.host.pageBoundsOf(tabId);
    if (page === null) return null;
    const zoom = deps.host.zoomFactorOf(tabId);
    // The tip stays inside the page: a target is inside the viewport (the
    // controller scrolls it into view), so this only guards rounding.
    const tipX = Math.min(Math.max(page.x + point.x * zoom, page.x), page.x + page.width);
    const tipY = Math.min(Math.max(page.y + point.y * zoom, page.y), page.y + page.height);
    return {
      x: Math.round(tipX - CURSOR_TIP_INSET),
      y: Math.round(tipY - CURSOR_TIP_INSET),
      width: size.width,
      height: size.height,
    };
  };

  /**
   * Pushes the drawable tab's state to the page and places the view, or
   * removes the view when nothing is drawable. Returns the seq pushed and the
   * glide the placement was given, so a driver can wait on both.
   */
  const render = (): { seq: number; glideMs: number } | null => {
    const target = drawable();
    const window = deps.getWindow();
    if (target === null || window === null || window.isDestroyed()) {
      detachView();
      return null;
    }
    const { tabId, state, holder } = target;
    const bounds = placement(tabId, state.point!);
    if (bounds === null) {
      detachView();
      return null;
    }
    const reducedMotion = deps.prefersReducedMotion();
    const live = ensureView();
    const from = attachedTo === null ? null : lastPlaced;
    attachView(window);
    const glideMs =
      from === null ? 0 : sessionCursorGlideMs(pointDistance(from, bounds), reducedMotion);
    live.setBounds(
      bounds,
      glideMs > 0 ? { animate: { duration: glideMs, easing: "ease-out" } } : undefined,
    );
    lastPlaced = { x: bounds.x, y: bounds.y };
    seq += 1;
    const pushed: CursorOverlayState = {
      seq,
      color: holder.color,
      name: holder.name,
      present: state.exit === null,
      gesture: state.gesture,
      pressKey: state.pressKey,
      labelPinned: state.labelPinnedUntil > Date.now(),
      handoff: state.exit === "handoff",
      reducedMotion,
    };
    if (!live.webContents.isDestroyed()) live.webContents.send(CURSOR_STATE_CHANNEL, pushed);
    return { seq, glideMs };
  };

  /** Waits for the page to draw `seq`, bounded so a dead page never holds an action. */
  const acknowledged = (pushedSeq: number, bound: number): Promise<void> =>
    Promise.race([
      new Promise<void>((resolve) => acks.set(pushedSeq, resolve)),
      wait(bound).then(() => {
        acks.delete(pushedSeq);
      }),
    ]);

  // ---- the page's answers, believed only from the overlay's own contents ----

  const fromOverlay = (event: { sender: { id: number } }): boolean =>
    view !== null && event.sender.id === view.webContents.id;
  const onSettled = (event: { sender: { id: number } }, ...args: unknown[]): void => {
    if (!fromOverlay(event) || typeof args[0] !== "number") return;
    const resolve = acks.get(args[0]);
    acks.delete(args[0]);
    resolve?.();
  };
  const onSize = (event: { sender: { id: number } }, ...args: unknown[]): void => {
    if (!fromOverlay(event)) return;
    const reported = args[0] as Partial<CursorOverlaySize> | undefined;
    if (
      typeof reported?.width !== "number" ||
      typeof reported.height !== "number" ||
      !(reported.width > 0 && reported.height > 0)
    ) {
      return;
    }
    size = { width: Math.ceil(reported.width), height: Math.ceil(reported.height) };
    // Resize in place: the tip does not move, only how much of the page the
    // view covers.
    if (view !== null && attachedTo !== null && lastPlaced !== null) {
      view.setBounds({ ...lastPlaced, ...size });
    }
  };
  const onTakeOver = (event: { sender: { id: number } }): void => {
    if (!fromOverlay(event)) return;
    const tabId = deps.host.attachedTabId();
    if (tabId !== null) deps.host.takeOver(tabId);
  };
  const onAskToLeave = (event: { sender: { id: number } }): void => {
    if (!fromOverlay(event)) return;
    const tabId = deps.host.attachedTabId();
    if (tabId !== null) deps.host.askToLeave(tabId);
  };
  deps.ipc.on(CURSOR_SETTLED_CHANNEL, onSettled);
  deps.ipc.on(CURSOR_SIZE_CHANNEL, onSize);
  deps.ipc.on(CURSOR_TAKE_OVER_CHANNEL, onTakeOver);
  deps.ipc.on(CURSOR_ASK_TO_LEAVE_CHANNEL, onAskToLeave);

  // ---- holds and the plane -------------------------------------------------

  const endHold = (tabId: string, exit: "fade" | "handoff"): void => {
    const state = states.get(tabId);
    if (state === undefined || state.point === null) {
      states.delete(tabId);
      return;
    }
    state.exit = exit;
    state.gesture = null;
    render();
    later(EXIT_MS, () => {
      if (states.get(tabId) === state && state.exit !== null) states.delete(tabId);
      render();
    });
  };

  const stopHold = deps.host.onHoldChange((event) => {
    switch (event.kind) {
      case "taken": {
        const state = stateOf(event.tabId);
        state.exit = null;
        state.labelPinnedUntil = Date.now() + SESSION_CURSOR_LABEL_PIN_MS;
        later(SESSION_CURSOR_LABEL_PIN_MS, () => render());
        render();
        return;
      }
      case "released":
        endHold(event.tabId, event.why === "takeover" ? "handoff" : "fade");
        return;
      case "person-took":
      case "person-handed-back":
      case "ask-to-leave":
        return;
    }
  });

  const stopPlane = deps.host.onPlaneChange(() => {
    // The plane moved, left or came back: the cursor is drawn where it last
    // was, with no glide — a workspace switch is not a cursor movement.
    lastPlaced = null;
    render();
  });

  return {
    driverFor: (tabId) => ({
      moveTo: async (point, gesture: TabCursorGesture, signal) => {
        signal?.throwIfAborted();
        const state = stateOf(tabId);
        state.point = point;
        state.gesture = null;
        state.exit = null;
        // A tab that is not on screen pays nothing: its state is kept for
        // the moment it is shown, and nothing is drawn or waited on. Rendering
        // here would redraw whichever tab IS on screen and wait on that.
        const onScreen = deps.host.attachedTabId() === tabId;
        const moved = onScreen ? render() : null;
        if (moved !== null) {
          // Landed: the page has drawn the state, and the view has finished
          // its glide. Bounded either way.
          await acknowledged(moved.seq, SESSION_CURSOR_GLIDE_MAX_MS + ACK_SLACK_MS);
          if (moved.glideMs > 0) await wait(moved.glideMs);
        }
        // The gesture shows as the input goes: the ring with the press, the
        // typing tag while text goes in, the nudge with the wheel.
        state.gesture = gesture;
        if (gesture === "click") state.pressKey += 1;
        if (onScreen) render();
      },
      gesture: (kind) => {
        const state = states.get(tabId);
        if (state === undefined) return;
        state.gesture = kind;
        if (deps.host.attachedTabId() === tabId) render();
      },
    }),
    dispose: () => {
      stopHold();
      stopPlane();
      deps.ipc.removeListener(CURSOR_SETTLED_CHANNEL, onSettled);
      deps.ipc.removeListener(CURSOR_SIZE_CHANNEL, onSize);
      deps.ipc.removeListener(CURSOR_TAKE_OVER_CHANNEL, onTakeOver);
      deps.ipc.removeListener(CURSOR_ASK_TO_LEAVE_CHANNEL, onAskToLeave);
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
      for (const resolve of acks.values()) resolve();
      acks.clear();
      detachView();
      states.clear();
    },
  };
}

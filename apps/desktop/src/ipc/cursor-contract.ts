/**
 * The wire between main and the Session cursor overlay page (VC-239).
 *
 * The overlay is a small app-owned `WebContentsView` main places over a
 * Browser Tab's native plane; it draws one `SessionCursor` and nothing else.
 * It is not the app renderer and it is not a domain surface: like the Browser
 * Tab bounds/show/hide channels (`main/browser/ipc.ts`), these are window
 * placement facts between a host and the one view it owns. Main pushes the
 * cursor's state; the page answers with the three things only it can know —
 * that it drew the state, how big its drawing is, and that the person
 * pressed one of the two controls on the label. Every message from the page
 * is checked against the overlay's own `webContents` before it is believed.
 *
 * Type-only, so the three processes that speak it (main, the cursor preload,
 * the overlay page) share one spelling without any of them importing another.
 */

/** What the Session is doing at the tip, as the cursor draws it. */
export type SessionCursorGesture = "click" | "hover" | "type" | "scroll" | null;

/** Everything the overlay page needs to draw the cursor; main is the only writer. */
export interface CursorOverlayState {
  /** Monotonic per push; the page acknowledges it so main knows the drawing landed. */
  seq: number;
  /** The holding Session's identity colour and name. */
  color: string;
  name: string;
  /** On screen, or fading out. */
  present: boolean;
  gesture: SessionCursorGesture;
  /** Bumped per press so a second click on one spot draws a second ring. */
  pressKey: number;
  /** Show the label regardless of hover — the moment the hold starts. */
  labelPinned: boolean;
  /** Exiting because the person took the tab: hand off rather than vanish. */
  handoff: boolean;
  /** Mirrors the system's reduced-motion setting, which main reads. */
  reducedMotion: boolean;
}

/** How big the page's drawing is right now, so main can size the view to it and no larger. */
export interface CursorOverlaySize {
  width: number;
  height: number;
}

/** Main → page. */
export const CURSOR_STATE_CHANNEL = "volli:cursor-state";
/** Page → main: the state with this `seq` is drawn. */
export const CURSOR_SETTLED_CHANNEL = "volli:cursor-settled";
/** Page → main: the drawing's size changed. */
export const CURSOR_SIZE_CHANNEL = "volli:cursor-size";
/** Page → main: the person pressed Take over on the label. */
export const CURSOR_TAKE_OVER_CHANNEL = "volli:cursor-take-over";
/** Page → main: the person pressed Ask to leave on the label. */
export const CURSOR_ASK_TO_LEAVE_CHANNEL = "volli:cursor-ask-to-leave";

/** What the cursor preload exposes to the overlay page as `window.volliCursor`. */
export interface CursorOverlayBridge {
  onState(listener: (state: CursorOverlayState) => void): () => void;
  settled(seq: number): void;
  resized(size: CursorOverlaySize): void;
  takeOver(): void;
  askToLeave(): void;
}

/**
 * One Browser Tab as every client sees it (VC-110, VC-238).
 *
 * Domain vocabulary, not transport, for the reason {@link BrowserTabHolder}
 * gives: the desktop's renderer reads this record today, and a client a future
 * host serves reads the same one, whichever engine renders the page behind it
 * (VC-561). The desktop's IPC contract re-exports these names.
 */
import type { BrowserTabHolder } from "./browser-tab-hold";

/**
 * Provenance main assigns when it creates a Browser Tab. The two values stay
 * closed because personal and agent-created tabs have different profile and
 * future grant policy; an arbitrary renderer label could not be trusted.
 */
export type BrowserTabCreatedBy = "user" | "session";

/**
 * Where a Browser Tab is drawn (VC-238). Main owns the value; the renderer asks
 * to change it through `volli:browser-set-presentation` and never writes it.
 *
 * - `headless`: the tab exists with a real viewport, wake hold, console and
 *   screenshots, but is in no strip, no tab order, and never attached to the
 *   window. Every Session-created tab is born this way.
 * - `preview`: pinned live above the composer of the chat that owns it.
 * - `tab`: an ordinary item in the Home or Ticket strip. A person's own tabs
 *   are always this and cannot be anything else.
 */
export type BrowserTabPresentation = "headless" | "preview" | "tab";

/**
 * Renderer-safe state for one live Browser Tab. Product identity and bounded
 * browser chrome facts cross IPC; Chromium ids, Session partitions, page
 * content, cookies, and history entries never do.
 */
export interface BrowserTabState {
  /** Product-owned opaque id — never a positional Chromium tab index. */
  tabId: string;
  projectId: string;
  /** Null for a project-level tab, whether opened by a person or Board Session. */
  ticketId: string | null;
  createdBy: BrowserTabCreatedBy;
  /**
   * The Session that opened this tab, or null for a person's tab. Ownership is
   * who may drive it through the Browser port — sibling Sessions on the same
   * Ticket never see each other's — and is separate from the storage partition,
   * which stays per Ticket.
   */
  ownerSessionId: string | null;
  presentation: BrowserTabPresentation;
  url: string;
  title: string;
  loading: boolean;
  /** Main-frame load failure, cleared when the next navigation starts. */
  error: string | null;
  canGoBack: boolean;
  canGoForward: boolean;
  /** Monotonic within this tab; a main-frame navigation advances it. */
  generation: number;
  /** Who holds the tab right now, or `null` for a free tab (VC-239). */
  heldBy: BrowserTabHolder | null;
}

/**
 * The renderer-measured native host plane in BrowserWindow content coordinates.
 * Main, not renderer, applies it to the WebContentsView.
 */
export interface BrowserTabBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * A screencast attachment's metadata (VC-619): what every frame of one
 * attachment is, stated once at attach and again only when it changes. The
 * frames themselves are image bytes and a sequence, nothing else
 * (host-protocol.md, Binary framing: metadata never rides inside image bytes).
 */
export interface BrowserScreencastMetadata {
  /** Image encoding of every frame. JPEG initially. */
  encoding: "image/jpeg";
  /** The page's viewport, in CSS pixels; a viewer's input is in these units. */
  width: number;
  height: number;
  /**
   * Device pixels per CSS pixel the frames are drawn at: 1, or 2 for a
   * high-DPI viewer. A frame is `width × deviceScaleFactor` pixels wide.
   */
  deviceScaleFactor: number;
}

/**
 * A person's input in a client's view of a Browser Tab (VC-619), in the page's
 * CSS pixels. The host applies it to the tab's engine as-is; it is the
 * person's input, so it never needs or takes the agent hold.
 *
 * `modifiers` is a bit field: Alt 1, Ctrl 2, Meta 4, Shift 8.
 */
export type BrowserViewerInput =
  | {
      kind: "mouse";
      type: "pressed" | "released" | "moved";
      x: number;
      y: number;
      button: "none" | "left" | "middle" | "right";
      /**
       * The buttons held down after this event, as the DOM's
       * `MouseEvent.buttons` bitmask: left 1, right 2, middle 4, back 8,
       * forward 16. A move while dragging carries the held button, so the
       * page sees a drag (text selection, sliders) rather than a hover.
       */
      buttons: number;
      clickCount: number;
      modifiers: number;
    }
  | { kind: "wheel"; x: number; y: number; deltaX: number; deltaY: number; modifiers: number }
  | {
      kind: "key";
      type: "down" | "up";
      /** The DOM `key` value, e.g. `a`, `Enter`, `ArrowLeft`. */
      key: string;
      /** The DOM `code` value, e.g. `KeyA`. */
      code: string;
      /** The legacy virtual key code (`KeyboardEvent.keyCode`), which editing keys need. */
      keyCode: number;
      /** The text a key-down produces, when it produces any. */
      text?: string;
      modifiers: number;
    }
  /** Committed text: an IME's commit, or a paste the client read from its own clipboard. */
  | { kind: "text"; text: string }
  /** An IME's in-progress composition. */
  | { kind: "composition"; text: string; selectionStart: number; selectionEnd: number };

/**
 * A JavaScript dialog a shown tab's page is waiting on (VC-619), for a viewer
 * to render and the person to answer. The page is stopped until it is
 * answered; a host that hears no answer in its own time gives the safe one
 * (acknowledge an alert, decline anything else — never "leave the page").
 */
export interface BrowserPendingDialog {
  /** Names this dialog; an answer to an older one is refused. */
  dialogId: string;
  type: "alert" | "confirm" | "prompt" | "beforeunload";
  /** The page's message, bounded by the host. */
  message: string;
  /** A prompt's default text; empty for every other type. */
  defaultPrompt: string;
}

/** The person's answer to a {@link BrowserPendingDialog}. */
export interface BrowserDialogResponse {
  /** OK (or "Leave") rather than Cancel (or "Stay"). */
  accept: boolean;
  /** A prompt's text, when accepted. */
  promptText?: string;
}

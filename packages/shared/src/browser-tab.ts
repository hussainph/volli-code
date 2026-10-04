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

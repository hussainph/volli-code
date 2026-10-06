/**
 * The Browser backend: one engine's Browser Tabs, as the agent tools and the
 * host's clients drive them (VC-561).
 *
 * Agent tools never speak to an engine. They speak CDP through the injected
 * {@link CdpTransport} of a {@link BrowserTabController}, and everything else
 * they need — which tabs exist, whose they are, who holds one, its console,
 * its pictures, keeping it awake — they ask of a backend through this
 * interface (see `browserAgentPort` in `./agent-port`). So the engine is the
 * one thing that changes between hosts:
 *
 * - Desktop answers with `BrowserTabHost` (`apps/desktop/src/main/browser/tab-host.ts`):
 *   `WebContentsView`s, each tab's app-private `webContents.debugger` as its
 *   CDP wire.
 * - A headless host answers with `ChromiumBrowserBackend` (`./chromium-backend`,
 *   VC-619): standalone Chromium, attached over a CDP pipe and never
 *   `--remote-debugging-port` (the VC-110 stance).
 *
 * The policy half every backend shares — ownership (VC-238), holds (VC-239),
 * the per-Project and per-Session caps, console bounds, pictures and traces —
 * is one implementation, `BrowserTabRegistry` (`./tab-registry`), so refs,
 * generations and refusals are the same whichever engine renders the page.
 * Window work — attaching a page to a person's window, DevTools, the cursor
 * overlay — is not here; it stays with the desktop.
 */
import type {
  BrowserTabBounds,
  BrowserTabCreatedBy,
  BrowserTabHolder,
  BrowserTabPresentation,
  BrowserTabState,
  BrowserTrace,
  BrowserViewerInput,
} from "@volli/shared";

import type { AgentBrowserBackend } from "./agent-port";
import type { CdpTransport } from "./cdp-controller";
import type { BrowserScreencastAttachment } from "./screencast";

/**
 * One Session's claim on a tab (VC-239), keyed by attachment as well as
 * Session: a hold belongs to the attachment that took it, so a stale port from
 * an earlier attachment can neither keep nor release the hold a newer one
 * holds. The two ids together are what the port hands the host on every
 * write; the host never learns a Session any other way.
 */
export interface BrowserSessionHolder {
  sessionId: string;
  attachmentId: string;
}

/** What taking a hold came to, from the host's side. */
export type BrowserHoldOutcome =
  | { kind: "held"; tab: BrowserTabState }
  | { kind: "refused"; holder: BrowserTabHolder };

/** Why a Session's hold ended. Every path the ticket names; no timer among them. */
export type BrowserHoldEnd = "release" | "turn-end" | "attachment-end" | "closed" | "takeover";

/**
 * A change of hands, for the parties that watch holds rather than tabs: the
 * cursor overlay (a Session took or lost a tab) and the steer notices a
 * takeover or an ask-to-leave owes the holding Session.
 */
export type BrowserHoldEvent =
  | { kind: "taken"; tabId: string; holder: BrowserSessionHolder }
  | { kind: "released"; tabId: string; holder: BrowserSessionHolder; why: BrowserHoldEnd }
  | {
      kind: "person-took";
      tabId: string;
      tabTitle: string;
      tabHostname: string;
      displaced: BrowserSessionHolder | null;
    }
  | { kind: "person-handed-back"; tabId: string }
  | {
      kind: "ask-to-leave";
      tabId: string;
      tabTitle: string;
      tabHostname: string;
      holder: BrowserSessionHolder;
    };

/**
 * The provenance and product scope required to create a Browser Tab. This is
 * main-process input; renderer IPC omits `createdBy` and is forced to `user` so
 * a remote renderer cannot forge agent provenance.
 *
 * A Session-created tab names its owner (VC-238): the port states its own
 * Session id at attach, so a tab always knows which Session may drive it and
 * whose attachment end closes it. A person's tab has no owner.
 */
export type BrowserTabCreateOptions = {
  url: string;
  projectId: string;
  ticketId: string | null;
} & (
  | { createdBy: "user"; ownerSessionId?: null }
  | { createdBy: "session"; ownerSessionId: string }
);

/**
 * How long a load wait should look for a navigation (VC-110): `current` waits
 * out a load already in progress, `possible-navigation` gives an action a
 * short grace to start one, and `required-navigation` waits for one that must
 * come.
 */
export type BrowserLoadWaitMode = "current" | "possible-navigation" | "required-navigation";

export const BROWSER_URL_MAX_CHARS = 8_192;
/**
 * The person's own tabs per project. Agent tabs are counted apart, under
 * {@link BROWSER_MAX_TABS_PER_SESSION}, so a fleet of parallel Sessions at
 * their cap can never stop a person opening one more (VC-238).
 */
export const BROWSER_MAX_TABS_PER_PROJECT = 32;
/** One Session's live tabs. Small on purpose: the refusal tells the model to close or reuse one. */
export const BROWSER_MAX_TABS_PER_SESSION = 6;
/**
 * The viewport a tab is born with. A Session-created tab may never be shown,
 * but it still needs a real one for layout, screenshots and pointer
 * coordinates; a client that shows the tab replaces it with what it measured.
 */
export const BROWSER_DEFAULT_BOUNDS: BrowserTabBounds = { x: 0, y: 0, width: 1_280, height: 720 };

export class BrowserTabLimitError extends Error {
  constructor() {
    super(`A project can have at most ${BROWSER_MAX_TABS_PER_PROJECT} live Browser Tabs`);
    this.name = "BrowserTabLimitError";
  }
}

/** The per-Session cap, a separate class so the port can name a separate rule. */
export class BrowserSessionTabLimitError extends Error {
  constructor() {
    super(
      `A Session can have at most ${BROWSER_MAX_TABS_PER_SESSION} Browser Tabs open: close one with the person, or reuse an open tab by passing its tabId.`,
    );
    this.name = "BrowserSessionTabLimitError";
  }
}

/**
 * Whether a target may enter a remote Browser Tab under its own steam. Keeping
 * this decision pure lets every PAGE-driven door — redirect, frame, and popup —
 * enforce the same HTTP(S)-only rule before the engine sees the target.
 *
 * The blank start page is deliberately NOT allowed here. Page-driven navigation
 * is the surface an attacker controls, and it has no business reaching a scheme
 * outside HTTP(S) even when that scheme is harmless today.
 */
export function isAllowedBrowserUrl(target: string): boolean {
  if (target.length > BROWSER_URL_MAX_CHARS) return false;
  try {
    const url = new URL(target);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Selects the storage boundary for one remote Browser Tab.
 *
 * Personal tabs share one durable browser-only profile so sign-in survives an
 * app restart without ever touching the app renderer's default session.
 * Session-created tabs share only their narrowest product scope's in-memory
 * partition: a Ticket when there is one, otherwise the Project. No `persist:`
 * prefix means Chromium discards agent credentials with this launch, while the
 * scope key prevents unrelated work from inheriting them.
 */
export function browserSessionPartition(input: {
  createdBy: BrowserTabCreatedBy;
  projectId: string;
  ticketId: string | null;
}): string {
  if (input.createdBy === "user") return "persist:volli-browser:user";
  const project = encodeURIComponent(input.projectId);
  return input.ticketId === null
    ? `volli-browser:project:${project}`
    : `volli-browser:ticket:${project}:${encodeURIComponent(input.ticketId)}`;
}

/**
 * One engine's Browser Tabs. Everything an agent tool or a host client asks of
 * the browser, and nothing about the window a person might draw a tab in.
 *
 * Extends {@link AgentBrowserBackend}, the narrow subset the agent port drives,
 * with the CDP wire, the load wait and the wake hold it binds per tab, and the
 * doors a host's clients use: presentation, viewport, pictures, the person's
 * side of a hold, and teardown.
 */
export interface BrowserBackend extends AgentBrowserBackend {
  // ---- tab lifecycle (VC-110) and ownership (VC-238) ----------------------

  /** Closes and forgets one tab without letting page unload code veto it. */
  close(tabId: string): void;
  /**
   * Where a Session's tab is drawn: headless, previewed by its owning chat, or
   * promoted into a strip. A person's tab refuses; it is always a `tab`.
   */
  setPresentation(tabId: string, presentation: BrowserTabPresentation): BrowserTabState;
  /** Closes every headless agent tab of one Ticket, when the Ticket is archived. */
  closeHeadlessForTicket(ticketId: string): string[];
  /** Closes every tab, when the host or its window goes away. */
  closeAll(): void;

  // ---- the CDP wire --------------------------------------------------------

  /**
   * The CDP wire for one live tab. The agent coordinator asks once per tab and
   * shares it across every Session's controller; `dispose` hands it back.
   * Never a loopback debugging port: an engine-private channel only.
   */
  transportFor(tabId: string): CdpTransport;
  /** Resolves when the tab has settled enough to read; must honour the signal and never reject. */
  waitForLoad(tabId: string, signal: AbortSignal, mode?: BrowserLoadWaitMode): Promise<void>;

  // ---- viewport, pictures, wakefulness, console ---------------------------

  /**
   * The tab's viewport: `width` and `height` are its page's. `x` and `y` place
   * the page on a client's plane, where the backend has one to place it on.
   */
  setBounds(tabId: string, bounds: BrowserTabBounds): void;
  /** A picture id's image as a data URL, or null for one this host never minted. */
  pictureOf(pictureId: string): string | null;
  /**
   * Holds one tab's engine at foreground pace and returns the release (VC-252).
   * Releasing twice releases once; a hold on an unknown tab releases into nothing.
   */
  holdAwake(tabId: string): () => void;

  // ---- the person's side of a hold (VC-239) -------------------------------

  /** The person takes the tab now; whoever held it is displaced and named back. */
  takeOver(tabId: string): { tab: BrowserTabState; displaced: BrowserSessionHolder | null };
  /** The person gives the tab back: free, and a Session may hold it on its next write. */
  handBack(tabId: string): BrowserTabState;
  /** The person asks the holding Session to release when it is safe. */
  askToLeave(tabId: string): BrowserSessionHolder | null;
  /** Whether one attachment holds a tab. */
  isHeldBy(tabId: string, holder: BrowserSessionHolder): boolean;
  /** The holder as clients see it, with the Session's name and colour resolved. */
  heldBy(tabId: string): BrowserTabHolder | null;
  /** Hold changes, for whoever relays or draws them. Returns the unsubscribe. */
  onHoldChange(listener: (event: BrowserHoldEvent) => void): () => void;

  // ---- traces (VC-453) ----------------------------------------------------

  /** A Session's kept Browser Traces, oldest first; empty when nothing was recorded. */
  tracesOf(sessionId: string): BrowserTrace[];

  // ---- optional capabilities a backend advertises (VC-619) ----------------
  //
  // The seam stays open: a capability one engine has and another does not is
  // an optional member, present on the backends that offer it. Desktop draws
  // its pages natively and has neither of these.

  /**
   * A frame source for one shown tab, for a client that draws the page
   * itself (`./screencast`): JPEG frames, latest wins, metadata at attach.
   * `deviceScaleFactor` is what the viewer's display wants (2 on Retina). A
   * headless tab refuses; the attachment ends when the tab closes or goes
   * headless.
   */
  attachScreencast?(
    tabId: string,
    options: { deviceScaleFactor: number },
  ): BrowserScreencastAttachment;
  /** A person's input in a client's view of one shown tab. A headless tab refuses. */
  viewerInput?(tabId: string, input: BrowserViewerInput): Promise<void>;
}

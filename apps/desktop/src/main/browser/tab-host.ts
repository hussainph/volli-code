import type {
  BrowserWindow,
  NativeImage,
  Rectangle,
  Session,
  WebContentsView,
  WebContentsViewConstructorOptions,
  WebPreferences,
} from "electron";
import {
  pickSessionColor,
  shortSessionId,
  type BrowserTabHolder,
  type RuntimeBrowserConsoleMessage,
} from "@volli/shared";

import { isBrowserStartUrl } from "../../browser-start-page";
import type {
  BrowserTabBounds,
  BrowserTabCaptureFrame,
  BrowserTabCreatedBy,
  BrowserTabPresentation,
  BrowserTabState,
} from "../../ipc/contract";
import type { BrowserPictureStore } from "./picture-store";

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
  | { kind: "person-took"; tabId: string; displaced: BrowserSessionHolder | null }
  | { kind: "person-handed-back"; tabId: string }
  | { kind: "ask-to-leave"; tabId: string; holder: BrowserSessionHolder };

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
 * Electron construction surfaces injected into the host. Tests can provide
 * inert views/sessions/windows, while production supplies the bundled Electron
 * objects; no Browser Tab policy depends on ambient Electron singletons.
 */
export interface BrowserTabHostDependencies {
  createId: () => string;
  createView: (options: WebContentsViewConstructorOptions) => WebContentsView;
  fromPartition: (partition: string) => Session;
  getWindow: () => BrowserWindow | null;
  publishState: (event: BrowserTabState) => void;
  publishClosed: (tabId: string) => void;
  /** Where captured pixels wait for the card that shows them (VC-238). */
  pictures: BrowserPictureStore;
  /** The clock the interaction window is measured against; production passes none. */
  now?: () => number;
  /**
   * A Session's display name for the holder record (VC-239). Asynchronous
   * because the title lives in the Session Engine's projection; the hold is
   * published at once under a placeholder and again when the name lands.
   * Absent, or `null` from it, leaves the placeholder — a hold never waits on
   * a name.
   */
  sessionName?: (sessionId: string) => Promise<string | null>;
}

interface BrowserTabEntry {
  state: BrowserTabState;
  view: WebContentsView;
  bounds: Rectangle;
  /**
   * The window this tab's view is attached to, or null while detached. Per
   * entry rather than one host-wide slot (VC-238): a shown agent tab and the
   * person's own browser pane are on screen together, and two panes of a
   * split each hold a tab, so the host attaches a SET of views keyed by tab.
   */
  attachedTo: BrowserWindow | null;
  devToolsView: WebContentsView | null;
  devToolsOpen: boolean;
  devToolsAttached: boolean;
  console: RuntimeBrowserConsoleMessage[];
  consoleTruncated: boolean;
  /** Live agent holds against background throttling; see {@link BrowserTabHost.holdAwake}. */
  wakeLeases: number;
  /**
   * When the person last touched this tab's page — a key, a click, a wheel, or
   * taking focus — or null while nobody ever has. Read by
   * {@link BrowserTabHost.capturePicture}; see the window there for why a
   * stamp rather than "is focused right now".
   */
  lastInteractionAt: number | null;
  /**
   * Whose turn it is to drive this tab (VC-239): the Session's claim with its
   * attachment, the person, or nobody. The renderer-facing projection of it
   * is `state.heldBy`, kept in step by {@link BrowserTabHost.publishHold}.
   *
   * Orthogonal to `state.ownerSessionId` (VC-238), which says whose tab this
   * is rather than whose turn it is: a headless tab can be held, and a hold
   * never moves ownership.
   */
  hold: { kind: "session"; holder: BrowserSessionHolder } | { kind: "person" } | null;
}

/**
 * The privilege floor every remote page is constructed with. Returned apart
 * from the Session so the security-sensitive constants stay pure and there is
 * no preload key a later caller could accidentally point at the app bridge.
 */
export function browserRemoteWebPreferences(): Pick<
  WebPreferences,
  "contextIsolation" | "nodeIntegration" | "sandbox"
> {
  return {
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
  };
}

/**
 * Whether a target may enter a remote Browser Tab under its own steam. Keeping
 * this decision pure lets every PAGE-driven door — redirect, frame, and popup —
 * enforce the same HTTP(S)-only rule before Electron sees the target.
 *
 * The blank start page is deliberately NOT allowed here. Page-driven navigation
 * is the surface an attacker controls, and it has no business reaching a scheme
 * outside HTTP(S) even when that scheme is harmless today.
 */
export const BROWSER_URL_MAX_CHARS = 8_192;
export const BROWSER_TITLE_MAX_CHARS = 512;
export const BROWSER_ERROR_MAX_CHARS = 1_024;
/**
 * The person's own tabs per project. Agent tabs are counted apart, under
 * {@link BROWSER_MAX_TABS_PER_SESSION}, so a fleet of parallel Sessions at
 * their cap can never stop a person opening one more (VC-238).
 */
export const BROWSER_MAX_TABS_PER_PROJECT = 32;
/** One Session's live tabs. Small on purpose: the refusal tells the model to close or reuse one. */
export const BROWSER_MAX_TABS_PER_SESSION = 6;
export const BROWSER_CONSOLE_MAX_MESSAGES = 100;
export const BROWSER_CONSOLE_MAX_CHARS = 30_000;
/**
 * How long after the person last touched a shown tab the host keeps its camera
 * shut (VC-238 §5). Five seconds covers the gap between a keystroke and the
 * agent's next action landing, which is the case that matters: the field they
 * just filled must not become a frame in the transcript.
 */
export const BROWSER_INTERACTION_QUIET_MS = 5_000;
export const BROWSER_DEFAULT_BOUNDS: Rectangle = { x: 0, y: 0, width: 1_280, height: 720 };

/**
 * Stand-in pixels are JPEG, not PNG, and this is a latency decision rather than
 * a size one. An overlay cannot appear until the capture returns, so the
 * encode sits on the critical path — and PNG's cost rises with image entropy,
 * so a dense page pays far more than a plain one and the wait becomes
 * unpredictable. Measured on the smoke fixture: PNG 20-52ms against JPEG
 * 11-17ms, and the gap widens with real content. Quality 80 is invisible on a
 * frame that exists to sit still behind a menu.
 */
const BROWSER_CAPTURE_JPEG_QUALITY = 80;
const BROWSER_DEVTOOLS_RATIO = 0.42;
const BROWSER_DEVTOOLS_DIVIDER_PX = 1;

/** Splits the renderer-measured plane without letting DevTools escape into a window. */
export function browserSurfaceBounds(
  bounds: Rectangle,
  devToolsOpen: boolean,
): { page: Rectangle; devTools: Rectangle | null } {
  if (!devToolsOpen || bounds.height < 2) return { page: { ...bounds }, devTools: null };
  const available = bounds.height - BROWSER_DEVTOOLS_DIVIDER_PX;
  const devToolsHeight = Math.max(1, Math.round(available * BROWSER_DEVTOOLS_RATIO));
  const pageHeight = available - devToolsHeight;
  return {
    page: { ...bounds, height: pageHeight },
    devTools: {
      x: bounds.x,
      y: bounds.y + pageHeight + BROWSER_DEVTOOLS_DIVIDER_PX,
      width: bounds.width,
      height: devToolsHeight,
    },
  };
}

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

/** Keeps page-owned chrome facts bounded and on one renderer/model-owned line. */
function boundedBrowserTitle(title: string): string {
  return title.replace(/\s+/g, " ").trim().slice(0, BROWSER_TITLE_MAX_CHARS);
}

function boundedBrowserUrl(url: string): string {
  return url.slice(0, BROWSER_URL_MAX_CHARS);
}

function boundedBrowserError(error: string | null): string | null {
  return error === null
    ? null
    : error.replace(/\s+/g, " ").trim().slice(0, BROWSER_ERROR_MAX_CHARS);
}

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
 * Whether a target may be opened by the PRODUCT — the New Browser Tab entry and
 * the address bar — which is the HTTP(S) rule plus this app's own blank start
 * page.
 *
 * The two predicates are separate on purpose. A new tab must be able to land
 * somewhere empty before a destination is typed, but widening the shared rule
 * would have handed the same scheme to every page redirect and popup. Splitting
 * the doors keeps the remote-content policy exactly as strict as it was.
 */
export function isAllowedBrowserTarget(target: string): boolean {
  return isBrowserStartUrl(target) || isAllowedBrowserUrl(target);
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
 * Owns every live WebContentsView-backed Browser Tab in Electron main.
 * Registry identity, native-surface lifetime, navigation policy, and state
 * publication stay together so neither renderer nor Chromium can become the
 * authority for which product tab an operation targets.
 */
export class BrowserTabHost {
  private readonly tabs = new Map<string, BrowserTabEntry>();
  private readonly securedSessions = new WeakSet<Session>();
  private readonly holdListeners = new Set<(event: BrowserHoldEvent) => void>();
  /**
   * Who watches which tabs are ON SCREEN and where their pages sit (VC-239):
   * the cursor overlay, which draws only over a tab that is attached and must
   * move with it. Told after every attach, detach and layout.
   *
   * A SET of tab ids rather than one (VC-238): the host attaches a view per
   * entry, so a shown agent tab and the person's own pane are on screen
   * together. A headless tab is attached to nothing and never appears here,
   * which is what keeps the cursor from ever drawing over one.
   */
  private readonly planeListeners = new Set<(attachedTabIds: readonly string[]) => void>();
  /**
   * The colour each live holding Session was handed, assigned on its first
   * hold against the colours then in use and never revisited — so a Session
   * keeps its colour for as long as it lives whoever comes or goes after it.
   * Pruned when the Session's attachment ends ({@link forgetSession}), so the
   * wheel is not blocked by Sessions nobody will see again.
   */
  private readonly sessionColors = new Map<string, string>();
  /** Names learned from {@link BrowserTabHostDependencies.sessionName}, so a second hold does not ask twice. */
  private readonly sessionNames = new Map<string, string>();

  constructor(private readonly deps: BrowserTabHostDependencies) {}

  private requireTab(tabId: string): BrowserTabEntry {
    const entry = this.tabs.get(tabId);
    if (entry === undefined) throw new Error("Unknown Browser Tab");
    return entry;
  }

  private layout(entry: BrowserTabEntry, devToolsOpen = entry.devToolsOpen): void {
    const split = browserSurfaceBounds(entry.bounds, devToolsOpen && entry.devToolsView !== null);
    entry.view.setBounds(split.page);
    if (split.devTools !== null) entry.devToolsView?.setBounds(split.devTools);
    if (entry.attachedTo !== null) this.emitPlane();
  }

  private emitPlane(): void {
    const attachedTabIds = this.attachedTabIds();
    for (const listener of this.planeListeners) listener(attachedTabIds);
  }

  // ---- the plane, for the cursor overlay (VC-239) -------------------------

  /**
   * Every tab whose native page is attached to the window right now, in
   * registry order. Plural since VC-238 lifted the one-view limit; a headless
   * tab is never among them.
   */
  attachedTabIds(): string[] {
    const onScreen: string[] = [];
    for (const entry of this.tabs.values()) {
      if (entry.attachedTo !== null) onScreen.push(entry.state.tabId);
    }
    return onScreen;
  }

  /** Whether this tab's page is on screen — the question the cursor overlay actually asks. */
  isOnScreen(tabId: string): boolean {
    return this.tabs.get(tabId)?.attachedTo != null;
  }

  /**
   * Where one tab's PAGE sits in window content coordinates while it is on
   * screen — the plane minus the DevTools split — or null when it is not.
   * The overlay maps page CSS pixels through this and the zoom factor.
   */
  pageBoundsOf(tabId: string): Rectangle | null {
    const entry = this.tabs.get(tabId);
    if (entry === undefined || entry.attachedTo === null) return null;
    return browserSurfaceBounds(entry.bounds, entry.devToolsOpen && entry.devToolsView !== null)
      .page;
  }

  /** The page's zoom, which scales its CSS pixels to the window's. 1 for a tab that is gone. */
  zoomFactorOf(tabId: string): number {
    const contents = this.tabs.get(tabId)?.view.webContents;
    if (contents === undefined || contents.isDestroyed()) return 1;
    return contents.getZoomFactor();
  }

  /** The holder as the renderer sees it, for the overlay's label and colour. */
  heldBy(tabId: string): BrowserTabHolder | null {
    const entry = this.tabs.get(tabId);
    return entry === undefined ? null : this.holderOf(entry);
  }

  /** Attach, detach and layout changes of the on-screen tab. Returns the unsubscribe. */
  onPlaneChange(listener: (attachedTabIds: readonly string[]) => void): () => void {
    this.planeListeners.add(listener);
    return () => {
      this.planeListeners.delete(listener);
    };
  }

  private attachDevTools(entry: BrowserTabEntry, window: BrowserWindow): void {
    if (entry.devToolsView === null || entry.devToolsAttached) return;
    window.contentView.addChildView(entry.devToolsView);
    entry.devToolsAttached = true;
  }

  private detachDevTools(entry: BrowserTabEntry, window: BrowserWindow): void {
    if (entry.devToolsView === null || !entry.devToolsAttached) return;
    if (!window.isDestroyed()) window.contentView.removeChildView(entry.devToolsView);
    entry.devToolsAttached = false;
  }

  /** Detaches the page and its DevTools from whichever window holds them; quiet when none does. */
  private detachEntry(entry: BrowserTabEntry): void {
    const window = entry.attachedTo;
    if (window === null) return;
    this.detachDevTools(entry, window);
    if (!window.isDestroyed()) window.contentView.removeChildView(entry.view);
    entry.attachedTo = null;
    // Every path that takes a page off screen — hide, close, a crash, going
    // headless — is a plane change the cursor overlay has to hear (VC-239).
    this.emitPlane();
  }

  private destroyDevTools(entry: BrowserTabEntry): void {
    const tools = entry.devToolsView;
    if (tools === null) return;
    if (entry.attachedTo !== null) this.detachDevTools(entry, entry.attachedTo);
    const inspected = entry.view.webContents;
    if (!inspected.isDestroyed() && entry.devToolsOpen) inspected.closeDevTools();
    if (!tools.webContents.isDestroyed()) tools.webContents.close({ waitForBeforeUnload: false });
    entry.devToolsView = null;
    entry.devToolsOpen = false;
    entry.devToolsAttached = false;
  }

  /**
   * Whether one more tab may open under `input`'s provenance. Two counters,
   * never one: a person's tabs are bounded per project and an agent's per
   * Session, so neither population can exhaust the other's allowance.
   */
  private hasCapacity(input: BrowserTabCreateOptions): boolean {
    let count = 0;
    if (input.createdBy === "user") {
      for (const entry of this.tabs.values()) {
        if (entry.state.projectId === input.projectId && entry.state.createdBy === "user") {
          count += 1;
        }
      }
      return count < BROWSER_MAX_TABS_PER_PROJECT;
    }
    // Headless only. A tab the person previewed or promoted is theirs to close
    // (§6) and outlives this Session, so counting it here would let a person's
    // own act — Show — lock the agent out of the allowance the cap exists to
    // guarantee it. The cap bounds what an agent may hold unseen, nothing else.
    for (const entry of this.tabs.values()) {
      if (
        entry.state.ownerSessionId === input.ownerSessionId &&
        entry.state.presentation === "headless"
      ) {
        count += 1;
      }
    }
    return count < BROWSER_MAX_TABS_PER_SESSION;
  }

  private assertCapacity(input: BrowserTabCreateOptions): void {
    if (this.hasCapacity(input)) return;
    throw input.createdBy === "user"
      ? new BrowserTabLimitError()
      : new BrowserSessionTabLimitError();
  }

  private recordConsole(entry: BrowserTabEntry, message: RuntimeBrowserConsoleMessage): void {
    const text = message.text.slice(0, BROWSER_CONSOLE_MAX_CHARS);
    if (text.length !== message.text.length) entry.consoleTruncated = true;
    entry.console.push({ ...message, text });

    let chars = entry.console.reduce((total, one) => total + one.text.length, 0);
    while (
      entry.console.length > BROWSER_CONSOLE_MAX_MESSAGES ||
      chars > BROWSER_CONSOLE_MAX_CHARS
    ) {
      const removed = entry.console.shift();
      chars -= removed?.text.length ?? 0;
      entry.consoleTruncated = true;
    }
  }

  private beginProductNavigation(entry: BrowserTabEntry, url?: string): void {
    this.publish(entry, {
      error: null,
      generation: entry.state.generation + 1,
      loading: true,
      ...(url === undefined ? {} : { url }),
    });
  }

  // ---- holds (VC-239) -----------------------------------------------------

  /** The renderer-facing holder for one entry's hold, with the Session's name and colour resolved. */
  private holderOf(entry: BrowserTabEntry): BrowserTabHolder | null {
    const hold = entry.hold;
    if (hold === null) return null;
    if (hold.kind === "person") return { kind: "person" };
    const { sessionId } = hold.holder;
    return {
      kind: "session",
      sessionId,
      name: this.sessionNames.get(sessionId) ?? `Session ${shortSessionId(sessionId)}`,
      color: this.sessionColors.get(sessionId) ?? pickSessionColor(sessionId, []),
    };
  }

  /** A Session's colour, assigned on its first hold and sticky from then on. */
  private colorFor(sessionId: string): string {
    let color = this.sessionColors.get(sessionId);
    if (color === undefined) {
      color = pickSessionColor(sessionId, this.sessionColors.values());
      this.sessionColors.set(sessionId, color);
    }
    return color;
  }

  /** Re-derives `state.heldBy` from the entry's hold and pushes the tab. */
  private publishHold(entry: BrowserTabEntry): void {
    entry.state = { ...entry.state, heldBy: this.holderOf(entry) };
    this.deps.publishState({ ...entry.state });
  }

  private emitHold(event: BrowserHoldEvent): void {
    for (const listener of this.holdListeners) listener(event);
  }

  /** Learns a Session's name once, then republishes every tab it holds under it. */
  private learnSessionName(sessionId: string): void {
    if (this.sessionNames.has(sessionId) || this.deps.sessionName === undefined) return;
    void this.deps.sessionName(sessionId).then(
      (name) => {
        if (name === null || name.trim() === "") return;
        this.sessionNames.set(sessionId, name.trim());
        for (const entry of this.tabs.values()) {
          if (entry.hold?.kind === "session" && entry.hold.holder.sessionId === sessionId) {
            this.publishHold(entry);
          }
        }
      },
      () => {
        // The placeholder stands. Nobody asked for the name and nothing waits
        // on it; a hold is not a user operation that can fail on a lookup.
      },
    );
  }

  private static sameHolder(a: BrowserSessionHolder, b: BrowserSessionHolder): boolean {
    return a.sessionId === b.sessionId && a.attachmentId === b.attachmentId;
  }

  /**
   * Rule 2 and rule 3 in one door: a write on a free tab takes the hold, a
   * write on one's own hold keeps it, and a write on anybody else's is
   * refused with the holder named. The port calls this before every write;
   * `browser_acquire` calls it on its own. Never throws for a judged
   * outcome — the refusal is an answer, and the port words it.
   */
  hold(tabId: string, holder: BrowserSessionHolder): BrowserHoldOutcome {
    const entry = this.requireTab(tabId);
    const current = entry.hold;
    if (current !== null) {
      if (current.kind === "session" && BrowserTabHost.sameHolder(current.holder, holder)) {
        return { kind: "held", tab: { ...entry.state } };
      }
      return { kind: "refused", holder: this.holderOf(entry)! };
    }
    entry.hold = { kind: "session", holder };
    this.colorFor(holder.sessionId);
    this.learnSessionName(holder.sessionId);
    this.publishHold(entry);
    this.emitHold({ kind: "taken", tabId, holder });
    return { kind: "held", tab: { ...entry.state } };
  }

  /**
   * Ends one Session's hold on one tab. Only the holder can: a release from
   * anyone else is a no-op rather than a refusal, because "you do not hold
   * this" is already the end state the caller asked for. An unknown tab is
   * the same no-op — a closed tab's hold went with it.
   */
  releaseHold(tabId: string, holder: BrowserSessionHolder, why: BrowserHoldEnd = "release"): void {
    const entry = this.tabs.get(tabId);
    if (entry === undefined || entry.hold === null || entry.hold.kind !== "session") return;
    if (!BrowserTabHost.sameHolder(entry.hold.holder, holder)) return;
    entry.hold = null;
    this.publishHold(entry);
    this.emitHold({ kind: "released", tabId, holder, why });
  }

  /** Every hold one attachment has, ended at once: a turn end or the attachment's end. */
  releaseAllHeldBy(holder: BrowserSessionHolder, why: BrowserHoldEnd): string[] {
    const released: string[] = [];
    for (const [tabId, entry] of this.tabs) {
      if (entry.hold?.kind !== "session") continue;
      if (!BrowserTabHost.sameHolder(entry.hold.holder, holder)) continue;
      this.releaseHold(tabId, holder, why);
      released.push(tabId);
    }
    return released;
  }

  /**
   * An attachment is over: its holds go, and its Session leaves the colour
   * order so the wheel is not blocked by a Session nobody will see again. A
   * later attachment of the same Session arrives as new and may take another
   * slot — the colour is stable for as long as the Session holds, which is
   * the life the cursor is drawn for.
   *
   * Holds are keyed by attachment and colours by Session, so the two can
   * disagree for a moment: while one attachment of a Session is torn down
   * another may already hold a tab. The colour stays until nothing of the
   * Session holds anything, or a live holder would lose its colour mid-hold
   * and re-pick one that could collide.
   */
  forgetSession(holder: BrowserSessionHolder): void {
    this.releaseAllHeldBy(holder, "attachment-end");
    for (const entry of this.tabs.values()) {
      if (entry.hold?.kind === "session" && entry.hold.holder.sessionId === holder.sessionId) {
        return;
      }
    }
    this.sessionColors.delete(holder.sessionId);
    this.sessionNames.delete(holder.sessionId);
  }

  /**
   * Rule 7: the person takes the tab now. Whoever held it is displaced and
   * named back, so the caller can tell that Session in-band rather than let
   * it learn by failing. Taking over a free tab or one the person already
   * holds is the same end state and reports nobody displaced.
   */
  takeOver(tabId: string): { tab: BrowserTabState; displaced: BrowserSessionHolder | null } {
    const entry = this.requireTab(tabId);
    const displaced = entry.hold?.kind === "session" ? entry.hold.holder : null;
    entry.hold = { kind: "person" };
    this.publishHold(entry);
    if (displaced !== null) {
      this.emitHold({ kind: "released", tabId, holder: displaced, why: "takeover" });
    }
    this.emitHold({ kind: "person-took", tabId, displaced });
    return { tab: { ...entry.state }, displaced };
  }

  /** The person gives the tab back: free, and a Session may hold it on its next write. */
  handBack(tabId: string): BrowserTabState {
    const entry = this.requireTab(tabId);
    if (entry.hold?.kind === "person") {
      entry.hold = null;
      this.publishHold(entry);
      this.emitHold({ kind: "person-handed-back", tabId });
    }
    return { ...entry.state };
  }

  /**
   * The person asks the holding Session to release when it is safe. The hold
   * stays; the request is an event for whoever relays it in-band. Nothing to
   * ask on a tab no Session holds.
   */
  askToLeave(tabId: string): BrowserSessionHolder | null {
    const entry = this.requireTab(tabId);
    if (entry.hold?.kind !== "session") return null;
    const holder = entry.hold.holder;
    this.emitHold({ kind: "ask-to-leave", tabId, holder });
    return holder;
  }

  /** Whether one attachment holds a tab — the port's own bookkeeping check. */
  isHeldBy(tabId: string, holder: BrowserSessionHolder): boolean {
    const hold = this.tabs.get(tabId)?.hold;
    return hold?.kind === "session" && BrowserTabHost.sameHolder(hold.holder, holder);
  }

  /** Hold changes, for the cursor overlay and the steer notices. Returns the unsubscribe. */
  onHoldChange(listener: (event: BrowserHoldEvent) => void): () => void {
    this.holdListeners.add(listener);
    return () => {
      this.holdListeners.delete(listener);
    };
  }

  private publish(
    entry: BrowserTabEntry,
    update: Partial<
      Pick<BrowserTabState, "error" | "generation" | "loading" | "presentation" | "title" | "url">
    > = {},
  ): void {
    const contents = entry.view.webContents;
    const next = {
      ...entry.state,
      url: contents.getURL() || entry.state.url,
      title: contents.getTitle(),
      loading: contents.isLoading(),
      canGoBack: contents.navigationHistory.canGoBack(),
      canGoForward: contents.navigationHistory.canGoForward(),
      ...update,
    };
    // URL and title are page-owned bytes. They cross IPC and can enter a model
    // result, so the Browser host — not each consumer — owns their bounds.
    entry.state = {
      ...next,
      url: boundedBrowserUrl(next.url),
      title: boundedBrowserTitle(next.title),
      error: boundedBrowserError(next.error),
    };
    this.deps.publishState({ ...entry.state });
  }

  private secureSession(isolatedSession: Session): void {
    if (this.securedSessions.has(isolatedSession)) return;
    isolatedSession.setPermissionRequestHandler((_contents, _permission, callback) => {
      callback(false);
    });
    isolatedSession.setPermissionCheckHandler(() => false);
    isolatedSession.on("will-download", (event) => {
      event.preventDefault();
    });
    this.securedSessions.add(isolatedSession);
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  /** Creates one hidden tab; visibility is a separate renderer-measured act. */
  open(input: BrowserTabCreateOptions): BrowserTabState {
    if (!isAllowedBrowserTarget(input.url)) {
      throw new Error("Browser Tabs only support HTTP(S) URLs");
    }
    this.assertCapacity(input);
    const tabId = this.deps.createId();
    if (this.tabs.has(tabId)) throw new Error("Duplicate Browser Tab id");

    const isolatedSession = this.deps.fromPartition(browserSessionPartition(input));
    this.secureSession(isolatedSession);
    const view = this.deps.createView({
      webPreferences: {
        ...browserRemoteWebPreferences(),
        session: isolatedSession,
      },
    });
    // A Session-created tab may never be selected by the renderer, but it still
    // needs a real viewport for layout, screenshots, and pointer coordinates.
    // Renderer measurement replaces this default whenever a person shows it.
    view.setBounds(BROWSER_DEFAULT_BOUNDS);
    const state: BrowserTabState = {
      tabId,
      projectId: input.projectId,
      ticketId: input.ticketId,
      createdBy: input.createdBy,
      ownerSessionId: input.createdBy === "session" ? input.ownerSessionId : null,
      // Agent tabs are born headless; only a person can reveal one (VC-238).
      presentation: input.createdBy === "session" ? "headless" : "tab",
      url: input.url,
      title: "",
      loading: true,
      error: null,
      canGoBack: false,
      canGoForward: false,
      generation: 0,
      heldBy: null,
    };
    const entry: BrowserTabEntry = {
      state,
      view,
      bounds: { ...BROWSER_DEFAULT_BOUNDS },
      attachedTo: null,
      devToolsView: null,
      devToolsOpen: false,
      devToolsAttached: false,
      console: [],
      consoleTruncated: false,
      wakeLeases: 0,
      lastInteractionAt: null,
      hold: null,
    };
    this.tabs.set(tabId, entry);
    // Everything that means "the person is using this tab", stamped in one
    // place: `input-event` covers keys, clicks and the wheel, and `focus`
    // covers a tab entered by keyboard alone.
    view.webContents.on("input-event", () => {
      entry.lastInteractionAt = this.now();
    });
    view.webContents.on("focus", () => {
      entry.lastInteractionAt = this.now();
    });
    view.webContents.setWindowOpenHandler(({ url }) => {
      // A hostile page can ask indefinitely; the same cap used by every other
      // open door turns excess popups into ordinary denials. A popup inherits
      // its opener's provenance and owner, so an agent tab's popups are the
      // agent's, count against its cap, and are born headless like it.
      if (isAllowedBrowserUrl(url) && this.hasCapacity(input)) {
        this.open({ ...input, url });
      }
      return { action: "deny" };
    });
    view.webContents.on("will-navigate", (details) => {
      if (!isAllowedBrowserUrl(details.url)) details.preventDefault();
    });
    view.webContents.on("will-frame-navigate", (details) => {
      if (!isAllowedBrowserUrl(details.url)) details.preventDefault();
    });
    view.webContents.on("will-redirect", (details) => {
      if (!isAllowedBrowserUrl(details.url)) details.preventDefault();
    });
    view.webContents.on("did-start-navigation", (details) => {
      if (!details.isMainFrame) return;
      this.publish(entry, {
        error: null,
        generation: entry.state.generation + 1,
        url: details.url,
      });
    });
    view.webContents.on("console-message", (_event, level, message) => {
      const consoleLevel: RuntimeBrowserConsoleMessage["level"] =
        level >= 3 ? "error" : level === 2 ? "warn" : level === 1 ? "info" : "debug";
      this.recordConsole(entry, { level: consoleLevel, text: message });
    });
    view.webContents.on("did-start-loading", () => this.publish(entry, { loading: true }));
    view.webContents.on("did-stop-loading", () => this.publish(entry, { loading: false }));
    view.webContents.on(
      "did-fail-load",
      (_event, errorCode, errorDescription, _validatedUrl, isMainFrame) => {
        // ERR_ABORTED is Chromium cancelling an older load because a newer one
        // won. It is not a failed user operation and must not overwrite the
        // newer page with a stale error.
        if (!isMainFrame || errorCode === -3) return;
        const message = `Could not load page: ${errorDescription}`;
        this.recordConsole(entry, { level: "error", text: message });
        this.publish(entry, {
          error: message,
          loading: false,
        });
      },
    );
    view.webContents.on("page-title-updated", (_event, title) => {
      this.publish(entry, { title });
    });
    view.webContents.on("devtools-opened", () => {
      entry.devToolsOpen = true;
      if (entry.attachedTo !== null) this.attachDevTools(entry, entry.attachedTo);
      this.layout(entry);
    });
    view.webContents.on("devtools-closed", () => {
      entry.devToolsOpen = false;
      if (entry.attachedTo !== null) this.detachDevTools(entry, entry.attachedTo);
      this.layout(entry);
    });
    view.webContents.on("render-process-gone", (_event, details) => {
      this.recordConsole(entry, {
        level: "error",
        text: `Browser Tab renderer stopped: ${details.reason}`,
      });
      // The card and the strip read `error` (VC-238 §9); a crash that only
      // reached the console would leave a tab looking healthy and blank. Volli's
      // words, with Chromium's reason as the one fact worth carrying; the next
      // navigation clears it like any other main-frame failure.
      this.publish(entry, {
        error: `The page stopped responding and its renderer exited (${details.reason}).`,
        loading: false,
      });
    });
    view.webContents.on("did-navigate", (_event, url) => this.publish(entry, { url }));
    view.webContents.on("did-navigate-in-page", (_event, url, isMainFrame) => {
      if (isMainFrame) this.publish(entry, { url });
    });
    view.webContents.on("destroyed", () => {
      if (this.tabs.get(tabId) !== entry) return;
      this.detachEntry(entry);
      this.destroyDevTools(entry);
      this.tabs.delete(tabId);
      this.endHoldOnClose(tabId, entry);
      this.deps.publishClosed(tabId);
    });
    this.deps.publishState({ ...state });
    void view.webContents.loadURL(input.url).catch(() => undefined);
    return { ...state };
  }

  /** A closed tab's hold goes with it; the holder hears so its own bookkeeping can drop the tab. */
  private endHoldOnClose(tabId: string, entry: BrowserTabEntry): void {
    const hold = entry.hold;
    entry.hold = null;
    if (hold?.kind === "session") {
      this.emitHold({ kind: "released", tabId, holder: hold.holder, why: "closed" });
    }
  }

  /** Closes and forgets one product tab without allowing page unload code to veto it. */
  close(tabId: string): void {
    const entry = this.requireTab(tabId);
    this.detachEntry(entry);
    this.destroyDevTools(entry);
    this.tabs.delete(tabId);
    this.endHoldOnClose(tabId, entry);
    this.deps.publishClosed(tabId);
    entry.view.webContents.close({ waitForBeforeUnload: false });
  }

  /**
   * Navigates one opaque tab. This is a product door — the address bar — so it
   * applies the product policy: the HTTP(S) rule pages face, plus the blank
   * start page a tab may return to.
   */
  navigate(tabId: string, url: string): BrowserTabState {
    if (!isAllowedBrowserTarget(url)) {
      throw new Error("Browser Tabs only support HTTP(S) URLs");
    }
    const entry = this.requireTab(tabId);
    this.beginProductNavigation(entry, url);
    void entry.view.webContents.loadURL(url).catch(() => undefined);
    return { ...entry.state };
  }

  /** Moves one tab backward when Chromium reports a preceding history entry. */
  back(tabId: string): BrowserTabState {
    const entry = this.requireTab(tabId);
    if (entry.view.webContents.navigationHistory.canGoBack()) {
      this.beginProductNavigation(entry);
      entry.view.webContents.navigationHistory.goBack();
    }
    return { ...entry.state };
  }

  /** Moves one tab forward when Chromium reports a following history entry. */
  forward(tabId: string): BrowserTabState {
    const entry = this.requireTab(tabId);
    if (entry.view.webContents.navigationHistory.canGoForward()) {
      this.beginProductNavigation(entry);
      entry.view.webContents.navigationHistory.goForward();
    }
    return { ...entry.state };
  }

  /** Reloads one tab without exposing a general WebContents operation surface. */
  reload(tabId: string): BrowserTabState {
    const entry = this.requireTab(tabId);
    this.beginProductNavigation(entry);
    entry.view.webContents.reload();
    return { ...entry.state };
  }

  /** Toggles Chromium DevTools inside this tab's measured plane. */
  toggleDevTools(tabId: string): void {
    const entry = this.requireTab(tabId);
    const contents = entry.view.webContents;
    if (entry.devToolsOpen) {
      entry.devToolsOpen = false;
      contents.closeDevTools();
      if (entry.attachedTo !== null) this.detachDevTools(entry, entry.attachedTo);
      this.layout(entry);
      return;
    }

    let tools = entry.devToolsView;
    if (tools === null || tools.webContents.isDestroyed()) {
      tools = this.deps.createView({});
      entry.devToolsView = tools;
      contents.setDevToolsWebContents(tools.webContents);
    }
    entry.devToolsOpen = true;
    if (entry.attachedTo !== null) this.attachDevTools(entry, entry.attachedTo);
    this.layout(entry);
    try {
      // Electron still wants a mode even with custom DevTools contents. `detach`
      // means "do not dock into the inspected WebContents" here; the explicit
      // setDevToolsWebContents target above keeps it inside Volli's own view.
      contents.openDevTools({ mode: "detach", activate: true });
    } catch (error) {
      entry.devToolsOpen = false;
      if (entry.attachedTo !== null) this.detachDevTools(entry, entry.attachedTo);
      this.layout(entry);
      throw error;
    }
  }

  /**
   * Where a Session's tab is drawn (VC-238): headless, pinned as the owning
   * chat's preview, or promoted into the strip. Main owns the value and the
   * renderer asks; a person's tab is always in the strip and refuses here.
   *
   * Nothing the agent sees moves. Owner, generation, URL, cookies and the
   * wake hold are untouched — the renderer's plane controller attaches the
   * native view for the surface that now draws it, exactly as it does for a
   * person's tab, so the overlay-freeze rule holds for every presentation.
   *
   * One preview per owning Session: a chat has one pinned pane, so previewing
   * a second tab returns the first to headless rather than leaving two tabs
   * both claiming a pane only one can occupy.
   */
  setPresentation(tabId: string, presentation: BrowserTabPresentation): BrowserTabState {
    const entry = this.requireTab(tabId);
    if (entry.state.createdBy === "user") {
      throw new Error("Only a Session's Browser Tab can be hidden or previewed");
    }
    if (presentation === "preview") {
      for (const other of this.tabs.values()) {
        if (
          other !== entry &&
          other.state.ownerSessionId === entry.state.ownerSessionId &&
          other.state.presentation === "preview"
        ) {
          this.publish(other, { presentation: "headless" });
        }
      }
    }
    // Detach before publishing: a tab going headless has no surface to draw
    // on, and main is the one that knows it. The renderer's plane controller
    // emits its own hide as the pane unmounts, but that arrives after the
    // state push, and until it did the page would still be over the window.
    if (presentation === "headless") this.detachEntry(entry);
    if (entry.state.presentation !== presentation) this.publish(entry, { presentation });
    return { ...entry.state };
  }

  /** Applies the renderer-measured host plane to the page and its docked DevTools. */
  setBounds(tabId: string, bounds: Rectangle): void {
    const entry = this.requireTab(tabId);
    entry.bounds = { ...bounds };
    this.layout(entry);
  }

  /**
   * Captures inert fallback pixels before the renderer hides this native plane
   * for one of its overlays.
   *
   * A WebContentsView always composites above the BrowserWindow renderer. The
   * live view therefore has to detach before a dialog or menu can cover it, but
   * detaching without a replacement exposes an empty (usually black) native
   * hole. These frames let the renderer paint the last visible page underneath
   * its overlay instead. Only PNG pixels cross the boundary — never remote DOM,
   * script, storage, or a WebContents handle.
   */
  async capture(tabId: string): Promise<BrowserTabCaptureFrame[]> {
    const entry = this.requireTab(tabId);
    const encode = (image: NativeImage): string =>
      `data:image/jpeg;base64,${image.toJPEG(BROWSER_CAPTURE_JPEG_QUALITY).toString("base64")}`;
    const split = browserSurfaceBounds(
      entry.bounds,
      entry.devToolsOpen && entry.devToolsView !== null,
    );
    // One place that knows the window→plane coordinate change, so the page and
    // DevTools frames can never drift apart on it.
    const planeRelative = (surface: Rectangle): BrowserTabBounds => ({
      x: surface.x - entry.bounds.x,
      y: surface.y - entry.bounds.y,
      width: surface.width,
      height: surface.height,
    });
    const pending: Promise<BrowserTabCaptureFrame>[] = [
      entry.view.webContents.capturePage().then((image) => ({
        kind: "page" as const,
        dataUrl: encode(image),
        bounds: planeRelative(split.page),
      })),
    ];
    const devToolsBounds = split.devTools;
    if (devToolsBounds !== null && entry.devToolsView !== null) {
      pending.push(
        entry.devToolsView.webContents.capturePage().then((image) => ({
          kind: "devtools" as const,
          dataUrl: encode(image),
          bounds: planeRelative(devToolsBounds),
        })),
      );
    }
    return Promise.all(pending);
  }

  /**
   * Photographs one tab for the transcript card after an agent navigated or
   * acted in it (VC-238), and hands back the picture's id — or null when it
   * declined to look.
   *
   * It declines while the person is USING a shown tab, and for a window after
   * they stop: the password they just typed must not become a frame in the
   * transcript, and the agent's next action often lands a beat after their
   * last keystroke. This is the takeover rule ChatGPT agent and Manus both
   * settled on.
   *
   * A recency stamp rather than `isFocused()`, deliberately. Instantaneous
   * focus is both too narrow and too brief: wheel-scrolling or hovering a
   * shown tab never focuses it, and focus leaves the moment they click Hide,
   * the chip, or another window — so an act arriving right after they typed
   * would photograph the filled field. Current focus still counts, for the
   * tab entered before this host ever saw an event from it. A headless tab is
   * attached to nothing and can be touched by nobody, so it always
   * photographs.
   *
   * JPEG through the same `capturePage` door the overlay freeze uses, for the
   * same latency reason; the store bounds how many live frames are kept.
   */
  async capturePicture(tabId: string): Promise<string | null> {
    const entry = this.requireTab(tabId);
    const contents = entry.view.webContents;
    if (entry.state.presentation !== "headless" && this.isBeingUsed(entry)) return null;
    const image = await contents.capturePage();
    return this.deps.pictures.put({
      tabId,
      generation: entry.state.generation,
      mime: "image/jpeg",
      bytes: image.toJPEG(BROWSER_CAPTURE_JPEG_QUALITY),
      ownerSessionId: entry.state.ownerSessionId,
      persist: false,
    });
  }

  /** Whether the person has touched this tab inside the quiet window, or holds it now. */
  private isBeingUsed(entry: BrowserTabEntry): boolean {
    if (entry.view.webContents.isFocused()) return true;
    const last = entry.lastInteractionAt;
    return last !== null && this.now() - last < BROWSER_INTERACTION_QUIET_MS;
  }

  /**
   * Keeps the PNG a `browser_screenshot` call produced, so the picture the
   * model asked for is also the person's to look at later. The engine already
   * rendered these bytes for the model; storing them costs no second capture.
   */
  keepScreenshot(tabId: string, base64Png: string): string {
    const entry = this.requireTab(tabId);
    return this.deps.pictures.put({
      tabId,
      generation: entry.state.generation,
      mime: "image/png",
      bytes: Buffer.from(base64Png, "base64"),
      // A picture that outlives this launch is attributable: whose Session
      // asked for it, so the bytes on disk are never anonymous.
      ownerSessionId: entry.state.ownerSessionId,
      persist: true,
    });
  }

  /** The renderer's one read of a picture: a data URL, or null for an id this host never minted. */
  pictureOf(pictureId: string): string | null {
    return this.deps.pictures.dataUrl(pictureId);
  }

  /**
   * Attaches one native page (and its DevTools) to the live app window,
   * beside whatever else is attached. Showing a tab never evicts another: each
   * on-screen pane drives its own tab's plane, and which tabs are on screen is
   * the renderer's layout to decide, not a host-wide slot's.
   */
  show(tabId: string): void {
    const entry = this.requireTab(tabId);
    // Main owns presentation (§2): a headless tab is "never attached to the
    // window until the person reveals it", and revealing is `setPresentation`,
    // not this. Without the guard the rule would rest on renderer discipline,
    // and one stale pane mounting a headless tab would put an agent's page on
    // screen with nothing in the UI claiming to have shown it.
    if (entry.state.presentation === "headless") {
      throw new Error("A headless Browser Tab has no plane until the person shows it");
    }
    if (entry.attachedTo !== null) return;
    const window = this.deps.getWindow();
    if (window === null || window.isDestroyed()) throw new Error("Browser window is unavailable");
    window.contentView.addChildView(entry.view);
    entry.attachedTo = window;
    if (entry.devToolsOpen) this.attachDevTools(entry, window);
    this.layout(entry);
  }

  /**
   * Detaches the named page and DevTools when its workspace surface is no
   * longer visible.
   *
   * Alone among the tab operations this one tolerates an unknown id, because
   * hiding asks for an end state rather than an action: a tab that no longer
   * exists has no native surface attached, which is exactly what the caller
   * wanted. The renderer's plane controller emits one last hide as its React
   * surface unmounts, and a closed tab is the ordinary reason that surface went
   * away — `close` detaches and forgets the entry before the renderer hears
   * about it. Throwing there reported a failure for work already done. Every
   * other door still requires a live tab: `show`, `navigate`, and the rest
   * cannot do anything meaningful without one, so an unknown id is a real
   * fault.
   */
  hide(tabId: string): void {
    const entry = this.tabs.get(tabId);
    if (entry === undefined) return;
    this.detachEntry(entry);
  }

  /**
   * The one seam the agent port drives a tab's engine through: the live
   * webContents, whose app-private `debugger` is the CDP wire. Handed out for
   * exactly that composition — nothing else in the app reaches a remote
   * page's contents, and the renderer never can.
   */
  webContentsOf(tabId: string): WebContentsView["webContents"] {
    return this.requireTab(tabId).view.webContents;
  }

  /**
   * Keeps one tab's engine at foreground pace while an agent drives it
   * (VC-252).
   *
   * A hidden Browser Tab is a detached WebContentsView, and Chromium answers
   * detachment with background throttling: timers near 1Hz, no animation
   * frames, no compositor output. That is the right resource policy for a tab
   * nobody is using — and exactly wrong for a tab a Session keeps driving
   * after the person switches to another workspace, where it stalls loads and
   * starves snapshots and screenshots of the frames they wait on until the
   * tab is shown again.
   *
   * Measured, not argued — `e2e/browser-throttle-bench.mjs`, Electron 44 /
   * Chromium 152 / macOS arm64, against the visible baseline of 100 timer
   * ticks and 60 frames a second:
   *
   *   detached, no hold            1.0 ticks/s,  0 fps   (0.01x — the stall)
   *   detached + own hold        100.0 ticks/s, 60 fps   (1.00x — the fix)
   *   another detached tab         1.0 ticks/s,  0 fps   while the first holds
   *   window's own renderer        1.0 ticks/s           minimised, first holds
   *
   * So the lease is PER-TAB in practice. Electron's 28.0.0 note —
   * `backgroundThrottling: false` reaching every WebContents in the host
   * BrowserWindow — reads wider than it measures: it says "displayed by", and
   * neither a detached view nor a minimised window's own page is displayed.
   * Holding one Browser Tab awake does not stop the rest of the app sleeping,
   * and total app CPU across six open tabs did not move (3.2% -> 2.6%, inside
   * noise). An earlier review claimed the opposite from the documentation
   * alone; the bench is why this comment does not.
   *
   * The hold does span the driving attachment rather than one tool call, and
   * that part is deliberate. Releasing per call would re-open the same wedge
   * one level down: `act` returns, the page is still fetching or laying out
   * what the click started, the hold drops, and the next `snapshot` reads a
   * page that stopped working in the gap. People are unaffected either way —
   * a plane a person can touch is attached, and an attached plane was never
   * throttled.
   *
   * Both halves of the fix are load-bearing, and the bench shows why: a tab
   * detached since birth and never held answers `Page.captureScreenshot`
   * never at all (the bench gives up at the controller's own 15s bound),
   * while the same tab under a hold answers in ~100ms.
   *
   * Returns the release. Releasing twice releases once, and a hold on a tab
   * that is unknown or has since closed releases into nothing — wakefulness
   * is resource policy, never a user operation to fail.
   */
  holdAwake(tabId: string): () => void {
    const entry = this.tabs.get(tabId);
    if (entry === undefined) return () => undefined;
    entry.wakeLeases += 1;
    if (entry.wakeLeases === 1) this.applyWakePolicy(entry);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      // A closed tab was already forgotten; its contents are tearing down and
      // owe no throttling answer.
      if (this.tabs.get(tabId) !== entry) return;
      entry.wakeLeases -= 1;
      if (entry.wakeLeases === 0) this.applyWakePolicy(entry);
    };
  }

  /** Foreground pace while agent holds are live; Chromium's own thrift once none are. Window-wide, per the note on {@link BrowserTabHost.holdAwake}. */
  private applyWakePolicy(entry: BrowserTabEntry): void {
    const contents = entry.view.webContents;
    if (!contents.isDestroyed()) contents.setBackgroundThrottling(entry.wakeLeases === 0);
  }

  /** Page console and renderer-failure evidence recorded from the moment the tab exists. */
  consoleOf(tabId: string): {
    messages: RuntimeBrowserConsoleMessage[];
    truncated: boolean;
  } {
    const entry = this.requireTab(tabId);
    return {
      messages: entry.console.map((message) => ({ ...message })),
      truncated: entry.consoleTruncated,
    };
  }

  /** Closes every live view when its owning app window goes away. */
  closeAll(): void {
    for (const tabId of this.tabs.keys()) this.close(tabId);
  }

  /**
   * Closes the headless tabs one Session owns, when its attachment ends
   * (VC-238). A tab a person has shown — previewed or promoted — is theirs to
   * close and survives the Session, the trade Claude Code's Chrome integration
   * makes too: pages you may still be reading stay open. Returns what closed.
   */
  closeHeadlessOwnedBy(sessionId: string): string[] {
    return this.closeHeadlessWhere((state) => state.ownerSessionId === sessionId);
  }

  /** Closes every headless agent tab of one Ticket, when the Ticket is archived. */
  closeHeadlessForTicket(ticketId: string): string[] {
    return this.closeHeadlessWhere((state) => state.ticketId === ticketId);
  }

  private closeHeadlessWhere(matches: (state: BrowserTabState) => boolean): string[] {
    const closing: string[] = [];
    for (const entry of this.tabs.values()) {
      if (entry.state.presentation === "headless" && matches(entry.state)) {
        closing.push(entry.state.tabId);
      }
    }
    for (const tabId of closing) this.close(tabId);
    return closing;
  }

  /** Lists only the caller's product scope, never Chromium's positional view order. */
  list(scope: { projectId: string; ticketId?: string }): BrowserTabState[] {
    const result: BrowserTabState[] = [];
    for (const entry of this.tabs.values()) {
      if (entry.state.projectId !== scope.projectId) continue;
      if (scope.ticketId !== undefined && entry.state.ticketId !== scope.ticketId) continue;
      result.push({ ...entry.state });
    }
    return result;
  }
}

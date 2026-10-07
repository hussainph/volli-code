import type {
  BaseWindow,
  BrowserWindow,
  NativeImage,
  Rectangle,
  Session,
  WebContentsView,
  WebContentsViewConstructorOptions,
  WebPreferences,
} from "electron";
import type { RuntimeBrowserConsoleMessage } from "@volli/shared";
import {
  BROWSER_DEFAULT_BOUNDS,
  browserSessionPartition,
  isAllowedBrowserUrl,
  type BrowserLoadWaitMode,
  type BrowserTabCreateOptions,
  type CdpTransport,
  BrowserTabRegistry,
  type BrowserTabChrome,
  type BrowserTabRecord,
  type BrowserTabRegistryPorts,
} from "@volli/host-core/browser";

import { isBrowserStartUrl } from "../../browser-start-page";
import type { BrowserTabBounds, BrowserTabCaptureFrame, BrowserTabState } from "../../ipc/contract";
import { debuggerTransport, loadWaiter } from "./webcontents-cdp";
import { hostLogger } from "@volli/host-core/log";

const log = hostLogger("browser");

/**
 * Electron construction surfaces injected into the host. Tests can provide
 * inert views/sessions/windows, while production supplies the bundled Electron
 * objects; no Browser Tab policy depends on ambient Electron singletons.
 */
export interface BrowserTabHostDependencies extends BrowserTabRegistryPorts {
  createView: (options: WebContentsViewConstructorOptions) => WebContentsView;
  fromPartition: (partition: string) => Session;
  getWindow: () => BrowserWindow | null;
  /**
   * Creates the window headless tabs are parked in — never shown, never given
   * to the person. Called on the first tab that needs a stage and again only
   * if that stage is destroyed, so every tab alive at one time shares one. See
   * {@link BrowserTabHost.requireStage} for why a tab nobody looks at still
   * needs a window to belong to, and why this is a {@link BaseWindow} rather
   * than a BrowserWindow (VC-278).
   */
  createStageWindow: () => BaseWindow;
}

/**
 * Where one tab's native view is parented right now. A view has exactly ONE
 * parent, so this is one value rather than a window slot and a staged flag
 * that could disagree (VC-278): "attached and staged" and "a stage flag with
 * no stage" stop being states anything can write.
 *
 * Per entry rather than one host-wide slot (VC-238): a shown agent tab and the
 * person's own browser pane are on screen together, and two panes of a split
 * each hold a tab, so the host parents a SET of views keyed by tab.
 *
 * `detached` is the transient state BETWEEN parents — a view mid-move, or one
 * whose tab is being forgotten. It is not where a live tab rests: every live
 * tab is either on the window or on the stage, because a view with no parent
 * has no compositor surface and cannot be captured or clicked ({@link
 * BrowserTabHost.requireStage}).
 */
type BrowserTabParent =
  | { kind: "window"; window: BrowserWindow }
  | { kind: "stage" }
  | { kind: "detached" };

interface BrowserTabEntry extends BrowserTabRecord {
  view: WebContentsView;
  bounds: Rectangle;
  /** The one place this tab's view is parented; see {@link BrowserTabParent}. */
  parent: BrowserTabParent;
  devToolsView: WebContentsView | null;
  devToolsOpen: boolean;
  devToolsAttached: boolean;
  /**
   * When the person last touched this tab's page — a key, a click, a wheel, or
   * taking focus — or null while nobody ever has. Read by
   * {@link BrowserTabHost.capturePicture}; see the window there for why a
   * stamp rather than "is focused right now".
   */
  lastInteractionAt: number | null;
  /** Bounded native transcript-preview captures, deduplicated by generation. */
  pictureCaptures: Map<number, Promise<NativeImage>>;
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
 * How long after the person last touched a shown tab the host keeps its camera
 * shut (VC-238 §5). Five seconds covers the gap between a keystroke and the
 * agent's next action landing, which is the case that matters: the field they
 * just filled must not become a frame in the transcript.
 */
export const BROWSER_INTERACTION_QUIET_MS = 5_000;

function sameRectangle(left: Rectangle, right: Rectangle): boolean {
  return (
    left.x === right.x &&
    left.y === right.y &&
    left.width === right.width &&
    left.height === right.height
  );
}

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
/** A transcript preview is optional; a stuck compositor must not wedge a tool. */
export const BROWSER_PREVIEW_TIMEOUT_MS = 1_000;
/**
 * Hard safety cap for Electron capture requests, which have no cancellation.
 * Two compositor hangs disable optional previews until the tab closes rather
 * than letting later navigations create an unbounded native request queue.
 */
export const BROWSER_PREVIEW_MAX_PENDING_CAPTURES = 2;
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

/**
 * The off-screen stage could not be built or has died and would not rebuild
 * (VC-278).
 *
 * This is a hard failure on purpose. A tab with no parent window has no
 * compositor surface, and Chromium does not say so: captures return a 0x0
 * image or never answer, clicks land nowhere, and the accessibility tree reads
 * perfectly the whole time. Continuing without a stage is exactly the silent
 * state this ticket exists to end, so every door that parks a tab raises this
 * instead of leaving one surfaceless.
 */
export class BrowserStageUnavailableError extends Error {
  constructor(options?: { cause?: unknown }) {
    super(
      "The Browser Tab stage is unavailable, so the tab would have no surface to capture or click",
      options,
    );
    this.name = "BrowserStageUnavailableError";
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
 * Owns every live WebContentsView-backed Browser Tab in Electron main: the
 * desktop's Browser backend (VC-561). Registry identity, ownership, holds and
 * state publication are {@link BrowserTabRegistry}'s, shared with every other
 * backend; native-surface lifetime, navigation and the window a person sees a
 * tab in are this host's, so neither renderer nor Chromium can become the
 * authority for which product tab an operation targets.
 */
export class BrowserTabHost extends BrowserTabRegistry<
  BrowserTabEntry,
  BrowserTabHostDependencies
> {
  private readonly securedSessions = new WeakSet<Session>();
  /**
   * Who watches which tabs are ON SCREEN and where their pages sit (VC-239):
   * the cursor overlay, which draws only over a tab attached to the app window
   * and must move with it. Told after every attach, detach and layout.
   *
   * A SET of tab ids rather than one (VC-238): the host attaches a view per
   * entry, so a shown agent tab and the person's own pane are on screen
   * together. A Headless tab is parked in the never-shown stage and never
   * appears here, which keeps the cursor from ever drawing over one.
   */
  private readonly planeListeners = new Set<(attachedTabIds: readonly string[]) => void>();
  /** The off-screen stage, built on the first tab that needs one; see {@link requireStage}. */
  private stageWindow: BaseWindow | null = null;

  /** The settle wait every Session's port binds; see {@link waitForLoad}. */
  private readonly loadWait = loadWaiter((tabId) => this.webContentsOf(tabId));

  /**
   * The window every tab lives in while it is not on screen — created once,
   * never shown, never handed to the person.
   *
   * A WebContentsView with no parent window has no compositor surface, and
   * Chromium answers that state far more quietly than it looks. Measured on
   * Electron 44 / Chromium 152 / macOS arm64
   * (`e2e/browser-headless-capture-probe.mjs`), a view that has NEVER been
   * added to a window:
   *
   *   Page.captureScreenshot        never answers (the 15s bound fires)
   *   webContents.capturePage()     a 0x0 image, `toJPEG` -> zero bytes
   *   Input.dispatchMouseEvent      click and hover reach nothing at all
   *   Accessibility.getFullAXTree   fine — which is what hid this
   *
   * The last two lines are the trap. A snapshot reads correctly off a tab whose
   * clicks land nowhere, so `browser_act` reported a target it had not touched
   * and the model read back a page that never changed. That is the state a
   * Session-created tab was born in and stayed in: `open` never attaches, and
   * `show` refuses a headless tab by design, so a tab the person never revealed
   * had no surface for its whole life.
   *
   * The wake hold does not help and was never the fix — the same probe times
   * out with the hold applied before the navigation, during it, and after the
   * load settles, on a heavy page and a light one. VC-252's bench read as if it
   * did only because it measured a tab attached ONCE and then detached, which
   * is the workspace-switch shape and not the shape agent tabs run in.
   *
   * Parking the view in a window that is never shown gives it the surface and
   * nothing else: clicks land, captures answer in ~50ms with pixels identical
   * to an attached tab, and the page stays exactly as invisible as VC-238
   * requires — presentation is still the person's to change, and this window is
   * not a presentation. Several tabs stack in it harmlessly; capture and input
   * are per-WebContents, and the probe drives three stacked tabs with no
   * occlusion between them.
   *
   * A {@link BaseWindow} rather than a BrowserWindow, and that is not a
   * detail. `BrowserWindow.getAllWindows()` is how this app finds its real
   * window in twenty-odd places — the window a shown tab attaches to, the one
   * the cursor overlay draws into, the count `activate` checks before
   * re-creating a window on a dock click, and every broadcast loop. A
   * BrowserWindow stage would have joined all of them: a shown tab could
   * attach to the stage instead of the app, and a dock click would find a
   * window already open and re-create nothing. A BaseWindow holds views and
   * has no webContents of its own, so it never appears in that list, and the
   * blast radius of adding it is nil.
   *
   * It does still count for `window-all-closed`, which is why {@link closeAll}
   * destroys it — the app window's own `closed` handler calls that, and the
   * order is right: the stage is gone before Electron asks whether every
   * window has closed.
   *
   * Built on the first tab that needs one and shared by every tab after it,
   * and rebuilt if it was destroyed ({@link closeAll} on a window close, with
   * the app then reopened). Never null: a stage that cannot be built raises
   * {@link BrowserStageUnavailableError} rather than handing back an absence
   * a caller could quietly skip over.
   */
  private requireStage(): BaseWindow {
    const live = this.stageWindow;
    if (live !== null && !live.isDestroyed()) return live;
    let created: BaseWindow;
    try {
      created = this.deps.createStageWindow();
    } catch (cause) {
      this.stageWindow = null;
      throw new BrowserStageUnavailableError({ cause });
    }
    if (created.isDestroyed()) {
      this.stageWindow = null;
      throw new BrowserStageUnavailableError();
    }
    this.stageWindow = created;
    return created;
  }

  /** The window this tab is on, or null while it is anywhere else. */
  private windowOf(entry: BrowserTabEntry): BrowserWindow | null {
    return entry.parent.kind === "window" ? entry.parent.window : null;
  }

  /**
   * Parks one tab's view in the stage, unless the app window already holds it.
   * A view has one parent, so this is the other half of
   * {@link detachFromWindow}: every live tab is in exactly one of the two
   * places for its whole life.
   *
   * Raises {@link BrowserStageUnavailableError} when there is no stage to park
   * in. Every caller is a door that would otherwise leave a tab surfaceless —
   * uncapturable and unclickable while reading as healthy — so the failure is
   * loud rather than a tab that quietly stops answering (VC-278).
   */
  private parkOnStage(entry: BrowserTabEntry): void {
    if (entry.parent.kind !== "detached") return;
    const stage = this.requireStage();
    stage.contentView.addChildView(entry.view);
    entry.parent = { kind: "stage" };
  }

  /** Takes one tab's view out of the stage, so a real window may adopt it. */
  private takeOffStage(entry: BrowserTabEntry): void {
    if (entry.parent.kind !== "stage") return;
    entry.parent = { kind: "detached" };
    const stage = this.stageWindow;
    if (stage !== null && !stage.isDestroyed()) stage.contentView.removeChildView(entry.view);
  }

  private layout(entry: BrowserTabEntry, devToolsOpen = entry.devToolsOpen): void {
    const split = browserSurfaceBounds(entry.bounds, devToolsOpen && entry.devToolsView !== null);
    entry.view.setBounds(split.page);
    if (split.devTools !== null) entry.devToolsView?.setBounds(split.devTools);
    if (entry.parent.kind === "window") this.emitPlane();
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
      if (entry.parent.kind === "window") onScreen.push(entry.state.tabId);
    }
    return onScreen;
  }

  /** Whether this tab's page is on screen — the question the cursor overlay actually asks. */
  isOnScreen(tabId: string): boolean {
    const entry = this.tabs.get(tabId);
    return entry !== undefined && entry.parent.kind === "window";
  }

  /**
   * Where one tab's PAGE sits in window content coordinates while it is on
   * screen — the plane minus the DevTools split — or null when it is not.
   * The overlay maps page CSS pixels through this and the zoom factor.
   */
  pageBoundsOf(tabId: string): Rectangle | null {
    const entry = this.tabs.get(tabId);
    if (entry === undefined || entry.parent.kind !== "window") return null;
    return browserSurfaceBounds(entry.bounds, entry.devToolsOpen && entry.devToolsView !== null)
      .page;
  }

  /** The page's zoom, which scales its CSS pixels to the window's. 1 for a tab that is gone. */
  zoomFactorOf(tabId: string): number {
    const contents = this.tabs.get(tabId)?.view.webContents;
    if (contents === undefined || contents.isDestroyed()) return 1;
    return contents.getZoomFactor();
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

  /**
   * Takes the page and its DevTools off the app window, leaving the view with
   * no parent. Quiet when the tab was not on screen to begin with.
   *
   * Half a move on its own: every caller but teardown follows it with
   * {@link parkOnStage}, because off screen is a place rather than an absence
   * (VC-278). The pair is {@link goOffScreen}; teardown is the one path that
   * stops here, since the view is about to be destroyed.
   */
  private detachFromWindow(entry: BrowserTabEntry): void {
    const parent = entry.parent;
    if (parent.kind !== "window") return;
    this.detachDevTools(entry, parent.window);
    entry.parent = { kind: "detached" };
    if (!parent.window.isDestroyed()) parent.window.contentView.removeChildView(entry.view);
    // Every path that takes a page off screen — hide, close, a crash, going
    // headless — is a plane change the cursor overlay has to hear (VC-239).
    this.emitPlane();
  }

  /**
   * Takes one tab off screen and back to the stage, which is where a tab
   * nobody is looking at lives (VC-278).
   *
   * Raises {@link BrowserStageUnavailableError} if the stage cannot be built:
   * a tab that came off the window and could not be parked has lost its
   * compositor surface, and the caller — Hide, or going headless — hears that
   * rather than returning as if the tab were still whole.
   */
  protected goOffScreen(entry: BrowserTabEntry): void {
    this.detachFromWindow(entry);
    this.parkOnStage(entry);
  }

  private destroyDevTools(entry: BrowserTabEntry): void {
    const tools = entry.devToolsView;
    if (tools === null) return;
    const window = this.windowOf(entry);
    if (window !== null) this.detachDevTools(entry, window);
    const inspected = entry.view.webContents;
    if (!inspected.isDestroyed() && entry.devToolsOpen) inspected.closeDevTools();
    if (!tools.webContents.isDestroyed()) tools.webContents.close({ waitForBeforeUnload: false });
    entry.devToolsView = null;
    entry.devToolsOpen = false;
    entry.devToolsAttached = false;
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

  /** The chrome facts every publish reads off the live webContents. */
  protected liveChrome(entry: BrowserTabEntry): BrowserTabChrome {
    const contents = entry.view.webContents;
    return {
      url: contents.getURL(),
      title: contents.getTitle(),
      loading: contents.isLoading(),
      canGoBack: contents.navigationHistory.canGoBack(),
      canGoForward: contents.navigationHistory.canGoForward(),
    };
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
    // The viewport alone is not enough to make those work: the view also needs
    // a window to belong to, which is what the stage is for (VC-278).
    view.setBounds(BROWSER_DEFAULT_BOUNDS);
    const state = this.newTabState(tabId, input);
    const entry: BrowserTabEntry = {
      state,
      view,
      bounds: { ...BROWSER_DEFAULT_BOUNDS },
      parent: { kind: "detached" },
      devToolsView: null,
      devToolsOpen: false,
      devToolsAttached: false,
      console: [],
      consoleTruncated: false,
      wakeLeases: 0,
      lastInteractionAt: null,
      pictureCaptures: new Map(),
      hold: null,
    };
    this.tabs.set(tabId, entry);
    // Before the load below, not after: the first navigation is what allocates
    // the surface the compositor then hands to captures and hit-testing, and a
    // view with no window when it commits never gets one (VC-278).
    try {
      this.parkOnStage(entry);
    } catch (error) {
      // A tab that cannot be staged would be born blind — answering snapshots
      // while its captures and clicks go nowhere. Nothing has been published
      // yet, so the half-built tab leaves no trace: it is unregistered, its
      // contents are closed, and the caller is told why instead of holding an
      // id for a tab that will never work.
      this.tabs.delete(tabId);
      try {
        view.webContents.close({ waitForBeforeUnload: false });
      } catch {
        // Nothing to recover: the view never became a product tab, and the
        // error the caller needs is the staging failure re-thrown below.
      }
      throw error;
    }
    // Everything that means "the person is using this tab", stamped in one
    // place: `input-event` covers keys, clicks and the wheel, and `focus`
    // covers a tab entered by keyboard alone.
    view.webContents.on("input-event", () => {
      // CDP input on a staged Headless tab can emit the same event. Only an
      // on-screen page is reachable by the person; keep its stamp after it is
      // hidden, but do not treat the agent's own headless input as user data.
      if (entry.parent.kind === "window") entry.lastInteractionAt = this.now();
    });
    view.webContents.on("focus", () => {
      if (entry.parent.kind === "window") entry.lastInteractionAt = this.now();
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
      const window = this.windowOf(entry);
      if (window !== null) this.attachDevTools(entry, window);
      this.layout(entry);
    });
    view.webContents.on("devtools-closed", () => {
      entry.devToolsOpen = false;
      const window = this.windowOf(entry);
      if (window !== null) this.detachDevTools(entry, window);
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
      this.forgetDestroyedEntry(tabId, entry);
    });
    this.deps.publishState({ ...state });
    void view.webContents.loadURL(input.url).catch(() => undefined);
    return { ...state };
  }

  /**
   * Chromium tore this tab's WebContents down under us — a crash, a page that
   * closed itself, a renderer that exited (VC-278).
   *
   * Two rules the ordinary {@link close} path does not need. The view is NOT
   * returned to the stage: parking a dead view would add a child nothing will
   * ever remove, and Electron may refuse the call outright — off screen is a
   * place for a live tab, and this tab is not one. And the registry loses the
   * tab BEFORE any native call, so the product answer is the same whatever
   * those calls do: a `destroyed` handler that threw would leave a phantom tab
   * the model could still address, on top of reaching main's uncaught handler,
   * since nothing awaits a WebContents event.
   */
  private forgetDestroyedEntry(tabId: string, entry: BrowserTabEntry): void {
    const parent = entry.parent;
    entry.parent = { kind: "detached" };
    if (parent.kind === "window") this.emitPlane();
    this.forgetEntry(tabId, entry);
    // Every step below asks Electron about objects it has already destroyed,
    // which is the one case where these calls raise. Nobody is waiting on the
    // answer and there is nothing to retry: the tab is gone either way, and
    // the alternative to swallowing here is crashing main over a view that no
    // longer exists.
    if (parent.kind === "window") {
      const window = parent.window;
      BrowserTabHost.ignoringDestroyed("detach DevTools", () => this.detachDevTools(entry, window));
      BrowserTabHost.ignoringDestroyed("remove the page from its window", () => {
        if (!window.isDestroyed()) window.contentView.removeChildView(entry.view);
      });
    } else if (parent.kind === "stage") {
      const stage = this.stageWindow;
      BrowserTabHost.ignoringDestroyed("remove the page from its stage", () => {
        if (stage !== null && !stage.isDestroyed()) stage.contentView.removeChildView(entry.view);
      });
    }
    BrowserTabHost.ignoringDestroyed("close DevTools", () => this.destroyDevTools(entry));
  }

  /** One native teardown step for a view Chromium has already destroyed; see {@link forgetDestroyedEntry}. */
  private static ignoringDestroyed(label: string, step: () => void): void {
    try {
      step();
    } catch (error) {
      // "Object has been destroyed" is the expected answer here, and it is
      // also the end state the step was asking for. Anything else is still a
      // background teardown failure rather than a user operation, but it must
      // remain visible in diagnostics instead of disappearing silently.
      if (error instanceof Error && /object has been destroyed/i.test(error.message)) return;
      log.error("browser tab teardown step failed after destruction", { step: label, error });
    }
  }

  /** Closes and forgets one product tab without allowing page unload code to veto it. */
  close(tabId: string): void {
    const entry = this.requireTab(tabId);
    // Off both parents and onto neither: the view is about to be destroyed, so
    // returning it to the stage would only add a child the stage has to drop
    // again (VC-278).
    this.detachFromWindow(entry);
    this.takeOffStage(entry);
    this.destroyDevTools(entry);
    this.forgetEntry(tabId, entry);
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
    const onScreenIn = this.windowOf(entry);
    if (entry.devToolsOpen) {
      entry.devToolsOpen = false;
      contents.closeDevTools();
      if (onScreenIn !== null) this.detachDevTools(entry, onScreenIn);
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
    if (onScreenIn !== null) this.attachDevTools(entry, onScreenIn);
    this.layout(entry);
    try {
      // Electron still wants a mode even with custom DevTools contents. `detach`
      // means "do not dock into the inspected WebContents" here; the explicit
      // setDevToolsWebContents target above keeps it inside Volli's own view.
      contents.openDevTools({ mode: "detach", activate: true });
    } catch (error) {
      entry.devToolsOpen = false;
      if (onScreenIn !== null) this.detachDevTools(entry, onScreenIn);
      this.layout(entry);
      throw error;
    }
  }

  /**
   * Applies the renderer-measured host plane to the page and its docked DevTools.
   *
   * Exact-bound deduplication belongs here rather than in the renderer: main is
   * the only owner that sees its own initial placement and page/DevTools split.
   * A renderer cache can otherwise go stale when main lays out the native view
   * itself and silently swallow the later placement that restores the DOM plane.
   */
  setBounds(tabId: string, bounds: Rectangle): void {
    const entry = this.requireTab(tabId);
    if (sameRectangle(entry.bounds, bounds)) return;
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
   * tab entered before this host ever saw an event from it. Headless state
   * does not erase this history: a tab hidden just after typing still declines
   * until the same quiet window passes.
   *
   * JPEG through the same `capturePage` door the overlay freeze uses, for the
   * same latency reason; the store bounds how many live frames are kept.
   */
  async capturePicture(tabId: string, signal?: AbortSignal): Promise<string | null> {
    // Unlike an explicit screenshot, this is background enrichment of an
    // already completed action. A closed tab or failed camera owes no failed
    // mutation: the snapshot remains useful without a transcript thumbnail.
    const entry = this.tabs.get(tabId);
    if (entry === undefined || signal?.aborted) return null;
    const contents = entry.view.webContents;
    const generation = entry.state.generation;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abandon: (() => void) | undefined;
    try {
      // Interaction privacy is independent of the final presentation. A tab
      // hidden one moment after the person typed still carries those pixels.
      if (this.isBeingUsed(entry)) return null;
      const deadline = new Promise<null>((resolve) => {
        abandon = () => resolve(null);
        signal?.addEventListener("abort", abandon, { once: true });
        timer = setTimeout(() => {
          log.warn("browser tab preview capture timed out", { tabId });
          resolve(null);
        }, BROWSER_PREVIEW_TIMEOUT_MS);
      });
      let capture = entry.pictureCaptures.get(generation);
      // Chromium does not offer cancellation for capturePage. Deduplicate calls
      // in one generation, and allow recovery after one compositor hang. If a
      // second native request also hangs, optional previews fail closed for
      // this tab instead of creating an unbounded queue the host cannot cancel.
      if (
        capture === undefined &&
        entry.pictureCaptures.size >= BROWSER_PREVIEW_MAX_PENDING_CAPTURES
      )
        return null;
      if (capture === undefined) {
        capture = contents.capturePage();
        entry.pictureCaptures.set(generation, capture);
        const owned = capture;
        void capture.then(
          () => {
            if (entry.pictureCaptures.get(generation) === owned)
              entry.pictureCaptures.delete(generation);
          },
          () => {
            if (entry.pictureCaptures.get(generation) === owned)
              entry.pictureCaptures.delete(generation);
          },
        );
      }
      const image = await Promise.race([capture, deadline]);
      // No late writes: navigation, teardown, withdrawal, or a person starting
      // to type during capture invalidates the frame just as surely as an
      // empty image. Keep the generation from BEFORE capture, never relabel it.
      if (
        image === null ||
        signal?.aborted ||
        image.isEmpty() ||
        this.tabs.get(tabId) !== entry ||
        entry.state.generation !== generation ||
        this.isBeingUsed(entry)
      )
        return null;
      const bytes = image.toJPEG(BROWSER_CAPTURE_JPEG_QUALITY);
      if (bytes.length === 0) return null;
      return this.deps.pictures.put({
        tabId,
        generation,
        mime: "image/jpeg",
        bytes,
        ownerSessionId: entry.state.ownerSessionId,
        persist: false,
      });
    } catch (error) {
      log.warn("browser tab preview capture unavailable", { tabId, error });
      return null;
    } finally {
      clearTimeout(timer);
      if (abandon !== undefined) signal?.removeEventListener("abort", abandon);
    }
  }

  /** Whether the person has touched this tab inside the quiet window, or holds it now. */
  private isBeingUsed(entry: BrowserTabEntry): boolean {
    if (entry.view.webContents.isFocused()) return true;
    const last = entry.lastInteractionAt;
    return last !== null && this.now() - last < BROWSER_INTERACTION_QUIET_MS;
  }

  /**
   * Attaches one native page (and its DevTools) to the live app window,
   * beside whatever else is attached. Showing a tab never evicts another: each
   * on-screen pane drives its own tab's plane, and which tabs are on screen is
   * the renderer's layout to decide, not a host-wide slot's.
   */
  show(tabId: string): void {
    const entry = this.requireTab(tabId);
    // Main owns presentation (§2): a Headless tab is never attached to the app
    // window until the person reveals it, and revealing is `setPresentation`,
    // not this. Without the guard the rule would rest on renderer discipline,
    // and one stale pane mounting a Headless tab would put a Session's page on
    // screen with nothing in the UI claiming to have shown it.
    if (entry.state.presentation === "headless") {
      throw new Error("A Headless Browser Tab has no visible plane until the person shows it");
    }
    if (entry.parent.kind === "window") return;
    const window = this.deps.getWindow();
    if (window === null || window.isDestroyed()) throw new Error("Browser window is unavailable");
    // Out of the stage before into the window: a view has one parent, and
    // adding it to a second silently takes it from the first (VC-278).
    this.takeOffStage(entry);
    window.contentView.addChildView(entry.view);
    entry.parent = { kind: "window", window };
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
   *
   * A LIVE tab is returned to the stage rather than left parentless, and that
   * part can fail loudly: {@link BrowserStageUnavailableError} says the page is
   * now surfaceless, which is a fault worth a toast rather than a tab that
   * silently stops answering captures and clicks (VC-278). Tolerating an
   * unknown id is about tabs that are gone, not about broken windows.
   */
  hide(tabId: string): void {
    const entry = this.tabs.get(tabId);
    if (entry === undefined) return;
    this.goOffScreen(entry);
  }

  /**
   * Takes every plane off ONE window and parks it back on the stage, for an app
   * page that has just been replaced or died (VC-424).
   *
   * Hide is otherwise the renderer's word: its plane controller emits it from
   * React cleanup as a pane unmounts. A main-frame reload, an
   * `ELECTRON_RENDERER_URL` re-navigation, or a crashed app renderer runs no
   * cleanup at all — and a Browser Tab's `WebContentsView` is a sibling of the
   * window's own `webContents`, not a child of it, so nothing in that reset
   * detaches one. The view stays composited exactly where the dead page last
   * placed it, over a fresh app UI that has never heard of the tab and cannot
   * hide what it does not know it has.
   *
   * Deliberately the smallest act that ends that: the tabs stay open, their
   * holds stay with the Sessions that took them, their engines keep running on
   * the stage, and a pane in the new page shows the same tab again through the
   * ordinary {@link show}. Closing them here would destroy live pages — and a
   * page a person was reading — over a reload they may not even have asked for.
   *
   * Scoped to the window whose page reset, never host-wide: a second window's
   * first navigation must not sweep planes off the window still showing them.
   *
   * Every plane comes off even when one cannot be parked. The view leaves the
   * window before the stage is asked for, so the pixels over the app are gone
   * either way, and the first {@link BrowserStageUnavailableError} is raised
   * once the sweep is complete: surfacelessness is still a fault worth hearing
   * about (VC-278), but never a reason to leave the remaining pages stranded on
   * top of the new page. Returns the tabs taken off, in registry order.
   */
  parkPlanesOn(window: BrowserWindow): string[] {
    const parked: string[] = [];
    let failure: Error | null = null;
    for (const entry of this.tabs.values()) {
      if (entry.parent.kind !== "window" || entry.parent.window !== window) continue;
      parked.push(entry.state.tabId);
      try {
        // The same pair every other off-screen path uses, so the cursor overlay
        // hears the plane change (VC-239) and the page keeps a surface (VC-278).
        this.goOffScreen(entry);
      } catch (cause) {
        // The first fault is the one reported; the sweep owes the rest of the
        // planes their detach either way.
        failure ??= cause instanceof Error ? cause : new Error(String(cause), { cause });
      }
    }
    if (failure !== null) throw failure;
    return parked;
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
   * The tab's CDP wire: its app-private `webContents.debugger`. No
   * `--remote-debugging-port` is ever opened, so no other local process can
   * reach this tab, or the app's own renderer, through a loopback endpoint.
   */
  transportFor(tabId: string): CdpTransport {
    return debuggerTransport(this.webContentsOf(tabId));
  }

  /** Settles when the tab stops loading, at the bound, or on withdrawal; see `loadWaiter`. */
  waitForLoad(tabId: string, signal: AbortSignal, mode?: BrowserLoadWaitMode): Promise<void> {
    return this.loadWait(tabId, signal, mode);
  }

  /**
   * Foreground pace while agent holds are live; Chromium's own thrift once
   * none are. The engine half of {@link BrowserTabRegistry.holdAwake}, which
   * keeps one tab's engine at foreground pace while an agent drives it
   * (VC-252).
   *
   * A Browser Tab outside the visible app window is eligible for Chromium's
   * background throttling. That is the right resource policy for a tab nobody
   * is using — and exactly wrong for a tab a Session keeps driving after the
   * person switches to another workspace, where it can stall loads and starve
   * snapshots of the frames they wait on. VC-278 now parks such a tab in the
   * never-shown stage so it keeps a compositor surface; the wake hold remains
   * the separate policy that keeps its timers and animation frames moving.
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
   * What this hold is NOT is the reason captures work. An earlier version of
   * this comment read the bench as saying a hold restores
   * `Page.captureScreenshot` on a tab detached since birth; it does not, and
   * the bench never measured that combination. The tab it measured at ~100ms
   * had been ATTACHED to the window once and then detached, which is the
   * workspace-switch shape. A tab that has never been attached at all times
   * out with a hold applied before its navigation, during it, or after its
   * load settles (VC-278, `e2e/browser-headless-capture-probe.mjs`). Frames
   * need a compositor surface, a surface needs a parent window, and that is
   * the stage's job ({@link requireStage}) — not this lease's. This one buys
   * timers and animation frames, which is what it was always measured for.
   */
  protected applyWakePolicy(entry: BrowserTabEntry): void {
    const contents = entry.view.webContents;
    if (!contents.isDestroyed()) contents.setBackgroundThrottling(entry.wakeLeases === 0);
  }

  /** Closes every live view when its owning app window goes away, and the stage with them. */
  closeAll(): void {
    for (const tabId of this.tabs.keys()) this.close(tabId);
    const stage = this.stageWindow;
    this.stageWindow = null;
    if (stage !== null && !stage.isDestroyed()) stage.destroy();
  }
}

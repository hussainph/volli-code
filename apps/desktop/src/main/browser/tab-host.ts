import type {
  BrowserWindow,
  Rectangle,
  Session,
  WebContentsView,
  WebContentsViewConstructorOptions,
  WebPreferences,
} from "electron";
import type { RuntimeBrowserConsoleMessage } from "@volli/shared";

import { isBrowserStartUrl } from "../../browser-start-page";
import type { BrowserTabCreatedBy, BrowserTabState } from "../../ipc/contract";

/**
 * The provenance and product scope required to create a Browser Tab. This is
 * main-process input; renderer IPC omits `createdBy` and is forced to `user` so
 * a remote renderer cannot forge agent provenance.
 */
export interface BrowserTabCreateOptions {
  url: string;
  projectId: string;
  ticketId: string | null;
  createdBy: BrowserTabCreatedBy;
}

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
}

interface BrowserTabEntry {
  state: BrowserTabState;
  view: WebContentsView;
  bounds: Rectangle;
  devToolsView: WebContentsView | null;
  devToolsOpen: boolean;
  devToolsAttached: boolean;
  console: RuntimeBrowserConsoleMessage[];
  consoleTruncated: boolean;
  /** Live agent holds against background throttling; see {@link BrowserTabHost.holdAwake}. */
  wakeLeases: number;
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
export const BROWSER_MAX_TABS_PER_PROJECT = 32;
export const BROWSER_CONSOLE_MAX_MESSAGES = 100;
export const BROWSER_CONSOLE_MAX_CHARS = 30_000;
export const BROWSER_DEFAULT_BOUNDS: Rectangle = { x: 0, y: 0, width: 1_280, height: 720 };
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
  private attached: { entry: BrowserTabEntry; window: BrowserWindow } | null = null;

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

  private detachEntry(entry: BrowserTabEntry, window: BrowserWindow): void {
    this.detachDevTools(entry, window);
    if (!window.isDestroyed()) window.contentView.removeChildView(entry.view);
  }

  private destroyDevTools(entry: BrowserTabEntry): void {
    const tools = entry.devToolsView;
    if (tools === null) return;
    if (this.attached?.entry === entry) this.detachDevTools(entry, this.attached.window);
    const inspected = entry.view.webContents;
    if (!inspected.isDestroyed() && entry.devToolsOpen) inspected.closeDevTools();
    if (!tools.webContents.isDestroyed()) tools.webContents.close({ waitForBeforeUnload: false });
    entry.devToolsView = null;
    entry.devToolsOpen = false;
    entry.devToolsAttached = false;
  }

  private hasCapacity(projectId: string): boolean {
    let count = 0;
    for (const entry of this.tabs.values()) {
      if (entry.state.projectId === projectId) count += 1;
    }
    return count < BROWSER_MAX_TABS_PER_PROJECT;
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

  private publish(
    entry: BrowserTabEntry,
    update: Partial<
      Pick<BrowserTabState, "error" | "generation" | "loading" | "title" | "url">
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

  /** Creates one hidden tab; visibility is a separate renderer-measured act. */
  open(input: BrowserTabCreateOptions): BrowserTabState {
    if (!isAllowedBrowserTarget(input.url)) {
      throw new Error("Browser Tabs only support HTTP(S) URLs");
    }
    if (!this.hasCapacity(input.projectId)) throw new BrowserTabLimitError();
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
      url: input.url,
      title: "",
      loading: true,
      error: null,
      canGoBack: false,
      canGoForward: false,
      generation: 0,
    };
    const entry: BrowserTabEntry = {
      state,
      view,
      bounds: { ...BROWSER_DEFAULT_BOUNDS },
      devToolsView: null,
      devToolsOpen: false,
      devToolsAttached: false,
      console: [],
      consoleTruncated: false,
      wakeLeases: 0,
    };
    this.tabs.set(tabId, entry);
    view.webContents.setWindowOpenHandler(({ url }) => {
      // A hostile page can ask indefinitely; the same per-project cap used by
      // every other open door turns excess popups into ordinary denials.
      if (isAllowedBrowserUrl(url) && this.hasCapacity(input.projectId)) {
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
      if (this.attached?.entry === entry) this.attachDevTools(entry, this.attached.window);
      this.layout(entry);
    });
    view.webContents.on("devtools-closed", () => {
      entry.devToolsOpen = false;
      if (this.attached?.entry === entry) this.detachDevTools(entry, this.attached.window);
      this.layout(entry);
    });
    view.webContents.on("render-process-gone", (_event, details) => {
      this.recordConsole(entry, {
        level: "error",
        text: `Browser Tab renderer stopped: ${details.reason}`,
      });
    });
    view.webContents.on("did-navigate", (_event, url) => this.publish(entry, { url }));
    view.webContents.on("did-navigate-in-page", (_event, url, isMainFrame) => {
      if (isMainFrame) this.publish(entry, { url });
    });
    view.webContents.on("destroyed", () => {
      if (this.tabs.get(tabId) !== entry) return;
      if (this.attached?.entry === entry) {
        this.detachEntry(entry, this.attached.window);
        this.attached = null;
      }
      this.destroyDevTools(entry);
      this.tabs.delete(tabId);
      this.deps.publishClosed(tabId);
    });
    this.deps.publishState({ ...state });
    void view.webContents.loadURL(input.url).catch(() => undefined);
    return { ...state };
  }

  /** Closes and forgets one product tab without allowing page unload code to veto it. */
  close(tabId: string): void {
    const entry = this.requireTab(tabId);
    if (this.attached?.entry === entry) this.hide(tabId);
    this.destroyDevTools(entry);
    this.tabs.delete(tabId);
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
      if (this.attached?.entry === entry) this.detachDevTools(entry, this.attached.window);
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
    if (this.attached?.entry === entry) this.attachDevTools(entry, this.attached.window);
    this.layout(entry);
    try {
      // Electron still wants a mode even with custom DevTools contents. `detach`
      // means "do not dock into the inspected WebContents" here; the explicit
      // setDevToolsWebContents target above keeps it inside Volli's own view.
      contents.openDevTools({ mode: "detach", activate: true });
    } catch (error) {
      entry.devToolsOpen = false;
      if (this.attached?.entry === entry) this.detachDevTools(entry, this.attached.window);
      this.layout(entry);
      throw error;
    }
  }

  /** Applies the renderer-measured host plane to the page and its docked DevTools. */
  setBounds(tabId: string, bounds: Rectangle): void {
    const entry = this.requireTab(tabId);
    entry.bounds = { ...bounds };
    this.layout(entry);
  }

  /** Attaches exactly one selected native page (and its DevTools) to the live app window. */
  show(tabId: string): void {
    const entry = this.requireTab(tabId);
    if (this.attached?.entry === entry) return;
    if (this.attached !== null) this.detachEntry(this.attached.entry, this.attached.window);
    const window = this.deps.getWindow();
    if (window === null || window.isDestroyed()) throw new Error("Browser window is unavailable");
    window.contentView.addChildView(entry.view);
    this.attached = { entry, window };
    if (entry.devToolsOpen) this.attachDevTools(entry, window);
    this.layout(entry);
  }

  /** Detaches the named page and DevTools when its workspace surface is no longer visible. */
  hide(tabId: string): void {
    const entry = this.requireTab(tabId);
    if (this.attached?.entry !== entry) return;
    this.detachEntry(entry, this.attached.window);
    this.attached = null;
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
   * tab is shown again. The lease is the narrow door between the two:
   * throttling stays Chromium's default for every tab, and only while at
   * least one agent hold is live does this tab run unthrottled.
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

  /** Foreground pace while agent holds are live; Chromium's own thrift once none are. */
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

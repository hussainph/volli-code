import type {
  BrowserWindow,
  Rectangle,
  Session,
  WebContentsView,
  WebContentsViewConstructorOptions,
  WebPreferences,
} from "electron";
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
}

interface BrowserTabEntry {
  state: BrowserTabState;
  view: WebContentsView;
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
 * Whether a target may enter a remote Browser Tab. Keeping this decision pure
 * lets every navigation door — address bar, page redirect, and popup — enforce
 * the same HTTP(S)-only rule before Electron sees the target.
 */
export function isAllowedBrowserUrl(target: string): boolean {
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
 * Session-created tabs share only their Ticket's in-memory partition: no
 * `persist:` prefix means Chromium discards its credentials with this launch,
 * while the Ticket key prevents one Ticket from inheriting another's state.
 */
export function browserSessionPartition(input: {
  createdBy: BrowserTabCreatedBy;
  projectId: string;
  ticketId: string | null;
}): string {
  if (input.createdBy === "user") return "persist:volli-browser:user";
  if (input.ticketId === null) {
    throw new Error("Session-created Browser Tabs require a Ticket scope");
  }
  return `volli-browser:ticket:${encodeURIComponent(input.projectId)}:${encodeURIComponent(input.ticketId)}`;
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

  private publish(
    entry: BrowserTabEntry,
    update: Partial<Pick<BrowserTabState, "generation" | "loading" | "title" | "url">> = {},
  ): void {
    const contents = entry.view.webContents;
    entry.state = {
      ...entry.state,
      url: contents.getURL() || entry.state.url,
      title: contents.getTitle(),
      loading: contents.isLoading(),
      canGoBack: contents.navigationHistory.canGoBack(),
      canGoForward: contents.navigationHistory.canGoForward(),
      ...update,
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
    if (!isAllowedBrowserUrl(input.url)) {
      throw new Error("Browser Tabs only support HTTP(S) URLs");
    }
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
    const state: BrowserTabState = {
      tabId,
      projectId: input.projectId,
      ticketId: input.ticketId,
      createdBy: input.createdBy,
      url: input.url,
      title: "",
      loading: true,
      canGoBack: false,
      canGoForward: false,
      generation: 0,
    };
    const entry = { state, view };
    this.tabs.set(tabId, entry);
    view.webContents.setWindowOpenHandler(({ url }) => {
      if (isAllowedBrowserUrl(url)) this.open({ ...input, url });
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
        generation: entry.state.generation + 1,
        url: details.url,
      });
    });
    view.webContents.on("did-start-loading", () => this.publish(entry, { loading: true }));
    view.webContents.on("did-stop-loading", () => this.publish(entry, { loading: false }));
    view.webContents.on("page-title-updated", (_event, title) => {
      this.publish(entry, { title });
    });
    view.webContents.on("did-navigate", (_event, url) => this.publish(entry, { url }));
    view.webContents.on("did-navigate-in-page", (_event, url, isMainFrame) => {
      if (isMainFrame) this.publish(entry, { url });
    });
    view.webContents.on("destroyed", () => {
      if (this.tabs.get(tabId) !== entry) return;
      if (this.attached?.entry === entry) {
        if (!this.attached.window.isDestroyed()) {
          this.attached.window.contentView.removeChildView(entry.view);
        }
        this.attached = null;
      }
      this.tabs.delete(tabId);
    });
    this.deps.publishState({ ...state });
    void view.webContents.loadURL(input.url).catch(() => undefined);
    return { ...state };
  }

  /** Closes and forgets one product tab without allowing page unload code to veto it. */
  close(tabId: string): void {
    const entry = this.requireTab(tabId);
    if (this.attached?.entry === entry) this.hide(tabId);
    this.tabs.delete(tabId);
    entry.view.webContents.close({ waitForBeforeUnload: false });
  }

  /** Navigates one opaque tab after applying the same HTTP(S) policy pages face. */
  navigate(tabId: string, url: string): BrowserTabState {
    if (!isAllowedBrowserUrl(url)) {
      throw new Error("Browser Tabs only support HTTP(S) URLs");
    }
    const entry = this.requireTab(tabId);
    void entry.view.webContents.loadURL(url).catch(() => undefined);
    return { ...entry.state };
  }

  /** Moves one tab backward when Chromium reports a preceding history entry. */
  back(tabId: string): BrowserTabState {
    const entry = this.requireTab(tabId);
    if (entry.view.webContents.navigationHistory.canGoBack()) {
      entry.view.webContents.navigationHistory.goBack();
    }
    return { ...entry.state };
  }

  /** Moves one tab forward when Chromium reports a following history entry. */
  forward(tabId: string): BrowserTabState {
    const entry = this.requireTab(tabId);
    if (entry.view.webContents.navigationHistory.canGoForward()) {
      entry.view.webContents.navigationHistory.goForward();
    }
    return { ...entry.state };
  }

  /** Reloads one tab without exposing a general WebContents operation surface. */
  reload(tabId: string): BrowserTabState {
    const entry = this.requireTab(tabId);
    entry.view.webContents.reload();
    return { ...entry.state };
  }

  /** Opens Chromium DevTools for exactly the named tab in its own detached window. */
  openDevTools(tabId: string): void {
    this.requireTab(tabId).view.webContents.openDevTools({ mode: "detach" });
  }

  /** Applies the renderer-measured host plane to the native child view. */
  setBounds(tabId: string, bounds: Rectangle): void {
    this.requireTab(tabId).view.setBounds(bounds);
  }

  /** Attaches exactly one selected native view to the live app window. */
  show(tabId: string): void {
    const entry = this.requireTab(tabId);
    if (this.attached?.entry === entry) return;
    if (this.attached !== null && !this.attached.window.isDestroyed()) {
      this.attached.window.contentView.removeChildView(this.attached.entry.view);
    }
    const window = this.deps.getWindow();
    if (window === null || window.isDestroyed()) throw new Error("Browser window is unavailable");
    window.contentView.addChildView(entry.view);
    this.attached = { entry, window };
  }

  /** Detaches the named view when its workspace surface is no longer visible. */
  hide(tabId: string): void {
    const entry = this.requireTab(tabId);
    if (this.attached?.entry !== entry) return;
    if (!this.attached.window.isDestroyed()) {
      this.attached.window.contentView.removeChildView(entry.view);
    }
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

import type {
  BaseWindow,
  BrowserWindow,
  Session,
  WebContentsView,
  WebContentsViewConstructorOptions,
} from "electron";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { BROWSER_START_URL } from "../../browser-start-page";
import {
  BROWSER_CONSOLE_MAX_CHARS,
  BROWSER_DEFAULT_BOUNDS,
  BROWSER_INTERACTION_QUIET_MS,
  BROWSER_MAX_TABS_PER_PROJECT,
  BROWSER_MAX_TABS_PER_SESSION,
  BROWSER_TITLE_MAX_CHARS,
  BROWSER_URL_MAX_CHARS,
  BrowserSessionTabLimitError,
  BrowserStageUnavailableError,
  BrowserTabHost,
  BrowserTabLimitError,
  browserRemoteWebPreferences,
  browserSessionPartition,
  browserSurfaceBounds,
  isAllowedBrowserTarget,
  isAllowedBrowserUrl,
} from "./tab-host";
import { BrowserPictureStore, type BrowserPictureRecord } from "./picture-store";

class FakeSession {
  permissionRequestHandler:
    | ((permission: string, callback: (granted: boolean) => void) => void)
    | null = null;
  permissionCheckHandler: (() => boolean) | null = null;
  listeners = new Map<string, (...args: unknown[]) => void>();

  setPermissionRequestHandler(
    handler: (_contents: unknown, permission: string, callback: (granted: boolean) => void) => void,
  ): void {
    this.permissionRequestHandler = (permission, callback) => handler({}, permission, callback);
  }

  setPermissionCheckHandler(handler: () => boolean): void {
    this.permissionCheckHandler = handler;
  }

  on(event: string, listener: (...args: unknown[]) => void): void {
    this.listeners.set(event, listener);
  }
}

class FakeWebContents {
  url = "";
  title = "";
  loading = false;
  listeners = new Map<string, ((...args: unknown[]) => void)[]>();
  windowOpenHandler: ((details: { url: string }) => { action: "deny" | "allow" }) | null = null;
  loadURL = vi.fn(async (url: string) => {
    nativeOrder.push(`load:${url}`);
    this.url = url;
  });
  close = vi.fn();
  reload = vi.fn();
  devToolsOpened = false;
  openDevTools = vi.fn((_options?: { mode?: string; activate?: boolean }) => {
    this.devToolsOpened = true;
    this.emit("devtools-opened");
  });
  closeDevTools = vi.fn(() => {
    this.devToolsOpened = false;
    this.emit("devtools-closed");
  });
  setDevToolsWebContents = vi.fn();
  setBackgroundThrottling = vi.fn();
  // The host encodes JPEG, so the fake answers the same door: a NativeImage
  // whose `toJPEG` returns the bytes the frame should carry. `isEmpty` is the
  // real one's answer for a view with no surface — the 0x0 image Chromium hands
  // back rather than failing (VC-278) — so a test can ask for that too.
  captureBytes = "page";
  capturePage = vi.fn(async () => ({
    toDataURL: () => `data:image/png;base64,${this.captureBytes}`,
    toJPEG: () => Buffer.from(this.captureBytes),
    isEmpty: () => this.captureBytes.length === 0,
  }));
  zoomFactor = 1;
  getZoomFactor(): number {
    return this.zoomFactor;
  }
  isDevToolsOpened(): boolean {
    return this.devToolsOpened;
  }
  isDestroyed(): boolean {
    return false;
  }
  focused = false;
  isFocused(): boolean {
    return this.focused;
  }
  navigationHistory = {
    canGoBack: vi.fn(() => false),
    canGoForward: vi.fn(() => false),
    goBack: vi.fn(),
    goForward: vi.fn(),
  };

  on(event: string, listener: (...args: unknown[]) => void): void {
    const listeners = this.listeners.get(event) ?? [];
    listeners.push(listener);
    this.listeners.set(event, listeners);
  }

  emit(event: string, ...args: unknown[]): void {
    for (const listener of this.listeners.get(event) ?? []) listener(...args);
  }

  setWindowOpenHandler(handler: (details: { url: string }) => { action: "deny" | "allow" }): void {
    this.windowOpenHandler = handler;
  }

  getURL(): string {
    return this.url;
  }

  getTitle(): string {
    return this.title;
  }

  isLoading(): boolean {
    return this.loading;
  }
}

class FakeView {
  readonly webContents = new FakeWebContents();
  setBounds = vi.fn();
}

const fakeWindow = {
  isDestroyed: () => false,
  contentView: {
    addChildView: vi.fn(),
    removeChildView: vi.fn(),
  },
};

/**
 * The off-screen stage (VC-278). Never shown, so a test that finds a view here
 * is finding a tab the person cannot see — which is the whole point of it.
 *
 * One instance per `createStageWindow` call, all of them kept in {@link stages}
 * so a test can tell "one stage shared by every tab" from "a stage each", and
 * can watch a destroyed stage be rebuilt.
 */
class FakeStage {
  destroyed = false;
  contentView = {
    addChildView: vi.fn(() => {
      nativeOrder.push("stage-add");
    }),
    removeChildView: vi.fn(),
  };
  destroy = vi.fn(() => {
    this.destroyed = true;
  });

  isDestroyed(): boolean {
    return this.destroyed;
  }
}

/** How the next stage is built, so a test can model Electron failing to give one. */
let stageBuilds: "ok" | "throws" | "born-destroyed";
let stages: FakeStage[];

function newStage(): BaseWindow {
  if (stageBuilds === "throws") throw new Error("no window server");
  const stage = new FakeStage();
  if (stageBuilds === "born-destroyed") stage.destroyed = true;
  stages.push(stage);
  return stage as unknown as BaseWindow;
}

/** The stage built first, which is the one every tab shares. */
const stage = (index = 0): FakeStage => stages[index]!;

/**
 * Native parenting and navigation in the order they happened, so a test can
 * prove a tab was staged BEFORE its first load rather than merely staged at
 * some point (VC-278): a view with no window when its first navigation commits
 * never gets a compositor surface.
 */
let nativeOrder: string[];

let views: FakeView[];
let viewOptions: WebContentsViewConstructorOptions[];
let sessions: Map<string, FakeSession>;
let published: unknown[];
let host: BrowserTabHost;
let pictures: BrowserPictureStore;
let persisted: Map<string, { bytes: Uint8Array; record: BrowserPictureRecord }>;
/** The host's clock, so the interaction quiet window can be moved deliberately. */
let clock: number;

beforeEach(() => {
  vi.clearAllMocks();
  views = [];
  viewOptions = [];
  sessions = new Map();
  published = [];
  persisted = new Map();
  stages = [];
  stageBuilds = "ok";
  nativeOrder = [];
  clock = 1_000;
  let nextId = 0;
  let nextPicture = 0;
  pictures = new BrowserPictureStore({
    createId: () => `picture-${++nextPicture}`,
    now: () => 1_000,
    persist: {
      write: (bytes, record) => persisted.set(record.id, { bytes, record }),
      read: (id) => {
        const held = persisted.get(id);
        return held === undefined ? null : { bytes: held.bytes, mime: held.record.mime };
      },
      list: () => [...persisted.values()].map((one) => one.record),
      remove: (id) => void persisted.delete(id),
    },
  });
  host = new BrowserTabHost({
    pictures,
    now: () => clock,
    createId: () => `opaque-${++nextId}`,
    createView: (options: WebContentsViewConstructorOptions) => {
      viewOptions.push(options);
      const view = new FakeView();
      views.push(view);
      return view as unknown as WebContentsView;
    },
    fromPartition: (partition: string) => {
      let isolated = sessions.get(partition);
      if (isolated === undefined) {
        isolated = new FakeSession();
        sessions.set(partition, isolated);
      }
      return isolated as unknown as Session;
    },
    getWindow: () => fakeWindow as unknown as BrowserWindow,
    createStageWindow: newStage,
    publishState: (event) => published.push(event),
    publishClosed: (tabId) => published.push({ closedTabId: tabId }),
  });
});

describe("browserSessionPartition", () => {
  it("keeps personal tabs in a persistent browser-only profile", () => {
    expect(
      browserSessionPartition({
        createdBy: "user",
        projectId: "project-1",
        ticketId: null,
      }),
    ).toBe("persist:volli-browser:user");
  });

  it("isolates session-created tabs in credentialless per-Ticket or per-Project partitions", () => {
    expect(
      browserSessionPartition({
        createdBy: "session",
        projectId: "project/one",
        ticketId: "ticket:42",
      }),
    ).toBe("volli-browser:ticket:project%2Fone:ticket%3A42");
    expect(
      browserSessionPartition({
        createdBy: "session",
        projectId: "project/one",
        ticketId: null,
      }),
    ).toBe("volli-browser:project:project%2Fone");
  });
});

describe("isAllowedBrowserUrl", () => {
  it("admits only absolute HTTP(S) targets", () => {
    expect(isAllowedBrowserUrl("http://localhost:3000/preview")).toBe(true);
    expect(isAllowedBrowserUrl("https://example.com/docs")).toBe(true);
    expect(isAllowedBrowserUrl("/relative")).toBe(false);
  });

  it("keeps the blank start page out of reach of page-driven navigation", () => {
    // The predicate every redirect, frame and popup is measured against must
    // not widen just because the product gained a start page.
    expect(isAllowedBrowserUrl(BROWSER_START_URL)).toBe(false);
  });

  it("refuses an oversized page-owned URL before it can cross IPC or enter a model result", () => {
    expect(isAllowedBrowserUrl(`https://example.com/${"x".repeat(BROWSER_URL_MAX_CHARS)}`)).toBe(
      false,
    );
  });
});

describe("isAllowedBrowserTarget", () => {
  it("adds the blank start page to the HTTP(S) rule, and nothing else", () => {
    expect(isAllowedBrowserTarget("https://example.com/docs")).toBe(true);
    expect(isAllowedBrowserTarget(BROWSER_START_URL)).toBe(true);
    // Exact match only: `about:` is a family of privileged Chromium pages, and
    // a lookalike must not ride in on the one page this app vouches for.
    expect(isAllowedBrowserTarget("about:blank#x")).toBe(false);
    expect(isAllowedBrowserTarget("about:config")).toBe(false);
    expect(isAllowedBrowserTarget("file:///etc/passwd")).toBe(false);
  });
});

describe("browserRemoteWebPreferences", () => {
  it("sandboxes remote content without Node or a preload bridge", () => {
    const preferences = browserRemoteWebPreferences();

    expect(preferences).toEqual({
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    });
    expect(preferences).not.toHaveProperty("preload");
  });
});

describe("BrowserTabHost security", () => {
  it("applies the sandbox, default-deny permissions, and download blocking to its isolated Session", () => {
    host.open({
      url: "https://example.com",
      projectId: "project-1",
      ticketId: null,
      createdBy: "user",
    });

    const isolated = sessions.get("persist:volli-browser:user");
    expect(viewOptions[0]?.webPreferences).toMatchObject({
      session: isolated,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    });
    expect(viewOptions[0]?.webPreferences).not.toHaveProperty("preload");

    const permissionAnswer = vi.fn();
    isolated?.permissionRequestHandler?.("geolocation", permissionAnswer);
    expect(permissionAnswer).toHaveBeenCalledWith(false);
    expect(isolated?.permissionCheckHandler?.()).toBe(false);

    const downloadEvent = { preventDefault: vi.fn() };
    isolated?.listeners.get("will-download")?.(downloadEvent, {}, {});
    expect(downloadEvent.preventDefault).toHaveBeenCalledOnce();
  });

  it("denies every window.open while turning an HTTP(S) popup into a managed sibling tab", () => {
    host.open({
      url: "https://example.com",
      projectId: "project-1",
      ticketId: "ticket-1",
      createdBy: "user",
    });
    const handler = views[0]?.webContents.windowOpenHandler;

    expect(handler?.({ url: "file:///etc/passwd" })).toEqual({ action: "deny" });
    expect(views).toHaveLength(1);
    expect(handler?.({ url: "https://docs.example.com" })).toEqual({ action: "deny" });
    expect(views).toHaveLength(2);
    expect(host.list({ projectId: "project-1", ticketId: "ticket-1" })).toHaveLength(2);
  });

  it("caps page-driven popup creation within one project", () => {
    host.open({
      url: "https://example.com",
      projectId: "project-1",
      ticketId: null,
      createdBy: "user",
    });
    const handler = views[0]?.webContents.windowOpenHandler;
    for (let index = 1; index < BROWSER_MAX_TABS_PER_PROJECT; index += 1) {
      handler?.({ url: `https://example.com/popup-${index}` });
    }
    expect(views).toHaveLength(BROWSER_MAX_TABS_PER_PROJECT);

    expect(handler?.({ url: "https://example.com/excess" })).toEqual({ action: "deny" });
    expect(views).toHaveLength(BROWSER_MAX_TABS_PER_PROJECT);
    expect(() =>
      host.open({
        url: "https://example.com/excess",
        projectId: "project-1",
        ticketId: null,
        createdBy: "user",
      }),
    ).toThrow(`at most ${BROWSER_MAX_TABS_PER_PROJECT}`);
  });

  it("gives an agent tab's popup its opener's owner, born headless like it", () => {
    const opener = host.open({
      url: "https://example.com",
      projectId: "project-1",
      ticketId: "ticket-1",
      createdBy: "session",
      ownerSessionId: "session-a",
    });

    expect(views[0]?.webContents.windowOpenHandler?.({ url: "https://popup.example.com" })).toEqual(
      { action: "deny" },
    );

    const tabs = host.list({ projectId: "project-1", ticketId: "ticket-1" });
    expect(tabs).toHaveLength(2);
    const popup = tabs.find((tab) => tab.tabId !== opener.tabId);
    expect(popup).toMatchObject({
      createdBy: "session",
      ownerSessionId: "session-a",
      presentation: "headless",
      url: "https://popup.example.com",
    });
  });

  it("caps an agent page's popups at the Session's own allowance, not the project's", () => {
    host.open({
      url: "https://example.com/0",
      projectId: "project-1",
      ticketId: "ticket-1",
      createdBy: "session",
      ownerSessionId: "session-a",
    });
    const handler = views[0]?.webContents.windowOpenHandler;
    for (let index = 1; index < BROWSER_MAX_TABS_PER_SESSION; index += 1) {
      handler?.({ url: `https://example.com/popup-${index}` });
    }
    expect(views).toHaveLength(BROWSER_MAX_TABS_PER_SESSION);

    expect(handler?.({ url: "https://example.com/excess" })).toEqual({ action: "deny" });
    expect(views).toHaveLength(BROWSER_MAX_TABS_PER_SESSION);
    // The person's own allowance is untouched by an agent page at its cap.
    expect(() =>
      host.open({
        url: "https://person.example.com",
        projectId: "project-1",
        ticketId: "ticket-1",
        createdBy: "user",
      }),
    ).not.toThrow();
  });

  it("refuses file, JavaScript, and custom-scheme navigation from both host and page", () => {
    const tab = host.open({
      url: "https://example.com",
      projectId: "project-1",
      ticketId: null,
      createdBy: "user",
    });
    const contents = views[0]?.webContents;

    expect(() => host.navigate(tab.tabId, "file:///etc/passwd")).toThrow(
      "Browser Tabs only support HTTP(S) URLs",
    );
    expect(() => host.navigate(tab.tabId, "javascript:alert(1)")).toThrow();
    expect(() => host.navigate(tab.tabId, "volli-app://bundle/index.html")).toThrow();

    const pageNavigation = { url: "file:///etc/passwd", preventDefault: vi.fn() };
    contents?.emit("will-navigate", pageNavigation);
    expect(pageNavigation.preventDefault).toHaveBeenCalledOnce();

    const redirect = { url: "javascript:alert(1)", preventDefault: vi.fn() };
    contents?.emit("will-redirect", redirect);
    expect(redirect.preventDefault).toHaveBeenCalledOnce();

    const frameNavigation = { url: "custom://escape", preventDefault: vi.fn() };
    contents?.emit("will-frame-navigate", frameNavigation);
    expect(frameNavigation.preventDefault).toHaveBeenCalledOnce();
  });

  it("opens a blank start page for the product while refusing one from a page", () => {
    const tab = host.open({
      url: BROWSER_START_URL,
      projectId: "project-1",
      ticketId: null,
      createdBy: "user",
    });

    // The product's own doors take it — this is what "New Browser Tab" opens.
    expect(tab.url).toBe(BROWSER_START_URL);
    expect(views[0]?.webContents.loadURL).toHaveBeenCalledWith(BROWSER_START_URL);
    expect(() => host.navigate(tab.tabId, BROWSER_START_URL)).not.toThrow();

    // A page's doors do not: neither a popup nor a redirect may reach it.
    const before = views.length;
    expect(views[0]?.webContents.windowOpenHandler?.({ url: BROWSER_START_URL })).toEqual({
      action: "deny",
    });
    expect(views).toHaveLength(before);

    const redirect = { url: BROWSER_START_URL, preventDefault: vi.fn() };
    views[0]?.webContents.emit("will-redirect", redirect);
    expect(redirect.preventDefault).toHaveBeenCalledOnce();
  });
});

describe("BrowserTabHost state", () => {
  it("pushes chrome state and bumps a tab-local generation on each main-frame navigation", () => {
    const tab = host.open({
      url: "https://example.com",
      projectId: "project-1",
      ticketId: null,
      createdBy: "user",
    });
    const contents = views[0]?.webContents;
    if (contents === undefined) throw new Error("expected WebContents");
    contents.url = "https://example.com/docs";
    contents.title = "Documentation";
    contents.loading = true;
    contents.navigationHistory.canGoBack.mockReturnValue(true);

    contents.emit("did-start-navigation", {
      url: contents.url,
      isMainFrame: true,
      isSameDocument: false,
    });

    expect(published.at(-1)).toEqual({
      ...tab,
      url: "https://example.com/docs",
      title: "Documentation",
      loading: true,
      canGoBack: true,
      generation: 1,
    });

    contents.emit("did-start-navigation", {
      url: "https://example.com/docs#api",
      isMainFrame: true,
      isSameDocument: true,
    });
    expect(published.at(-1)).toMatchObject({
      url: "https://example.com/docs#api",
      generation: 2,
    });

    contents.title = "API Reference";
    contents.navigationHistory.canGoForward.mockReturnValue(true);
    contents.emit("page-title-updated", {}, "API Reference");
    expect(published.at(-1)).toMatchObject({
      title: "API Reference",
      canGoForward: true,
      generation: 2,
    });

    contents.loading = false;
    contents.emit("did-stop-loading");
    expect(published.at(-1)).toMatchObject({ loading: false, generation: 2 });
  });

  it("bounds page-owned titles and publishes a main-frame load failure until navigation retries", () => {
    const tab = host.open({
      url: "https://example.com",
      projectId: "project-1",
      ticketId: null,
      createdBy: "user",
    });
    const contents = views[0]?.webContents;
    if (contents === undefined) throw new Error("expected WebContents");

    contents.title = `  hostile\n${"x".repeat(BROWSER_TITLE_MAX_CHARS)}  `;
    contents.emit("page-title-updated", {}, contents.title);
    const titled = published.at(-1) as { title: string };
    expect(titled.title).not.toContain("\n");
    expect(titled.title.length).toBe(BROWSER_TITLE_MAX_CHARS);

    contents.loading = false;
    contents.emit("did-fail-load", {}, -105, "NAME_NOT_RESOLVED", tab.url, true);
    expect(published.at(-1)).toMatchObject({
      error: "Could not load page: NAME_NOT_RESOLVED",
      loading: false,
    });

    contents.emit("did-start-navigation", {
      url: "https://example.com/retry",
      isMainFrame: true,
    });
    expect(published.at(-1)).toMatchObject({ error: null });
  });

  it("invalidates existing refs synchronously when product navigation is requested", () => {
    const tab = host.open({
      url: "https://example.com",
      projectId: "project-1",
      ticketId: null,
      createdBy: "user",
    });

    const moved = host.navigate(tab.tabId, "https://example.com/next");

    expect(moved).toMatchObject({
      url: "https://example.com/next",
      loading: true,
      error: null,
      generation: tab.generation + 1,
    });
  });

  it("records console evidence from tab creation under one byte bound", () => {
    const tab = host.open({
      url: "https://example.com",
      projectId: "project-1",
      ticketId: null,
      createdBy: "user",
    });
    const contents = views[0]?.webContents;

    contents?.emit("console-message", {}, 1, "booted");
    contents?.emit("console-message", {}, 2, "x".repeat(BROWSER_CONSOLE_MAX_CHARS + 1));

    const record = host.consoleOf(tab.tabId);
    expect(record.messages).toEqual([
      { level: "warn", text: "x".repeat(BROWSER_CONSOLE_MAX_CHARS) },
    ]);
    expect(record.truncated).toBe(true);
  });

  it("publishes a crashed page renderer as the tab's error, in Volli's words, until the next navigation", () => {
    const tab = host.open({
      url: "https://example.com",
      projectId: "project-1",
      ticketId: "ticket-1",
      createdBy: "session",
      ownerSessionId: "session-a",
    });

    views[0]!.webContents.emit("render-process-gone", {}, { reason: "crashed" });

    expect(published.at(-1)).toMatchObject({
      tabId: tab.tabId,
      error: "The page stopped responding and its renderer exited (crashed).",
      loading: false,
    });
    // The console keeps the evidence for the model's next read too.
    expect(host.consoleOf(tab.tabId).messages.at(-1)?.text).toContain("crashed");

    host.navigate(tab.tabId, "https://example.com/again");
    expect(published.at(-1)).toMatchObject({ error: null });
  });

  it("does not surface Chromium aborting an older load for a newer navigation", () => {
    host.open({
      url: "https://example.com",
      projectId: "project-1",
      ticketId: null,
      createdBy: "user",
    });
    const before = published.length;

    views[0]?.webContents.emit("did-fail-load", {}, -3, "ABORTED", "https://example.com", true);

    expect(published).toHaveLength(before);
  });
});

describe("browserSurfaceBounds", () => {
  it("keeps the page whole when tools are closed and docks them below it when open", () => {
    const bounds = { x: 12, y: 48, width: 800, height: 600 };

    expect(browserSurfaceBounds(bounds, false)).toEqual({ page: bounds, devTools: null });
    expect(browserSurfaceBounds(bounds, true)).toEqual({
      page: { x: 12, y: 48, width: 800, height: 347 },
      devTools: { x: 12, y: 396, width: 800, height: 252 },
    });
    expect(browserSurfaceBounds({ ...bounds, height: 1 }, true)).toEqual({
      page: { ...bounds, height: 1 },
      devTools: null,
    });
  });
});

describe("BrowserTabHost navigation controls", () => {
  it("drives history and reload through the opaque tab id", () => {
    const tab = host.open({
      url: "https://example.com",
      projectId: "project-1",
      ticketId: null,
      createdBy: "user",
    });
    const contents = views[0]?.webContents;
    contents?.navigationHistory.canGoBack.mockReturnValue(true);
    contents?.navigationHistory.canGoForward.mockReturnValue(true);

    host.back(tab.tabId);
    host.forward(tab.tabId);
    host.reload(tab.tabId);

    expect(contents?.navigationHistory.goBack).toHaveBeenCalledOnce();
    expect(contents?.navigationHistory.goForward).toHaveBeenCalledOnce();
    expect(contents?.reload).toHaveBeenCalledOnce();
  });

  it("toggles custom DevTools inside the selected Browser plane", () => {
    const tab = host.open({
      url: "https://example.com",
      projectId: "project-1",
      ticketId: null,
      createdBy: "user",
    });
    const page = views[0];
    if (page === undefined) throw new Error("expected page view");
    host.show(tab.tabId);

    host.toggleDevTools(tab.tabId);

    const tools = views[1];
    if (tools === undefined) throw new Error("expected DevTools view");
    expect(page.webContents.setDevToolsWebContents).toHaveBeenCalledWith(tools.webContents);
    expect(page.webContents.openDevTools).toHaveBeenCalledWith({ mode: "detach", activate: true });
    expect(fakeWindow.contentView.addChildView).toHaveBeenCalledWith(tools);
    expect(page.setBounds).toHaveBeenLastCalledWith({ x: 0, y: 0, width: 1280, height: 417 });
    expect(tools.setBounds).toHaveBeenLastCalledWith({ x: 0, y: 418, width: 1280, height: 302 });

    host.toggleDevTools(tab.tabId);

    expect(page.webContents.closeDevTools).toHaveBeenCalledOnce();
    expect(fakeWindow.contentView.removeChildView).toHaveBeenCalledWith(tools);
    expect(page.setBounds).toHaveBeenLastCalledWith(BROWSER_DEFAULT_BOUNDS);

    host.close(tab.tabId);
    expect(tools.webContents.close).toHaveBeenCalledWith({ waitForBeforeUnload: false });
  });
});

describe("BrowserTabHost native surface", () => {
  it("captures page and docked DevTools pixels in plane-relative positions", async () => {
    const tab = host.open({
      url: "https://example.com",
      projectId: "project-1",
      ticketId: null,
      createdBy: "user",
    });
    const bounds = { x: 12, y: 48, width: 800, height: 600 };
    host.setBounds(tab.tabId, bounds);
    host.show(tab.tabId);
    host.toggleDevTools(tab.tabId);
    const tools = views[1];
    if (tools === undefined) throw new Error("expected DevTools view");
    tools.webContents.captureBytes = "tools";

    await expect(host.capture(tab.tabId)).resolves.toEqual([
      {
        kind: "page",
        dataUrl: "data:image/jpeg;base64,cGFnZQ==",
        bounds: { x: 0, y: 0, width: 800, height: 347 },
      },
      {
        kind: "devtools",
        dataUrl: "data:image/jpeg;base64,dG9vbHM=",
        bounds: { x: 0, y: 348, width: 800, height: 252 },
      },
    ]);
    expect(views[0]?.webContents.capturePage).toHaveBeenCalledOnce();
    expect(tools.webContents.capturePage).toHaveBeenCalledOnce();
  });

  it("captures just the page when DevTools is closed, still plane-relative", async () => {
    const tab = host.open({
      url: "https://example.com",
      projectId: "project-1",
      ticketId: null,
      createdBy: "user",
    });
    // Deliberately NOT the default bounds: those start at 0,0, so a frame that
    // forgot to subtract `entry.bounds` would answer identically and the case
    // would prove nothing.
    host.setBounds(tab.tabId, { x: 40, y: 24, width: 640, height: 480 });

    await expect(host.capture(tab.tabId)).resolves.toEqual([
      {
        kind: "page",
        dataUrl: "data:image/jpeg;base64,cGFnZQ==",
        bounds: { x: 0, y: 0, width: 640, height: 480 },
      },
    ]);
  });

  it("refuses to capture a tab it does not have", async () => {
    // The renderer asks by opaque id and a tab can close mid-overlay; the
    // guarded IPC envelope turns this throw into `{ ok: false }`.
    await expect(host.capture("tab-that-never-existed")).rejects.toThrow();
  });

  it("sets renderer-measured bounds and attaches every shown tab at once, each hidden on its own", () => {
    const first = host.open({
      url: "https://one.example.com",
      projectId: "project-1",
      ticketId: null,
      createdBy: "user",
    });
    const second = host.open({
      url: "https://two.example.com",
      projectId: "project-1",
      ticketId: "ticket-1",
      createdBy: "session",
      ownerSessionId: "session-a",
    });
    const bounds = { x: 12, y: 48, width: 800, height: 600 };
    // The person showed it: an agent tab has no plane before that (§2).
    host.setPresentation(second.tabId, "preview");

    host.setBounds(first.tabId, bounds);
    host.show(first.tabId);
    // A shown agent tab beside the person's own browser pane: two native views
    // on screen together (VC-238), where the host used to keep one slot and a
    // second show silently evicted the first — the split-view fight.
    host.show(second.tabId);
    host.show(second.tabId);
    expect(fakeWindow.contentView.addChildView.mock.calls).toEqual([[views[0]], [views[1]]]);
    expect(fakeWindow.contentView.removeChildView).not.toHaveBeenCalled();

    host.hide(second.tabId);
    expect(fakeWindow.contentView.removeChildView.mock.calls).toEqual([[views[1]]]);

    // Closing an attached tab detaches exactly that one.
    host.close(first.tabId);
    expect(views[0]?.setBounds).toHaveBeenCalledWith(bounds);
    expect(fakeWindow.contentView.removeChildView.mock.calls).toEqual([[views[1]], [views[0]]]);
  });

  it("docks and undocks DevTools for whichever attached tab opened them", () => {
    const first = host.open({
      url: "https://one.example.com",
      projectId: "project-1",
      ticketId: null,
      createdBy: "user",
    });
    const second = host.open({
      url: "https://two.example.com",
      projectId: "project-1",
      ticketId: null,
      createdBy: "user",
    });
    host.show(first.tabId);
    host.show(second.tabId);

    host.toggleDevTools(second.tabId);
    const tools = views[2]!;
    expect(fakeWindow.contentView.addChildView).toHaveBeenCalledWith(tools);

    host.hide(second.tabId);
    expect(fakeWindow.contentView.removeChildView.mock.calls).toEqual([[tools], [views[1]]]);
    // The first tab is untouched by the second's hide.
    expect(fakeWindow.contentView.removeChildView).not.toHaveBeenCalledWith(views[0]);
  });

  it("accepts a hide for a closed tab, because its surface is already detached", () => {
    const tab = host.open({
      url: "https://example.com",
      projectId: "project-1",
      ticketId: null,
      createdBy: "user",
    });
    host.show(tab.tabId);
    host.close(tab.tabId);
    const detaches = fakeWindow.contentView.removeChildView.mock.calls.length;

    // The renderer plane controller emits this as its React surface unmounts,
    // which is exactly what closing the tab caused.
    expect(() => host.hide(tab.tabId)).not.toThrow();

    expect(fakeWindow.contentView.removeChildView.mock.calls).toHaveLength(detaches);
    expect(() => host.show(tab.tabId)).toThrow("Unknown Browser Tab");
  });

  it("accepts a hide for a tab whose WebContents died outside the close command", () => {
    const tab = host.open({
      url: "https://example.com",
      projectId: "project-1",
      ticketId: null,
      createdBy: "user",
    });
    host.show(tab.tabId);
    views[0]?.webContents.emit("destroyed");

    expect(() => host.hide(tab.tabId)).not.toThrow();
  });
});

describe("BrowserTabHost wakefulness", () => {
  it("runs the engine at foreground pace while any agent hold is live, and restores throttling at the last release", () => {
    const tab = host.open({
      url: "https://example.com",
      projectId: "project-1",
      ticketId: null,
      createdBy: "user",
    });
    const contents = views[0]!.webContents;

    const first = host.holdAwake(tab.tabId);
    const second = host.holdAwake(tab.tabId);
    expect(contents.setBackgroundThrottling.mock.calls).toEqual([[false]]);

    // Releasing one hold twice is one release: the other Session's hold stands.
    first();
    first();
    expect(contents.setBackgroundThrottling.mock.calls).toEqual([[false]]);

    second();
    expect(contents.setBackgroundThrottling.mock.calls).toEqual([[false], [true]]);
  });

  it("wakes the tab again when a fresh hold follows the last release", () => {
    // A Session that drives a tab, stops, and drives it again must get the
    // engine back. Restoring throttling has to leave the lease reusable, not
    // spent (VC-252 review).
    const tab = host.open({
      url: "https://example.com",
      projectId: "project-1",
      ticketId: null,
      createdBy: "user",
    });
    const contents = views[0]!.webContents;

    host.holdAwake(tab.tabId)();
    host.holdAwake(tab.tabId);

    expect(contents.setBackgroundThrottling.mock.calls).toEqual([[false], [true], [false]]);
  });

  it("treats a hold on an unknown tab and a release after close as nothing to do", () => {
    expect(() => host.holdAwake("missing")()).not.toThrow();

    const tab = host.open({
      url: "https://example.com",
      projectId: "project-1",
      ticketId: null,
      createdBy: "user",
    });
    const contents = views[0]!.webContents;
    const release = host.holdAwake(tab.tabId);
    host.close(tab.tabId);

    // The tab is already forgotten; a late release owes its torn-down
    // contents no throttling answer.
    expect(() => release()).not.toThrow();
    expect(contents.setBackgroundThrottling.mock.calls).toEqual([[false]]);
  });
});

describe("BrowserTabHost holds (VC-239)", () => {
  const A = { sessionId: "ses-a", attachmentId: "att-a1" };
  const B = { sessionId: "ses-b", attachmentId: "att-b1" };

  function openTab(owner = A.sessionId): string {
    return host.open({
      url: "https://example.com",
      projectId: "project-1",
      ticketId: "ticket-1",
      createdBy: "session",
      // Owned from birth (VC-238); held only when a hold is taken (VC-239).
      ownerSessionId: owner,
    }).tabId;
  }

  /** Every hold event the host emitted, in order. */
  function holdEvents(): unknown[] {
    const events: unknown[] = [];
    host.onHoldChange((event) => events.push(event));
    return events;
  }

  /** The last `heldBy` published for one tab. */
  function lastHeldBy(tabId: string): unknown {
    const states = published.filter(
      (event): event is { tabId: string; heldBy: unknown } =>
        typeof event === "object" && event !== null && "tabId" in event && event.tabId === tabId,
    );
    return states.at(-1)?.heldBy;
  }

  it("is free at birth, taken by the first write, kept by its holder, and refused to anyone else", () => {
    const tabId = openTab();
    const events = holdEvents();
    expect(lastHeldBy(tabId)).toBeNull();

    expect(host.hold(tabId, A)).toMatchObject({ kind: "held", tab: { tabId } });
    expect(lastHeldBy(tabId)).toMatchObject({ kind: "session", sessionId: "ses-a" });
    expect(host.isHeldBy(tabId, A)).toBe(true);
    expect(events).toEqual([{ kind: "taken", tabId, holder: A }]);

    // A second write from the same attachment is the same hold, not a second
    // event — the hold spans the turn, not the call.
    expect(host.hold(tabId, A)).toMatchObject({ kind: "held" });
    expect(events).toHaveLength(1);

    // Another Session, and the SAME Session on a later attachment, are both
    // somebody else: a hold belongs to the attachment that took it.
    expect(host.hold(tabId, B)).toMatchObject({
      kind: "refused",
      holder: { kind: "session", sessionId: "ses-a" },
    });
    expect(host.hold(tabId, { sessionId: "ses-a", attachmentId: "att-a2" })).toMatchObject({
      kind: "refused",
    });
    expect(host.isHeldBy(tabId, B)).toBe(false);
  });

  it("names the holder with a placeholder at once and the Session's title when it lands", async () => {
    const pending: { resolve: (name: string | null) => void } = { resolve: () => undefined };
    let nextId = 0;
    host = new BrowserTabHost({
      createId: () => `opaque-named-${++nextId}`,
      createView: () => new FakeView() as unknown as WebContentsView,
      fromPartition: () => new FakeSession() as unknown as Session,
      getWindow: () => fakeWindow as unknown as BrowserWindow,
      createStageWindow: newStage,
      publishState: (event) => published.push(event),
      publishClosed: (tabId) => published.push({ closedTabId: tabId }),
      pictures,
      sessionName: () =>
        new Promise((resolve) => {
          pending.resolve = resolve;
        }),
    });
    const tabId = openTab();
    host.hold(tabId, A);
    // A hold never waits on a name: the short id stands in.
    expect(lastHeldBy(tabId)).toMatchObject({ kind: "session", name: "Session ses-a" });

    pending.resolve("Fix checkout form");
    await Promise.resolve();
    await Promise.resolve();
    expect(lastHeldBy(tabId)).toMatchObject({ name: "Fix checkout form" });

    // A second tab held by the same Session wears the learned name at once,
    // and the name is not asked for again.
    const second = openTab();
    host.hold(second, A);
    expect(lastHeldBy(second)).toMatchObject({ name: "Fix checkout form" });
  });

  it("keeps the placeholder when the name lookup fails or answers nothing", async () => {
    const answers = [Promise.reject(new Error("engine down")), Promise.resolve("   ")];
    let nextId = 0;
    host = new BrowserTabHost({
      createId: () => `opaque-unnamed-${++nextId}`,
      createView: () => new FakeView() as unknown as WebContentsView,
      fromPartition: () => new FakeSession() as unknown as Session,
      getWindow: () => fakeWindow as unknown as BrowserWindow,
      createStageWindow: newStage,
      publishState: (event) => published.push(event),
      publishClosed: (tabId) => published.push({ closedTabId: tabId }),
      pictures,
      sessionName: () => answers.shift()!,
    });
    const first = openTab();
    host.hold(first, A);
    await Promise.resolve();
    await Promise.resolve();
    expect(lastHeldBy(first)).toMatchObject({ name: "Session ses-a" });
    // The failed lookup is not cached as a name, so the next Session asks again
    // — and a blank answer is no name either.
    const second = openTab();
    host.hold(second, B);
    await Promise.resolve();
    await Promise.resolve();
    expect(lastHeldBy(second)).toMatchObject({ name: "Session ses-b" });
  });

  /** A Session's colour alone on a fresh host: its hashed slot's hue. */
  const soloColor = (id: string): string => {
    const probe = new BrowserTabHost({
      createId: () => "probe",
      createView: () => new FakeView() as unknown as WebContentsView,
      fromPartition: () => new FakeSession() as unknown as Session,
      getWindow: () => null,
      createStageWindow: newStage,
      publishState: () => undefined,
      publishClosed: () => undefined,
      pictures,
    });
    const tabId = probe.open({
      url: "https://example.com",
      projectId: "p",
      ticketId: null,
      createdBy: "session",
      ownerSessionId: id,
    }).tabId;
    const outcome = probe.hold(tabId, { sessionId: id, attachmentId: "x" });
    return outcome.kind === "held" ? (outcome.tab.heldBy as { color: string }).color : "";
  };

  /**
   * Two ids that hash to the same slot, found by search, so a test asserts
   * the collision case rather than hoping for it.
   */
  const collidingPair = (): [string, string] => {
    const seen = new Map<string, string>();
    for (let n = 0; ; n += 1) {
      const id = `ses-${n}`;
      const color = soloColor(id);
      const earlier = seen.get(color);
      if (earlier !== undefined) return [earlier, id];
      seen.set(color, id);
    }
  };

  it("gives concurrent Sessions different colours and keeps each one's colour while it lives", () => {
    const [first, second] = collidingPair();

    const one = openTab();
    const two = openTab();
    host.hold(one, { sessionId: first, attachmentId: "1" });
    host.hold(two, { sessionId: second, attachmentId: "2" });
    const firstColor = (lastHeldBy(one) as { color: string }).color;
    const secondColor = (lastHeldBy(two) as { color: string }).color;
    expect(firstColor).not.toBe(secondColor);

    // The first Session leaves. The second keeps its colour — republished on
    // its next state push — rather than sliding into the freed slot.
    host.forgetSession({ sessionId: first, attachmentId: "1" });
    views[1]!.webContents.emit("page-title-updated", {}, "Renamed");
    expect((lastHeldBy(two) as { color: string }).color).toBe(secondColor);

    // A newcomer takes the freed slot, so the wheel is not blocked by a
    // Session nobody will see again.
    const three = openTab();
    host.hold(three, { sessionId: first, attachmentId: "3" });
    expect((lastHeldBy(three) as { color: string }).color).toBe(firstColor);
  });

  it("keeps a Session's colour while a newer attachment of it still holds, and lets go once none does", () => {
    // `displaced` arrived second and was stepped off its hashed slot, so a
    // colour re-picked from nothing would be `first`'s — the collision the
    // wheel exists to prevent.
    const [first, displaced] = collidingPair();
    const theirs = openTab();
    const one = openTab();
    const two = openTab();
    host.hold(theirs, { sessionId: first, attachmentId: "f" });
    host.hold(one, { sessionId: displaced, attachmentId: "old" });
    const color = (lastHeldBy(one) as { color: string }).color;
    expect(color).not.toBe(soloColor(displaced));
    // The Session re-attaches and holds a second tab before the old
    // attachment is torn down.
    host.hold(two, { sessionId: displaced, attachmentId: "new" });
    expect((lastHeldBy(two) as { color: string }).color).toBe(color);

    host.forgetSession({ sessionId: displaced, attachmentId: "old" });
    expect(lastHeldBy(one)).toBeNull();
    // The survivor is republished on its next state push in the colour it
    // had, not in the one it shares a hash with.
    views[2]!.webContents.emit("page-title-updated", {}, "Renamed");
    expect((lastHeldBy(two) as { color: string }).color).toBe(color);
    expect(host.heldBy(two)).toMatchObject({ kind: "session", color });

    host.forgetSession({ sessionId: displaced, attachmentId: "new" });
    expect(lastHeldBy(two)).toBeNull();
    expect(host.heldBy(two)).toBeNull();
    // Nothing of it holds, so its slot is free for a newcomer.
    const later = openTab();
    host.hold(later, { sessionId: "ses-newcomer", attachmentId: "n" });
    expect(host.heldBy(later)).not.toBeNull();
  });

  it("releases only for the holder, and treats anyone else's release as already done", () => {
    const tabId = openTab();
    host.hold(tabId, A);
    const events = holdEvents();

    host.releaseHold(tabId, B);
    expect(host.isHeldBy(tabId, A)).toBe(true);
    expect(events).toEqual([]);

    host.releaseHold(tabId, A);
    expect(lastHeldBy(tabId)).toBeNull();
    expect(events).toEqual([{ kind: "released", tabId, holder: A, why: "release" }]);

    // Releasing a free tab, or a tab that no longer exists, is the end state
    // the caller asked for.
    host.releaseHold(tabId, A);
    host.releaseHold("missing", A);
    expect(events).toHaveLength(1);

    // And the tab is free for the next writer.
    expect(host.hold(tabId, B)).toMatchObject({ kind: "held" });
  });

  it("ends every hold one attachment has at a turn end, and reports which tabs", () => {
    const one = openTab();
    const two = openTab();
    const theirs = openTab();
    host.hold(one, A);
    host.hold(two, A);
    host.hold(theirs, B);
    const events = holdEvents();

    expect(host.releaseAllHeldBy(A, "turn-end")).toEqual([one, two]);
    expect(lastHeldBy(one)).toBeNull();
    expect(lastHeldBy(two)).toBeNull();
    expect(host.isHeldBy(theirs, B)).toBe(true);
    expect(events.map((event) => (event as { why: string }).why)).toEqual(["turn-end", "turn-end"]);

    // The next turn takes the hold again on its first write.
    expect(host.hold(one, A)).toMatchObject({ kind: "held" });
  });

  it("lets the person take over, tells who was displaced, refuses the Session until hand-back, then frees it", () => {
    const tabId = openTab();
    host.hold(tabId, A);
    const events = holdEvents();

    expect(host.takeOver(tabId)).toMatchObject({
      displaced: A,
      tab: { heldBy: { kind: "person" } },
    });
    expect(events).toEqual([
      { kind: "released", tabId, holder: A, why: "takeover" },
      { kind: "person-took", tabId, displaced: A },
    ]);
    expect(host.isHeldBy(tabId, A)).toBe(false);
    expect(host.hold(tabId, A)).toEqual({ kind: "refused", holder: { kind: "person" } });
    expect(host.hold(tabId, B)).toEqual({ kind: "refused", holder: { kind: "person" } });

    // Address bar, back, forward and reload are not a takeover and not a
    // hand-back: a product navigation leaves the person's hold as it is.
    host.navigate(tabId, "https://example.com/next");
    expect(lastHeldBy(tabId)).toEqual({ kind: "person" });

    expect(host.handBack(tabId)).toMatchObject({ heldBy: null });
    expect(events.at(-1)).toEqual({ kind: "person-handed-back", tabId });
    expect(host.hold(tabId, A)).toMatchObject({ kind: "held" });
  });

  it("takes over a free tab with nobody displaced, and hands back a tab the person does not hold as a no-op", () => {
    const tabId = openTab();
    const events = holdEvents();
    expect(host.takeOver(tabId).displaced).toBeNull();
    expect(events).toEqual([{ kind: "person-took", tabId, displaced: null }]);
    // Taking over again is the same end state.
    expect(host.takeOver(tabId).displaced).toBeNull();

    host.handBack(tabId);
    host.hold(tabId, A);
    // Hand-back is the person's control: it does not end a Session's hold.
    host.handBack(tabId);
    expect(host.isHeldBy(tabId, A)).toBe(true);
    expect(
      events.filter((event) => (event as { kind: string }).kind === "person-handed-back"),
    ).toHaveLength(1);
  });

  it("relays an ask-to-leave to the holding Session and leaves the hold in place", () => {
    const tabId = openTab();
    const events = holdEvents();
    expect(host.askToLeave(tabId)).toBeNull();
    expect(events).toEqual([]);

    host.hold(tabId, A);
    expect(host.askToLeave(tabId)).toEqual(A);
    expect(events.at(-1)).toEqual({ kind: "ask-to-leave", tabId, holder: A });
    expect(host.isHeldBy(tabId, A)).toBe(true);
  });

  it("ends the hold with the tab, whether closed by the product or torn down by Chromium", () => {
    const closed = openTab();
    const gone = openTab();
    host.hold(closed, A);
    host.hold(gone, A);
    const events = holdEvents();

    host.close(closed);
    expect(events).toEqual([{ kind: "released", tabId: closed, holder: A, why: "closed" }]);
    expect(host.isHeldBy(closed, A)).toBe(false);

    views[1]!.webContents.emit("destroyed");
    expect(events.at(-1)).toEqual({ kind: "released", tabId: gone, holder: A, why: "closed" });
    // Nothing is left for a turn end to release.
    expect(host.releaseAllHeldBy(A, "turn-end")).toEqual([]);
  });

  it("stops telling a listener that unsubscribed", () => {
    const tabId = openTab();
    const events: unknown[] = [];
    const stop = host.onHoldChange((event) => events.push(event));
    host.hold(tabId, A);
    stop();
    host.releaseHold(tabId, A);
    expect(events).toHaveLength(1);
  });
});

describe("BrowserTabHost plane, for the cursor overlay (VC-239)", () => {
  const A = { sessionId: "ses-a", attachmentId: "att-a1" };

  function openTab(owner = A.sessionId): string {
    return host.open({
      url: "https://example.com",
      projectId: "project-1",
      ticketId: "ticket-1",
      createdBy: "session",
      // Owned from birth (VC-238); held only when a hold is taken (VC-239).
      ownerSessionId: owner,
    }).tabId;
  }

  it("names every tab on screen and its page rect, and 1x zoom for a tab that is gone", () => {
    const one = openTab();
    const two = openTab();
    expect(host.attachedTabIds()).toEqual([]);
    expect(host.isOnScreen(one)).toBe(false);
    expect(host.pageBoundsOf(one)).toBeNull();

    // A headless tab has no plane at all (VC-238): the person shows it first.
    host.setPresentation(one, "preview");
    host.setBounds(one, { x: 10, y: 20, width: 800, height: 600 });
    host.show(one);
    expect(host.attachedTabIds()).toEqual([one]);
    expect(host.isOnScreen(one)).toBe(true);
    expect(host.pageBoundsOf(one)).toEqual({ x: 10, y: 20, width: 800, height: 600 });
    expect(host.pageBoundsOf(two)).toBeNull();
    views[0]!.webContents.zoomFactor = 1.25;
    expect(host.zoomFactorOf(one)).toBe(1.25);
    expect(host.zoomFactorOf("missing")).toBe(1);

    // A second tab joins it rather than evicting it (VC-238): the cursor asks
    // whether ITS tab is up, not which single tab is.
    host.setPresentation(two, "tab");
    host.show(two);
    expect(host.attachedTabIds()).toEqual([one, two]);
    expect(host.isOnScreen(two)).toBe(true);

    // DevTools takes its share of the plane; the page rect shrinks with it.
    host.toggleDevTools(one);
    expect(host.pageBoundsOf(one)?.height).toBeLessThan(600);

    host.hide(one);
    expect(host.attachedTabIds()).toEqual([two]);
    expect(host.isOnScreen(one)).toBe(false);
    expect(host.pageBoundsOf(one)).toBeNull();
  });

  it("never puts a headless tab on the plane, so the cursor can never draw over one", () => {
    const headless = openTab();

    expect(() => host.show(headless)).toThrow(
      "A Headless Browser Tab has no visible plane until the person shows it",
    );
    expect(host.attachedTabIds()).toEqual([]);
    expect(host.isOnScreen(headless)).toBe(false);

    // Held, and still not drawable: a hold is not a reason to be on screen.
    host.hold(headless, A);
    expect(host.heldBy(headless)).toMatchObject({ kind: "session", sessionId: A.sessionId });
    expect(host.isOnScreen(headless)).toBe(false);
    expect(host.pageBoundsOf(headless)).toBeNull();
  });

  it("tells a plane listener about every attach, detach and layout, and stops when unsubscribed", () => {
    const one = openTab();
    const two = openTab();
    host.setPresentation(one, "preview");
    host.setPresentation(two, "tab");
    const record: string[][] = [];
    const stop = host.onPlaneChange((ids) => record.push([...ids]));

    host.show(one);
    host.setBounds(one, { x: 0, y: 0, width: 640, height: 480 });
    // A tab that is not on screen laying out is nothing to the overlay.
    host.setBounds(two, { x: 0, y: 0, width: 640, height: 480 });
    host.show(two);
    host.hide(two);
    expect(record).toEqual([[one], [one], [one, two], [one]]);

    // A close of an on-screen tab detaches it; Chromium tearing it down does too.
    host.close(one);
    host.show(two);
    views[1]!.webContents.emit("destroyed");
    expect(record.slice(4)).toEqual([[], [two], []]);

    stop();
    const third = openTab();
    host.setPresentation(third, "preview");
    host.show(third);
    expect(record).toHaveLength(7);
  });

  it("answers the holder for the overlay's label, or null", () => {
    const one = openTab();
    expect(host.heldBy(one)).toBeNull();
    expect(host.heldBy("missing")).toBeNull();
    host.hold(one, { sessionId: "ses-a", attachmentId: "att-a" });
    expect(host.heldBy(one)).toMatchObject({ kind: "session", sessionId: "ses-a" });
  });
});

describe("BrowserTabHost registry", () => {
  it("creates an opaque, scoped tab and lists it only inside its project", () => {
    const opened = host.open({
      url: "http://localhost:3000",
      projectId: "project-1",
      ticketId: "ticket-1",
      createdBy: "user",
    });

    expect(opened).toMatchObject({
      tabId: "opaque-1",
      url: "http://localhost:3000",
      projectId: "project-1",
      ticketId: "ticket-1",
      createdBy: "user",
      generation: 0,
    });
    expect(views[0]?.setBounds).toHaveBeenCalledWith(BROWSER_DEFAULT_BOUNDS);
    expect(views[0]?.webContents.loadURL).toHaveBeenCalledWith("http://localhost:3000");
    expect(host.list({ projectId: "project-1" })).toEqual([opened]);
    expect(host.list({ projectId: "another-project" })).toEqual([]);
  });

  it("closes by opaque id, detaching and destroying the owned WebContents", () => {
    const tab = host.open({
      url: "https://example.com",
      projectId: "project-1",
      ticketId: null,
      createdBy: "user",
    });
    host.show(tab.tabId);

    host.close(tab.tabId);

    expect(fakeWindow.contentView.removeChildView).toHaveBeenCalledWith(views[0]);
    expect(views[0]?.webContents.close).toHaveBeenCalledWith({ waitForBeforeUnload: false });
    expect(host.list({ projectId: "project-1" })).toEqual([]);
    expect(published.at(-1)).toEqual({ closedTabId: tab.tabId });
    expect(() => host.reload(tab.tabId)).toThrow("Unknown Browser Tab");
  });

  it("closes every live view when the owning app window closes", () => {
    for (const url of ["https://one.example.com", "https://two.example.com"]) {
      host.open({ url, projectId: "project-1", ticketId: null, createdBy: "user" });
    }

    host.closeAll();

    expect(host.list({ projectId: "project-1" })).toEqual([]);
    expect(views.every((view) => view.webContents.close.mock.calls.length === 1)).toBe(true);
  });

  it("forgets a tab whose WebContents was destroyed outside the close command", () => {
    const tab = host.open({
      url: "https://example.com",
      projectId: "project-1",
      ticketId: null,
      createdBy: "user",
    });

    views[0]?.webContents.emit("destroyed");

    expect(host.list({ projectId: "project-1" })).toEqual([]);
    expect(published.at(-1)).toEqual({ closedTabId: tab.tabId });
    expect(() => host.reload(tab.tabId)).toThrow("Unknown Browser Tab");
  });
});

describe("BrowserTabHost ownership and presentation (VC-238)", () => {
  it("records which Session opened a tab and starts it headless; a person's tab is unowned and in the strip", () => {
    const agent = host.open({
      url: "https://agent.example.com",
      projectId: "project-1",
      ticketId: "ticket-1",
      createdBy: "session",
      ownerSessionId: "session-a",
    });
    const person = host.open({
      url: "https://person.example.com",
      projectId: "project-1",
      ticketId: "ticket-1",
      createdBy: "user",
    });

    expect(agent).toMatchObject({
      createdBy: "session",
      ownerSessionId: "session-a",
      presentation: "headless",
    });
    expect(person).toMatchObject({ createdBy: "user", ownerSessionId: null, presentation: "tab" });
    // Headless means the window never sees the view until a person reveals it,
    // but the page still has its real viewport for layout and screenshots.
    expect(fakeWindow.contentView.addChildView).not.toHaveBeenCalled();
    expect(views[0]?.setBounds).toHaveBeenCalledWith(BROWSER_DEFAULT_BOUNDS);
  });

  it("reveals and hides an agent tab on request, publishing the change and touching nothing the agent sees", () => {
    const tab = host.open({
      url: "https://agent.example.com",
      projectId: "project-1",
      ticketId: "ticket-1",
      createdBy: "session",
      ownerSessionId: "session-a",
    });
    views[0]!.webContents.url = "https://agent.example.com/page";
    views[0]!.webContents.emit("did-start-navigation", {
      isMainFrame: true,
      url: "https://agent.example.com/page",
    });
    const before = host.list({ projectId: "project-1" })[0]!;
    expect(before.generation).toBe(1);

    const previewed = host.setPresentation(tab.tabId, "preview");
    expect(previewed.presentation).toBe("preview");
    expect(published.at(-1)).toMatchObject({ tabId: tab.tabId, presentation: "preview" });

    const promoted = host.setPresentation(tab.tabId, "tab");
    expect(promoted.presentation).toBe("tab");

    const hidden = host.setPresentation(tab.tabId, "headless");
    expect(hidden.presentation).toBe("headless");
    // Show/Hide change where the tab is drawn and nothing else: owner, Session,
    // generation and URL are exactly what they were.
    expect(hidden).toEqual({ ...before, presentation: "headless" });
  });

  it("refuses to change a person's tab, which is always in the strip", () => {
    const person = host.open({
      url: "https://person.example.com",
      projectId: "project-1",
      ticketId: null,
      createdBy: "user",
    });

    expect(() => host.setPresentation(person.tabId, "headless")).toThrow(
      "Only a Session's Browser Tab can be hidden or previewed",
    );
    expect(host.list({ projectId: "project-1" })[0]?.presentation).toBe("tab");
  });

  it("keeps one preview per owning Session: previewing a second tab returns the first to headless", () => {
    const first = host.open({
      url: "https://one.example.com",
      projectId: "project-1",
      ticketId: null,
      createdBy: "session",
      ownerSessionId: "session-a",
    });
    const second = host.open({
      url: "https://two.example.com",
      projectId: "project-1",
      ticketId: null,
      createdBy: "session",
      ownerSessionId: "session-a",
    });
    const other = host.open({
      url: "https://three.example.com",
      projectId: "project-1",
      ticketId: null,
      createdBy: "session",
      ownerSessionId: "session-b",
    });

    host.setPresentation(first.tabId, "preview");
    host.setPresentation(other.tabId, "preview");
    host.setPresentation(second.tabId, "preview");

    const byId = new Map(host.list({ projectId: "project-1" }).map((tab) => [tab.tabId, tab]));
    expect(byId.get(first.tabId)?.presentation).toBe("headless");
    expect(byId.get(second.tabId)?.presentation).toBe("preview");
    // Another Session's preview is another chat's pinned pane; it stays.
    expect(byId.get(other.tabId)?.presentation).toBe("preview");
    // The displaced tab was published so its card can update.
    expect(published).toContainEqual(
      expect.objectContaining({ tabId: first.tabId, presentation: "headless" }),
    );
  });

  it("refuses to attach a headless tab: revealing is the person's act, and main owns the fact", () => {
    const tab = host.open({
      url: "https://agent.example.com",
      projectId: "project-1",
      ticketId: null,
      createdBy: "session",
      ownerSessionId: "session-a",
    });

    // The renderer's plane controller has no business mounting a tab nothing
    // showed. If it tries, the host is the one that says no.
    expect(() => host.show(tab.tabId)).toThrow(
      "A Headless Browser Tab has no visible plane until the person shows it",
    );
    expect(fakeWindow.contentView.addChildView).not.toHaveBeenCalled();

    host.setPresentation(tab.tabId, "preview");
    expect(() => host.show(tab.tabId)).not.toThrow();
    expect(fakeWindow.contentView.addChildView).toHaveBeenCalledTimes(1);
  });

  it("detaches a shown tab as it goes headless, without waiting for the renderer to say so", () => {
    const tab = host.open({
      url: "https://agent.example.com",
      projectId: "project-1",
      ticketId: null,
      createdBy: "session",
      ownerSessionId: "session-a",
    });
    host.setPresentation(tab.tabId, "preview");
    host.show(tab.tabId);

    host.setPresentation(tab.tabId, "headless");

    expect(fakeWindow.contentView.removeChildView).toHaveBeenCalledWith(views[0]);
    // And back onto the stage, so the tab the person just hid can still be
    // captured and clicked by the Session driving it (VC-278).
    expect(stage().contentView.addChildView).toHaveBeenLastCalledWith(views[0]);
  });
});

/**
 * The off-screen stage (VC-278): the never-shown window every Browser Tab is
 * parented to while nobody is looking at it. Without it a tab has no
 * compositor surface at all — captures never answer, clicks reach nothing —
 * while its accessibility tree reads perfectly, which is what hid the fault.
 */
describe("BrowserTabHost stage (VC-278)", () => {
  const agentTab = (index = 0) =>
    host.open({
      url: `https://agent.example.com/${index}`,
      projectId: "project-1",
      ticketId: null,
      createdBy: "session",
      ownerSessionId: "session-a",
    });

  it("parks every new tab in the off-screen stage before its first navigation", () => {
    const tab = agentTab();

    // Order is the whole point: the first navigation is what allocates the
    // surface, and a view with no window when it commits never gets one. Staged
    // after `loadURL` would look identical to every other assertion here and
    // still leave the tab uncapturable for life.
    expect(nativeOrder).toEqual(["stage-add", "load:https://agent.example.com/0"]);
    expect(stage().contentView.addChildView).toHaveBeenCalledWith(views[0]);
    expect(fakeWindow.contentView.addChildView).not.toHaveBeenCalled();
    // Staged is not shown: nothing about presentation moved.
    expect(host.list({ projectId: "project-1" })[0]?.presentation).toBe("headless");
    expect(host.isOnScreen(tab.tabId)).toBe(false);
    expect(host.attachedTabIds()).toEqual([]);
  });

  it("shares one stage across every tab that needs one", () => {
    agentTab(0);
    agentTab(1);
    agentTab(2);

    // One never-shown window holding three views, not three windows: captures
    // and input are per-WebContents, so stacking them costs nothing and a stage
    // per tab would be three windows Electron counts for `window-all-closed`.
    expect(stages).toHaveLength(1);
    expect(stage().contentView.addChildView.mock.calls).toEqual([
      [views[0]],
      [views[1]],
      [views[2]],
    ]);
  });

  it("rebuilds a stage that was destroyed behind the host's back", () => {
    agentTab(0);
    // The host still holds the reference; Electron has already torn the window
    // down. Reusing it would throw on the first `addChildView`, and skipping
    // the staging would put the new tab back in the surfaceless state this
    // ticket is about.
    stage().destroy();

    agentTab(1);

    expect(stages).toHaveLength(2);
    expect(stage(1).contentView.addChildView).toHaveBeenCalledWith(views[1]);
    expect(stage(0).contentView.addChildView).not.toHaveBeenCalledWith(views[1]);
    // And the live tab that follows uses the same replacement, not a third.
    agentTab(2);
    expect(stages).toHaveLength(2);
    expect(stage(1).contentView.addChildView).toHaveBeenCalledWith(views[2]);
  });

  it("destroys the stage with the last window, and builds another for the next tab", () => {
    agentTab(0);

    // What closing the app window does: every tab goes, and the stage with it
    // rather than outliving the app as an invisible window holding nothing.
    host.closeAll();
    expect(stage().destroy).toHaveBeenCalled();
    expect(host.list({ projectId: "project-1" })).toEqual([]);

    // Reopening the window is an ordinary thing to do on macOS, and the tab
    // opened after it needs a stage as much as the first one did.
    agentTab(1);
    expect(stages).toHaveLength(2);
    expect(stage(1).contentView.addChildView).toHaveBeenCalledWith(views[1]);
  });

  it("moves a tab between the stage and the window, never leaving it in both", () => {
    const tab = agentTab();
    host.setPresentation(tab.tabId, "preview");

    host.show(tab.tabId);
    // Out of the stage, into the window — a view has one parent, so showing has
    // to take it back before the window can adopt it.
    expect(stage().contentView.removeChildView).toHaveBeenCalledWith(views[0]);
    expect(fakeWindow.contentView.addChildView).toHaveBeenCalledWith(views[0]);
    expect(host.isOnScreen(tab.tabId)).toBe(true);

    stage().contentView.addChildView.mockClear();
    host.hide(tab.tabId);
    // Hiding returns it to the stage rather than to nowhere: off screen is a
    // place. Otherwise every hidden tab would lose its surface again.
    expect(fakeWindow.contentView.removeChildView).toHaveBeenCalledWith(views[0]);
    expect(stage().contentView.addChildView).toHaveBeenCalledWith(views[0]);
    expect(host.isOnScreen(tab.tabId)).toBe(false);

    // Showing it again is one move, not two: the stage does not keep a copy.
    stage().contentView.removeChildView.mockClear();
    host.show(tab.tabId);
    expect(stage().contentView.removeChildView.mock.calls).toEqual([[views[0]]]);
  });

  it("takes a closed tab out of the stage instead of leaving its view parented", () => {
    const tab = agentTab();

    host.close(tab.tabId);

    expect(stage().contentView.removeChildView).toHaveBeenCalledWith(views[0]);
    // And never back in: a view about to be destroyed is a child the stage
    // would only have to drop again.
    expect(stage().contentView.addChildView.mock.calls).toEqual([[views[0]]]);
  });

  it("refuses to open a tab it cannot stage, leaving nothing registered", () => {
    stageBuilds = "throws";

    // A tab with no stage would answer snapshots while its captures and clicks
    // went nowhere, which is the silent failure VC-278 is about. The caller is
    // told instead of being handed an id for a tab that will never work.
    expect(() => agentTab()).toThrow(BrowserStageUnavailableError);
    expect(host.list({ projectId: "project-1" })).toEqual([]);
    // Nothing was published for a tab that never existed, and its contents do
    // not leak: the half-built view is closed on the way out.
    expect(published).toEqual([]);
    expect(views[0]?.webContents.close).toHaveBeenCalledWith({ waitForBeforeUnload: false });

    // The next tab, once a stage can be built again, is ordinary.
    stageBuilds = "ok";
    const tab = agentTab(1);
    expect(host.list({ projectId: "project-1" }).map((one) => one.tabId)).toEqual([tab.tabId]);
    expect(stage().contentView.addChildView).toHaveBeenCalledWith(views[1]);
  });

  it("treats a stage that is born destroyed as no stage at all", () => {
    stageBuilds = "born-destroyed";

    expect(() => agentTab()).toThrow(BrowserStageUnavailableError);
    expect(host.list({ projectId: "project-1" })).toEqual([]);
    expect(stage().contentView.addChildView).not.toHaveBeenCalled();
  });

  it("tells the caller when hiding cannot return a tab to the stage", () => {
    const tab = agentTab();
    host.setPresentation(tab.tabId, "preview");
    host.show(tab.tabId);
    // The stage died while the tab was on screen, and no replacement can be
    // built — the window server is gone.
    stage().destroy();
    stageBuilds = "throws";

    expect(() => host.hide(tab.tabId)).toThrow(BrowserStageUnavailableError);

    // The page did leave the window, which is what Hide asked for; what failed
    // is the part that keeps it capturable, and that is worth saying out loud
    // rather than leaving a tab that quietly stops answering.
    expect(fakeWindow.contentView.removeChildView).toHaveBeenCalledWith(views[0]);
    expect(host.isOnScreen(tab.tabId)).toBe(false);
    expect(host.list({ projectId: "project-1" }).map((one) => one.tabId)).toEqual([tab.tabId]);
  });

  it("never returns a destroyed on-screen tab's view to the stage", () => {
    const tab = agentTab();
    host.setPresentation(tab.tabId, "preview");
    host.show(tab.tabId);
    const planes: string[][] = [];
    host.onPlaneChange((ids) => planes.push([...ids]));
    stage().contentView.addChildView.mockClear();

    // Chromium tore the WebContents down under us: a crash, or a page that
    // closed itself.
    expect(() => views[0]!.webContents.emit("destroyed")).not.toThrow();

    // Parking a dead view would add a child nothing will ever remove — and
    // Electron may refuse the call outright, which would take main's uncaught
    // handler with it since nothing awaits a WebContents event.
    expect(stage().contentView.addChildView).not.toHaveBeenCalled();
    expect(fakeWindow.contentView.removeChildView).toHaveBeenCalledWith(views[0]);
    expect(planes).toEqual([[]]);
    expect(host.list({ projectId: "project-1" })).toEqual([]);
    expect(published.at(-1)).toEqual({ closedTabId: tab.tabId });
  });

  it("takes an already-headless destroyed tab off the stage instead of leaving it parented", () => {
    const tab = agentTab();
    stage().contentView.addChildView.mockClear();

    expect(() => views[0]!.webContents.emit("destroyed")).not.toThrow();

    expect(stage().contentView.removeChildView).toHaveBeenCalledWith(views[0]);
    expect(stage().contentView.addChildView).not.toHaveBeenCalled();
    expect(host.list({ projectId: "project-1" })).toEqual([]);
    expect(published.at(-1)).toEqual({ closedTabId: tab.tabId });
  });

  it("forgets a destroyed tab even when Electron refuses to unparent its dead view", () => {
    const tab = agentTab();
    stage().contentView.removeChildView.mockImplementation(() => {
      throw new Error("Object has been destroyed");
    });

    // "Object has been destroyed" is the expected answer for a view Chromium
    // has already torn down, and it must not leave a phantom tab in the
    // registry that the model can still address.
    expect(() => views[0]!.webContents.emit("destroyed")).not.toThrow();

    expect(host.list({ projectId: "project-1" })).toEqual([]);
    expect(published.at(-1)).toEqual({ closedTabId: tab.tabId });
    expect(() => host.reload(tab.tabId)).toThrow("Unknown Browser Tab");
  });
});

describe("BrowserTabHost lifecycle (VC-238)", () => {
  const agentTab = (owner: string, ticketId: string | null, index: number) =>
    host.open({
      url: `https://agent.example.com/${owner}/${index}`,
      projectId: "project-1",
      ticketId,
      createdBy: "session",
      ownerSessionId: owner,
    });

  it("closes a Session's headless tabs when its attachment ends and leaves the ones a person has shown", () => {
    const headless = agentTab("session-a", "ticket-1", 0);
    const previewed = agentTab("session-a", "ticket-1", 1);
    const promoted = agentTab("session-a", "ticket-1", 2);
    const sibling = agentTab("session-b", "ticket-1", 0);
    host.setPresentation(previewed.tabId, "preview");
    host.setPresentation(promoted.tabId, "tab");

    const closed = host.closeHeadlessOwnedBy("session-a");

    expect(closed).toEqual([headless.tabId]);
    expect(host.list({ projectId: "project-1" }).map((tab) => tab.tabId)).toEqual([
      previewed.tabId,
      promoted.tabId,
      sibling.tabId,
    ]);
    expect(views[0]?.webContents.close).toHaveBeenCalledWith({ waitForBeforeUnload: false });
  });

  it("closes a Ticket's headless agent tabs when the Ticket is archived, whoever owned them", () => {
    const a = agentTab("session-a", "ticket-1", 0);
    const b = agentTab("session-b", "ticket-1", 0);
    const shown = agentTab("session-b", "ticket-1", 1);
    const elsewhere = agentTab("session-c", "ticket-2", 0);
    const person = host.open({
      url: "https://person.example.com",
      projectId: "project-1",
      ticketId: "ticket-1",
      createdBy: "user",
    });
    host.setPresentation(shown.tabId, "tab");

    const closed = host.closeHeadlessForTicket("ticket-1");

    expect(closed.toSorted()).toEqual([a.tabId, b.tabId].toSorted());
    expect(host.list({ projectId: "project-1" }).map((tab) => tab.tabId)).toEqual([
      shown.tabId,
      elsewhere.tabId,
      person.tabId,
    ]);
  });
});

describe("BrowserTabHost pictures (VC-238)", () => {
  const agentTab = () =>
    host.open({
      url: "https://agent.example.com",
      projectId: "project-1",
      ticketId: "ticket-1",
      createdBy: "session",
      ownerSessionId: "session-a",
    });

  it("captures a live JPEG of a headless tab into the picture store and hands back its id", async () => {
    const tab = agentTab();
    views[0]!.webContents.captureBytes = "after-click";

    const pictureId = await host.capturePicture(tab.tabId);

    expect(pictureId).toBe("picture-1");
    expect(pictures.dataUrl("picture-1")).toBe(
      `data:image/jpeg;base64,${Buffer.from("after-click").toString("base64")}`,
    );
    expect(pictures.describe("picture-1")).toMatchObject({ tabId: tab.tabId, generation: 0 });
  });

  it("does not capture while the person is interacting with a shown tab", async () => {
    const tab = agentTab();
    host.setPresentation(tab.tabId, "preview");
    views[0]!.webContents.focused = true;

    expect(await host.capturePicture(tab.tabId)).toBeNull();
    expect(views[0]!.webContents.capturePage).not.toHaveBeenCalled();

    // A shown tab nobody is touching still photographs: the person is
    // watching, not typing, and the card owes them the picture.
    views[0]!.webContents.focused = false;
    expect(await host.capturePicture(tab.tabId)).toBe("picture-1");
  });

  it("declines for a tab in the strip too, not only the pinned preview", async () => {
    const tab = agentTab();
    host.setPresentation(tab.tabId, "tab");
    views[0]!.webContents.focused = true;

    expect(await host.capturePicture(tab.tabId)).toBeNull();
    expect(views[0]!.webContents.capturePage).not.toHaveBeenCalled();
  });

  it("keeps its camera shut for a window after the person's last keystroke, then opens again", async () => {
    const tab = agentTab();
    host.setPresentation(tab.tabId, "preview");
    // Typed, then clicked Hide or another window: focus has already left, and
    // an instantaneous focus check would photograph the field they just filled.
    views[0]!.webContents.emit("input-event", { type: "keyDown" });
    views[0]!.webContents.focused = false;

    clock += BROWSER_INTERACTION_QUIET_MS - 1;
    expect(await host.capturePicture(tab.tabId)).toBeNull();

    clock += 2;
    expect(await host.capturePicture(tab.tabId)).toBe("picture-1");
  });

  it("counts a wheel or a hover as using the tab, which focus alone never reports", async () => {
    const tab = agentTab();
    host.setPresentation(tab.tabId, "preview");
    views[0]!.webContents.emit("input-event", { type: "mouseWheel" });

    expect(views[0]!.webContents.isFocused()).toBe(false);
    expect(await host.capturePicture(tab.tabId)).toBeNull();
  });

  it("photographs a headless tab however recently the page was driven, since nobody can touch it", async () => {
    const tab = agentTab();
    views[0]!.webContents.emit("input-event", { type: "keyDown" });

    expect(await host.capturePicture(tab.tabId)).toBe("picture-1");
  });

  it("declines an empty capture rather than minting a picture of nothing", async () => {
    const tab = agentTab();
    // What Chromium hands back for a view with no compositor surface: a 0x0
    // image, not a failure. Stored, it became `data:image/jpeg;base64,` in a
    // transcript card — a broken frame nobody could tell from a real one
    // (VC-278).
    views[0]!.webContents.captureBytes = "";

    expect(await host.capturePicture(tab.tabId)).toBeNull();

    // A live capture is never persisted, so the disk says nothing about this
    // either way: the store is what has to be untouched. No id was minted and
    // none was burned — the next real capture is still `picture-1`.
    expect(pictures.describe("picture-1")).toBeNull();
    expect(pictures.dataUrl("picture-1")).toBeNull();
    views[0]!.webContents.captureBytes = "real";
    expect(await host.capturePicture(tab.tabId)).toBe("picture-1");
  });

  it("refuses to keep a screenshot with no pixels, at the store's door too", () => {
    const tab = agentTab();

    expect(() => host.keepScreenshot(tab.tabId, "")).toThrow(
      "Refusing to keep an empty Browser Tab screenshot",
    );
    expect(persisted.size).toBe(0);
  });

  it("keeps a screenshot the model asked for as a persisted picture, attributed to its Session", () => {
    const tab = agentTab();
    const png = Buffer.from("png-bytes").toString("base64");

    const pictureId = host.keepScreenshot(tab.tabId, png);

    expect(pictureId).toBe("picture-1");
    expect(persisted.get("picture-1")).toEqual({
      bytes: Buffer.from("png-bytes"),
      record: {
        id: "picture-1",
        tabId: tab.tabId,
        generation: 0,
        capturedAt: 1_000,
        ownerSessionId: "session-a",
        mime: "image/png",
      },
    });
    expect(pictures.dataUrl("picture-1")).toBe(`data:image/png;base64,${png}`);
  });

  it("leaves a person's own screenshot unowned on disk, since no Session took it", () => {
    const tab = host.open({
      url: "https://person.example.com",
      projectId: "project-1",
      ticketId: null,
      createdBy: "user",
    });

    host.keepScreenshot(tab.tabId, Buffer.from("x").toString("base64"));

    expect(persisted.get("picture-1")?.record.ownerSessionId).toBeNull();
  });

  it("resolves a picture for the renderer, or nothing for an id it never minted", () => {
    const tab = agentTab();
    const id = host.keepScreenshot(tab.tabId, Buffer.from("x").toString("base64"));

    expect(host.pictureOf(id)).toMatch(/^data:image\/png;base64,/);
    expect(host.pictureOf("missing")).toBeNull();
  });
});

describe("BrowserTabHost limits (VC-238)", () => {
  const agentTab = (owner: string, index: number) =>
    host.open({
      url: `https://agent.example.com/${owner}/${index}`,
      projectId: "project-1",
      ticketId: "ticket-1",
      createdBy: "session",
      ownerSessionId: owner,
    });

  it("caps one Session's tabs with its own error, and lets another Session keep opening", () => {
    for (let index = 0; index < BROWSER_MAX_TABS_PER_SESSION; index += 1)
      agentTab("session-a", index);

    expect(() => agentTab("session-a", 99)).toThrow(BrowserSessionTabLimitError);
    expect(() => agentTab("session-a", 99)).toThrow(
      `A Session can have at most ${BROWSER_MAX_TABS_PER_SESSION} Browser Tabs open`,
    );
    expect(() => agentTab("session-b", 0)).not.toThrow();
  });

  it("counts only what the agent holds unseen: a tab the person adopted frees its place", () => {
    const tabs = [];
    for (let index = 0; index < BROWSER_MAX_TABS_PER_SESSION; index += 1) {
      tabs.push(agentTab("session-a", index));
    }
    expect(() => agentTab("session-a", 99)).toThrow(BrowserSessionTabLimitError);

    // Show and Open as tab hand a tab to the person (§6): it is theirs to
    // close and outlives the Session, so charging it to the agent's allowance
    // would let the person's own act lock the agent out.
    host.setPresentation(tabs[0]!.tabId, "preview");
    expect(() => agentTab("session-a", 98)).not.toThrow();

    host.setPresentation(tabs[1]!.tabId, "tab");
    expect(() => agentTab("session-a", 97)).not.toThrow();
    expect(() => agentTab("session-a", 96)).toThrow(BrowserSessionTabLimitError);
  });

  it("counts agent tabs apart from the person's, so agents at their cap never stop a person opening one", () => {
    // Six Sessions at their cap: 36 agent tabs in one project, past the project cap.
    for (const owner of ["a", "b", "c", "d", "e", "f"]) {
      for (let index = 0; index < BROWSER_MAX_TABS_PER_SESSION; index += 1) agentTab(owner, index);
    }
    expect(host.list({ projectId: "project-1" }).length).toBeGreaterThan(
      BROWSER_MAX_TABS_PER_PROJECT,
    );

    expect(() =>
      host.open({
        url: "https://person.example.com",
        projectId: "project-1",
        ticketId: null,
        createdBy: "user",
      }),
    ).not.toThrow();
  });

  it("still caps the person's own tabs per project, without agent tabs in the count", () => {
    agentTab("session-a", 0);
    for (let index = 0; index < BROWSER_MAX_TABS_PER_PROJECT; index += 1) {
      host.open({
        url: `https://person.example.com/${index}`,
        projectId: "project-1",
        ticketId: null,
        createdBy: "user",
      });
    }

    expect(() =>
      host.open({
        url: "https://person.example.com/one-more",
        projectId: "project-1",
        ticketId: null,
        createdBy: "user",
      }),
    ).toThrow(BrowserTabLimitError);
  });
});

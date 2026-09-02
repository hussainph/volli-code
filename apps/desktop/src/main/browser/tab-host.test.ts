import type {
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
  BROWSER_MAX_TABS_PER_PROJECT,
  BROWSER_TITLE_MAX_CHARS,
  BROWSER_URL_MAX_CHARS,
  BrowserTabHost,
  browserRemoteWebPreferences,
  browserSessionPartition,
  browserSurfaceBounds,
  isAllowedBrowserTarget,
  isAllowedBrowserUrl,
} from "./tab-host";

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
  isDevToolsOpened(): boolean {
    return this.devToolsOpened;
  }
  isDestroyed(): boolean {
    return false;
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

let views: FakeView[];
let viewOptions: WebContentsViewConstructorOptions[];
let sessions: Map<string, FakeSession>;
let published: unknown[];
let host: BrowserTabHost;

beforeEach(() => {
  vi.clearAllMocks();
  views = [];
  viewOptions = [];
  sessions = new Map();
  published = [];
  let nextId = 0;
  host = new BrowserTabHost({
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
  it("sets renderer-measured bounds and attaches only the visible tab", () => {
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
    const bounds = { x: 12, y: 48, width: 800, height: 600 };

    host.setBounds(first.tabId, bounds);
    host.show(first.tabId);
    host.show(second.tabId);
    host.hide(second.tabId);

    expect(views[0]?.setBounds).toHaveBeenCalledWith(bounds);
    expect(fakeWindow.contentView.addChildView.mock.calls).toEqual([[views[0]], [views[1]]]);
    expect(fakeWindow.contentView.removeChildView.mock.calls).toEqual([[views[0]], [views[1]]]);
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

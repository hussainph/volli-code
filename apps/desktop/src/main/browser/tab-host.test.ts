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
  BROWSER_MAX_TABS_PER_SESSION,
  BROWSER_TITLE_MAX_CHARS,
  BROWSER_URL_MAX_CHARS,
  BrowserSessionTabLimitError,
  BrowserTabHost,
  BrowserTabLimitError,
  browserRemoteWebPreferences,
  browserSessionPartition,
  browserSurfaceBounds,
  isAllowedBrowserTarget,
  isAllowedBrowserUrl,
} from "./tab-host";
import { BrowserPictureStore } from "./picture-store";

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
  setBackgroundThrottling = vi.fn();
  // The host encodes JPEG, so the fake answers the same door: a NativeImage
  // whose `toJPEG` returns the bytes the frame should carry.
  captureBytes = "page";
  capturePage = vi.fn(async () => ({
    toDataURL: () => `data:image/png;base64,${this.captureBytes}`,
    toJPEG: () => Buffer.from(this.captureBytes),
  }));
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

let views: FakeView[];
let viewOptions: WebContentsViewConstructorOptions[];
let sessions: Map<string, FakeSession>;
let published: unknown[];
let host: BrowserTabHost;
let pictures: BrowserPictureStore;
let persisted: Map<string, { bytes: Uint8Array; mime: string }>;

beforeEach(() => {
  vi.clearAllMocks();
  views = [];
  viewOptions = [];
  sessions = new Map();
  published = [];
  persisted = new Map();
  let nextId = 0;
  let nextPicture = 0;
  pictures = new BrowserPictureStore({
    createId: () => `picture-${++nextPicture}`,
    now: () => 1_000,
    persist: {
      write: (id, bytes, mime) => persisted.set(id, { bytes, mime }),
      read: (id) => (persisted.get(id) as { bytes: Uint8Array; mime: "image/png" }) ?? null,
    },
  });
  host = new BrowserTabHost({
    pictures,
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
    expect(published).toContainEqual(expect.objectContaining({ tabId: first.tabId, presentation: "headless" }));
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

    expect(closed.sort()).toEqual([a.tabId, b.tabId].sort());
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

  it("keeps a screenshot the model asked for as a persisted picture", () => {
    const tab = agentTab();
    const png = Buffer.from("png-bytes").toString("base64");

    const pictureId = host.keepScreenshot(tab.tabId, png);

    expect(pictureId).toBe("picture-1");
    expect(persisted.get("picture-1")).toEqual({ bytes: Buffer.from("png-bytes"), mime: "image/png" });
    expect(pictures.dataUrl("picture-1")).toBe(`data:image/png;base64,${png}`);
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
    for (let index = 0; index < BROWSER_MAX_TABS_PER_SESSION; index += 1) agentTab("session-a", index);

    expect(() => agentTab("session-a", 99)).toThrow(BrowserSessionTabLimitError);
    expect(() => agentTab("session-a", 99)).toThrow(
      `A Session can have at most ${BROWSER_MAX_TABS_PER_SESSION} Browser Tabs open`,
    );
    expect(() => agentTab("session-b", 0)).not.toThrow();
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

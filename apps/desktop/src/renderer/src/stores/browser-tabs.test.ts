import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { BROWSER_START_URL } from "../../../browser-start-page";
import type { BrowserTabState, BrowserTabStateEvent } from "../../../ipc/contract";
import type { BrowserApi } from "@renderer/components/browser/browser-api";
import {
  browserTabDisplayTitle,
  hydrateBrowserTabs,
  subscribeBrowserTabs,
  useBrowserTabsStore,
} from "./browser-tabs";

function tab(overrides: Partial<BrowserTabState> = {}): BrowserTabState {
  return {
    tabId: "tab-1",
    projectId: "project-1",
    ticketId: null,
    createdBy: "user",
    url: "https://volli.dev/docs",
    title: "Volli docs",
    loading: false,
    error: null,
    canGoBack: false,
    canGoForward: false,
    generation: 0,
    ...overrides,
  };
}

beforeEach(() => {
  useBrowserTabsStore.setState({ byId: {}, hydratedProjects: new Set() });
});

describe("browser tab store", () => {
  it("receives updates, removes tabs, and leaves an absent remove quiet", () => {
    const store = useBrowserTabsStore.getState();
    store.receive(tab());
    store.receive(tab({ title: "Updated" }));

    expect(useBrowserTabsStore.getState().byId["tab-1"]?.title).toBe("Updated");
    store.remove("tab-1");
    expect(useBrowserTabsStore.getState().byId).toEqual({});
    const settled = useBrowserTabsStore.getState();
    settled.remove("missing");
    expect(useBrowserTabsStore.getState()).toBe(settled);
  });

  it("reconciles one project's whole registry without touching another project", () => {
    const store = useBrowserTabsStore.getState();
    store.receive(tab({ tabId: "stale" }));
    store.receive(tab({ tabId: "other", projectId: "project-2" }));

    store.receiveProject("project-1", [tab({ tabId: "fresh" })]);

    expect(Object.keys(useBrowserTabsStore.getState().byId).toSorted()).toEqual(["fresh", "other"]);
    expect(useBrowserTabsStore.getState().hydratedProjects.has("project-1")).toBe(true);
  });

  it("hydrates only a successful main-owned listing", async () => {
    const listed = vi.fn(async () => ({ ok: true as const, tabs: [tab()] }));
    const api = { list: listed } as unknown as BrowserApi;

    await expect(hydrateBrowserTabs(api, "project-1")).resolves.toMatchObject({ ok: true });
    expect(listed).toHaveBeenCalledWith({ projectId: "project-1" });
    expect(useBrowserTabsStore.getState().byId["tab-1"]).toBeDefined();

    useBrowserTabsStore.setState({ byId: {}, hydratedProjects: new Set() });
    const failed = {
      list: async () => ({ ok: false as const, error: "offline" }),
    } as unknown as BrowserApi;
    await hydrateBrowserTabs(failed, "project-1");
    expect(useBrowserTabsStore.getState().byId).toEqual({});
    expect(useBrowserTabsStore.getState().hydratedProjects.size).toBe(0);
  });

  it("projects both state and close pushes and returns the gateway unsubscribe", () => {
    let listener: ((event: BrowserTabStateEvent) => void) | undefined;
    const unsubscribe = vi.fn();
    const api = {
      onTabState: (next: (event: BrowserTabStateEvent) => void) => {
        listener = next;
        return unsubscribe;
      },
    } as unknown as BrowserApi;

    const stop = subscribeBrowserTabs(api);
    listener?.({ tab: tab() });
    expect(useBrowserTabsStore.getState().byId["tab-1"]).toBeDefined();
    listener?.({ closedTabId: "tab-1" });
    expect(useBrowserTabsStore.getState().byId).toEqual({});
    stop();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });
});

describe("browserTabDisplayTitle", () => {
  it("prefers the page's own title, then its host", () => {
    expect(browserTabDisplayTitle(tab())).toBe("Volli docs");
    expect(browserTabDisplayTitle(tab({ title: "   " }))).toBe("volli.dev");
  });

  it("falls back safely when the host record has no hostname or is not a URL", () => {
    expect(browserTabDisplayTitle(tab({ title: "", url: "file:///tmp/example" }))).toBe(
      "file:///tmp/example",
    );
    expect(browserTabDisplayTitle(tab({ title: "", url: "not a url" }))).toBe("not a url");
    expect(browserTabDisplayTitle(tab({ title: "", url: "" }))).toBe("Browser");
  });

  it("calls a blank tab a New Tab rather than showing the scheme it runs on", () => {
    // `about:blank` reports no title and no hostname, so the host fallback
    // would otherwise put the raw start URL in the strip — the one string the
    // address bar is deliberately hiding.
    expect(browserTabDisplayTitle(tab({ url: BROWSER_START_URL, title: "" }))).toBe("New Tab");
  });

  it("keeps naming a blank tab a New Tab even if the page reports a title", () => {
    // Chromium sometimes reports `about:blank` as the title of about:blank.
    expect(browserTabDisplayTitle(tab({ url: BROWSER_START_URL, title: "about:blank" }))).toBe(
      "New Tab",
    );
  });
});

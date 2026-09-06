// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ActivityBrowse } from "@volli/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { BrowserTabState } from "../../../../ipc/contract";
import { useBrowserTabsStore } from "@renderer/stores/browser-tabs";
import type { BrowserApi } from "./browser-api";
import {
  BrowserCardHostContext,
  BrowserTabCard,
  forgetBrowserPictures,
  type BrowserCardHost,
} from "./browser-tab-card";

vi.mock("@renderer/lib/toast", () => ({ toastError: vi.fn() }));
import { toastError } from "@renderer/lib/toast";

let container: HTMLDivElement | null = null;
let root: Root | null = null;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  useBrowserTabsStore.setState({ byId: {}, hydratedProjects: new Set() });
  forgetBrowserPictures();
  vi.mocked(toastError).mockClear();
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.unstubAllGlobals();
});

function tab(overrides: Partial<BrowserTabState> = {}): BrowserTabState {
  return {
    tabId: "tab-1",
    projectId: "project-1",
    ticketId: null,
    createdBy: "session",
    ownerSessionId: "s1",
    presentation: "headless",
    url: "https://example.com/sign-in",
    title: "Sign in — Example",
    loading: false,
    error: null,
    canGoBack: false,
    canGoForward: false,
    generation: 3,
    heldBy: null,
    ...overrides,
  };
}

function facet(overrides: Partial<ActivityBrowse> = {}): ActivityBrowse {
  return {
    action: "click",
    tabId: "tab-1",
    url: "https://example.com/sign-in",
    title: "Sign in — Example",
    target: "Sign in",
    picture: null,
    errorCount: null,
    ownerSessionId: "s1",
    error: null,
    refusal: null,
    ...overrides,
  };
}

function host(overrides: Partial<BrowserApi> = {}): BrowserCardHost {
  const api = {
    setPresentation: vi.fn(async (input) => ({ ok: true, tab: tab(input) }) as const),
    close: vi.fn(async () => ({ ok: true }) as const),
    picture: vi.fn(async () => ({ ok: true, dataUrl: "data:image/jpeg;base64,cGl4" }) as const),
    ...overrides,
  } as unknown as BrowserApi;
  return {
    sessionId: "s1",
    api,
    sessionTitle: (id) => (id === "s1-child" ? "Explore the seam" : null),
  };
}

async function draw(
  card: BrowserCardHost | null,
  browse: ActivityBrowse,
  note: string | null = null,
) {
  await act(async () => {
    root?.render(
      <BrowserCardHostContext.Provider value={card}>
        <BrowserTabCard facet={browse} note={note} />
      </BrowserCardHostContext.Provider>,
    );
  });
}

const text = () => container?.textContent ?? "";
const button = (name: string) =>
  [...(container?.querySelectorAll("button") ?? [])].find((one) => one.textContent === name);

describe("BrowserTabCard", () => {
  it("shows the live tab — URL, title, owner — and offers Show, Open as tab and Close for a headless agent tab", async () => {
    useBrowserTabsStore.getState().receive(tab());
    const card = host();

    await draw(card, facet());

    expect(text()).toContain("Sign in — Example");
    expect(text()).toContain("example.com/sign-in");
    expect(text()).toContain("this Session");
    expect(button("Show")).toBeDefined();
    expect(button("Open as tab")).toBeDefined();
    expect(button("Close")).toBeDefined();
    expect(button("Hide")).toBeUndefined();

    await act(async () => button("Show")?.click());
    expect(card.api.setPresentation).toHaveBeenCalledWith({
      tabId: "tab-1",
      presentation: "preview",
    });
    await act(async () => button("Open as tab")?.click());
    expect(card.api.setPresentation).toHaveBeenCalledWith({ tabId: "tab-1", presentation: "tab" });
    await act(async () => button("Close")?.click());
    expect(card.api.close).toHaveBeenCalledWith({ tabId: "tab-1" });
  });

  it("offers Hide instead of Show once the tab is on screen, and names a child Session as the driver", async () => {
    useBrowserTabsStore
      .getState()
      .receive(tab({ presentation: "preview", ownerSessionId: "s1-child" }));
    const card = host();

    await draw(card, facet({ ownerSessionId: "s1-child" }));

    expect(text()).toContain("Explore the seam");
    expect(button("Hide")).toBeDefined();
    expect(button("Show")).toBeUndefined();
    await act(async () => button("Hide")?.click());
    expect(card.api.setPresentation).toHaveBeenCalledWith({
      tabId: "tab-1",
      presentation: "headless",
    });
  });

  it("says the tab is gone and keeps the last URL, title and picture from the transcript", async () => {
    const card = host();

    await draw(card, facet({ picture: "picture-1" }));

    expect(text()).toContain("Tab closed");
    expect(text()).toContain("Sign in — Example");
    expect(text()).toContain("example.com/sign-in");
    expect(button("Show")).toBeUndefined();
    expect(button("Close")).toBeUndefined();
    const image = container?.querySelector("img");
    expect(image?.getAttribute("src")).toBe("data:image/jpeg;base64,cGl4");
    expect(card.api.picture).toHaveBeenCalledWith({ pictureId: "picture-1" });
  });

  it("keeps a gone agent tab the Session's, rather than rendering it as the person's", async () => {
    // Nothing is in the live store: the facet is the transcript's whole memory
    // of who was driving. It only reads if the port stamped a real owner.
    await draw(host(), facet({ ownerSessionId: "s1-child" }));

    expect(text()).toContain("Explore the seam");
    expect(text()).not.toContain("Driven by you");
    expect(
      container?.querySelector("[data-browser-tab-mark]")?.getAttribute("data-browser-tab-mark"),
    ).toBe("session");
  });

  it("keeps a gone tab's load failure, so a broken page does not read as a clean one", async () => {
    await draw(host(), facet({ error: "Could not load page: ERR_NAME_NOT_RESOLVED" }));

    expect(text()).toContain("Tab closed");
    expect(text()).toContain("Could not load page: ERR_NAME_NOT_RESOLVED");
  });

  it("shows loading, a load failure, and a refusal in Volli's words, never the page's", async () => {
    useBrowserTabsStore.getState().receive(tab({ loading: true }));
    await draw(host(), facet());
    expect(text()).toContain("Loading");

    useBrowserTabsStore
      .getState()
      .receive(tab({ loading: false, error: "Could not load page: ERR_NAME_NOT_RESOLVED" }));
    await draw(host(), facet());
    expect(text()).toContain("Could not load page");

    await draw(host(), facet({ refusal: "browser.stale-ref" }), "Volli refused the browser action");
    expect(text()).toContain("browser.stale-ref");
    expect(text()).toContain("Volli refused the browser action");
  });

  it("says when a picture is no longer available, and asks main only once per picture", async () => {
    const card = host({ picture: vi.fn(async () => ({ ok: true, dataUrl: null }) as const) });
    await draw(card, facet({ picture: "picture-9" }));
    await draw(card, facet({ picture: "picture-9" }));

    expect(text()).toContain("Picture unavailable");
    expect(card.api.picture).toHaveBeenCalledTimes(1);
  });

  it("toasts a failed Show, Hide or Close rather than swallowing it", async () => {
    useBrowserTabsStore.getState().receive(tab());
    const card = host({
      setPresentation: vi.fn(async () => ({ ok: false, error: "Unknown Browser Tab" }) as const),
      close: vi.fn(async () => {
        throw new Error("gone");
      }),
    });
    await draw(card, facet());

    await act(async () => button("Show")?.click());
    expect(toastError).toHaveBeenCalledWith("Could not show Browser Tab: Unknown Browser Tab");
    await act(async () => button("Close")?.click());
    expect(toastError).toHaveBeenCalledWith("Could not close Browser Tab: gone");
  });

  it("draws the facts alone, with no actions, where no host is mounted (the lab)", async () => {
    await draw(null, facet());

    expect(text()).toContain("example.com/sign-in");
    expect(container?.querySelectorAll("button")).toHaveLength(0);
  });

  it("does not act on a person's own tab beyond closing it", async () => {
    useBrowserTabsStore
      .getState()
      .receive(tab({ createdBy: "user", ownerSessionId: null, presentation: "tab" }));
    await draw(host(), facet({ ownerSessionId: null }));

    expect(text()).toContain("you");
    expect(
      container?.querySelector("[data-browser-tab-mark]")?.getAttribute("data-browser-tab-mark"),
    ).toBe("user");
    expect(button("Show")).toBeUndefined();
    expect(button("Open as tab")).toBeUndefined();
    expect(button("Close")).toBeDefined();
  });
});

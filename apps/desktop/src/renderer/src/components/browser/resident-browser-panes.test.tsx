// @vitest-environment jsdom
import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { BrowserTabState } from "../../../../ipc/contract";
import type { BrowserApi } from "./browser-api";
import {
  browserViewportSnapshot,
  registerBrowserViewport,
  subscribeBrowserViewports,
} from "./browser-viewport-registry";
import { BrowserPaneAnchor, ResidentBrowserPanes } from "./resident-browser-panes";
import { useBrowserTabsStore } from "@renderer/stores/browser-tabs";

const { mounted, unmounted, focusHomePane, focusTicketPane } = vi.hoisted(() => ({
  mounted: vi.fn(),
  unmounted: vi.fn(),
  focusHomePane: vi.fn(),
  focusTicketPane: vi.fn(),
}));

vi.mock("@renderer/stores/workspace", () => ({
  useWorkspaceStore: { getState: () => ({ focusHomePane, focusTicketPane }) },
}));

// Keep the real chrome and native-plane controller; count their React lifetime.
vi.mock("./browser-pane", async (importOriginal) => {
  const original = await importOriginal<typeof import("./browser-pane")>();
  return {
    BrowserPane(props: React.ComponentProps<typeof original.BrowserPane>) {
      React.useEffect(() => {
        mounted(props.tab.tabId);
        return () => unmounted(props.tab.tabId);
      }, [props.tab.tabId]);
      return <original.BrowserPane {...props} />;
    },
  };
});

class TestResizeObserver {
  observe(): void {}
  disconnect(): void {}
}

function tab(overrides: Partial<BrowserTabState> = {}): BrowserTabState {
  return {
    tabId: "opaque-tab-a",
    projectId: "project-a",
    ticketId: null,
    createdBy: "user",
    ownerSessionId: null,
    presentation: "tab",
    url: "https://example.com",
    title: "Example",
    loading: false,
    error: null,
    canGoBack: false,
    canGoForward: false,
    generation: 0,
    heldBy: null,
    ...overrides,
  };
}

let host: HTMLDivElement;
let root: Root;
let api: BrowserApi;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ResizeObserver", TestResizeObserver);
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue(
    new DOMRect(40, 60, 800, 600),
  );
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(800);
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(600);
  useBrowserTabsStore.setState({ byId: {}, hydratedProjects: new Set() });
  vi.clearAllMocks();
  api = {
    setBounds: vi.fn(async () => ({ ok: true }) as const),
    show: vi.fn(async () => ({ ok: true }) as const),
    hide: vi.fn(async () => ({ ok: true }) as const),
  } as unknown as BrowserApi;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  expect(browserViewportSnapshot().size).toBe(0);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function receive(...tabs: BrowserTabState[]): void {
  act(() => {
    for (const state of tabs) useBrowserTabsStore.getState().receive(state);
  });
}

function viewport(input: Element): HTMLElement {
  return input.closest<HTMLElement>('[data-slot="terminal-viewport-box"]')!;
}

function address(): HTMLInputElement {
  return host.querySelector<HTMLInputElement>('input[placeholder="Enter a URL"]')!;
}

function renderAnchor(key: string | null, visible = true, paneId = "pane-a"): void {
  act(() => {
    root.render(
      <>
        {key !== null && (
          <div key={key} data-pane-id={paneId}>
            <BrowserPaneAnchor tabId="opaque-tab-a" visible={visible} />
          </div>
        )}
        <ResidentBrowserPanes api={api} />
      </>,
    );
  });
}

it("mounts strip tabs from every project, but never preview or headless tabs", () => {
  receive(
    tab(),
    tab({ tabId: "opaque-tab-b", projectId: "project-b", ticketId: "ticket-b" }),
    tab({ tabId: "preview", presentation: "preview" }),
    tab({ tabId: "headless", presentation: "headless" }),
  );
  renderAnchor(null);
  expect(mounted.mock.calls).toEqual([["opaque-tab-a"], ["opaque-tab-b"]]);
  const boxes = host.querySelectorAll<HTMLElement>('[data-slot="terminal-viewport-box"]');
  expect(boxes).toHaveLength(2);
  expect([...boxes].every((box) => box.style.display === "none")).toBe(true);
});

it("retains the real pane and unfinished address through area remounts and anchor handoffs", () => {
  receive(tab());
  renderAnchor("home");
  const input = address();
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  act(() => {
    setValue.call(input, "https://unfinished.example/path");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  expect(viewport(input).style.display).toBe("block");
  expect(viewport(input).style.left).toBe("40px");
  expect(viewport(input).style.width).toBe("800px");

  renderAnchor(null); // Leaving an area/project/nav surface unmounts its anchor.
  expect(viewport(input).style.display).toBe("none");
  receive(tab({ title: "Page title push" }));
  renderAnchor("ticket-remounted", true, "paired-pane");
  renderAnchor("unpaired-pane");
  expect(address()).toBe(input);
  expect(input.value).toBe("https://unfinished.example/path");
  expect(viewport(input).style.display).toBe("block");
  expect(mounted.mock.calls).toEqual([["opaque-tab-a"]]);
  expect(unmounted).not.toHaveBeenCalled();
});

it("unpublishes retained background anchors so hidden nav surfaces cannot show a viewport", async () => {
  receive(tab());
  renderAnchor("retained", false);
  const input = address();
  expect(browserViewportSnapshot().size).toBe(0);
  expect(viewport(input).style.display).toBe("none");
  expect(api.show).not.toHaveBeenCalled();

  renderAnchor("retained", true);
  await act(async () => {
    await Promise.resolve();
  });
  expect(browserViewportSnapshot().size).toBe(1);
  expect(viewport(input).style.display).toBe("block");
  renderAnchor("retained", false);
  expect(browserViewportSnapshot().size).toBe(0);
  expect(viewport(input).style.display).toBe("none");
  expect(api.hide).toHaveBeenCalledWith({ tabId: "opaque-tab-a" });
  expect(address()).toBe(input);
  expect(unmounted).not.toHaveBeenCalled();
});

it("positions native bounds before showing, including a same-size anchor handoff", () => {
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
    const box = this.closest<HTMLElement>('[data-slot="terminal-viewport-box"]');
    if (box !== null) {
      return new DOMRect(
        Number.parseFloat(box.style.left) || 0,
        Number.parseFloat(box.style.top) || 0,
        box.style.display === "none" ? 0 : 800,
        box.style.display === "none" ? 0 : 600,
      );
    }
    return new DOMRect(
      this.parentElement?.getAttribute("data-pane-id") === "right" ? 440 : 40,
      60,
      800,
      600,
    );
  });
  receive(tab());
  renderAnchor("left", true, "left");
  expect(api.setBounds).toHaveBeenLastCalledWith({
    tabId: "opaque-tab-a",
    bounds: { x: 40, y: 60, width: 800, height: 600 },
  });
  expect(vi.mocked(api.setBounds).mock.invocationCallOrder.at(-1)).toBeLessThan(
    vi.mocked(api.show).mock.invocationCallOrder.at(-1)!,
  );
  renderAnchor("right", true, "right");
  expect(api.setBounds).toHaveBeenLastCalledWith({
    tabId: "opaque-tab-a",
    bounds: { x: 440, y: 60, width: 800, height: 600 },
  });
  expect(vi.mocked(api.setBounds).mock.invocationCallOrder.at(-1)).toBeLessThan(
    vi.mocked(api.show).mock.invocationCallOrder.at(-1)!,
  );
  expect(mounted).toHaveBeenCalledTimes(1);
  expect(unmounted).not.toHaveBeenCalled();
});

it("shows both pair members and hides only the anchor whose surface becomes inactive", () => {
  receive(tab(), tab({ tabId: "opaque-tab-b", ticketId: "ticket-b" }));
  const render = (firstVisible: boolean) =>
    act(() =>
      root.render(
        <>
          <BrowserPaneAnchor tabId="opaque-tab-a" visible={firstVisible} />
          <BrowserPaneAnchor tabId="opaque-tab-b" visible />
          <ResidentBrowserPanes api={api} />
        </>,
      ),
    );
  render(true);
  const boxes = [...host.querySelectorAll<HTMLElement>('[data-slot="terminal-viewport-box"]')];
  expect(boxes.map((box) => box.style.display)).toEqual(["block", "block"]);
  render(false);
  expect(boxes.map((box) => box.style.display)).toEqual(["none", "block"]);
  expect(browserViewportSnapshot().has("opaque-tab-a")).toBe(false);
  expect(browserViewportSnapshot().has("opaque-tab-b")).toBe(true);
  expect(mounted).toHaveBeenCalledTimes(2);
  expect(unmounted).not.toHaveBeenCalled();
});

it("routes pointer capture through the current anchor's pane and tab owner", () => {
  receive(tab());
  renderAnchor("home", true, "home-pane");
  act(() => address().dispatchEvent(new MouseEvent("pointerdown", { bubbles: true })));
  expect(focusHomePane).toHaveBeenCalledWith("project-a", "home-pane");

  receive(tab({ projectId: "project-b", ticketId: "ticket-b" }));
  renderAnchor("ticket", true, "ticket-pane");
  act(() => address().dispatchEvent(new MouseEvent("pointerdown", { bubbles: true })));
  expect(focusTicketPane).toHaveBeenCalledWith("project-b", "ticket-b", "ticket-pane");
  renderAnchor(null);
  act(() => address().dispatchEvent(new MouseEvent("pointerdown", { bubbles: true })));
  expect(focusHomePane).toHaveBeenCalledTimes(1);
  expect(focusTicketPane).toHaveBeenCalledTimes(1);
});

it("unmounts only on removal or leaving strip presentation, not unrelated store updates", () => {
  receive(tab(), tab({ tabId: "opaque-tab-b" }));
  renderAnchor(null);
  receive(tab({ tabId: "opaque-tab-b", title: "New title" }));
  expect(unmounted).not.toHaveBeenCalled();
  act(() => useBrowserTabsStore.getState().remove("opaque-tab-a"));
  expect(unmounted.mock.calls).toEqual([["opaque-tab-a"]]);
  receive(tab({ tabId: "opaque-tab-b", presentation: "headless" }));
  expect(unmounted.mock.calls).toEqual([["opaque-tab-a"], ["opaque-tab-b"]]);
});

describe("browser viewport registry", () => {
  it("keeps snapshots stable and old cleanup cannot clear a replacement anchor", () => {
    const first = document.createElement("div");
    const second = document.createElement("div");
    const changed = vi.fn();
    const unsubscribe = subscribeBrowserViewports(changed);
    const empty = browserViewportSnapshot();
    const clearFirst = registerBrowserViewport("tab", first);
    const published = browserViewportSnapshot();
    expect(published).not.toBe(empty);
    expect(browserViewportSnapshot()).toBe(published);
    registerBrowserViewport("tab", first);
    expect(changed).toHaveBeenCalledTimes(1);
    const clearSecond = registerBrowserViewport("tab", second);
    const replacement = browserViewportSnapshot();
    clearFirst();
    expect(browserViewportSnapshot()).toBe(replacement);
    expect(browserViewportSnapshot().get("tab")).toBe(second);
    clearSecond();
    expect(changed).toHaveBeenCalledTimes(3);
    clearSecond();
    expect(changed).toHaveBeenCalledTimes(3);
    unsubscribe();
  });
});

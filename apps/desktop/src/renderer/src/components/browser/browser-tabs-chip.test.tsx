// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { BrowserTabState } from "../../../../ipc/contract";
import type { BrowserApi } from "./browser-api";
import { BrowserTabsChip } from "./browser-tabs-chip";

vi.mock("@renderer/lib/toast", () => ({ toastError: vi.fn() }));
import { toastError } from "@renderer/lib/toast";

let container: HTMLDivElement | null = null;
let root: Root | null = null;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  vi.mocked(toastError).mockClear();
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.unstubAllGlobals();
});

function tab(overrides: Partial<BrowserTabState> & { tabId: string }): BrowserTabState {
  return {
    projectId: "project-1",
    ticketId: null,
    createdBy: "session",
    ownerSessionId: "s1",
    presentation: "headless",
    url: "https://example.com/one",
    title: "One",
    loading: false,
    error: null,
    canGoBack: false,
    canGoForward: false,
    generation: 1,
    ...overrides,
  };
}

function api(overrides: Partial<BrowserApi> = {}): BrowserApi {
  return {
    setPresentation: vi.fn(async () => ({ ok: true, tab: tab({ tabId: "a" }) }) as const),
    close: vi.fn(async () => ({ ok: true }) as const),
    ...overrides,
  } as unknown as BrowserApi;
}

async function draw(tabs: BrowserTabState[], browser: BrowserApi) {
  await act(async () => {
    root?.render(
      <BrowserTabsChip
        tabs={tabs}
        api={browser}
        sessionId="s1"
        sessionTitle={(id) => (id === "s-child" ? "Read the docs" : null)}
      />,
    );
  });
}

/** The popover is a Radix portal, so every query is document-wide. */
const trigger = () => document.querySelector<HTMLElement>("[data-browser-tabs-chip]");
const rows = () => [...document.querySelectorAll("[data-browser-inventory-tab]")];
const buttons = (name: string) =>
  [...document.querySelectorAll("button")].filter((one) => one.textContent === name);

async function openInventory() {
  await act(async () => trigger()?.click());
}

describe("BrowserTabsChip", () => {
  it("counts the tabs this chat holds, and does not exist at all while there are none", async () => {
    await draw([], api());
    expect(trigger()).toBeNull();

    await draw([tab({ tabId: "a" })], api());
    expect(trigger()?.textContent).toBe("1 tab");
    expect(trigger()?.getAttribute("data-browser-tabs-chip")).toBe("1");

    await draw([tab({ tabId: "a" }), tab({ tabId: "b" })], api());
    expect(trigger()?.textContent).toBe("2 tabs");
  });

  it("lists every tab with its title, URL and owner, including a child Session's", async () => {
    await draw(
      [
        tab({ tabId: "a", title: "One", url: "https://example.com/one" }),
        tab({
          tabId: "b",
          title: "Two",
          url: "https://example.com/two",
          ownerSessionId: "s-child",
        }),
      ],
      api(),
    );

    await openInventory();

    expect(rows()).toHaveLength(2);
    expect(rows()[0]?.textContent).toContain("One");
    expect(rows()[0]?.textContent).toContain("https://example.com/one");
    expect(rows()[0]?.textContent).toContain("this Session");
    // A headless tab is visible nowhere else, so a child's must be nameable here.
    expect(rows()[1]?.textContent).toContain("Read the docs");
  });

  it("shows a headless tab and hides one already on screen", async () => {
    const browser = api();
    await draw([tab({ tabId: "a" }), tab({ tabId: "b", presentation: "preview" })], browser);
    await openInventory();

    expect(buttons("Show")).toHaveLength(1);
    expect(buttons("Hide")).toHaveLength(1);

    await act(async () => buttons("Show")[0]?.click());
    expect(browser.setPresentation).toHaveBeenCalledWith({ tabId: "a", presentation: "preview" });

    await act(async () => buttons("Hide")[0]?.click());
    expect(browser.setPresentation).toHaveBeenCalledWith({ tabId: "b", presentation: "headless" });
  });

  it("closes one tab, and closes all of them from the one action at the foot", async () => {
    const browser = api();
    await draw([tab({ tabId: "a" }), tab({ tabId: "b" })], browser);
    await openInventory();

    await act(async () => buttons("Close")[0]?.click());
    expect(browser.close).toHaveBeenCalledWith({ tabId: "a" });

    await act(async () => buttons("Close all")[0]?.click());
    expect(browser.close).toHaveBeenCalledWith({ tabId: "a" });
    expect(browser.close).toHaveBeenCalledWith({ tabId: "b" });
    expect(browser.close).toHaveBeenCalledTimes(3);
  });

  it("toasts a refused Show or Close rather than swallowing it", async () => {
    const browser = api({
      setPresentation: vi.fn(async () => ({ ok: false, error: "Unknown Browser Tab" }) as const),
      close: vi.fn(async () => {
        throw new Error("gone");
      }),
    });
    await draw([tab({ tabId: "a" })], browser);
    await openInventory();

    await act(async () => buttons("Show")[0]?.click());
    expect(toastError).toHaveBeenCalledWith("Could not show Browser Tab: Unknown Browser Tab");

    await act(async () => buttons("Close")[0]?.click());
    expect(toastError).toHaveBeenCalledWith("Could not close Browser Tab: gone");
  });

  it("marks every tab in the inventory as a Session's, since a person's is never listed here", async () => {
    await draw([tab({ tabId: "a" })], api());
    await openInventory();

    expect(
      rows()[0]?.querySelector("[data-browser-tab-mark]")?.getAttribute("data-browser-tab-mark"),
    ).toBe("session");
  });
});

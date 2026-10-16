// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  HOME_BOARD_TAB,
  HomePaneTabStrip,
  type HomeTabDescriptor,
} from "@renderer/components/home/home-tab-strip";
import {
  TicketPaneTabStrip,
  type TicketTabDescriptor,
} from "@renderer/components/ticket/ticket-tabs";
import { Tab, TabStrip } from "@renderer/components/ui/tab-strip";
import { GroupedTabList, groupTabItems, type TabPair } from "./grouped-tab-chip";

const noop = () => {};
const pair: TabPair = { id: "pair-1", tabIds: ["chat:one", "browser:one"] };
const chat: HomeTabDescriptor = {
  kind: "chat",
  id: "chat:one",
  sessionId: "one",
  title: "Chat",
  status: "working",
};
const browser: HomeTabDescriptor = {
  kind: "browser",
  id: "browser:one",
  tabId: "one",
  title: "Page",
  loading: false,
  driven: false,
  heldBy: null,
};
let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({
      matches: false,
      addEventListener: noop,
      removeEventListener: noop,
    })),
  );
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

function tab(label: string): HTMLElement {
  const found = container.querySelector<HTMLElement>(`[role="tab"][aria-label="${label}"]`);
  if (found === null) throw new Error(`Missing tab ${label}`);
  return found;
}
function click(element: Element) {
  act(() => element.dispatchEvent(new MouseEvent("click", { bubbles: true })));
}
function press(element: Element, key: string) {
  act(() =>
    element.dispatchEvent(
      new KeyboardEvent("keydown", { key, code: key, bubbles: true, cancelable: true }),
    ),
  );
}

function home(
  activeTabId: string,
  pairs: readonly TabPair[] = [pair],
  callbacks = { select: vi.fn(), close: vi.fn(), unpair: vi.fn(), rename: vi.fn() },
) {
  act(() =>
    root.render(
      <HomePaneTabStrip
        label="Home tabs"
        projectId="project"
        tabs={[HOME_BOARD_TAB, chat, browser]}
        activeTabId={activeTabId}
        pairs={pairs}
        onUnpair={callbacks.unpair}
        onSelect={callbacks.select}
        onClose={callbacks.close}
        onRename={callbacks.rename}
        onPinFile={noop}
        onCloseOtherFiles={noop}
      />,
    ),
  );
  return callbacks;
}

it("groups at the first member, using tuple order and leaving incomplete or overlapping pairs alone", () => {
  const tabs = [{ id: "first" }, { id: "browser:one" }, { id: "other" }, { id: "chat:one" }];
  const groups = groupTabItems(tabs, [
    pair,
    { id: "overlap", tabIds: ["chat:one", "other"] },
    { id: "missing", tabIds: ["first", "absent"] },
    { id: "same", tabIds: ["other", "other"] },
  ]);
  expect(groups.map((group) => group.tabs.map((item) => item.id))).toEqual([
    ["first"],
    ["chat:one", "browser:one"],
    ["other"],
  ]);
});

describe("paired Home tabs", () => {
  it("selects both members, marks the focused one, and preserves the nodes when focus switches", () => {
    home(chat.id);
    const group = container.querySelector('[data-slot="grouped-tab-chip"]');
    const first = tab("Chat");
    const second = tab("Page");
    expect(first.querySelector('[data-session-glyph="working"]')).not.toBeNull();
    expect(first.querySelector('[data-slot="tab-state"]')).toBeNull();
    expect(first.getAttribute("aria-selected")).toBe("true");
    expect(second.getAttribute("aria-selected")).toBe("true");
    expect(first.tabIndex).toBe(0);
    expect(second.tabIndex).toBe(-1);
    expect(first.parentElement?.getAttribute("data-focused")).toBe("true");
    home(browser.id);
    expect(container.querySelector('[data-slot="grouped-tab-chip"]')).toBe(group);
    expect(tab("Chat")).toBe(first);
    expect(tab("Page")).toBe(second);
    expect(first.parentElement?.getAttribute("data-focused")).toBe("false");
    expect(second.parentElement?.getAttribute("data-focused")).toBe("true");
    expect(second.tabIndex).toBe(0);
  });

  it("keeps individual selection, closing, rename and keyboard traversal; Unpair does not select", () => {
    const callbacks = home(chat.id);
    click(tab("Page"));
    expect(callbacks.select).toHaveBeenCalledWith(browser);
    callbacks.select.mockClear();
    click(container.querySelector('[aria-label="Close Page"]')!);
    expect(callbacks.close).toHaveBeenCalledWith(browser);
    expect(callbacks.select).not.toHaveBeenCalled();
    click(container.querySelector('[aria-label="Unpair tabs"]')!);
    expect(callbacks.unpair).toHaveBeenCalledWith(pair.id);
    expect(callbacks.close).toHaveBeenCalledTimes(1);
    expect(callbacks.select).not.toHaveBeenCalled();
    act(() => tab("Chat").focus());
    press(tab("Chat"), "ArrowRight");
    expect(document.activeElement).toBe(tab("Page"));
    act(() => tab("Chat").dispatchEvent(new MouseEvent("dblclick", { bubbles: true })));
    expect(container.querySelector('input[aria-label="Rename Chat"]')).not.toBeNull();
  });

  it("does not group single tabs and can pair the permanent Board without making it closable", () => {
    home(HOME_BOARD_TAB.id, []);
    expect(container.querySelector('[data-slot="grouped-tab-chip"]')).toBeNull();
    home(browser.id, [{ id: "board-pair", tabIds: [HOME_BOARD_TAB.id, browser.id] }]);
    expect(tab("Board").getAttribute("aria-selected")).toBe("true");
    expect(container.querySelector('[aria-label="Close Board"]')).toBeNull();
    expect(tab("Page").getAttribute("aria-selected")).toBe("true");
  });
});

it("pairs Ticket Body and Browser tabs with the same member controls and single entry point", () => {
  const body: TicketTabDescriptor = { id: "body", kind: "body", label: "Body" };
  const page: TicketTabDescriptor = { id: browser.id, kind: "browser", label: "Page" };
  const onSelect = vi.fn();
  const onClose = vi.fn();
  const onUnpair = vi.fn();
  act(() =>
    root.render(
      <TicketPaneTabStrip
        label="Ticket tabs"
        projectId="project"
        ticketId="ticket"
        tabs={[body, page]}
        activeTabId={page.id}
        pairs={[{ id: "body-pair", tabIds: [body.id, page.id] }]}
        onSelectTab={onSelect}
        onCloseTab={onClose}
        onRenameSessionTab={noop}
        onUnpair={onUnpair}
      />,
    ),
  );
  expect(tab("Body").getAttribute("aria-selected")).toBe("true");
  expect(tab("Body").tabIndex).toBe(-1);
  expect(tab("Page").tabIndex).toBe(0);
  expect(container.querySelector('[aria-label="Close Body"]')).toBeNull();
  click(tab("Body"));
  expect(onSelect).toHaveBeenCalledWith("body");
  click(container.querySelector('[aria-label="Close Page"]')!);
  expect(onClose).toHaveBeenCalledWith(page);
  click(container.querySelector('[aria-label="Unpair tabs"]')!);
  expect(onUnpair).toHaveBeenCalledWith("body-pair");
});

it("uses the same SessionGlyph and no duplicate state mark on Ticket chat tabs", () => {
  act(() =>
    root.render(
      <TicketPaneTabStrip
        label="Ticket tabs"
        projectId="project"
        ticketId="ticket"
        tabs={[{ id: chat.id, kind: "chat", label: "Chat", status: "waiting" }]}
        activeTabId={chat.id}
        onSelectTab={noop}
        onCloseTab={noop}
        onRenameSessionTab={noop}
      />,
    ),
  );
  expect(tab("Chat").querySelector('[data-session-glyph="waiting"]')).not.toBeNull();
  expect(tab("Chat").querySelector('[data-slot="tab-state"]')).toBeNull();
});

it("retains each member's sortable registration instead of making the group draggable", () => {
  act(() =>
    root.render(
      <TabStrip label="Tabs" reorder={{ ids: [...pair.tabIds], onReorder: noop }}>
        <GroupedTabList
          tabs={[{ id: pair.tabIds[0] }, { id: pair.tabIds[1] }]}
          pairs={[pair]}
          activeTabId={pair.tabIds[0]}
        >
          {(item, state) => (
            <Tab
              label={item.id}
              dragId={item.id}
              active={state.active}
              tabStop={state.tabStop}
              onActivate={noop}
            />
          )}
        </GroupedTabList>
      </TabStrip>,
    ),
  );
  for (const id of pair.tabIds)
    expect(tab(id).getAttribute("aria-describedby")).toContain("DndDescribedBy");
  expect(
    container.querySelector('[data-slot="grouped-tab-chip"]')?.hasAttribute("aria-describedby"),
  ).toBe(false);
});

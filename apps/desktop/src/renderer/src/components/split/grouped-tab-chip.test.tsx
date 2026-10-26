// @vitest-environment jsdom
import { act } from "react";
import { ChatCircleIcon } from "@phosphor-icons/react/dist/csr/ChatCircle";
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
import { useBrowserTabsStore } from "@renderer/stores/browser-tabs";
import { GroupedTabList, groupTabItems, type TabGroup } from "./grouped-tab-chip";

const noop = () => {};
/** [chat:one, term] stacked in one pane (chat in front) | [browser:one]. */
const group: TabGroup = {
  id: "group-1",
  panes: [
    { paneId: "p1", tabIds: ["chat:one", "term"], activeTabId: "chat:one" },
    { paneId: "p2", tabIds: ["browser:one"], activeTabId: "browser:one" },
  ],
};
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
const file: HomeTabDescriptor = {
  kind: "file",
  id: "file:a.ts",
  relPath: "a.ts",
  title: "a.ts",
  hint: null,
  preview: false,
  dirty: false,
};
const term: HomeTabDescriptor = {
  kind: "file",
  id: "term",
  relPath: "term",
  title: "Notes",
  hint: null,
  preview: false,
  dirty: false,
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
async function openChipMenu() {
  const chip = container.querySelector('[data-slot="grouped-tab-chip"]')!;
  await act(async () => {
    chip.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 10, clientY: 10 }));
  });
}

function home(
  activeTabId: string,
  groups: readonly TabGroup[] = [group],
  shownGroupId: string | null = "group-1",
  callbacks = { select: vi.fn(), close: vi.fn(), ungroup: vi.fn(), rename: vi.fn() },
) {
  act(() =>
    root.render(
      <HomePaneTabStrip
        label="Home tabs"
        projectId="project"
        tabs={[HOME_BOARD_TAB, chat, file, browser, term]}
        activeTabId={activeTabId}
        groups={groups}
        shownGroupId={shownGroupId}
        onUngroup={callbacks.ungroup}
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

it("draws a group as one chip where its earliest tab sits, each pane's front a segment", () => {
  const tabs = [
    { id: "first" },
    { id: "browser:one" },
    { id: "other" },
    { id: "term" },
    { id: "chat:one" },
  ];
  const items = groupTabItems(tabs, [group]);
  expect(
    items.map((item) =>
      item.group === null ? item.tab.id : item.segments.map((segment) => segment.id),
    ),
  ).toEqual(["first", ["chat:one", "browser:one"], "other"]);
  // A front that is not live falls back to the stack's first live tab.
  const fallback = groupTabItems([{ id: "term" }, { id: "browser:one" }], [group]);
  expect(fallback[0]).toMatchObject({ segments: [{ id: "term" }, { id: "browser:one" }] });
  // A group with nothing live draws no segment at all.
  expect(groupTabItems([{ id: "x" }], [group])).toEqual([{ group: null, tab: { id: "x" } }]);
  expect(groupTabItems([{ id: "term" }], [group])[0]).toMatchObject({ segments: [{ id: "term" }] });
});

describe("a Home tab group's chip", () => {
  it("selects every segment, marks the focused pane's front, keeps its nodes as focus moves", () => {
    home(chat.id);
    const chip = container.querySelector('[data-slot="grouped-tab-chip"]');
    expect(chip?.getAttribute("aria-label")).toBe("Tab group");
    expect(chip?.getAttribute("data-active")).toBe("true");
    const first = tab("Chat");
    const second = tab("Page");
    // The stacked tab behind the front is not a top-level tab.
    expect(container.querySelector('[role="tab"][aria-label="Notes"]')).toBeNull();
    expect(first.querySelector('[data-session-glyph="working"]')).not.toBeNull();
    expect(first.getAttribute("aria-selected")).toBe("true");
    expect(second.getAttribute("aria-selected")).toBe("true");
    expect(first.tabIndex).toBe(0);
    expect(second.tabIndex).toBe(-1);
    expect(first.parentElement?.getAttribute("data-focused")).toBe("true");
    home(browser.id);
    expect(container.querySelector('[data-slot="grouped-tab-chip"]')).toBe(chip);
    expect(tab("Chat")).toBe(first);
    expect(first.parentElement?.getAttribute("data-focused")).toBe("false");
    expect(second.parentElement?.getAttribute("data-focused")).toBe("true");
    expect(second.tabIndex).toBe(0);
  });

  it("draws an unshown group's chip inactive beside an ordinary tab in front", () => {
    home(file.id, [group], null);
    expect(
      container.querySelector('[data-slot="grouped-tab-chip"]')?.getAttribute("data-active"),
    ).toBe("false");
    expect(tab("Chat").getAttribute("aria-selected")).toBe("false");
    expect(tab("a.ts").getAttribute("aria-selected")).toBe("true");
  });

  it("summarizes an unshown group's chip and opens it out once shown (VC-614)", () => {
    home(file.id, [group], null);
    const chip = container.querySelector('[data-slot="grouped-tab-chip"]')!;
    expect(chip.getAttribute("data-compact")).toBe("true");
    // The other panes fold into a +n that names them and shows the group.
    const more = chip.querySelector<HTMLButtonElement>('[data-slot="grouped-tab-more"]')!;
    expect(more.textContent).toBe("+1");
    expect(more.getAttribute("aria-label")).toBe("1 more in this group: Page");
    expect(more.title).toBe("Page");
    expect(more.tabIndex).toBe(-1);
    const callbacks = home(file.id, [group], null);
    act(() => chip.querySelector<HTMLButtonElement>('[data-slot="grouped-tab-more"]')!.click());
    expect(callbacks.select).toHaveBeenCalledWith(chat);
    home(chat.id);
    expect(chip.getAttribute("data-compact")).toBe("false");
    expect(chip.querySelector('[data-slot="grouped-tab-more"]')).toBeNull();
    // A group whose other panes have nothing live has nothing to summarize.
    home(file.id, [{ id: "solo", panes: [group.panes[0]!] }], null);
    expect(
      container.querySelector('[data-slot="grouped-tab-chip"]')?.getAttribute("data-compact"),
    ).toBe("false");
  });

  it("keeps per-segment selection, closing, rename and keyboard traversal", () => {
    const callbacks = home(chat.id);
    click(tab("Page"));
    expect(callbacks.select).toHaveBeenCalledWith(browser);
    callbacks.select.mockClear();
    click(container.querySelector('[aria-label="Close Page"]')!);
    expect(callbacks.close).toHaveBeenCalledWith(browser);
    expect(callbacks.select).not.toHaveBeenCalled();
    act(() => tab("Chat").focus());
    press(tab("Chat"), "ArrowRight");
    expect(document.activeElement).toBe(tab("Page"));
    act(() => tab("Chat").dispatchEvent(new MouseEvent("dblclick", { bubbles: true })));
    expect(container.querySelector('input[aria-label="Rename Chat"]')).not.toBeNull();
  });

  it("lists the whole group by pane on right-click: one row per tab, its pane and place, then Ungroup", async () => {
    useBrowserTabsStore.setState({
      byId: { one: { url: "http://127.0.0.1:5173/login?next=1" } as never },
    } as never);
    const callbacks = home(chat.id);
    await openChipMenu();
    const menu = document.querySelector('[data-slot="grouped-tab-menu"]')!;
    expect(menu.textContent).toContain("Tab group");
    expect(menu.textContent).toContain("2 panes");
    const rows = [...menu.querySelectorAll('[data-slot="context-menu-item"][data-pane]')];
    expect(
      rows.map((row) => [
        row.getAttribute("aria-label"),
        row.getAttribute("data-pane"),
        row.getAttribute("data-front"),
        row.getAttribute("data-showing"),
      ]),
    ).toEqual([
      ["Chat, pane 1, showing", "1", "true", "true"],
      ["Notes, pane 1, behind", "1", "false", "false"],
      ["Page, pane 2", "2", "true", "false"],
    ]);
    // The line that tells like tabs apart: a page's host:port/path.
    expect(rows[2]!.textContent).toContain("127.0.0.1:5173/login?next=1");
    // No checkmarks: nothing in the menu is a radio any more.
    expect(menu.querySelector('[data-slot="context-menu-radio-item"]')).toBeNull();
    await act(async () => {
      rows[1]!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(callbacks.select).toHaveBeenCalledWith(term);
    await openChipMenu();
    const ungroup = [...document.querySelectorAll('[data-slot="context-menu-item"]')].find(
      (row) => row.textContent === "Ungroup",
    )!;
    await act(async () => {
      ungroup.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(callbacks.ungroup).toHaveBeenCalledWith("group-1");
    useBrowserTabsStore.setState({ byId: {} } as never);
  });

  it("can hold the permanent Board without making it closable or draggable", () => {
    home(
      browser.id,
      [
        {
          id: "board-group",
          panes: [
            { paneId: "a", tabIds: [HOME_BOARD_TAB.id], activeTabId: HOME_BOARD_TAB.id },
            { paneId: "b", tabIds: [browser.id], activeTabId: browser.id },
          ],
        },
      ],
      "board-group",
    );
    expect(tab("Board").getAttribute("aria-selected")).toBe("true");
    expect(container.querySelector('[aria-label="Close Board"]')).toBeNull();
    expect(tab("Page").getAttribute("aria-selected")).toBe("true");
  });
});

it("groups Ticket Body and Browser tabs with the same segment controls and single entry point", () => {
  const body: TicketTabDescriptor = { id: "body", kind: "body", label: "Body" };
  const page: TicketTabDescriptor = { id: browser.id, kind: "browser", label: "Page" };
  const onSelect = vi.fn();
  const onClose = vi.fn();
  act(() =>
    root.render(
      <TicketPaneTabStrip
        label="Ticket tabs"
        projectId="project"
        ticketId="ticket"
        tabs={[body, page]}
        activeTabId={page.id}
        groups={[
          {
            id: "body-group",
            panes: [
              { paneId: "a", tabIds: [body.id], activeTabId: body.id },
              { paneId: "b", tabIds: [page.id], activeTabId: page.id },
            ],
          },
        ]}
        shownGroupId="body-group"
        onSelectTab={onSelect}
        onCloseTab={onClose}
        onRenameSessionTab={noop}
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

it("leaves a chip's segments out of the sortable — the chip is not dragged, its tabs move in pane strips", () => {
  act(() =>
    root.render(
      <TabStrip label="Tabs" reorder={{ ids: ["x"], onReorder: noop }}>
        <GroupedTabList
          tabs={[{ id: "x" }, { id: "chat:one" }, { id: "browser:one" }]}
          groups={[group]}
          shownGroupId={null}
          activeTabId="x"
          edgeTargets
          describe={(item) => ({ label: item.id, icon: ChatCircleIcon })}
          onSelect={noop}
        >
          {(item, state) => (
            <Tab
              label={item.id}
              dragId={state.grouped ? undefined : item.id}
              active={state.active}
              tabStop={state.tabStop}
              onActivate={noop}
            />
          )}
        </GroupedTabList>
      </TabStrip>,
    ),
  );
  expect(tab("x").getAttribute("aria-describedby")).toContain("DndDescribedBy");
  expect(tab("chat:one").hasAttribute("aria-describedby")).toBe(false);
  // Every top-level item is an edge target for grouping, segments included.
  expect(
    [...container.querySelectorAll("[data-pair-target-id]")].map((node) =>
      node.getAttribute("data-pair-target-id"),
    ),
  ).toEqual(["x", "chat:one", "browser:one"]);
});

it("marks no edge targets on a pane's own strip", () => {
  act(() =>
    root.render(
      <HomePaneTabStrip
        label="Pane 1 tabs"
        projectId="project"
        tabs={[chat, browser]}
        activeTabId={chat.id}
        onSelect={noop}
        onClose={noop}
        onRename={noop}
        onReorder={noop}
        onPinFile={noop}
        onCloseOtherFiles={noop}
      />,
    ),
  );
  expect(container.querySelector("[data-pair-target-id]")).toBeNull();
  expect(container.querySelector('[data-slot="grouped-tab-chip"]')).toBeNull();
});

it("puts the way out of the group on a pane strip's trailing edge (VC-614)", () => {
  const takeOut = vi.fn();
  act(() =>
    root.render(
      <HomePaneTabStrip
        label="Pane 2 of 3"
        projectId="project"
        tabs={[browser]}
        activeTabId={browser.id}
        onTakeOut={takeOut}
        onSelect={noop}
        onClose={noop}
        onRename={noop}
        onPinFile={noop}
        onCloseOtherFiles={noop}
      />,
    ),
  );
  const button = container.querySelector<HTMLButtonElement>('[data-slot="pane-take-out"]')!;
  expect(button.getAttribute("aria-label")).toBe("Take out of group");
  act(() => button.click());
  expect(takeOut).toHaveBeenCalledTimes(1);
  // The top strip, and a pane strip given no way out, draw none.
  home(chat.id);
  expect(container.querySelector('[data-slot="pane-take-out"]')).toBeNull();
});

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
function chip(): HTMLElement {
  const found = container.querySelector<HTMLElement>('[data-slot="grouped-tab-chip"]');
  if (found === null) throw new Error("Missing chip");
  return found;
}
function popover(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[data-slot="grouped-tab-popover"]');
}
/** React derives enter/leave from `pointerover`/`pointerout`; jsdom has no PointerEvent. */
function pointer(type: "pointerover" | "pointerout", target: Element, related: Element | null) {
  const event = new MouseEvent(type, { bubbles: true, buttons: 0, relatedTarget: related });
  Object.defineProperty(event, "pointerType", { value: "mouse" });
  act(() => target.dispatchEvent(event));
}
async function rightClickChip() {
  await act(async () => {
    chip().dispatchEvent(
      new MouseEvent("contextmenu", { bubbles: true, clientX: 10, clientY: 10 }),
    );
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

it("places a group's chip where its earliest tab sits, knowing each pane's front", () => {
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
  it("draws the group as ONE tab — the focused member in front of a stacked glyph, no segments, no +n", () => {
    home(chat.id);
    const node = chip();
    expect(node.getAttribute("data-active")).toBe("true");
    // One tab for the whole group: its other members are not top-level tabs.
    expect(node.querySelectorAll('[role="tab"]')).toHaveLength(1);
    const front = tab("Chat");
    expect(node.contains(front)).toBe(true);
    expect(container.querySelector('[role="tab"][aria-label="Page"]')).toBeNull();
    expect(container.querySelector('[role="tab"][aria-label="Notes"]')).toBeNull();
    expect(container.querySelector('[data-slot="grouped-tab-more"]')).toBeNull();
    expect(container.querySelector('[data-slot="grouped-tab-member"]')).toBeNull();
    expect(node.textContent).not.toMatch(/\+\d/);
    // The tab's own glyph rides the front card; two members fan out behind it.
    const stack = front.querySelector('[data-slot="tab-glyph-stack"]')!;
    expect(stack.getAttribute("data-depth")).toBe("3");
    const cards = [...stack.querySelectorAll('[data-slot="tab-glyph-card"]')];
    expect(cards.map((card) => card.getAttribute("data-layer"))).toEqual(["2", "1", "0"]);
    expect(cards[2]!.querySelector('[data-session-glyph="working"]')).not.toBeNull();
    expect(front.getAttribute("aria-selected")).toBe("true");
    expect(front.tabIndex).toBe(0);
    expect(front.getAttribute("aria-haspopup")).toBe("menu");
    expect(front.getAttribute("aria-expanded")).toBe("false");
    // Focus moving to another pane brings ITS tab to the front of the same chip.
    home(browser.id);
    expect(chip()).toBe(node);
    expect(container.querySelector('[role="tab"][aria-label="Chat"]')).toBeNull();
    expect(tab("Page").tabIndex).toBe(0);
    expect(node.contains(tab("Page"))).toBe(true);
  });

  it("draws an unshown group by its first pane's front, inactive beside an ordinary tab", () => {
    home(file.id, [group], null);
    expect(chip().getAttribute("data-active")).toBe("false");
    expect(tab("Chat").getAttribute("aria-selected")).toBe("false");
    expect(tab("a.ts").getAttribute("aria-selected")).toBe("true");
    // A group of one live tab has nothing behind its front.
    home(file.id, [{ id: "solo", panes: [{ ...group.panes[0]!, tabIds: ["chat:one"] }] }], null);
    expect(
      container.querySelector('[data-slot="tab-glyph-stack"]')?.getAttribute("data-depth"),
    ).toBe("1");
  });

  it("selects on a press, and opens the list from the stack, or from a chip already showing", () => {
    const callbacks = home(file.id, [group], null);
    click(tab("Chat"));
    expect(callbacks.select).toHaveBeenCalledWith(chat);
    expect(popover()).toBeNull();
    // The stack is the list's door: it opens without selecting.
    callbacks.select.mockClear();
    click(tab("Chat").querySelector('[data-slot="tab-glyph-stack"]')!);
    expect(popover()).not.toBeNull();
    expect(callbacks.select).not.toHaveBeenCalled();
    expect(tab("Chat").getAttribute("aria-expanded")).toBe("true");
    press(document.body, "Escape");
    expect(popover()).toBeNull();
    // A press on a chip whose group is on screen opens the list.
    home(chat.id);
    click(tab("Chat"));
    expect(popover()).not.toBeNull();
  });

  it("opens on hover after a short delay, survives the trip into the list, closes on leave", () => {
    vi.useFakeTimers();
    try {
      home(chat.id);
      pointer("pointerover", tab("Chat"), document.body);
      expect(popover()).toBeNull();
      act(() => vi.advanceTimersByTime(300));
      const list = popover()!;
      expect(list).not.toBeNull();
      // Hover never takes focus from wherever it was (a terminal, typically).
      expect(list.contains(document.activeElement)).toBe(false);
      // Leaving the chip for the list keeps it open past the grace.
      pointer("pointerout", tab("Chat"), list);
      pointer("pointerover", list, tab("Chat"));
      act(() => vi.advanceTimersByTime(500));
      expect(popover()).not.toBeNull();
      pointer("pointerout", list, document.body);
      act(() => vi.advanceTimersByTime(500));
      expect(popover()).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does nothing new on hovering an ordinary tab", () => {
    vi.useFakeTimers();
    try {
      home(chat.id);
      pointer("pointerover", tab("a.ts"), document.body);
      act(() => vi.advanceTimersByTime(500));
      expect(popover()).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("lists the whole group in two-line rows — title, detail, status — then Ungroup", async () => {
    useBrowserTabsStore.setState({
      byId: { one: { url: "http://127.0.0.1:5173/login?next=1" } as never },
    } as never);
    const callbacks = home(chat.id);
    await rightClickChip();
    const list = popover()!;
    expect(list.getAttribute("role")).toBe("menu");
    // The header names the front tab; no "Tab group", no pane count.
    const header = list.querySelector('[data-slot="grouped-tab-popover-header"]')!;
    expect(header.textContent).toBe("Chat");
    expect(list.textContent).not.toContain("Tab group");
    expect(list.textContent).not.toMatch(/panes?\b/);
    const rows = [...list.querySelectorAll<HTMLElement>('[data-slot="grouped-tab-row"]')];
    expect(rows.map((row) => row.getAttribute("aria-label"))).toEqual([
      "Chat, Working",
      "Notes",
      "Page, 127.0.0.1:5173/login?next=1",
    ]);
    expect(rows.map((row) => row.getAttribute("role"))).toEqual([
      "menuitem",
      "menuitem",
      "menuitem",
    ]);
    expect(rows[0]!.getAttribute("aria-current")).toBe("true");
    // Title over detail, status on the title's line; no pane badges, no checks.
    expect(rows[0]!.textContent).toBe("ChatWorking");
    expect(rows[2]!.textContent).toBe("Page127.0.0.1:5173/login?next=1");
    // Pane and place ride the rows as data only, for probes; nothing draws them.
    expect(rows.map((row) => [row.dataset.pane, row.dataset.front])).toEqual([
      ["1", "true"],
      ["1", "false"],
      ["2", "true"],
    ]);
    expect(list.querySelector('[role="menuitemradio"], [role="menuitemcheckbox"]')).toBeNull();
    click(rows[1]!);
    expect(callbacks.select).toHaveBeenCalledWith(term);
    expect(popover()).toBeNull();
    await rightClickChip();
    const ungroup = popover()!.querySelector('[data-slot="grouped-tab-ungroup"]')!;
    expect(ungroup.previousElementSibling?.getAttribute("role")).toBe("separator");
    expect(ungroup.querySelector("svg")).not.toBeNull();
    expect(ungroup.textContent).toBe("Ungroup");
    click(ungroup);
    expect(callbacks.ungroup).toHaveBeenCalledWith("group-1");
    useBrowserTabsStore.setState({ byId: {} } as never);
  });

  it("opens from the keyboard into its first row, walks the rows, and gives focus back", async () => {
    home(chat.id);
    act(() => tab("Chat").focus());
    await act(async () => {
      tab("Chat").dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }),
      );
    });
    const rows = [...popover()!.querySelectorAll<HTMLElement>('[role="menuitem"]')];
    expect(document.activeElement).toBe(rows[0]);
    press(rows[0]!, "ArrowDown");
    expect(document.activeElement).toBe(rows[1]);
    press(rows[1]!, "ArrowUp");
    press(rows[0]!, "ArrowUp");
    // Wraps to Ungroup at the foot.
    expect(document.activeElement?.textContent).toBe("Ungroup");
    await act(async () => {
      document.activeElement!.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
      );
    });
    expect(popover()).toBeNull();
    expect(document.activeElement).toBe(tab("Chat"));
    // Enter on a chip whose group is showing opens it too.
    press(tab("Chat"), "Enter");
    expect(popover()).not.toBeNull();
  });

  it("keeps the front's close, rename and the strip's keyboard traversal", () => {
    const callbacks = home(chat.id);
    click(container.querySelector('[aria-label="Close Chat"]')!);
    expect(callbacks.close).toHaveBeenCalledWith(chat);
    expect(popover()).toBeNull();
    act(() => tab("Chat").focus());
    press(tab("Chat"), "ArrowRight");
    expect(document.activeElement).toBe(tab("a.ts"));
    act(() => tab("Chat").dispatchEvent(new MouseEvent("dblclick", { bubbles: true })));
    expect(container.querySelector('input[aria-label="Rename Chat"]')).not.toBeNull();
  });

  it("can hold the permanent Board without making it closable or draggable", () => {
    home(
      HOME_BOARD_TAB.id,
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
  });
});

it("groups Ticket Body and Browser tabs behind the same one-tab chip", () => {
  const body: TicketTabDescriptor = { id: "body", kind: "body", label: "Body" };
  const page: TicketTabDescriptor = { id: browser.id, kind: "browser", label: "Page" };
  const session: TicketTabDescriptor = {
    id: "session-1",
    kind: "session",
    label: "zsh",
    status: "idle",
  };
  const onSelect = vi.fn();
  const onClose = vi.fn();
  const render = (activeTabId: string) =>
    act(() =>
      root.render(
        <TicketPaneTabStrip
          label="Ticket tabs"
          projectId="project"
          ticketId="ticket"
          tabs={[body, page, session]}
          activeTabId={activeTabId}
          groups={[
            {
              id: "body-group",
              panes: [
                { paneId: "a", tabIds: [body.id, session.id], activeTabId: body.id },
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
  render(page.id);
  expect(tab("Page").tabIndex).toBe(0);
  expect(container.querySelector('[role="tab"][aria-label="Body"]')).toBeNull();
  click(container.querySelector('[aria-label="Close Page"]')!);
  expect(onClose).toHaveBeenCalledWith(page);
  render(body.id);
  expect(container.querySelector('[aria-label="Close Body"]')).toBeNull();
  click(tab("Body"));
  expect(onSelect).toHaveBeenCalledWith("body");
  // The chip's list carries a terminal's state where the strip already has it.
  const rows = [...popover()!.querySelectorAll('[data-slot="grouped-tab-row"]')];
  expect(rows.map((row) => row.getAttribute("aria-label"))).toEqual(["Body", "zsh, Idle", "Page"]);
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

it("leaves a chip's front out of the sortable — the chip is not dragged, its tabs move in pane strips", () => {
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
  // Every top-level item is an edge target for grouping, the chip by its front.
  expect(
    [...container.querySelectorAll("[data-pair-target-id]")].map((node) =>
      node.getAttribute("data-pair-target-id"),
    ),
  ).toEqual(["x", "chat:one"]);
  expect(chip().getAttribute("data-pair-target-id")).toBe("chat:one");
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

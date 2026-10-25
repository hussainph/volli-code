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

  it("lists the whole group by pane on right-click, front checked, and ungroups from there", async () => {
    const callbacks = home(chat.id);
    await openChipMenu();
    const labels = [...document.querySelectorAll('[data-slot="context-menu-label"]')].map(
      (label) => label.textContent,
    );
    expect(labels).toEqual(["Pane 1", "Pane 2"]);
    const items = [...document.querySelectorAll('[data-slot="context-menu-radio-item"]')];
    expect(items.map((item) => [item.textContent, item.getAttribute("aria-checked")])).toEqual([
      ["Chat", "true"],
      ["Notes", "false"],
      ["Page", "true"],
    ]);
    // A segment's own tab menu gives way to the chip's.
    expect(document.querySelector('[data-slot="context-menu-item"]')?.textContent).toBe("Ungroup");
    await act(async () => {
      items[1]!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(callbacks.select).toHaveBeenCalledWith(term);
    await openChipMenu();
    await act(async () => {
      document
        .querySelector('[data-slot="context-menu-item"]')!
        .dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(callbacks.ungroup).toHaveBeenCalledWith("group-1");
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

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
import { providerMark } from "@renderer/components/models/model-identity";
import { useProjectSessionsStore } from "@renderer/stores/project-sessions";
import { useTicketSessionRecordsStore } from "@renderer/stores/ticket-session-records";
import { useChatSessionsStore } from "@renderer/stores/chat-sessions";
import { useBrowserTabsStore } from "@renderer/stores/browser-tabs";
import {
  EMPTY_SESSION_USAGE_SUMMARY,
  type ChatSessionRecord,
  type SessionPresentationProjection,
} from "@volli/shared";
import { seedSlice } from "@volli/session-presentation";
import { ChatProviderIcon } from "@renderer/components/sessions/chat-provider-icon";
import { projectChatProviders, ticketChatProviders } from "@renderer/lib/session-provider-index";
import { ChatIcon } from "@renderer/components/ui/icon";
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
  useProjectSessionsStore.setState({ byProject: {} });
  useTicketSessionRecordsStore.setState({ byTicket: {} });
  useChatSessionsStore.setState({ sessions: {} });
  useBrowserTabsStore.setState({ byId: {} } as never);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  useProjectSessionsStore.setState({ byProject: {} });
  useTicketSessionRecordsStore.setState({ byTicket: {} });
  useChatSessionsStore.setState({ sessions: {} });
  useBrowserTabsStore.setState({ byId: {} } as never);
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
/** Right-click opens the one shared member popover — there is no second menu. */
async function rightClickChip() {
  await act(async () => {
    chip().dispatchEvent(
      new MouseEvent("contextmenu", { bubbles: true, clientX: 10, clientY: 10 }),
    );
  });
}
/** Hover the chip long enough to clear the intent delay (real timers). */
async function hoverChipOpen() {
  await act(async () => {
    const enter = new MouseEvent("pointerover", { bubbles: true, buttons: 0 });
    Object.defineProperty(enter, "pointerType", { value: "mouse" });
    chip().dispatchEvent(enter);
    await new Promise((done) => setTimeout(done, 300));
  });
}
/**
 * A chip front's commands sit in its tab's action dropdown, named after the
 * tab's own reading — label, plus the quiet detail when the front has one.
 */
function actionsTrigger(label: string, detail?: string | null): HTMLElement {
  const found = container.querySelector<HTMLElement>(
    `[aria-label="Actions for ${detail ? `${label} · ${detail}` : label}"]`,
  );
  if (found === null) throw new Error(`Missing actions trigger for ${label}`);
  return found;
}
/** First argument per call: what each close/select reported, in order. */
function firstArgs(mock: { mock: { calls: unknown[][] } }): unknown[] {
  return mock.mock.calls.map((call) => call[0]);
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
    // The stacked glyph: the front tab's own glyph on the front card, two
    // members' glyphs fanned out behind it, and no state mark — the members'
    // states are said in the popover, never on the chip.
    const stack = front.querySelector('[data-slot="tab-glyph-stack"]')!;
    expect(stack.getAttribute("data-depth")).toBe("3");
    expect(stack.getAttribute("aria-hidden")).toBe("true");
    const cards = [...stack.querySelectorAll('[data-slot="tab-glyph-card"]')];
    expect(cards.map((card) => card.getAttribute("data-layer"))).toEqual(["2", "1", "0"]);
    expect(cards[2]!.querySelector("svg")).not.toBeNull();
    expect(stack.querySelector("[data-session-glyph]")).toBeNull();
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

  it("lists the whole group in member rows — title, detail, state — then Ungroup", async () => {
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
      "Chat, working",
      "Notes",
      "Page, 127.0.0.1:5173/login?next=1",
    ]);
    expect(rows.map((row) => row.getAttribute("role"))).toEqual([
      "menuitem",
      "menuitem",
      "menuitem",
    ]);
    expect(rows[0]!.getAttribute("aria-current")).toBe("true");
    // A chat member's state is said by its glyph, never repeated as a word;
    // a file member's detail rides the row's secondary line.
    expect(rows[0]!.textContent).toBe("Chat");
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
    expect(ungroup.closest(".list-row")!.previousElementSibling?.getAttribute("role")).toBe(
      "separator",
    );
    expect(ungroup.querySelector("svg")).not.toBeNull();
    expect(ungroup.textContent).toBe("Ungroup");
    click(ungroup);
    expect(callbacks.ungroup).toHaveBeenCalledWith("group-1");
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

  it("closes the whole group from the chip's ×, and keeps the strip's keyboard traversal", () => {
    const callbacks = home(chat.id);
    // Main close semantics: the chip's × closes every member; per-member close
    // lives in the member list.
    click(container.querySelector('[aria-label="Close Chat"]')!);
    expect(firstArgs(callbacks.close)).toEqual([chat, term, browser]);
    expect(popover()).toBeNull();
    act(() => tab("Chat").focus());
    press(tab("Chat"), "ArrowRight");
    expect(document.activeElement).toBe(tab("a.ts"));
  });

  it("holds the permanent Board, whose group's close reports every member", () => {
    const callbacks = home(
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
    // The chip's × is the group's, not the Board's: each member is reported to
    // the caller, which owns what closing a permanent tab means.
    click(container.querySelector('[aria-label="Close Board"]')!);
    expect(firstArgs(callbacks.close)).toEqual([HOME_BOARD_TAB, browser]);
  });

  it("names the header after an explicitly set group title, else the front tab", async () => {
    for (const title of ["Workspace", undefined] as const) {
      home(chat.id, [{ ...group, title }]);
      await hoverChipOpen();
      const header = popover()!.querySelector('[data-slot="grouped-tab-popover-header"]')!;
      expect(header.textContent).toBe(title ?? "Chat");
      press(document.body, "Escape");
      expect(popover()).toBeNull();
    }
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
  // The chip's × is the group's: every member is reported.
  click(container.querySelector('[aria-label="Close Page"]')!);
  expect(firstArgs(onClose)).toEqual([body, session, page]);
  render(body.id);
  click(tab("Body"));
  expect(onSelect).toHaveBeenCalledWith("body");
  // The chip's list carries a terminal's state where the strip already has it.
  const rows = [...popover()!.querySelectorAll('[data-slot="grouped-tab-row"]')];
  expect(rows.map((row) => row.getAttribute("aria-label"))).toEqual(["Body", "zsh, idle", "Page"]);
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
          describe={(item) => ({ label: item.id, icon: ChatIcon })}
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

it("keeps twin file captions short and their list directories on the secondary line", async () => {
  const src = {
    ...file,
    id: "file:src/app.ts",
    relPath: "src/app.ts",
    title: "app.ts",
    hint: "src",
  };
  const docs = {
    ...file,
    id: "file:docs/app.ts",
    relPath: "docs/app.ts",
    title: "app.ts",
    hint: "docs",
  };
  act(() =>
    root.render(
      <HomePaneTabStrip
        label="Files"
        projectId="project"
        tabs={[HOME_BOARD_TAB, src, docs]}
        activeTabId={src.id}
        groups={[
          {
            id: "twins",
            panes: [
              { paneId: "left", tabIds: [src.id], activeTabId: src.id },
              { paneId: "right", tabIds: [docs.id], activeTabId: docs.id },
            ],
          },
        ]}
        shownGroupId="twins"
        onUngroup={noop}
        onSelect={noop}
        onClose={noop}
        onRename={noop}
        onPinFile={noop}
        onCloseOtherFiles={noop}
      />,
    ),
  );
  await hoverChipOpen();
  const list = popover()!;
  const rows = [...list.querySelectorAll("[data-tab-id]")];
  expect(rows.map((row) => row.querySelector(".list-row-secondary")?.textContent)).toEqual([
    "src",
    "docs",
  ]);
  expect(rows.map((row) => row.querySelector(".truncate.text-ui")?.textContent)).toEqual([
    "app.ts",
    "app.ts",
  ]);
});

describe("the chip's action dropdown", () => {
  it.each([
    { detail: undefined, status: "working" },
    { detail: null, status: "working" },
    { detail: "src/session.ts", status: "working" },
    { detail: "src/session.ts", status: undefined },
    { detail: undefined, status: undefined },
  ])(
    "renders member detail $detail and status $status once in the dropdown",
    async ({ detail, status }) => {
      const member = { id: "member" };
      const onSelect = vi.fn();
      const onClose = vi.fn();
      act(() =>
        root.render(
          <TabStrip label="Tabs">
            <GroupedTabList
              tabs={[member]}
              groups={[
                {
                  id: "group",
                  panes: [{ paneId: "pane", tabIds: [member.id], activeTabId: member.id }],
                },
              ]}
              activeTabId={member.id}
              shownGroupId="group"
              describe={() => ({ label: "Session", icon: ChatIcon, detail, status })}
              onSelect={onSelect}
              onClose={onClose}
            >
              {() => <Tab label="Session" active tabStop onActivate={noop} />}
            </GroupedTabList>
          </TabStrip>,
        ),
      );
      const trigger = actionsTrigger("Session", detail);
      await act(async () => {
        trigger.focus();
        press(trigger, "ArrowDown");
      });
      const menu = document.querySelector('[data-slot="dropdown-menu-content"]')!;
      const row = menu.querySelector<HTMLButtonElement>('[data-tab-id="member"]')!;
      expect(row.tagName).toBe("BUTTON");
      expect(row.closest(".list-row")?.getAttribute("data-density")).toBe("two-line");
      expect(row.querySelector(".list-row-secondary")?.textContent ?? null).toBe(detail ?? null);
      expect(row.textContent).toBe(`Session${detail ?? ""}${status ?? ""}`);
      act(() => row.focus());
      expect(document.activeElement).toBe(row);
      click(row);
      expect(onSelect).toHaveBeenCalledExactlyOnceWith(member);
      expect(document.querySelector('[data-slot="dropdown-menu-content"]')).toBeNull();
      await act(async () => press(trigger, "ArrowDown"));
      const close = document.querySelector<HTMLButtonElement>('[aria-label="Close: Session"]')!;
      expect(close.tagName).toBe("BUTTON");
      click(close);
      expect(onClose).toHaveBeenCalledExactlyOnceWith(member);
      expect(onSelect).toHaveBeenCalledTimes(1);
      expect(document.querySelector('[data-slot="dropdown-menu-content"]')).toBeNull();
    },
  );

  it("names its header after an explicit group title, else the front tab", async () => {
    home(chat.id, [{ ...group, title: "Workspace" }]);
    const trigger = container.querySelector('[aria-label="Actions for Workspace"]')!;
    await act(async () =>
      trigger.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button: 0 })),
    );
    const menu = document.querySelector('[data-slot="dropdown-menu-content"]')!;
    expect(menu.querySelector('[data-slot="grouped-tab-popover-header"]')?.textContent).toBe(
      "Workspace",
    );
    expect([...menu.querySelectorAll("[data-tab-id]")].map((row) => row.textContent)).toEqual([
      "Chat",
      "Notes",
      "Page",
    ]);
  });

  it.each([undefined, null, "src/session.ts"])(
    "keeps chat detail %s without a redundant status word",
    async (detail) => {
      const member = { id: "member" };
      act(() =>
        root.render(
          <TabStrip label="Tabs">
            <GroupedTabList
              tabs={[member]}
              groups={[
                {
                  id: "group",
                  panes: [{ paneId: "pane", tabIds: [member.id], activeTabId: member.id }],
                },
              ]}
              activeTabId={member.id}
              shownGroupId="group"
              describe={() => ({
                label: "Session",
                icon: ChatIcon,
                detail,
                status: "ready",
                memberGlyph: (
                  <ChatProviderIcon sessionId={null} savedProviderId="anthropic" state="ready" />
                ),
              })}
              onSelect={noop}
            >
              {() => <Tab label="Session" active tabStop onActivate={noop} />}
            </GroupedTabList>
          </TabStrip>,
        ),
      );
      const trigger = actionsTrigger("Session", detail);
      await act(async () =>
        trigger.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button: 0 })),
      );
      const row = document.querySelector(
        '[data-slot="dropdown-menu-content"] [data-tab-id="member"]',
      )!;
      expect(row.closest(".list-row")?.getAttribute("data-density")).toBe(
        detail == null ? "row" : "two-line",
      );
      expect(row.querySelector(".list-row-secondary")?.textContent ?? null).toBe(detail ?? null);
      expect(row.textContent).toBe(`Session${detail ?? ""}`);
      expect(
        row.querySelector('[data-session-glyph="ready"]')?.getAttribute("aria-label"),
      ).toContain("ready");
      expect(row.querySelectorAll("svg")).toHaveLength(2);
    },
  );

  it("offers member actions and Ungroup from the chip's right-click, through the shared list", async () => {
    const callbacks = home(chat.id);
    await rightClickChip();
    const list = popover()!;
    expect(list.textContent).toContain("Page");
    const close = list.querySelector('[aria-label="Close: Page"]')!;
    click(close);
    expect(callbacks.close).toHaveBeenCalledWith(browser);
    expect(popover()).toBeNull();
    await rightClickChip();
    const ungroup = popover()!.querySelector('[data-slot="grouped-tab-ungroup"]')!;
    click(ungroup);
    expect(callbacks.ungroup).toHaveBeenCalledWith(group.id);
    expect(popover()).toBeNull();
  });

  it("puts Take out inside the pane tab dropdown, claims pointer-down, and preserves context parity", async () => {
    const takeOut = vi.fn();
    act(() =>
      root.render(
        <HomePaneTabStrip
          label="Pane tabs"
          projectId="p"
          tabs={[chat]}
          activeTabId={chat.id}
          onSelect={noop}
          onClose={noop}
          onRename={noop}
          onPinFile={noop}
          onCloseOtherFiles={noop}
          onTakeOutTab={takeOut}
        />,
      ),
    );
    expect(container.querySelector('[data-slot="pane-take-out"]')).toBeNull();
    const trigger = container.querySelector('[aria-label="Actions for Chat"]')!;
    const down = new MouseEvent("pointerdown", { bubbles: true, button: 0, cancelable: true });
    await act(async () => trigger.dispatchEvent(down));
    const action = [...document.querySelectorAll('[data-slot="dropdown-menu-item"]')].find((item) =>
      item.textContent?.includes("Take out of group"),
    )!;
    expect(action).toBeDefined();
    click(action);
    expect(takeOut).toHaveBeenCalledExactlyOnceWith(chat.id);
    expect(document.querySelector('[data-slot="dropdown-menu-content"]')).toBeNull();
    await act(async () =>
      tab("Chat").dispatchEvent(
        new MouseEvent("contextmenu", { bubbles: true, clientX: 10, clientY: 10 }),
      ),
    );
    expect(document.querySelector('[data-slot="context-menu-content"]')?.textContent).toContain(
      "Take out of group",
    );
  });

  it("owns the pointer while open: the hover list stands down and a member action dismisses it", async () => {
    const callbacks = home(chat.id);
    await hoverChipOpen();
    expect(popover()).not.toBeNull();
    const trigger = chip().querySelector('[aria-label="Actions for Chat"]')!;
    await act(async () =>
      trigger.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button: 0 })),
    );
    // Opening the command menu closes the hover list; the chip stops hounding.
    expect(popover()).toBeNull();
    const menu = document.querySelector('[data-slot="dropdown-menu-content"]')!;
    const close = menu.querySelector('[aria-label="Close: Page"]')!;
    expect(close).not.toBeNull();
    click(close);
    expect(callbacks.close).toHaveBeenCalledExactlyOnceWith(browser);
    expect(document.querySelector('[data-slot="dropdown-menu-content"]')).toBeNull();
  });
});

function savedChat(providerId: string | null): ChatSessionRecord {
  return {
    sessionId: "one",
    projectId: "project",
    ticketId: null,
    title: "Chat",
    createdAt: 1,
    adapterId: null,
    live: false,
    activity: "idle",
    waitingOn: null,
    outcome: null,
    lastActivityAt: 1,
    bornTicketless: true,
    role: "project",
    parentSessionId: null,
    model: providerId === null ? null : { providerId, modelId: "test", reasoningLevel: "off" },
  };
}

function saveProvider(providerId: string | null) {
  const record = savedChat(providerId);
  act(() => {
    useProjectSessionsStore.setState({
      byProject: { project: { terminal: [], chat: [record], provenance: {} } },
    });
    useTicketSessionRecordsStore.setState({
      byTicket: {
        ticket: [
          {
            kind: "chat",
            record: { ...record, ticketId: "ticket" },
            usage: EMPTY_SESSION_USAGE_SUMMARY,
            provenance: { kind: "user" },
          },
        ],
      },
    });
  });
}

it("indexes each roster once, not once per icon or unrelated store update", () => {
  const rows = Array.from({ length: 1000 }, (_, index) => ({
    ...savedChat("anthropic"),
    sessionId: String(index),
  }));
  const ticketRows = rows.map((record) => ({
    kind: "chat" as const,
    record,
    usage: EMPTY_SESSION_USAGE_SUMMARY,
    provenance: { kind: "user" as const },
  }));
  const projectScan = vi.spyOn(rows, "map");
  const ticketScan = vi.spyOn(ticketRows, "flatMap");
  const projects = projectChatProviders(rows);
  const tickets = ticketChatProviders(ticketRows);
  for (const row of rows) {
    expect(projectChatProviders(rows).get(row.sessionId)).toBe("anthropic");
    expect(ticketChatProviders(ticketRows).get(row.sessionId)).toBe("anthropic");
  }
  expect(projectChatProviders(rows)).toBe(projects);
  expect(ticketChatProviders(ticketRows)).toBe(tickets);
  expect(projectScan).toHaveBeenCalledTimes(1);
  expect(ticketScan).toHaveBeenCalledTimes(1);
  expect(
    projectChatProviders([{ ...savedChat(null), sessionId: "__proto__" }]).get("__proto__"),
  ).toBeNull();
  expect(projectChatProviders(undefined).size).toBe(0);
  expect(ticketChatProviders(undefined).size).toBe(0);
  // Icons consume row data; they must never independently read either roster.
  act(() =>
    root.render(
      <>
        {rows.map((row) => (
          <ChatProviderIcon
            key={row.sessionId}
            sessionId={row.sessionId}
            savedProviderId="anthropic"
          />
        ))}
      </>,
    ),
  );
  projectScan.mockClear();
  ticketScan.mockClear();
  act(() => {
    useProjectSessionsStore.setState({
      byProject: { other: { terminal: [], chat: rows, provenance: {} } },
    });
    useTicketSessionRecordsStore.setState({ byTicket: { other: ticketRows } });
  });
  expect(projectScan).not.toHaveBeenCalled();
  expect(ticketScan).not.toHaveBeenCalled();
  projectScan.mockRestore();
  ticketScan.mockRestore();
});

function ticketGroup() {
  act(() =>
    root.render(
      <TicketPaneTabStrip
        label="Ticket tabs"
        projectId="project"
        ticketId="ticket"
        tabs={[
          { kind: "chat", id: chat.id, label: "Chat", status: "working" },
          { kind: "browser", id: browser.id, label: "Page", browserTabId: "one" },
        ]}
        activeTabId={chat.id}
        groups={[group]}
        shownGroupId={group.id}
        onSelectTab={noop}
        onCloseTab={noop}
        onRenameSessionTab={noop}
      />,
    ),
  );
}

function expectProvider(node: Element, providerId: string) {
  const mark = providerMark(providerId)!;
  const svg = node.querySelector("svg")!;
  expect(svg.getAttribute("fill")).toBe(mark.tint);
  expect([...svg.querySelectorAll("path")].map((path) => path.getAttribute("d"))).toEqual(
    mark.paths,
  );
}

function expectChatMember(row: Element) {
  expect(row.textContent).toBe("Chat");
  expect(row.querySelector(".list-row-secondary")).toBeNull();
  expect(row.closest(".list-row")?.getAttribute("data-density")).toBe("row");
  const glyph = row.querySelector('[data-session-glyph="working"]')!;
  expect(glyph.getAttribute("aria-label")).toContain("working");
  expect(glyph.closest('[aria-hidden="true"]')).toBeNull();
  expect(glyph.querySelector('[class*="animate-spin"]')).not.toBeNull();
}

describe.each(["Home", "Ticket"] as const)("%s grouped chat artwork", (surface) => {
  const mount = () => (surface === "Home" ? home(chat.id) : ticketGroup());

  it("uses the saved provider on the chip's cards, in the list and the dropdown, without changing names or other kinds", async () => {
    saveProvider("anthropic");
    mount();
    const chipNode = chip();
    // The front card carries the front tab's saved-provider artwork; the
    // members behind keep their own kinds' glyphs.
    const frontCard = chipNode.querySelector('[data-slot="tab-glyph-card"][data-layer="0"]')!;
    expectProvider(frontCard, "anthropic");
    expect(
      chipNode.querySelector('[data-slot="tab-glyph-stack"]')?.getAttribute("aria-hidden"),
    ).toBe("true");
    expect(chipNode.querySelector('[role="tab"]')?.getAttribute("aria-label")).toBe("Chat");
    const behindCards = [...chipNode.querySelectorAll('[data-slot="tab-glyph-card"]')].filter(
      (card) => card.getAttribute("data-layer") !== "0",
    );
    expect(behindCards.length).toBeGreaterThan(0);
    const behindBefore = behindCards.map((card) => card.innerHTML);
    // Changing the saved provider updates an already mounted chip.
    saveProvider("openai-codex");
    expectProvider(frontCard, "openai-codex");
    expect(
      [...chipNode.querySelectorAll('[data-slot="tab-glyph-card"]')]
        .filter((card) => card.getAttribute("data-layer") !== "0")
        .map((card) => card.innerHTML),
    ).toEqual(behindBefore);
    // The member list carries the live member glyph — provider and state.
    await hoverChipOpen();
    const list = popover()!;
    const listRow = list.querySelector(`[data-tab-id="${chat.id}"]`)!;
    expectProvider(listRow, "openai-codex");
    expectChatMember(listRow);
    expect(list.querySelector('[data-slot="group-member-heading"]')).toBeNull();
    expect(frontCard.querySelector("[data-session-glyph]")).toBeNull();
    // The action dropdown shows the same rows.
    await act(async () =>
      chipNode
        .querySelector('[aria-label="Actions for Chat"]')!
        .dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button: 0 })),
    );
    const dropdown = document.querySelector('[data-slot="dropdown-menu-content"]')!;
    const dropdownRow = dropdown.querySelector(`[data-tab-id="${chat.id}"]`)!;
    expectProvider(dropdownRow, "openai-codex");
    expectChatMember(dropdownRow);
    expect(dropdown.querySelector('[data-slot="group-member-heading"]')).toBeNull();
  });

  it.each([null, "unknown-provider"])(
    "keeps the chat fallback for provider %s",
    async (providerId) => {
      saveProvider(providerId);
      mount();
      const svg = container.querySelector('[data-slot="tab-glyph-card"][data-layer="0"] svg')!;
      expect(svg.classList.contains("text-muted-foreground")).toBe(true);
      expect(svg.getAttribute("fill")).not.toBe(providerMark("anthropic")!.tint);
      await act(async () =>
        container
          .querySelector('[aria-label="Actions for Chat"]')!
          .dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button: 0 })),
      );
      const row = document.querySelector(
        `[data-slot="dropdown-menu-content"] [data-tab-id="${chat.id}"]`,
      )!;
      expectChatMember(row);
      expect(
        row.querySelector("[data-session-glyph] svg")?.classList.contains("text-muted-foreground"),
      ).toBe(true);
    },
  );

  it("prefers a resident model selection to the saved provider and reacts without remounting", () => {
    saveProvider("anthropic");
    mount();
    const projection: SessionPresentationProjection = {
      session: {
        id: "one",
        projectId: "project",
        ticketId: null,
        role: "project",
        parentSessionId: null,
        title: "Chat",
        createdAt: 1,
      },
      status: "open",
      liveExecutor: null,
      attention: { active: [], primary: null },
      interactions: { active: [], resolved: [] },
      signal: null,
      modelTier: null,
      modelSelection: { providerId: "google", modelId: "test", reasoningLevel: "off" },
      turnActive: false,
      lastActivityAt: 1,
      bornTicketless: true,
      scheduledResume: null,
    };
    act(() =>
      useChatSessionsStore.setState({ sessions: { one: { ...seedSlice("ready"), projection } } }),
    );
    expectProvider(
      container.querySelector('[data-slot="tab-glyph-card"][data-layer="0"]')!,
      "google",
    );
    act(() => useChatSessionsStore.setState({ sessions: {} }));
    expectProvider(
      container.querySelector('[data-slot="tab-glyph-card"][data-layer="0"]')!,
      "anthropic",
    );
  });
});

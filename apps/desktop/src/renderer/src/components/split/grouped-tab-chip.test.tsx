// @vitest-environment jsdom
import { act } from "react";

import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  HOME_BOARD_TAB,
  HomePaneTabStrip,
  type HomeTabDescriptor,
} from "@renderer/components/home/home-tab-strip";
import { TicketPaneTabStrip } from "@renderer/components/ticket/ticket-tabs";
import { providerMark } from "@renderer/components/models/model-identity";
import { useProjectSessionsStore } from "@renderer/stores/project-sessions";
import { useTicketSessionRecordsStore } from "@renderer/stores/ticket-session-records";
import { useChatSessionsStore } from "@renderer/stores/chat-sessions";
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

describe("one capsule per group", () => {
  it("has one roving tab, a flat overlapping stack, and no focused-member underline", () => {
    home(chat.id);
    const chip = container.querySelector('[data-slot="grouped-tab-chip"]')!;
    const capsule = chip.querySelector<HTMLElement>('[role="tab"]')!;
    expect(chip.querySelectorAll('[role="tab"]')).toHaveLength(1);
    expect(capsule.getAttribute("aria-label")).toBe("Chat");
    expect(capsule.getAttribute("aria-selected")).toBe("true");
    expect(chip.querySelectorAll(".group-icon-disc")).toHaveLength(3);
    expect(chip.querySelector("[data-focused]")).toBeNull();
    home(browser.id);
    expect(chip.querySelector('[role="tab"]')).toBe(capsule);
    expect(capsule.tabIndex).toBe(0);
  });
  it("keeps an inactive group as one capsule beside single tabs", () => {
    const callbacks = home(file.id, [group], null);
    expect(tab("Chat").getAttribute("aria-selected")).toBe("false");
    expect(tab("a.ts").getAttribute("aria-selected")).toBe("true");
    click(tab("Chat"));
    expect(callbacks.select).toHaveBeenCalledWith(chat);
    act(() => tab("Chat").focus());
    press(tab("Chat"), "ArrowRight");
    expect(document.activeElement).toBe(tab("a.ts"));
  });
  it("keeps twin file captions short and their hover-list directories on the secondary line", async () => {
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
    const chip = container.querySelector('[data-slot="grouped-tab-chip"]')!;
    await act(async () => {
      chip.dispatchEvent(new MouseEvent("pointerover", { bubbles: true }));
      await new Promise((done) => setTimeout(done, 300));
    });
    const card = document.querySelector('[data-slot="hover-card-content"]')!;
    expect(
      [...card.querySelectorAll(".list-row-secondary")].map((node) => node.textContent),
    ).toEqual(["src", "docs"]);
    expect(
      [...card.querySelectorAll("[data-tab-id] .truncate.text-ui")].map((node) => node.textContent),
    ).toEqual(["app.ts", "app.ts"]);
  });

  it("lists all members on hover, retaining their details and status", async () => {
    const callbacks = home(chat.id);
    const chip = container.querySelector('[data-slot="grouped-tab-chip"]')!;
    await act(async () => {
      chip.dispatchEvent(new MouseEvent("pointerover", { bubbles: true }));
      await new Promise((done) => setTimeout(done, 300));
    });
    const card = document.querySelector('[data-slot="hover-card-content"]')!;
    expect(card.getAttribute("aria-label")).toBe("Tab group items");
    expect(card.textContent).toContain("Chat");
    expect(card.textContent).not.toContain("working");
    expect(
      card.querySelector('[data-session-glyph="working"]')?.getAttribute("aria-label"),
    ).toContain("working");
    const notes = [...card.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("Notes"),
    )!;
    click(notes);
    expect(callbacks.select).toHaveBeenCalledWith(term);
  });
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
      const trigger = container.querySelector<HTMLElement>('[aria-label="Actions for Session"]')!;
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

  it.each([undefined, "Workspace"])(
    "only shows an explicitly set group header (%s)",
    async (title) => {
      home(chat.id, [{ ...group, title }]);
      const trigger = container.querySelector(`[aria-label="Actions for ${title ?? "Chat"}"]`)!;
      await act(async () =>
        trigger.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button: 0 })),
      );
      const menu = document.querySelector('[data-slot="dropdown-menu-content"]')!;
      expect(menu.querySelector('[data-slot="group-member-heading"]')?.textContent ?? null).toBe(
        title ?? null,
      );
      expect(menu.textContent?.match(/Chat/g)).toHaveLength(1);
      expect([...menu.querySelectorAll("[data-tab-id]")].map((row) => row.textContent)).toEqual([
        "Chat",
        "Notes",
        "Page",
      ]);
    },
  );

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
      const trigger = container.querySelector('[aria-label="Actions for Session"]')!;
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

  it("offers member actions and Ungroup in its context menu", async () => {
    const callbacks = home(chat.id);
    await openChipMenu();
    const menu = document.querySelector('[data-slot="grouped-tab-menu"]')!;
    expect(menu.textContent).toContain("Page");
    const close = menu.querySelector('[aria-label="Close: Page"]')!;
    click(close);
    expect(callbacks.close).toHaveBeenCalledWith(browser);
    await openChipMenu();
    const ungroup = [...document.querySelectorAll('[data-slot="context-menu-item"]')].find(
      (item) => item.textContent === "Ungroup",
    )!;
    click(ungroup);
    expect(callbacks.ungroup).toHaveBeenCalledWith(group.id);
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
  it("lets the dropdown own the pointer and runs a member action before dismissing", async () => {
    const callbacks = home(chat.id);
    const chip = container.querySelector('[data-slot="grouped-tab-chip"]')!;
    await act(async () => {
      chip.dispatchEvent(new MouseEvent("pointerover", { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 300));
    });
    const trigger = chip.querySelector('[aria-label="Actions for Chat"]')!;
    await act(async () =>
      trigger.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button: 0 })),
    );
    expect(
      document.querySelector('[data-slot="hover-card-content"][data-state="open"]'),
    ).toBeNull();
    const menu = document.querySelector('[data-slot="dropdown-menu-content"]')!;
    const close = menu.querySelector('[aria-label="Close: Page"]')!;
    expect(close).not.toBeNull();
    click(close);
    expect(callbacks.close).toHaveBeenCalledExactlyOnceWith(browser);
    expect(document.querySelector('[data-slot="dropdown-menu-content"]')).toBeNull();
  });
  it("uses a +N after three icons without expanding into member capsules", () => {
    const four = {
      ...group,
      panes: [...group.panes, { paneId: "p3", tabIds: [file.id], activeTabId: file.id }],
    };
    home(chat.id, [four]);
    const chip = container.querySelector('[data-slot="grouped-tab-chip"]')!;
    expect(chip.querySelectorAll(".group-icon-disc")).toHaveLength(3);
    expect(chip.textContent).toContain("+1");
    expect(chip.querySelectorAll('[role="tab"]')).toHaveLength(1);
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

  it("uses the saved provider in the disc, hover and dropdown, without changing names or other kinds", async () => {
    saveProvider("anthropic");
    mount();
    const chip = container.querySelector('[data-slot="grouped-tab-chip"]')!;
    const disc = chip.querySelector(".group-icon-disc")!;
    expectProvider(disc, "anthropic");
    expect(chip.querySelector(".group-icon-stack")?.getAttribute("aria-hidden")).toBe("true");
    expect(chip.querySelector('[role="tab"]')?.getAttribute("aria-label")).toBe("Chat");
    const otherIcons = [...chip.querySelectorAll(".group-icon-disc")]
      .slice(1)
      .map((node) => node.innerHTML);
    // Changing the saved provider updates an already mounted chip.
    saveProvider("openai-codex");
    expectProvider(disc, "openai-codex");
    expect(
      [...chip.querySelectorAll(".group-icon-disc")].slice(1).map((node) => node.innerHTML),
    ).toEqual(otherIcons);
    await act(async () => {
      chip.dispatchEvent(new MouseEvent("pointerover", { bubbles: true }));
      await new Promise((done) => setTimeout(done, 300));
    });
    const hover = document.querySelector('[data-slot="hover-card-content"]')!;
    const hoverRow = hover.querySelector(`[data-tab-id="${chat.id}"]`)!;
    expectProvider(hoverRow, "openai-codex");
    expectChatMember(hoverRow);
    expect(hover.querySelector('[data-slot="group-member-heading"]')).toBeNull();
    expect(disc.querySelector("[data-session-glyph]")).toBeNull();
    await act(async () =>
      chip
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
      const svg = container.querySelector(".group-icon-disc svg")!;
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
    expectProvider(container.querySelector(".group-icon-disc")!, "google");
    act(() => useChatSessionsStore.setState({ sessions: {} }));
    expectProvider(container.querySelector(".group-icon-disc")!, "anthropic");
  });
});

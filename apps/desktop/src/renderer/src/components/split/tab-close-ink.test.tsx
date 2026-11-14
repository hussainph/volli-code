// @vitest-environment jsdom
import * as React from "react";
import { act } from "react";

import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { HomePaneTabStrip, type HomeTabDescriptor } from "@renderer/components/home/home-tab-strip";
import {
  TicketPaneTabStrip,
  type TicketTabDescriptor,
} from "@renderer/components/ticket/ticket-tabs";
import { useBrowserTabsStore } from "@renderer/stores/browser-tabs";
import { useChatSessionsStore } from "@renderer/stores/chat-sessions";
import { useProjectSessionsStore } from "@renderer/stores/project-sessions";
import { useTicketSessionRecordsStore } from "@renderer/stores/ticket-session-records";
import type { TabGroup } from "./grouped-tab-chip";

/**
 * VC-1229: a tab's Close carries one ink in both of its menus, and the tab
 * kind decides it. Session tabs (terminal, chat) close running work and read
 * destructive; Browser, File and Diff tabs are views that reopen and read plain.
 */
const noop = () => {};

const homeTabs: readonly HomeTabDescriptor[] = [
  { kind: "chat", id: "chat:c1", sessionId: "c1", title: "Chat", status: "idle" },
  {
    kind: "terminal",
    id: "t1",
    tab: {
      sessionId: "t1",
      title: "Shell",
      scope: { kind: "project", projectId: "p" },
      layout: { kind: "pane", sessionId: "t1", exitCode: null },
      activePaneId: "t1",
    },
  },
  {
    kind: "browser",
    id: "browser:b1",
    tabId: "b1",
    title: "Page",
    loading: false,
    driven: false,
    heldBy: null,
  },
  {
    kind: "file",
    id: "file:a.ts",
    relPath: "a.ts",
    title: "a.ts",
    hint: null,
    preview: false,
    dirty: false,
  },
];
const ticketTabs: readonly TicketTabDescriptor[] = [
  { id: "chat:c2", kind: "chat", label: "Chat" },
  { id: "s2", kind: "session", label: "Shell" },
  { id: "browser:b2", kind: "browser", label: "Page", browserTabId: "b2" },
  { id: "file:b.ts", kind: "file", label: "b.ts", relPath: "b.ts" },
  { id: "diff:c.ts", kind: "diff", label: "c.ts", relPath: "c.ts" },
];

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({ matches: false, addEventListener: noop, removeEventListener: noop })),
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
  vi.unstubAllGlobals();
});

type Surface = "Home" | "Ticket";

function strip(surface: Surface, groups?: readonly TabGroup[]): React.ReactElement {
  return surface === "Home" ? (
    <HomePaneTabStrip
      label="Home tabs"
      projectId="p"
      tabs={homeTabs}
      activeTabId={homeTabs[0]!.id}
      groups={groups}
      shownGroupId={groups?.[0]?.id ?? null}
      onSelect={noop}
      onClose={noop}
      onRename={noop}
      onPinFile={noop}
      onCloseOtherFiles={noop}
    />
  ) : (
    <TicketPaneTabStrip
      label="Ticket tabs"
      projectId="p"
      ticketId="t"
      tabs={ticketTabs}
      activeTabId={ticketTabs[0]!.id}
      groups={groups}
      shownGroupId={groups?.[0]?.id ?? null}
      onSelectTab={noop}
      onCloseTab={noop}
      onRenameSessionTab={noop}
    />
  );
}

/** A fresh strip per menu, so no portal from the last menu is still open. */
function render(element: React.ReactElement) {
  act(() => root.render(<></>));
  act(() => root.render(element));
}

/** The Close row's variant in a menu, or null when the menu has no Close. */
function closeVariant(slot: "dropdown-menu-item" | "context-menu-item"): string | null {
  const row = [...document.querySelectorAll(`[data-slot="${slot}"]`)].find(
    (item) => item.textContent?.trim() === "Close",
  );
  return row?.getAttribute("data-variant") ?? null;
}

async function dropdownClose(surface: Surface, label: string): Promise<string | null> {
  render(strip(surface));
  const trigger = container.querySelector(`[aria-label="Actions for ${label}"]`)!;
  await act(async () =>
    trigger.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button: 0 })),
  );
  return closeVariant("dropdown-menu-item");
}

async function contextClose(surface: Surface, label: string): Promise<string | null> {
  render(strip(surface));
  const tab = container.querySelector(`[role="tab"][aria-label="${label}"]`)!;
  await act(async () =>
    tab.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 10, clientY: 10 })),
  );
  return closeVariant("context-menu-item");
}

async function chipClose(surface: Surface, groups: readonly TabGroup[]): Promise<string | null> {
  render(strip(surface, groups));
  const trigger = container.querySelector('[data-slot="grouped-tab-chip"] [data-slot="tab-menu"]')!;
  await act(async () =>
    trigger.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button: 0 })),
  );
  return closeVariant("dropdown-menu-item");
}

function pair(a: string, b: string): TabGroup[] {
  return [
    {
      id: "g",
      panes: [
        { paneId: "a", tabIds: [a], activeTabId: a },
        { paneId: "b", tabIds: [b], activeTabId: b },
      ],
    },
  ];
}

describe("tab Close ink (VC-1229)", () => {
  it.each([
    ["Home", "Chat"],
    ["Home", "Shell"],
    ["Ticket", "Chat"],
    ["Ticket", "Shell"],
  ] as const)(
    "%s %s tab: destructive in the dropdown and the right-click menu",
    async (surface, label) => {
      expect(await dropdownClose(surface, label)).toBe("destructive");
      expect(await contextClose(surface, label)).toBe("destructive");
    },
  );

  it.each([
    ["Home", "Page"],
    ["Home", "a.ts"],
  ] as const)(
    "%s %s tab: plain in the dropdown and the right-click menu",
    async (surface, label) => {
      expect(await dropdownClose(surface, label)).toBe("default");
      expect(await contextClose(surface, label)).toBe("default");
    },
  );

  it.each(["Page", "b.ts", "c.ts"])(
    "Ticket %s tab: plain in the dropdown; its right-click menu has no Close",
    async (label) => {
      expect(await dropdownClose("Ticket", label)).toBe("default");
      // These kinds' right-click menus carry no Close of their own.
      expect(await contextClose("Ticket", label)).toBeNull();
    },
  );

  it.each(["Home", "Ticket"] as const)(
    "%s group chip: Close is destructive when any member is a Session, plain otherwise",
    async (surface) => {
      const [chat, , page, file] = surface === "Home" ? homeTabs : ticketTabs;
      expect(await chipClose(surface, pair(chat!.id, page!.id))).toBe("destructive");
      expect(await chipClose(surface, pair(page!.id, file!.id))).toBe("default");
    },
  );
});

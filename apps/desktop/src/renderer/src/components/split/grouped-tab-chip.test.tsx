// @vitest-environment jsdom
import { act } from "react";

import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  HOME_BOARD_TAB,
  HomePaneTabStrip,
  type HomeTabDescriptor,
} from "@renderer/components/home/home-tab-strip";
import { groupTabItems, type TabGroup } from "./grouped-tab-chip";

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
    expect(card.textContent).toContain("working");
    const notes = [...card.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("Notes"),
    )!;
    click(notes);
    expect(callbacks.select).toHaveBeenCalledWith(term);
  });
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

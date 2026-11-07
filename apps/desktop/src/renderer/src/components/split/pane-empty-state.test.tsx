// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { PaneEmptyState } from "./pane-empty-state";
let container: HTMLDivElement, root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.body.appendChild(document.createElement("div"));
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
function render(handlers: Partial<React.ComponentProps<typeof PaneEmptyState>> = {}) {
  act(() =>
    root.render(
      <PaneEmptyState
        onNewChat={vi.fn()}
        onNewTerminal={vi.fn()}
        onNewBrowser={vi.fn()}
        onOpenFile={vi.fn()}
        onClosePane={vi.fn()}
        {...handlers}
      />,
    ),
  );
}
async function openMenu() {
  await act(async () =>
    container
      .querySelector<HTMLButtonElement>('[aria-label="Pane actions"]')!
      .dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
      ),
  );
}
const entries = () => [
  ...container.querySelectorAll<HTMLElement>('[data-slot="pane-empty-row"]'),
  ...document.querySelectorAll<HTMLElement>('[role="menuitem"]'),
];
describe("PaneEmptyState", () => {
  it("offers all five verbs, with secondary choices in the shared pane inventory", async () => {
    render();
    await openMenu();
    expect(entries().map((row) => row.getAttribute("aria-label"))).toEqual([
      "New chat",
      "New terminal",
      "New browser",
      "Open file…",
      "Close pane",
    ]);
  });
  it("uses a compact panel illustration, one primary action and a separated close", async () => {
    render();
    expect(container.querySelector(".empty-state")?.getAttribute("data-tier")).toBe("panel");
    expect(container.querySelectorAll(".empty-state button")).toHaveLength(1);
    await openMenu();
    expect(document.querySelector('[role="menu"] [role="separator"]')).not.toBeNull();
    expect(entries().at(-1)?.textContent).toBe("Close pane");
  });
  it("names chat without its chord and preserves the keyboard focus landing target", () => {
    render();
    const chat = container.querySelector('[data-slot="pane-empty-row"]')!;
    expect(chat.textContent).toContain("⌘T");
    expect(chat.getAttribute("aria-label")).toBe("New chat");
    expect(chat.getAttribute("aria-keyshortcuts")).toBe("Meta+T");
  });
  it("gives Browser no invented chord", async () => {
    render();
    await openMenu();
    const browser = entries().find((row) => row.getAttribute("aria-label") === "New browser")!;
    expect(browser.getAttribute("aria-keyshortcuts")).toBeNull();
    expect(browser.textContent).toBe("New browser");
  });
  it("gives Close pane no invented chord", async () => {
    render();
    await openMenu();
    expect(entries().at(-1)?.getAttribute("aria-keyshortcuts")).toBeNull();
  });
  it("runs each original callback, including after the inventory has closed and reopened", async () => {
    const actions = {
      onNewChat: vi.fn(),
      onNewTerminal: vi.fn(),
      onNewBrowser: vi.fn(),
      onOpenFile: vi.fn(),
      onClosePane: vi.fn(),
    };
    render(actions);
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[aria-label="New chat"]')!.click(),
    );
    for (const name of ["New terminal", "New browser", "Open file…", "Close pane"]) {
      await openMenu();
      await act(async () =>
        entries()
          .find((row) => row.getAttribute("aria-label") === name)!
          .click(),
      );
    }
    for (const action of Object.values(actions)) expect(action).toHaveBeenCalledOnce();
  });
  it("states the reason without adding chat onboarding copy", () => {
    render();
    expect(container.querySelector("h2")?.textContent).toBe("No open tabs");
    expect(container.querySelector("p")).toBeNull();
    expect(container.textContent).not.toContain("drag a tab");
  });
});

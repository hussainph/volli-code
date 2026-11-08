// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, describe, it, expect, vi } from "vite-plus/test";
import { SidebarProvider } from "@renderer/components/ui/sidebar";
import { PrimarySidebar } from "./primary-sidebar";

const { selection } = vi.hoisted(() => ({
  selection: {
    project: { id: "p", name: "Project", ticketPrefix: "VC" } as {
      id: string;
      name: string;
      ticketPrefix: string;
    } | null,
  },
}));
vi.mock("@renderer/hooks/use-selected-project", () => ({
  useSelectedProject: () => selection.project,
}));
vi.mock("@renderer/hooks/use-active-nav", () => ({ useActiveNav: () => ["home", () => {}] }));
vi.mock("@renderer/components/sidebar/nav-list", () => ({
  NavList: () => <div data-testid="feature-nav">Home Automations</div>,
}));
vi.mock("@renderer/components/cloud-moves/cloud-moves", () => ({ CloudMoveRailRow: () => null }));
vi.mock("@renderer/components/sidebar/update-button", () => ({ UpdateButton: () => null }));
vi.mock("./sidebar-files", () => ({
  SidebarFiles: () => <div data-testid="sidebar-files">Files tree</div>,
}));
const { mounts, listing, newChat, newTerminal } = vi.hoisted(() => ({
  mounts: vi.fn(),
  listing: { count: 0 },
  newChat: vi.fn(),
  newTerminal: vi.fn(),
}));
vi.mock("@renderer/components/sessions/session-create", () => ({
  startProjectChat: newChat,
  startProjectTerminal: newTerminal,
}));
vi.mock("@renderer/components/sidebar/active-sessions", () => ({
  ActiveSessions: ({ visible }: { visible: boolean }) => {
    useState(() => mounts());
    return (
      <div data-testid="sidebar-sessions" data-visible={visible}>
        {listing.count > 0 ? <h3>Active{listing.count}</h3> : null}
        Sessions list
      </div>
    );
  },
}));
vi.mock("@renderer/components/sidebar/sidebar-scroll", () => ({
  SidebarScrollArea: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="session-scrollport">{children}</div>
  ),
}));

describe("primary sidebar content choice", () => {
  let root: Root;
  let container: HTMLElement;
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    vi.stubGlobal("matchMedia", () => ({
      matches: false,
      addEventListener() {},
      removeEventListener() {},
    }));
    vi.clearAllMocks();
    listing.count = 0;
    selection.project = { id: "p", name: "Project", ticketPrefix: "VC" };
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[data-choice="sessions"]')?.click(),
    );
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });
  async function show() {
    await act(async () =>
      root.render(
        <SidebarProvider>
          <PrimarySidebar />
        </SidebarProvider>,
      ),
    );
  }
  it("pins borderless icon-only choices directly above Settings, outside both scrollports", async () => {
    await show();
    const chrome = container.querySelector('[data-slot="navigator-selector"]')!;
    const switcher = chrome.querySelector('[aria-label="Sidebar content"]')!;
    expect(chrome.className).toContain("h-[22px]");
    expect(switcher.textContent).toBe("");
    expect(switcher.className).toContain("h-[22px]");
    expect(switcher.className).not.toContain("glass");
    const footer = container.querySelector('[data-slot="sidebar-footer"]')!;
    expect(chrome.parentElement).toBe(footer);
    expect(chrome.nextElementSibling?.textContent).toBe("Settings");
    expect(chrome.className).not.toMatch(/\bborder(?:-b)?\b/);
    expect(container.querySelector('[data-testid="feature-nav"]')?.nextElementSibling).not.toBe(
      chrome,
    );
    expect(container.querySelector('[data-slot="sidebar-header"]')?.textContent).toBe("ProjectVC");
    for (const tab of switcher.querySelectorAll("button")) {
      expect(tab.className).toContain("size-6");
      expect(tab.querySelector("svg")?.classList.contains("size-3.5")).toBe(true);
      expect(tab.closest('[data-testid="session-scrollport"]')).toBeNull();
    }
    const sessions = switcher.querySelector<HTMLButtonElement>('[data-choice="sessions"]')!;
    await act(async () =>
      sessions.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })),
    );
    const files = switcher.querySelector<HTMLButtonElement>('[data-choice="files"]')!;
    expect(files.getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(files);
    expect(files.className).toContain("text-primary");
    expect(sessions.className).toContain("text-muted-foreground");
    await act(async () =>
      files.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })),
    );
    expect(document.activeElement).toBe(sessions);
    await act(async () =>
      sessions.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true })),
    );
    expect(document.activeElement).toBe(files);
    await act(async () =>
      files.dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true })),
    );
    expect(document.activeElement).toBe(sessions);
  });
  it("keeps Settings without offering project content or creation when no project is selected", async () => {
    selection.project = null;
    await show();
    expect(container.querySelector('[data-slot="navigator-selector"]')).toBeNull();
    expect(container.querySelector('[aria-label="Open a tab"]')).toBeNull();
    expect(container.querySelector('[data-slot="sidebar-footer"]')?.textContent).toBe("Settings");
  });
  it("remembers Files in this window and suspends hidden session activity", async () => {
    await show();
    const files = container.querySelector<HTMLButtonElement>('[data-choice="files"]')!;
    expect(files.getAttribute("aria-selected")).toBe("false");
    await act(async () => files.click());
    expect(container.querySelector('[data-testid="sidebar-files"]')).not.toBeNull();
    expect(
      container.querySelector('[data-testid="sidebar-sessions"]')?.getAttribute("data-visible"),
    ).toBe("false");
    await act(async () => root.render(null));
    await show();
    expect(container.querySelector('[data-choice="files"]')?.getAttribute("aria-selected")).toBe(
      "true",
    );
    const sessions = container.querySelector<HTMLButtonElement>('[data-choice="sessions"]')!;
    await act(async () => sessions.click());
    expect(
      container.querySelector<HTMLElement>('[data-testid="sidebar-files"]')?.style.display,
    ).toBe("none");
    expect(
      container.querySelector('[data-testid="sidebar-sessions"]')?.getAttribute("data-visible"),
    ).toBe("true");
  });
  it("hides the session roster without remounting it when Files is toggled", async () => {
    await show();
    const roster = container.querySelector('[data-testid="sidebar-sessions"]');
    for (const choice of ["files", "sessions", "files", "sessions"]) {
      await act(async () =>
        container.querySelector<HTMLButtonElement>(`[data-choice="${choice}"]`)!.click(),
      );
      expect(container.querySelector('[data-testid="sidebar-sessions"]')).toBe(roster);
    }
    expect(mounts).toHaveBeenCalledTimes(1);
  });
  it("keeps independent nonzero scroll positions through repeated mode changes", async () => {
    await show();
    const sessions = container.querySelector<HTMLElement>('[data-testid="session-scrollport"]')!;
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[data-choice="files"]')!.click(),
    );
    const files = container.querySelector<HTMLElement>('[data-testid="sidebar-files"]')!;
    sessions.scrollTop = 291;
    files.scrollTop = 405;
    for (const choice of ["sessions", "files", "sessions", "files"]) {
      await act(async () =>
        container.querySelector<HTMLButtonElement>(`[data-choice="${choice}"]`)!.click(),
      );
      expect(container.querySelector('[data-testid="session-scrollport"]')).toBe(sessions);
      expect(container.querySelector('[data-testid="sidebar-files"]')).toBe(files);
      expect(sessions.scrollTop).toBe(291);
      expect(files.scrollTop).toBe(405);
    }
  });
  it("keeps the accessible creation chooser outside the scrollport and tablist as Active changes", async () => {
    await show();
    const plus = container.querySelector<HTMLButtonElement>('[aria-label="Open a tab"]')!;
    expect(plus.disabled).toBe(false);
    expect(plus.closest('[data-slot="navigator-selector"]')).not.toBeNull();
    expect(plus.closest('[data-slot="sidebar-footer"]')).not.toBeNull();
    expect(plus.closest('[role="tablist"]')).toBeNull();
    expect(plus.closest('[data-testid="session-scrollport"]')).toBeNull();
    plus.focus();
    for (const count of [1, 4, 0]) {
      listing.count = count;
      await show();
      expect(container.querySelector('[aria-label="Open a tab"]')).toBe(plus);
      expect(document.activeElement).toBe(plus);
    }
    for (const choice of ["files", "sessions"]) {
      await act(async () =>
        container.querySelector<HTMLButtonElement>(`[data-choice="${choice}"]`)!.click(),
      );
      expect(container.querySelector('[aria-label="Open a tab"]')).toBe(plus);
    }
    expect(mounts).toHaveBeenCalledTimes(1);
    await act(async () =>
      plus.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })),
    );
    const chat = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
      (item) => item.textContent === "Chat",
    )!;
    const terminal = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
      (item) => item.textContent === "Terminal",
    );
    expect(terminal).toBeDefined();
    await act(async () => chat.click());
    expect(newChat).toHaveBeenCalledWith("p");
  });
});

// @vitest-environment jsdom
import { act, useState, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, describe, it, expect, vi } from "vite-plus/test";
import { SidebarProvider } from "@renderer/components/ui/sidebar";
import { PrimarySidebar } from "./primary-sidebar";

vi.mock("@renderer/hooks/use-selected-project", () => ({
  useSelectedProject: () => ({ id: "p", name: "Project", ticketPrefix: "VC" }),
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
const { mounts, listing } = vi.hoisted(() => ({ mounts: vi.fn(), listing: { count: 0 } }));
vi.mock("@renderer/components/sidebar/active-sessions", () => ({
  ActiveSessions: ({
    visible,
    onActiveCountChange,
  }: {
    visible: boolean;
    onActiveCountChange?(count: number): void;
  }) => {
    const count = listing.count;
    useEffect(() => {
      onActiveCountChange?.(count);
    }, [onActiveCountChange, count]);
    useState(() => mounts());
    return (
      <div data-testid="sidebar-sessions" data-visible={visible}>
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
    mounts.mockClear();
    listing.count = 0;
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
  it("places borderless icon-only choices below navigation, outside both scrollports", async () => {
    await show();
    const switcher = container.querySelector('[aria-label="Sidebar content"]')!;
    expect(switcher.getAttribute("data-slot")).toBe("navigator-selector");
    expect(switcher.className).toContain("h-[22px]");
    expect(switcher.textContent).toBe("");
    expect(switcher.className).not.toContain("glass");
    expect(container.querySelector('[data-testid="feature-nav"]')?.nextElementSibling).toBe(
      switcher,
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
  it("restores the Active total inline without duplicating the header or counting Files", async () => {
    await show();
    expect(container.querySelector("[data-band-count]")).toBeNull();
    listing.count = 4;
    await show();
    const header = container.querySelector("h3")!.parentElement!;
    expect(header.textContent).toContain("Active4");
    expect(header.querySelector('[aria-label="Sidebar content"]')).toBeNull();
    expect(
      container.querySelector('[data-slot="sidebar-header"] [aria-label="Sidebar content"]'),
    ).toBeNull();
    expect(container.querySelectorAll("h3")).toHaveLength(1);
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[data-choice="files"]')!.click(),
    );
    expect(header.querySelector("[data-band-count]")).toBeNull();
    expect(container.querySelector('[data-choice="files"]')?.getAttribute("aria-selected")).toBe(
      "true",
    );
    listing.count = 0;
    await show();
    expect(container.querySelector("[data-band-count]")).toBeNull();
  });
});

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
vi.mock("@renderer/components/sidebar/nav-list", () => ({ NavList: () => null }));
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
  SidebarScrollArea: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
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
    ).not.toBeNull();
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

// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { Project, Ticket } from "@volli/shared";
import type { FileTreeNavigator } from "@renderer/components/files/file-tree-navigator";
import { DEFAULT_PROJECT_UI, useProjectUiStore } from "@renderer/stores/project-ui";
import { useBoardStore } from "@renderer/stores/board";
import { useUiStore } from "@renderer/stores/ui";
import { SidebarFiles } from "./sidebar-files";

vi.mock("@renderer/components/files/file-tree-navigator", () => ({
  FileTreeNavigator: (props: React.ComponentProps<typeof FileTreeNavigator>) => (
    <button
      data-testid="navigator"
      data-ticket={props.ticketId ?? "main"}
      data-available={props.available}
      onClick={() => props.onOpen("src/file.ts")}
    >
      {props.root}
    </button>
  ),
}));

const project = { id: "p", name: "Project" } as Project;
const ticket = { id: "t", projectId: "p", branch: "volli/t", worktreePath: "/worktree" } as Ticket;

describe("sidebar file scope", () => {
  let root: Root;
  let container: HTMLElement;
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    Object.defineProperty(window, "api", {
      configurable: true,
      value: { appState: { set: async () => ({ ok: true }) } },
    });
    useUiStore.setState({ settingsOpen: false });
    useProjectUiStore.setState({
      byProject: {
        p: { ...DEFAULT_PROJECT_UI, nav: "home", homeActiveTab: "board", openTicketId: "t" },
      },
    });
    useBoardStore.setState({ ticketsByProject: { p: [ticket] } });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    useUiStore.setState({ settingsOpen: false });
    vi.unstubAllGlobals();
    Reflect.deleteProperty(window, "api");
  });
  async function show() {
    await act(async () => root.render(<SidebarFiles project={project} />));
  }
  it("uses a ticket worktree only while that ticket is actually on screen", async () => {
    await show();
    expect(container.querySelector("button")?.dataset.ticket).toBe("t");
    await act(async () => useProjectUiStore.getState().pinHomeFile("p", "README.md"));
    expect(container.querySelector("button")?.dataset.ticket).toBe("main");
    await act(async () =>
      useProjectUiStore.setState({
        byProject: {
          p: {
            ...DEFAULT_PROJECT_UI,
            nav: "automations",
            homeActiveTab: "board",
            openTicketId: "t",
          },
        },
      }),
    );
    expect(container.querySelector("button")?.dataset.ticket).toBe("main");
    await act(async () =>
      useProjectUiStore.setState({
        byProject: {
          p: { ...DEFAULT_PROJECT_UI, nav: "home", homeActiveTab: "board", openTicketId: "t" },
        },
      }),
    );
    await act(async () => useUiStore.setState({ settingsOpen: true }));
    expect(container.querySelector("button")?.dataset.ticket).toBe("t");
  });
  it("pins and focuses a ticket file even when that pinned tab already exists", async () => {
    await show();
    await act(async () => container.querySelector<HTMLButtonElement>("button")!.click());
    expect(useProjectUiStore.getState().byProject.p?.ticketTabs.t?.active).toBe("file:src/file.ts");
    await act(async () => useProjectUiStore.getState().setTicketActiveTab("p", "t", "doc"));
    await act(async () => container.querySelector<HTMLButtonElement>("button")!.click());
    const tabs = useProjectUiStore.getState().byProject.p?.ticketTabs.t;
    expect(tabs?.active).toBe("file:src/file.ts");
    expect(tabs?.files).toEqual([{ relPath: "src/file.ts", pinned: true }]);
  });
  it("opens a main-checkout file in front of Settings instead of behind it", async () => {
    useUiStore.setState({ settingsOpen: true });
    await show();
    await act(async () => useProjectUiStore.getState().closeTicket("p"));
    expect(container.querySelector("button")?.dataset.ticket).toBe("main");
    await act(async () => container.querySelector<HTMLButtonElement>("button")!.click());
    expect(useUiStore.getState().settingsOpen).toBe(false);
    const workspace = useProjectUiStore.getState().byProject.p;
    expect(workspace?.homeActiveTab).toBe("file:src/file.ts");
    expect(workspace?.projectFiles.tabs).toEqual([{ relPath: "src/file.ts", pinned: true }]);
  });
  it("never substitutes Main for a ticket without a worktree", async () => {
    useBoardStore.setState({ ticketsByProject: { p: [{ ...ticket, worktreePath: null }] } });
    await show();
    expect(container.querySelector("button")?.dataset.ticket).toBe("t");
    expect(container.querySelector("button")?.dataset.available).toBe("false");
  });
});

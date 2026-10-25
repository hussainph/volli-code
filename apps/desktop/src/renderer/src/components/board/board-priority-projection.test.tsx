// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import type { Ticket } from "@volli/shared";
import type { TicketResult } from "../../../../ipc/contract";

import { TooltipProvider } from "@renderer/components/ui/tooltip";
import { useAutomationsStore } from "@renderer/stores/automations";
import { useBoardStore } from "@renderer/stores/board";
import { DEFAULT_PROJECT_UI, useProjectUiStore } from "@renderer/stores/project-ui";

import { Board } from "./board";

const ticket: Ticket = {
  id: "priority-ticket",
  projectId: "p1",
  ticketNumber: 1,
  title: "Priority projection",
  body: "",
  status: "backlog",
  priority: "medium",
  labels: [],
  usesWorktree: true,
  preferredHarnessId: "claude-code",
  order: 0,
  worktreePath: null,
  branch: null,
  baseBranch: null,
  prUrl: null,
  createdAt: 1,
  updatedAt: 1,
};

let container: HTMLElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("matchMedia", (media: string) => ({
    media,
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  }));
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  useBoardStore.getState().hydrate({ p1: [ticket] }, { p1: [] });
  useProjectUiStore.setState({ byProject: { p1: { ...DEFAULT_PROJECT_UI } } });
  useAutomationsStore.setState({
    byProject: { p1: [] },
    armingByProject: { p1: [] },
    orderByProject: { p1: [] },
    enabledIds: [],
    enablementRead: true,
    railReadAt: { p1: useBoardStore.getState().lastPlanningChange.version },
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it("projects the priority on the real board in the mutation commit, before IPC answers", async () => {
  let resolvePriority!: (result: TicketResult) => void;
  const setPriority = vi.fn(
    () =>
      new Promise<TicketResult>((resolve) => {
        resolvePriority = resolve;
      }),
  );
  vi.stubGlobal("api", { tickets: { setPriority } });
  act(() =>
    root.render(
      <TooltipProvider>
        <Board projectId="p1" ticketPrefix="VC" />
      </TooltipProvider>,
    ),
  );
  const indicator = () => container.querySelector('article [role="img"][aria-label^="Priority:"]');
  expect(indicator()?.getAttribute("aria-label")).toBe("Priority: Medium");

  let pending!: Promise<void>;
  // Synchronous act flushes this store write's React commit, with no timer,
  // frame or gateway reply. This catches a product-side deferred projection;
  // the smoke's bounded wait only answers whether its DOM is readable in CI.
  act(() => {
    pending = useBoardStore.getState().setTicketPriority("p1", ticket.id, "high");
  });
  expect(setPriority).toHaveBeenCalledWith({ ticketId: ticket.id, priority: "high" });
  expect(indicator()?.getAttribute("aria-label")).toBe("Priority: High");

  await act(async () => {
    resolvePriority({ ok: true, ticket: { ...ticket, priority: "high", updatedAt: 2 } });
    await pending;
  });
  expect(indicator()?.getAttribute("aria-label")).toBe("Priority: High");
});

/** The card's own context menu, opened the way a right-click opens it. */
function openCardMenu(): void {
  const trigger = container.querySelector('[data-slot="context-menu-trigger"]');
  if (trigger === null) throw new Error("the card has no context menu");
  act(() => {
    trigger.dispatchEvent(
      new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }),
    );
  });
}

function menuRow(slot: string, label: string, within: ParentNode = document): HTMLElement {
  const found = [...within.querySelectorAll<HTMLElement>(`[data-slot="${slot}"]`)].find(
    (row) => row.textContent?.trim() === label,
  );
  if (found === undefined) throw new Error(`no ${slot} named ${label}`);
  return found;
}

it("projects High in the commit of the menu select itself, before IPC answers", async () => {
  // VC-665: the store action above is only half the path a person takes. The
  // smoke's 11.5 now waits out the modal menu's exit (its `hideOthers` keeps
  // the card out of the accessibility tree until the portal unmounts), so a
  // deferral added in the menu's own `onSelect` would pass it. This drives the
  // real card menu and reads the indicator in the same synchronous act.
  let resolvePriority!: (result: TicketResult) => void;
  const setPriority = vi.fn(
    () =>
      new Promise<TicketResult>((resolve) => {
        resolvePriority = resolve;
      }),
  );
  vi.stubGlobal("api", { tickets: { setPriority } });
  act(() =>
    root.render(
      <TooltipProvider>
        <Board projectId="p1" ticketPrefix="VC" />
      </TooltipProvider>,
    ),
  );
  const indicator = () => container.querySelector('article [role="img"][aria-label^="Priority:"]');
  expect(indicator()?.getAttribute("aria-label")).toBe("Priority: Medium");

  openCardMenu();
  act(() => menuRow("context-menu-sub-trigger", "Priority").click());
  const priorities = document.querySelector('[data-slot="context-menu-sub-content"]');
  if (priorities === null) throw new Error("the Priority submenu did not open");
  const high = menuRow("context-menu-item", "High", priorities);

  act(() => high.click());
  expect(setPriority).toHaveBeenCalledWith({ ticketId: ticket.id, priority: "high" });
  expect(indicator()?.getAttribute("aria-label")).toBe("Priority: High");

  await act(async () => {
    resolvePriority({ ok: true, ticket: { ...ticket, priority: "high", updatedAt: 2 } });
  });
  expect(indicator()?.getAttribute("aria-label")).toBe("Priority: High");
});

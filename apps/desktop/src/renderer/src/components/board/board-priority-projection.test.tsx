// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import type { Ticket } from "@volli/shared";
import type { TicketResult } from "../../../../ipc/contract";

import { TooltipProvider } from "@renderer/components/ui/tooltip";
import { useAutomationsStore } from "@renderer/stores/automations";
import { useBoardStore } from "@renderer/stores/board";
import { DEFAULT_WORKSPACE_UI, useWorkspaceStore } from "@renderer/stores/workspace";

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
  useWorkspaceStore.setState({ byProject: { p1: { ...DEFAULT_WORKSPACE_UI } } });
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

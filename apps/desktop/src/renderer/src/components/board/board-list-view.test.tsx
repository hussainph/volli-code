import { TicketDialogHost } from "./ticket-dialog-host";
// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { DndContext } from "@dnd-kit/core";
import { type Ticket, type TicketStatus } from "@volli/shared";
import { expect, it, vi } from "vite-plus/test";
import { TooltipProvider } from "../ui/tooltip";
import { BoardListView } from "./board-list-view";
it("bounds mounted rows without truncating the status model and restores keyboard focus at the logical end", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  const rect = HTMLElement.prototype.getBoundingClientRect;
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(360);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
    this: HTMLElement,
  ) {
    if (this.hasAttribute("data-list-row-body"))
      return new DOMRect(
        0,
        -(this.closest<HTMLElement>("[data-list-ticket-count]")?.scrollTop ?? 0),
        500,
        36000,
      );
    return rect.call(this);
  });
  const groups: Record<TicketStatus, Ticket[]> = {
    backlog: [],
    todo: [],
    doing: [],
    needs_review: [],
    done: [],
  };
  groups.todo = Array.from({ length: 1000 }, (_, i) => ({
    id: `t${i}`,
    projectId: "p1",
    ticketNumber: i + 1,
    title: `Ticket ${i}`,
    body: "",
    status: "todo",
    priority: "medium",
    labels: [],
    usesWorktree: false,
    preferredHarnessId: "claude-code",
    order: i,
    worktreePath: null,
    branch: null,
    baseBranch: null,
    prUrl: null,
    createdAt: 1,
    updatedAt: 1,
  }));
  try {
    await act(async () =>
      root.render(
        <TooltipProvider>
          <DndContext>
            <TicketDialogHost projectId="p1">
              <BoardListView
                projectId="p1"
                ticketPrefix="DRV"
                projectLabels={[]}
                groups={groups}
                shownStatuses={["todo"]}
                emptyDropStatuses={[]}
                boardEmpty={false}
                dragActive={false}
                aimedStatus={null}
                selectedIds={[]}
                draggingIds={[]}
                groupDragIds={[]}
                onSelect={() => {}}
                onOpen={() => {}}
              />
            </TicketDialogHost>
          </DndContext>
        </TooltipProvider>,
      ),
    );
    expect(host.querySelectorAll("[data-ticket-row]")).toHaveLength(40);
    expect(
      host.querySelector("[data-list-ticket-count]")?.getAttribute("data-list-ticket-count"),
    ).toBe("1000");
    await act(async () =>
      host
        .querySelector("[data-ticket-focus-id]")!
        .dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true })),
    );
    await act(async () => {
      await new Promise((resolve) => requestAnimationFrame(resolve));
    });
    expect(host.querySelector('[data-ticket-focus-id="t999"]')).not.toBeNull();
    expect(document.activeElement?.getAttribute("data-ticket-focus-id")).toBe("t999");
    expect(host.querySelectorAll("[data-ticket-row]").length).toBeLessThanOrEqual(40);
  } finally {
    act(() => root.unmount());
    host.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  }
});

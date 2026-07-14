import * as React from "react";
import { CaretRightIcon } from "@phosphor-icons/react/dist/csr/CaretRight";
import { displayTicketId, type Ticket } from "@volli/shared";

import { TicketArtifactsTab } from "@renderer/components/ticket/ticket-artifacts-tab";
import { TicketDocTab } from "@renderer/components/ticket/ticket-doc-tab";
import { TicketProperties } from "@renderer/components/ticket/ticket-properties";
import { TicketSessionsPanel } from "@renderer/components/ticket/ticket-sessions-panel";
import { TicketTabStrip, type TicketTabDescriptor } from "@renderer/components/ticket/ticket-tabs";
import { TicketTitle } from "@renderer/components/ticket/ticket-title";
import { useWorkspaceStore } from "@renderer/stores/workspace";

/**
 * The Doc/Artifacts tabs always present (decision #6, default tab on open is
 * Doc); step 6 appends one `"session"`-kind descriptor per linked session to
 * this array — see ticket-tabs.tsx's module doc for the data-driven contract.
 */
const BASE_TABS: readonly TicketTabDescriptor[] = [
  { id: "doc", kind: "doc", label: "Doc" },
  { id: "artifacts", kind: "artifacts", label: "Artifacts" },
];

/**
 * The full-page ticket detail view (ticket-detail-mvp decision #1), rendered
 * by board-page.tsx in place of the board's content when a ticket is open —
 * the global sessions layer and sidebar stay mounted around it (they live
 * higher up the tree, in main-content.tsx/app-shell.tsx). Layout: main column
 * (title → tab plane) + a right rail (properties → sessions), matching
 * decision #4.
 */
export function TicketDetail({
  projectId,
  ticketPrefix,
  ticket,
}: {
  projectId: string;
  ticketPrefix: string;
  ticket: Ticket;
}) {
  const closeTicket = useWorkspaceStore((state) => state.closeTicket);
  // `tabs` is BASE_TABS today; step 6 appends one session-kind descriptor per
  // linked session here (e.g. `[...BASE_TABS, ...sessionTabs]`) — the routing
  // below is already keyed off `kind`, not tab id, so that extension needs no
  // change here beyond a new `kind === "session"` branch.
  const tabs = BASE_TABS;
  const [activeTabId, setActiveTabId] = React.useState<string>(tabs[0]!.id);
  const activeTab = tabs.find((tab) => tab.id === activeTabId) ?? tabs[0]!;
  const displayId = displayTicketId(ticketPrefix, ticket.ticketNumber);

  const handleClose = React.useCallback(() => closeTicket(projectId), [closeTicket, projectId]);

  // Escape closes the detail view and returns to the board — but only when
  // focus isn't inside an input/textarea/contenteditable or an open menu/
  // dialog, the same guard board.tsx's own Escape-deselect uses, so a
  // property dropdown or the label editor's text field can still dismiss
  // itself on Escape without also closing the whole view. Board's own
  // Escape-deselect listener is inert while this view is mounted — board.tsx
  // isn't rendered at all (board-page.tsx swaps the two) — so the two never
  // fire off the same keypress.
  React.useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      const target = event.target;
      if (
        target instanceof Element &&
        target.closest(
          "input, textarea, [contenteditable], [role=menu], [role=dialog], [role=alertdialog]",
        ) !== null
      ) {
        return;
      }
      handleClose();
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [handleClose]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex shrink-0 items-center gap-1.5 px-4 pt-3 pb-3 text-sm">
        <button
          type="button"
          onClick={handleClose}
          className="text-muted-foreground transition-colors duration-150 ease-out hover:text-foreground"
        >
          Board
        </button>
        <CaretRightIcon weight="bold" className="size-3 text-muted-foreground" />
        <span className="font-mono text-xs text-muted-foreground">{displayId}</span>
      </header>
      <div className="flex min-h-0 flex-1 overflow-hidden">
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-6 pb-6">
          <TicketTitle ticket={ticket} />
          <TicketTabStrip tabs={tabs} activeTabId={activeTab.id} onSelectTab={setActiveTabId} />
          {
            activeTab.kind === "doc" ? (
              <TicketDocTab ticket={ticket} />
            ) : activeTab.kind === "artifacts" ? (
              <TicketArtifactsTab projectId={projectId} ticketId={ticket.id} />
            ) : null /* step 6: a "session" tab renders that session's terminal pane */
          }
        </div>
        <aside className="flex w-[300px] shrink-0 flex-col gap-6 overflow-y-auto border-l border-sidebar-border bg-sidebar px-4 py-5">
          <TicketProperties projectId={projectId} ticket={ticket} />
          <TicketSessionsPanel />
        </aside>
      </div>
    </div>
  );
}

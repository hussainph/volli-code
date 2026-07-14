import * as React from "react";
import { CaretRightIcon } from "@phosphor-icons/react/dist/csr/CaretRight";
import { displayTicketId, errorMessage, type Ticket } from "@volli/shared";
import { toast } from "sonner";

import { TicketArtifactsTab } from "@renderer/components/ticket/ticket-artifacts-tab";
import { TicketDocTab } from "@renderer/components/ticket/ticket-doc-tab";
import { TicketProperties } from "@renderer/components/ticket/ticket-properties";
import { TicketSessionPlane } from "@renderer/components/ticket/ticket-session-plane";
import { TicketSessionsPanel } from "@renderer/components/ticket/ticket-sessions-panel";
import { TicketTabStrip, type TicketTabDescriptor } from "@renderer/components/ticket/ticket-tabs";
import { TicketTitle } from "@renderer/components/ticket/ticket-title";
import { isEscapeExempt } from "@renderer/lib/escape-guard";
import { useTicketSessionsStore } from "@renderer/stores/ticket-sessions";
import { useWorkspaceStore } from "@renderer/stores/workspace";
import { closeTicketSession } from "@renderer/terminal/session-lifecycle";
import { getOrCreateEngine } from "@renderer/terminal/registry";

/** Initial PTY grid; restty re-measures and resizes the shell within a frame. */
const INITIAL_COLS = 80;
const INITIAL_ROWS = 24;

/**
 * The Doc/Artifacts tabs always present (decision #6, default tab on open is
 * Doc); one `"session"`-kind descriptor is appended per linked live session —
 * see ticket-tabs.tsx's module doc for the data-driven contract.
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
 * decision #4. The tab plane hosts the ticket's live terminals; those stay
 * resident (engines outlive the view via the module registry, decision #8).
 */
export function TicketDetail({
  projectId,
  projectPath,
  ticketPrefix,
  ticket,
}: {
  projectId: string;
  projectPath: string;
  ticketPrefix: string;
  ticket: Ticket;
}) {
  const closeTicket = useWorkspaceStore((state) => state.closeTicket);
  const sessionTabs = useTicketSessionsStore((state) => state.byTicket[ticket.id]?.tabs);
  const creating = useTicketSessionsStore((state) => state.startingTickets[ticket.id] ?? false);

  // BASE_TABS + one session-kind descriptor per live session; routing below is
  // keyed off `kind`, not id, so the plane and content branch generically.
  const tabs: TicketTabDescriptor[] = [
    ...BASE_TABS,
    ...(sessionTabs ?? []).map(
      (tab): TicketTabDescriptor => ({ id: tab.sessionId, kind: "session", label: tab.title }),
    ),
  ];
  const [activeTabId, setActiveTabId] = React.useState<string>(tabs[0]!.id);
  // A closed session tab (or one that never existed) falls back to Doc.
  const activeTab = tabs.find((tab) => tab.id === activeTabId) ?? tabs[0]!;
  const displayId = displayTicketId(ticketPrefix, ticket.ticketNumber);

  const handleClose = React.useCallback(() => closeTicket(projectId), [closeTicket, projectId]);

  // Boots a ticket-scoped PTY (env-injected VOLLI_TICKET/VOLLI_TICKET_DIR in
  // main, decision #16), registers its tab, and switches to it. The engine
  // exists BEFORE the tab so output arriving between the create reply and the
  // view's mount is buffered, not dropped.
  const createSession = React.useCallback(async () => {
    const store = useTicketSessionsStore.getState();
    if (store.startingTickets[ticket.id]) return;
    store.setStarting(ticket.id, true);
    try {
      const result = await window.api.terminal.create({
        workspaceId: projectId,
        cwd: projectPath,
        cols: INITIAL_COLS,
        rows: INITIAL_ROWS,
        ticket: { ticketId: ticket.id },
      });
      if (!result.ok) {
        toast.error(`Could not start session: ${result.error}`);
        return;
      }
      getOrCreateEngine(result.sessionId);
      store.addSession(ticket.id, result.sessionId, result.session.title);
      setActiveTabId(result.sessionId);
    } catch (error) {
      toast.error(`Could not start session: ${errorMessage(error)}`);
    } finally {
      store.setStarting(ticket.id, false);
    }
  }, [projectId, projectPath, ticket.id]);

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
      if (isEscapeExempt(event.target)) return;
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
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden px-6 pb-6">
          <TicketTitle ticket={ticket} />
          <TicketTabStrip
            tabs={tabs}
            activeTabId={activeTab.id}
            onSelectTab={setActiveTabId}
            onCloseSessionTab={(sessionId) => closeTicketSession(ticket.id, sessionId)}
          />
          {/* Positioning context for the resident terminal plane: Doc/Artifacts
              scroll in-flow; the plane overlays them, shown only for a session tab. */}
          <div className="relative flex min-h-0 flex-1 flex-col">
            {activeTab.kind === "doc" || activeTab.kind === "artifacts" ? (
              <div className="min-h-0 flex-1 overflow-y-auto">
                {activeTab.kind === "doc" ? (
                  <TicketDocTab ticket={ticket} />
                ) : (
                  <TicketArtifactsTab projectId={projectId} ticketId={ticket.id} />
                )}
              </div>
            ) : null}
            <TicketSessionPlane
              ticketId={ticket.id}
              activeSessionId={activeTab.kind === "session" ? activeTab.id : null}
            />
          </div>
        </div>
        <aside className="flex w-[300px] shrink-0 flex-col gap-6 overflow-y-auto border-l border-sidebar-border bg-sidebar px-4 py-5">
          <TicketProperties projectId={projectId} ticket={ticket} />
          <TicketSessionsPanel
            ticketId={ticket.id}
            creating={creating}
            onNewSession={() => void createSession()}
            onActivateSession={setActiveTabId}
          />
        </aside>
      </div>
    </div>
  );
}

import * as React from "react";
import { CaretRightIcon } from "@phosphor-icons/react/dist/csr/CaretRight";
import { displayTicketId, type Ticket } from "@volli/shared";

import { ContentColumn } from "@renderer/components/layout/content-column";
import { ConfirmCloseDialog } from "@renderer/components/sessions/confirm-close-dialog";
import { createTerminalSession } from "@renderer/components/sessions/session-create";
import { TicketArtifactsTab } from "@renderer/components/ticket/ticket-artifacts-tab";
import { TicketDocTab } from "@renderer/components/ticket/ticket-doc-tab";
import { TicketProperties } from "@renderer/components/ticket/ticket-properties";
import { TicketSessionPlane } from "@renderer/components/ticket/ticket-session-plane";
import { TicketSessionsPanel } from "@renderer/components/ticket/ticket-sessions-panel";
import { TicketTabStrip, type TicketTabDescriptor } from "@renderer/components/ticket/ticket-tabs";
import { TicketTitle } from "@renderer/components/ticket/ticket-title";
import { isEscapeExempt } from "@renderer/lib/escape-guard";
import { cn } from "@renderer/lib/utils";
import { sessionPanes, ticketScope, useSessionsStore } from "@renderer/stores/sessions";
import { useUiStore } from "@renderer/stores/ui";
import { useWorkspaceStore } from "@renderer/stores/workspace";
import { useCloseGuard } from "@renderer/terminal/close-guard";
import { closeTicketSession, renameTerminalSession } from "@renderer/terminal/session-lifecycle";

/**
 * The right rail's bottom "Details" drawer (status/priority/labels/worktree).
 * Sessions dominate the rail; Details is collapsed by default and pinned
 * beneath them, its open/closed state persisted app-wide via `useUiStore`
 * (mirrors the `railCollapsed` chrome preference). A quiet header toggles it;
 * the caret rotates to point down when open.
 */
function TicketDetailsDrawer({ projectId, ticket }: { projectId: string; ticket: Ticket }) {
  const expanded = useUiStore((state) => state.detailsExpanded);
  const toggle = useUiStore((state) => state.toggleDetailsExpanded);
  return (
    <div className="shrink-0 border-t border-sidebar-border">
      <button
        type="button"
        onClick={toggle}
        aria-expanded={expanded}
        className="flex w-full items-center justify-between px-4 py-3 text-label font-medium text-muted-foreground uppercase transition-colors duration-150 ease-out hover:text-foreground"
      >
        Details
        <CaretRightIcon
          weight="bold"
          className={cn(
            "size-3 transition-transform duration-150 ease-out",
            expanded && "rotate-90",
          )}
        />
      </button>
      {expanded ? (
        <div className="max-h-80 overflow-y-auto px-4 pb-4">
          <TicketProperties projectId={projectId} ticket={ticket} />
        </div>
      ) : null}
    </div>
  );
}

/**
 * The Doc/Artifacts tabs always present (decision #6, default tab on open is
 * Doc — its label is the ticket's own display id, e.g. "VC-12"); one
 * `"session"`-kind descriptor is appended per linked live session — see
 * ticket-tabs.tsx's module doc for the data-driven contract.
 */
const ARTIFACTS_TAB: TicketTabDescriptor = {
  id: "artifacts",
  kind: "artifacts",
  label: "Artifacts",
};

/**
 * The full-page ticket detail view (ticket-detail-mvp decision #1), rendered
 * by board-page.tsx in place of the board's content when a ticket is open —
 * the global sessions layer and sidebar stay mounted around it (they live
 * higher up the tree, in main-content.tsx/app-shell.tsx). Layout follows the
 * browser-window metaphor: ONE full-width Chrome-style tab row at the very top,
 * spanning above both the main column (title → content plane) and the right
 * rail (sessions → collapsible Details). Navigation is the chrome bar's ←/→
 * history plus Escape; there's no breadcrumb. The tab plane hosts the ticket's
 * live terminals; those stay resident (engines outlive the view via the module
 * registry, decision #8) and are positioned by the always-mounted overlay onto
 * the plane's measured box in the main column — so the rail collapsing (which
 * hands the plane the full width) never unmounts a terminal.
 */
export function TicketDetail({
  projectId,
  ticketPrefix,
  ticket,
}: {
  projectId: string;
  /** Kept in the props contract for board-page; the PTY cwd now resolves in main. */
  projectPath: string;
  ticketPrefix: string;
  ticket: Ticket;
}) {
  const closeTicket = useWorkspaceStore((state) => state.closeTicket);
  const sessionTabs = useSessionsStore((state) => state.byOwner[ticket.id]?.tabs);
  const creating = useSessionsStore((state) => state.starting[ticket.id] ?? false);
  const railCollapsed = useUiStore((state) => state.railCollapsed);
  const closeGuard = useCloseGuard();

  const displayId = displayTicketId(ticketPrefix, ticket.ticketNumber);

  // Doc (labeled with the ticket id) + Artifacts + one session-kind descriptor
  // per live session; routing below is keyed off `kind`, not id, so the plane
  // and content branch generically.
  const tabs: TicketTabDescriptor[] = [
    { id: "doc", kind: "doc", label: displayId },
    ARTIFACTS_TAB,
    ...(sessionTabs ?? []).map(
      (tab): TicketTabDescriptor => ({
        id: tab.sessionId,
        kind: "session",
        label: tab.title,
      }),
    ),
  ];
  const [activeTabId, setActiveTabId] = React.useState<string>(tabs[0]!.id);
  // A closed session tab (or one that never existed) falls back to Doc.
  const activeTab = tabs.find((tab) => tab.id === activeTabId) ?? tabs[0]!;

  const handleClose = React.useCallback(() => closeTicket(projectId), [closeTicket, projectId]);

  // Boots a ticket-scoped PTY (env-injected VOLLI_TICKET/VOLLI_TICKET_DIR in
  // main, decision #16) as a resident tab, then switches to it. The terminal is
  // hosted by the always-mounted sessions layer, so it survives leaving the
  // detail; only the tab selection is local here. Shared by the tab strip's "+"
  // and the rail's New-session button so both take the exact same path.
  const createSession = React.useCallback(async () => {
    const sessionId = await createTerminalSession(ticketScope(projectId, ticket.id));
    if (sessionId !== null) setActiveTabId(sessionId);
  }, [projectId, ticket.id]);

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
    <>
      <div className="flex min-h-0 flex-1 flex-col">
        {/* One full-width tab row above both the main column and the rail (the
          browser-window metaphor). The active tab fuses with the content plane
          in the main column below it. */}
        <TicketTabStrip
          tabs={tabs}
          activeTabId={activeTab.id}
          creating={creating}
          onSelectTab={setActiveTabId}
          onCloseSessionTab={(sessionId) => {
            const tab = sessionTabs?.find((candidate) => candidate.sessionId === sessionId);
            const liveIds = tab
              ? sessionPanes(tab.layout)
                  .filter((pane) => pane.exitCode === null)
                  .map((pane) => pane.sessionId)
              : [sessionId];
            closeGuard.guard(liveIds, () => closeTicketSession(ticket.id, sessionId));
          }}
          onRenameSessionTab={(sessionId, title) => renameTerminalSession(sessionId, title)}
          onNewSession={() => void createSession()}
        />
        <div className="flex min-h-0 flex-1 overflow-hidden">
          {/* No horizontal padding here: Tier A children (title, Doc tab) center
            themselves on the measure via <ContentColumn>; Tier B planes
            (artifacts, terminals) own their edges (DESIGN.md tier model).
            Session tabs are pure workbench: no title, no top air — the tab strip
            already names the ticket, and the terminal gets every pixel. */}
          <div
            className={cn(
              "flex min-h-0 flex-1 flex-col overflow-hidden",
              activeTab.kind !== "session" && "pt-8",
            )}
          >
            {activeTab.kind !== "session" && (
              <ContentColumn>
                <TicketTitle ticket={ticket} />
              </ContentColumn>
            )}
            {/* Positioning context for the resident terminal plane: Doc/Artifacts
              scroll in-flow; the plane overlays them, shown only for a session tab. */}
            <div
              className={cn(
                "relative flex min-h-0 flex-1 flex-col",
                activeTab.kind !== "session" && "mt-3",
              )}
            >
              {activeTab.kind === "doc" || activeTab.kind === "artifacts" ? (
                <div className="min-h-0 flex-1 overflow-y-auto [scrollbar-gutter:stable]">
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
          {railCollapsed ? null : (
            <aside className="flex w-[300px] shrink-0 flex-col border-l border-sidebar-border bg-sidebar">
              <div className="min-h-0 flex-1 overflow-y-auto px-4 py-5">
                <TicketSessionsPanel
                  ticketId={ticket.id}
                  creating={creating}
                  onNewSession={() => void createSession()}
                  onActivateSession={setActiveTabId}
                />
              </div>
              <TicketDetailsDrawer projectId={projectId} ticket={ticket} />
            </aside>
          )}
        </div>
      </div>
      <ConfirmCloseDialog
        pending={closeGuard.pending}
        onConfirm={closeGuard.confirm}
        onCancel={closeGuard.cancel}
      />
    </>
  );
}

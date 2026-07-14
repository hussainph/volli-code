import * as React from "react";

import { TerminalView } from "@renderer/components/sessions/terminal-view";
import { cn } from "@renderer/lib/utils";
import { findSessionPane } from "@renderer/stores/sessions";
import { useTicketSessionsStore } from "@renderer/stores/ticket-sessions";

/**
 * Hosts a ticket's live terminals inside the detail's tab plane (ticket-detail-
 * mvp decisions #6/#8). Every session tab is mounted at once and shown/hidden by
 * visibility — the sessions-surface keep-alive pattern — so switching Doc ↔
 * Artifacts ↔ session tabs never unmounts a terminal. Engines outlive leaving
 * the detail entirely via the module registry (session state is model-resident,
 * views lazy); teardown is only ever explicit (close/kill). The whole plane is
 * an absolute overlay, hidden unless a session tab is the active tab.
 */
export function TicketSessionPlane({
  ticketId,
  activeSessionId,
}: {
  ticketId: string;
  activeSessionId: string | null;
}) {
  const sessions = useTicketSessionsStore((state) => state.byTicket[ticketId]);
  const setActiveSession = useTicketSessionsStore((state) => state.setActiveSession);
  const tabs = sessions?.tabs ?? [];
  if (tabs.length === 0) return null;

  return (
    <div className={cn("absolute inset-0", activeSessionId === null && "hidden")}>
      {tabs.map((tab) => (
        <TicketSessionPane
          key={tab.sessionId}
          ticketId={ticketId}
          sessionId={tab.sessionId}
          visible={activeSessionId === tab.sessionId}
          onActivate={() => setActiveSession(ticketId, tab.sessionId)}
        />
      ))}
    </div>
  );
}

function TicketSessionPane({
  ticketId,
  sessionId,
  visible,
  onActivate,
}: {
  ticketId: string;
  sessionId: string;
  visible: boolean;
  onActivate(): void;
}) {
  // Read liveness fresh against the ticket store so keystrokes/resizes stop
  // forwarding once this session's PTY exits.
  const getLive = React.useCallback(() => {
    const tabs = useTicketSessionsStore.getState().byTicket[ticketId]?.tabs ?? [];
    for (const tab of tabs) {
      const pane = findSessionPane(tab.layout, sessionId);
      if (pane !== null) return pane.exitCode === null;
    }
    return false;
  }, [ticketId, sessionId]);

  return (
    <div className={cn("absolute inset-0 bg-background", !visible && "hidden")}>
      <TerminalView
        projectId={ticketId}
        tabId={sessionId}
        sessionId={sessionId}
        visible={visible}
        active={visible}
        onActivate={onActivate}
        getLive={getLive}
      />
    </div>
  );
}

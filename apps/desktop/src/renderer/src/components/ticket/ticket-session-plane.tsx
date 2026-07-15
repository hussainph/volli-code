import * as React from "react";

import { setTicketSessionViewport } from "@renderer/components/sessions/ticket-terminal-host";

/**
 * The ticket detail's session viewport (ticket-detail-mvp decisions #6/#8). The
 * ticket's live terminals are NOT hosted here — they live in the always-mounted
 * sessions layer's {@link TicketTerminalOverlay}, so they survive leaving the
 * detail entirely (session state is model-resident, views lazy; teardown is only
 * ever explicit close/kill). This is just a measured placeholder: while a
 * session tab is active it publishes its box, and the overlay rect-syncs the
 * hosted terminal onto it. Absent an active session it renders nothing.
 */
export function TicketSessionPlane({
  ticketId,
  activeSessionId,
}: {
  ticketId: string;
  activeSessionId: string | null;
}) {
  const anchorRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    const anchor = anchorRef.current;
    if (anchor === null || activeSessionId === null) return;
    setTicketSessionViewport({ ticketId, sessionId: activeSessionId, anchor });
    return () => setTicketSessionViewport(null);
  }, [ticketId, activeSessionId]);

  if (activeSessionId === null) return null;
  return <div ref={anchorRef} className="absolute inset-0" />;
}

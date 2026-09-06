import * as React from "react";

import { publishTerminalViewport } from "@renderer/components/split/terminal-viewport-registry";

/**
 * A pane saying "draw this terminal here" (VC-202 §3).
 *
 * The measured placeholder half of the keep-alive seam: the terminal itself is
 * mounted once, forever, in the always-mounted sessions layer, and what a
 * surface renders in its place is this — an empty box that publishes its own
 * element for the duration and lets the layer's host rect-sync the live
 * terminal onto it.
 *
 * It replaces `ticket/ticket-session-plane.tsx`, which did exactly this for the
 * one session a ticket could show. The generalisation is the whole of the
 * difference: the anchor is keyed by terminal TAB id and carries its owner, so
 * a ticket's grid, Home's grid and zen mode all publish through one registry
 * and several terminals can be on screen at once.
 *
 * NOTHING UNMOUNTS WHEN THIS DOES. Unpublishing hides a terminal's box; the
 * engine, the PTY and the scrollback are untouched (CLAUDE.md).
 */
export function TerminalPaneAnchor({ tabId, ownerId }: { tabId: string; ownerId: string }) {
  const anchorRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    const anchor = anchorRef.current;
    // Never null in practice — the div below is rendered unconditionally — but
    // a ref read is a ref read.
    if (anchor === null) return;
    publishTerminalViewport(tabId, { ownerId, anchor });
    return () => publishTerminalViewport(tabId, null);
  }, [tabId, ownerId]);

  return <div ref={anchorRef} data-slot="terminal-pane-anchor" className="absolute inset-0" />;
}

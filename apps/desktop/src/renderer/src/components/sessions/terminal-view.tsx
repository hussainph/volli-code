import { errorMessage } from "@volli/shared";
import * as React from "react";
import { toast } from "sonner";

import { findSessionPane, useSessionsStore } from "@renderer/stores/sessions";
import { cn } from "@renderer/lib/utils";
import { getEngine, getOrCreateEngine } from "@renderer/terminal/registry";

interface TerminalViewProps {
  /** The unified store owner key (projectId for scratch, ticketId for ticket). */
  ownerId: string;
  tabId: string;
  sessionId: string;
  /** Visible = inside the active tab of the selected surface. */
  visible: boolean;
  active: boolean;
  onActivate(): void;
}

/**
 * Host for one session's live terminal. It owns the wiring between the renderer
 * engine (from the module registry, so it survives every incidental unmount)
 * and the main-process PTY: engine keystrokes → PTY write, PTY resize forwarding.
 *
 * The view NEVER kills or disposes anything — engines outlive views by design
 * (keep-alive tabs, headless sessions). Teardown happens only through
 * terminal/session-lifecycle.ts on an explicit tab close or project removal,
 * which also keeps React StrictMode's dev double-mount trivially safe: attach
 * re-parents idempotently and onData/onResize replace the prior callback.
 */
export function TerminalView({
  ownerId,
  tabId,
  sessionId,
  visible,
  active,
  onActivate,
}: TerminalViewProps) {
  const containerRef = React.useRef<HTMLDivElement>(null);

  // Read liveness fresh on every event — main forgets the session on PTY exit,
  // so forwarding for an exited tab would only toast "Unknown terminal session"
  // at the user. A stale closure over the tab would keep forwarding forever.
  // Reads the unified store by owner; scratch and ticket sessions share the same
  // model, so no per-surface override is needed.
  const isLive = React.useCallback(() => {
    const tab = useSessionsStore
      .getState()
      .byOwner[ownerId]?.tabs.find((candidate) => candidate.sessionId === tabId);
    return tab !== undefined && findSessionPane(tab.layout, sessionId)?.exitCode === null;
  }, [ownerId, tabId, sessionId]);

  React.useEffect(() => {
    const container = containerRef.current;
    if (container === null) return;

    const engine = getOrCreateEngine(sessionId);

    // Keystrokes → PTY.
    const offData = engine.onData((data) => {
      if (!isLive()) return;
      window.api.terminal
        .write(sessionId, data)
        .then((result) => {
          if (!result.ok) toast.error(`Terminal write failed: ${result.error}`);
        })
        .catch((error: unknown) => {
          toast.error(`Terminal write failed: ${errorMessage(error)}`);
        });
    });

    // Grid changes → PTY resize (fires immediately with the current grid).
    const offResize = engine.onResize(({ cols, rows }) => {
      if (!isLive()) return;
      window.api.terminal
        .resize(sessionId, cols, rows)
        .then((result) => {
          if (!result.ok) toast.error(`Terminal resize failed: ${result.error}`);
        })
        .catch((error: unknown) => {
          toast.error(`Terminal resize failed: ${errorMessage(error)}`);
        });
    });

    // Attach AFTER the callbacks are wired: attach flushes buffered PTY output
    // into the parser, and a reply it generates (e.g. a CPR response to a
    // prompt's cursor probe) must find a data subscriber or it is dropped.
    engine.attach(container);

    // Unsubscribe on cleanup — onData/onResize are multi-subscriber now, so
    // StrictMode's dev double-mount would otherwise forward every keystroke
    // twice. The engine itself stays alive (registry owns its lifecycle).
    return () => {
      offData();
      offResize();
    };
  }, [sessionId, isLive]);

  // Hidden terminals pause rendering; a GPU canvas measures as zero while
  // hidden, so reveal must unpause and refit. Focus is handled separately so
  // revealing a split tab doesn't focus every leaf in mount order.
  React.useEffect(() => {
    const engine = getOrCreateEngine(sessionId);
    engine.setPaused(!visible);
    // fit() re-measures now and once more next frame (engine-internal settle
    // fit), so the settled CSS box and devicePixelRatio land without the React
    // layer carrying renderer-timing knowledge.
    if (visible) engine.fit();
  }, [visible, sessionId]);

  React.useEffect(() => {
    if (visible && active) getOrCreateEngine(sessionId).focus();
  }, [visible, active, sessionId]);

  // Reports on-screen visibility to main (issue #51 warm-park tier): a pane
  // coming on screen both auto-wakes a parked session and tells main "never
  // auto-park what's on screen"; going off-screen (including this view's own
  // unmount) clears the guard so the idle-park sweep can consider it again.
  React.useEffect(() => {
    window.api.terminal.setVisible(sessionId, visible);
    return () => window.api.terminal.setVisible(sessionId, false);
  }, [sessionId, visible]);

  return (
    <div
      ref={containerRef}
      data-terminal-renderer={sessionId}
      // Six pixels keeps the first glyph/cursor off Volli's chrome edge while
      // preserving nearly the full terminal grid.
      className={cn("h-full min-h-0 w-full min-w-0 overflow-hidden p-1.5", !visible && "hidden")}
      onMouseDown={() => {
        onActivate();
        getEngine(sessionId)?.focus();
      }}
    />
  );
}

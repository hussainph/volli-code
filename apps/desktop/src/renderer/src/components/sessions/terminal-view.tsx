import * as React from "react";
import { toast } from "sonner";

import { useSessionsStore } from "@renderer/stores/sessions";
import { cn } from "@renderer/lib/utils";
import { disposeEngine, getOrCreateEngine } from "@renderer/terminal/registry";
import type { TerminalDataRouter } from "@renderer/terminal/data-router";

interface TerminalViewProps {
  projectId: string;
  sessionId: string;
  /** The one shared PTY-output stream router; keyed by sessionId. */
  router: TerminalDataRouter;
  /** Visible = the active tab of the selected project while Sessions is shown. */
  visible: boolean;
}

/**
 * Host for one session's live terminal. It owns the wiring between the renderer
 * engine (from the module registry, so it survives every incidental unmount)
 * and the main-process PTY: engine keystrokes → PTY write, PTY output → engine.
 *
 * The engine is NOT disposed on unmount unless the session is truly gone from
 * the store — that distinguishes a keep-alive re-render (nav/project/StrictMode)
 * from a real tab close, and is what lets a live terminal survive navigation.
 */
export function TerminalView({ projectId, sessionId, router, visible }: TerminalViewProps) {
  const containerRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    const container = containerRef.current;
    if (container === null) return;

    const engine = getOrCreateEngine(sessionId);
    engine.attach(container);

    // Keystrokes → PTY.
    engine.onData((data) => {
      void window.api.terminal.write(sessionId, data).then((result) => {
        if (!result.ok) toast.error(`Terminal write failed: ${result.error}`);
      });
    });

    // Grid changes → PTY resize (fires immediately with the current grid).
    engine.onResize(({ cols, rows }) => {
      void window.api.terminal.resize(sessionId, cols, rows).then((result) => {
        if (!result.ok) toast.error(`Terminal resize failed: ${result.error}`);
      });
    });

    // PTY output → engine (routed off the one shared stream by sessionId).
    router.register(sessionId, (data) => engine.write(data));

    return () => {
      router.unregister(sessionId);
      // Only a real close (session removed from the store) tears the engine
      // and its PTY down. A keep-alive re-render leaves both alive.
      const stillOpen = useSessionsStore
        .getState()
        .byProject[projectId]?.tabs.some((tab) => tab.sessionId === sessionId);
      if (!stillOpen) {
        disposeEngine(sessionId);
        void window.api.terminal.kill(sessionId).then((result) => {
          if (!result.ok) toast.error(`Terminal close failed: ${result.error}`);
        });
      }
    };
  }, [projectId, sessionId, router]);

  // A GPU canvas measures as zero while hidden; refit + focus on reveal.
  React.useEffect(() => {
    if (!visible) return;
    const engine = getOrCreateEngine(sessionId);
    engine.fit();
    engine.focus();
  }, [visible, sessionId]);

  return (
    <div
      ref={containerRef}
      // Every session's terminal stays mounted; only the active one shows.
      // `hidden` (display:none) is why reveal must refit.
      className={cn("absolute inset-0", !visible && "hidden")}
      onMouseDown={() => getOrCreateEngine(sessionId).focus()}
    />
  );
}

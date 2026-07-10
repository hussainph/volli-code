import { errorMessage } from "@volli/shared";
import * as React from "react";
import { toast } from "sonner";

import { useSessionsStore } from "@renderer/stores/sessions";
import { cn } from "@renderer/lib/utils";
import { getEngine, getOrCreateEngine } from "@renderer/terminal/registry";

interface TerminalViewProps {
  projectId: string;
  sessionId: string;
  /** Visible = the active tab of the selected project while Sessions is shown. */
  visible: boolean;
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
export function TerminalView({ projectId, sessionId, visible }: TerminalViewProps) {
  const containerRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    const container = containerRef.current;
    if (container === null) return;

    const engine = getOrCreateEngine(sessionId);

    // Read liveness fresh on every event — main forgets the session on PTY
    // exit, so forwarding for an exited tab would only toast "Unknown
    // terminal session" at the user. A stale closure over the tab would
    // keep forwarding forever.
    const isLive = () =>
      useSessionsStore
        .getState()
        .byProject[projectId]?.tabs.find((tab) => tab.sessionId === sessionId)?.exitCode === null;

    // Keystrokes → PTY.
    engine.onData((data) => {
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
    engine.onResize(({ cols, rows }) => {
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
    // prompt's cursor probe) must find dataCb already set or it is dropped.
    engine.attach(container);
  }, [projectId, sessionId]);

  // Hidden terminals pause rendering; a GPU canvas measures as zero while
  // hidden, so reveal must unpause, refit, and focus.
  React.useEffect(() => {
    const engine = getOrCreateEngine(sessionId);
    engine.setPaused(!visible);
    if (visible) {
      engine.fit();
      engine.focus();
    }
  }, [visible, sessionId]);

  return (
    <div
      ref={containerRef}
      // Every session's terminal stays mounted; only the active one shows.
      // `hidden` (display:none) is why reveal must refit.
      className={cn("absolute inset-0", !visible && "hidden")}
      onMouseDown={() => getEngine(sessionId)?.focus()}
    />
  );
}

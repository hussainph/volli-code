import { TerminalWindowIcon } from "@phosphor-icons/react/dist/csr/TerminalWindow";
import { errorMessage } from "@volli/shared";
import * as React from "react";
import { toast } from "sonner";

import { SessionTabs } from "@renderer/components/sessions/session-tabs";
import { TerminalView } from "@renderer/components/sessions/terminal-view";
import { Button } from "@renderer/components/ui/button";
import { useSelectedProject } from "@renderer/hooks/use-selected-project";
import { useProjectsStore } from "@renderer/stores/projects";
import { useSessionsStore } from "@renderer/stores/sessions";
import { cn } from "@renderer/lib/utils";
import { disposeEngine, getEngine, getOrCreateEngine } from "@renderer/terminal/registry";
import { closeTerminalSession } from "@renderer/terminal/session-lifecycle";
import type { Project } from "@volli/shared";

/** Initial PTY grid; restty re-measures and resizes the shell within a frame. */
const INITIAL_COLS = 80;
const INITIAL_ROWS = 24;

interface SessionsLayerProps {
  /** Sessions is the active page. The layer stays MOUNTED regardless; this only
   *  toggles its visibility so every live terminal survives navigation. */
  visible: boolean;
}

/**
 * The always-mounted terminal surface. It owns EVERY live terminal across ALL
 * projects (each kept alive via the module engine registry), so switching nav,
 * projects, or opening Settings only flips CSS visibility — no terminal is ever
 * unmounted incidentally (CLAUDE.md). The tab strip and "+" act on the selected
 * project; the terminal region below stacks one absolute-filled TerminalView per
 * session, showing only the selected project's active tab.
 */
export function SessionsLayer({ visible }: SessionsLayerProps) {
  const byProject = useSessionsStore((state) => state.byProject);
  const addSession = useSessionsStore((state) => state.addSession);
  const setActiveSession = useSessionsStore((state) => state.setActiveSession);
  const markExited = useSessionsStore((state) => state.markExited);
  const selected = useSelectedProject();

  const creatingRef = React.useRef(new Set<string>());
  // Projects that already got their one auto-opened session. Marked at attempt
  // time and never cleared — a failure's retry surface is the empty state's
  // "New session" button, and a user closing their last tab must be able to
  // hold zero sessions without the effect respawning one.
  const autoOpenedRef = React.useRef(new Set<string>());
  const [, forceRender] = React.useReducer((n: number) => n + 1, 0);

  // The single subscription to the shared PTY streams: fan output out to the
  // matching engine (lookup ONLY — creating here would leak engines for events
  // racing a close), and record exits on whichever tab owns the session. Every
  // chunk is acked regardless: main's flow-control bookkeeping must not starve
  // when no engine exists.
  React.useEffect(() => {
    const offData = window.api.terminal.onData((event) => {
      getEngine(event.sessionId)?.write(event.data);
      window.api.terminal.ack(event.sessionId, event.data.length);
    });
    const offExit = window.api.terminal.onExit((event) =>
      markExited(event.sessionId, event.exitCode),
    );
    return () => {
      offData();
      offExit();
    };
  }, [markExited]);

  const createSession = React.useCallback(
    async (project: Project) => {
      if (creatingRef.current.has(project.id)) return;
      creatingRef.current.add(project.id);
      forceRender();
      try {
        const result = await window.api.terminal.create({
          workspaceId: project.id,
          cwd: project.path,
          cols: INITIAL_COLS,
          rows: INITIAL_ROWS,
        });
        if (!result.ok) {
          toast.error(`Could not start terminal: ${result.error}`);
          return;
        }
        // Engine exists BEFORE the tab does, so output arriving between the
        // create reply and the view's mount is buffered, not dropped.
        getOrCreateEngine(result.sessionId);
        // The project may have been removed while create was in flight; adding
        // the tab would resurrect its session record with a PTY no UI can close.
        const stillTracked = useProjectsStore
          .getState()
          .projects.some((candidate) => candidate.id === project.id);
        if (!stillTracked) {
          disposeEngine(result.sessionId);
          window.api.terminal
            .kill(result.sessionId)
            .then((killResult) => {
              if (!killResult.ok) toast.error(`Terminal close failed: ${killResult.error}`);
            })
            .catch((error: unknown) => {
              toast.error(`Terminal close failed: ${errorMessage(error)}`);
            });
          return;
        }
        addSession(project.id, result.sessionId);
      } catch (error) {
        toast.error(`Could not start terminal: ${errorMessage(error)}`);
      } finally {
        creatingRef.current.delete(project.id);
        forceRender();
      }
    },
    [addSession],
  );

  // Zero-friction first visit: auto-open a session when Sessions is revealed
  // for a project that has never had one — once per project, see autoOpenedRef.
  const selectedTabCount = selected ? (byProject[selected.id]?.tabs.length ?? 0) : 0;
  React.useEffect(() => {
    if (
      visible &&
      selected &&
      selectedTabCount === 0 &&
      !autoOpenedRef.current.has(selected.id) &&
      !creatingRef.current.has(selected.id)
    ) {
      autoOpenedRef.current.add(selected.id);
      void createSession(selected);
    }
  }, [visible, selected, selectedTabCount, createSession]);

  const selectedSessions = selected ? byProject[selected.id] : undefined;
  const creatingSelected = selected ? creatingRef.current.has(selected.id) : false;

  return (
    <div className={cn("flex min-h-0 flex-1 flex-col bg-background", !visible && "hidden")}>
      {selected && (
        <SessionTabs
          tabs={selectedSessions?.tabs ?? []}
          activeSessionId={selectedSessions?.activeSessionId ?? null}
          onSelect={(sessionId) => setActiveSession(selected.id, sessionId)}
          onClose={(sessionId) => closeTerminalSession(selected.id, sessionId)}
          onNew={() => void createSession(selected)}
          creating={creatingSelected}
        />
      )}

      <div className="relative min-h-0 flex-1">
        {/* Keep-alive: render a TerminalView for every session in every project.
            Only the selected project's active tab is visible; the rest are
            display:none but fully live. */}
        {Object.entries(byProject).flatMap(([projectId, sessions]) =>
          sessions.tabs.map((tab) => (
            <TerminalView
              key={tab.sessionId}
              projectId={projectId}
              sessionId={tab.sessionId}
              visible={
                visible && projectId === selected?.id && tab.sessionId === sessions.activeSessionId
              }
            />
          )),
        )}

        {selected && selectedTabCount === 0 && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 text-center">
            <TerminalWindowIcon weight="fill" className="size-8 text-muted-foreground" />
            <p className="max-w-sm text-sm text-muted-foreground">
              Global scratch sessions — plan, brainstorm, and orchestrate outside any ticket.
            </p>
            <Button
              size="sm"
              onClick={() => void createSession(selected)}
              disabled={creatingSelected}
            >
              {creatingSelected ? "Starting…" : "New session"}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

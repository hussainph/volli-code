import { TerminalWindowIcon } from "@phosphor-icons/react/dist/csr/TerminalWindow";
import { errorMessage } from "@volli/shared";
import * as React from "react";
import { toast } from "sonner";

import { SessionTabs } from "@renderer/components/sessions/session-tabs";
import { SessionSplitLayout } from "@renderer/components/sessions/session-split-layout";
import { Button } from "@renderer/components/ui/button";
import { useSelectedProject } from "@renderer/hooks/use-selected-project";
import { useProjectsStore } from "@renderer/stores/projects";
import {
  findSessionPane,
  useSessionsStore,
  type TerminalSplitDirection,
} from "@renderer/stores/sessions";
import { useTicketSessionsStore } from "@renderer/stores/ticket-sessions";
import { cn } from "@renderer/lib/utils";
import { disposeEngine, getEngine, getOrCreateEngine } from "@renderer/terminal/registry";
import { adjacentPaneId, type TerminalFocusDirection } from "@renderer/terminal/pane-navigation";
import { closeTerminalPane, closeTerminalSession } from "@renderer/terminal/session-lifecycle";
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
 * project; the terminal region below stacks one split tree per tab, showing only
 * the selected project's active tab while every leaf stays alive.
 */
export function SessionsLayer({ visible }: SessionsLayerProps) {
  const byProject = useSessionsStore((state) => state.byProject);
  const addSession = useSessionsStore((state) => state.addSession);
  const addSplit = useSessionsStore((state) => state.addSplit);
  const setActiveSession = useSessionsStore((state) => state.setActiveSession);
  const setActivePane = useSessionsStore((state) => state.setActivePane);
  const setSplitRatio = useSessionsStore((state) => state.setSplitRatio);
  const markExited = useSessionsStore((state) => state.markExited);
  const setStarting = useSessionsStore((state) => state.setStarting);
  const selected = useSelectedProject();

  // Projects that already got their one auto-opened session. Marked at attempt
  // time and never cleared — a failure's retry surface is the empty state's
  // "New session" button, and a user closing their last tab must be able to
  // hold zero sessions without the effect respawning one.
  const autoOpenedRef = React.useRef(new Set<string>());

  // The single subscription to the shared PTY streams (this layer is always
  // mounted, so it owns the app-wide fan-out for BOTH project scratch sessions
  // and ticket sessions): fan output out to the matching engine (lookup ONLY —
  // creating here would leak engines for events racing a close), bump the
  // owning ticket session's activity, and record exits on whichever store owns
  // the session (each self-scopes; a miss is a harmless no-op). Every chunk is
  // acked exactly once here: main's flow-control bookkeeping must not starve.
  React.useEffect(() => {
    const offData = window.api.terminal.onData((event) => {
      getEngine(event.sessionId)?.write(event.data);
      window.api.terminal.ack(event.sessionId, event.data.length);
      useTicketSessionsStore.getState().bumpOutput(event.sessionId, Date.now());
    });
    const offExit = window.api.terminal.onExit((event) => {
      markExited(event.sessionId, event.exitCode);
      useTicketSessionsStore.getState().markExited(event.sessionId, event.exitCode);
    });
    return () => {
      offData();
      offExit();
    };
  }, [markExited]);

  const createSession = React.useCallback(
    async (project: Project) => {
      if (useSessionsStore.getState().startingProjects[project.id]) return;
      setStarting(project.id, true);
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
        setStarting(project.id, false);
      }
    },
    [addSession, setStarting],
  );

  const createSplit = React.useCallback(
    async (
      project: Project,
      tabId: string,
      sourcePaneId: string,
      direction: TerminalSplitDirection,
    ) => {
      if (useSessionsStore.getState().startingProjects[project.id]) return;
      setStarting(project.id, true);
      try {
        const result = await window.api.terminal.create({
          workspaceId: project.id,
          cwd: project.path,
          cols: INITIAL_COLS,
          rows: INITIAL_ROWS,
        });
        if (!result.ok) {
          toast.error(`Could not split terminal: ${result.error}`);
          return;
        }
        getOrCreateEngine(result.sessionId);
        const projectState = useSessionsStore.getState().byProject[project.id];
        const tab = projectState?.tabs.find((candidate) => candidate.sessionId === tabId);
        const stillTracked = useProjectsStore
          .getState()
          .projects.some((candidate) => candidate.id === project.id);
        if (
          !stillTracked ||
          tab === undefined ||
          findSessionPane(tab.layout, sourcePaneId) === null
        ) {
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
        addSplit(project.id, tabId, sourcePaneId, result.sessionId, direction);
      } catch (error) {
        toast.error(`Could not split terminal: ${errorMessage(error)}`);
      } finally {
        setStarting(project.id, false);
      }
    },
    [addSplit, setStarting],
  );

  // Zero-friction first visit: auto-open a session when Sessions is revealed
  // for a project that has never had one — once per project, see autoOpenedRef.
  const selectedTabCount = selected ? (byProject[selected.id]?.tabs.length ?? 0) : 0;
  const creatingSelected = useSessionsStore((state) =>
    selected ? (state.startingProjects[selected.id] ?? false) : false,
  );
  React.useEffect(() => {
    if (
      visible &&
      selected &&
      selectedTabCount === 0 &&
      !autoOpenedRef.current.has(selected.id) &&
      !creatingSelected
    ) {
      autoOpenedRef.current.add(selected.id);
      void createSession(selected);
    }
  }, [visible, selected, selectedTabCount, creatingSelected, createSession]);

  const selectedSessions = selected ? byProject[selected.id] : undefined;

  const handleTerminalShortcut = React.useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (!event.metaKey || event.ctrlKey || event.repeat || selected === null) return;
      const target = event.target;
      if (!(target instanceof Element)) return;
      const paneHost = target.closest<HTMLElement>("[data-terminal-pane-id]");
      const paneId = paneHost?.dataset.terminalPaneId;
      const tabId = paneHost?.dataset.terminalTabId;
      if (!paneId || !tabId) return;

      const stop = () => {
        event.preventDefault();
        event.stopPropagation();
      };
      if (event.altKey) {
        const direction: TerminalFocusDirection | null =
          event.key === "ArrowLeft"
            ? "left"
            : event.key === "ArrowRight"
              ? "right"
              : event.key === "ArrowUp"
                ? "up"
                : event.key === "ArrowDown"
                  ? "down"
                  : null;
        if (direction === null) return;
        stop();
        const tab = useSessionsStore
          .getState()
          .byProject[selected.id]?.tabs.find((candidate) => candidate.sessionId === tabId);
        if (tab === undefined) return;
        const nextPaneId = adjacentPaneId(tab.layout, paneId, direction);
        if (nextPaneId !== null) setActivePane(selected.id, tabId, nextPaneId);
        return;
      }
      if (event.code === "KeyD") {
        stop();
        const direction: TerminalSplitDirection = event.shiftKey ? "horizontal" : "vertical";
        void createSplit(selected, tabId, paneId, direction);
        return;
      }
      if (event.key === "+" || event.key === "=") {
        stop();
        getEngine(paneId)?.adjustFontSize(1);
        return;
      }
      if (event.key === "-") {
        stop();
        getEngine(paneId)?.adjustFontSize(-1);
        return;
      }
      if (event.key === "0") {
        stop();
        getEngine(paneId)?.resetFontSize();
      }
    },
    [createSplit, selected, setActivePane],
  );

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

      <div className="relative min-h-0 flex-1" onKeyDownCapture={handleTerminalShortcut}>
        {/* Keep-alive: render every tab's split tree across every project.
            Hidden leaves stay mounted/paused; every visible leaf owns a
            distinct engine + PTY and only layout geometry is shared. */}
        {Object.entries(byProject).flatMap(([projectId, sessions]) =>
          sessions.tabs.map((tab) => (
            <SessionSplitLayout
              key={tab.sessionId}
              projectId={projectId}
              tab={tab}
              visible={
                visible && projectId === selected?.id && tab.sessionId === sessions.activeSessionId
              }
              onActivate={(sessionId) => setActivePane(projectId, tab.sessionId, sessionId)}
              onSplit={(sessionId, direction) => {
                const project = useProjectsStore
                  .getState()
                  .projects.find((candidate) => candidate.id === projectId);
                if (project !== undefined) {
                  void createSplit(project, tab.sessionId, sessionId, direction);
                }
              }}
              onClose={(sessionId) => closeTerminalPane(projectId, tab.sessionId, sessionId)}
              onResize={(splitId, ratio) => setSplitRatio(projectId, tab.sessionId, splitId, ratio)}
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

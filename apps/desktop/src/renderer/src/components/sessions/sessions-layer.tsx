import { TerminalWindowIcon } from "@phosphor-icons/react/dist/csr/TerminalWindow";
import * as React from "react";

import { ConfirmCloseDialog } from "@renderer/components/sessions/confirm-close-dialog";
import { SessionTabs } from "@renderer/components/sessions/session-tabs";
import { SessionSplitLayout } from "@renderer/components/sessions/session-split-layout";
import { TicketTerminalOverlay } from "@renderer/components/sessions/ticket-terminal-host";
import {
  createTerminalSession,
  createTerminalSplit,
} from "@renderer/components/sessions/session-create";
import { Button } from "@renderer/components/ui/button";
import { useSelectedProject } from "@renderer/hooks/use-selected-project";
import {
  scratchScope,
  sessionPanes,
  useSessionsStore,
  type TerminalSplitDirection,
} from "@renderer/stores/sessions";
import { cn } from "@renderer/lib/utils";
import { useCloseGuard } from "@renderer/terminal/close-guard";
import { getEngine } from "@renderer/terminal/registry";
import { adjacentPaneId, type TerminalFocusDirection } from "@renderer/terminal/pane-navigation";
import {
  closeTerminalPane,
  closeTerminalSession,
  renameTerminalSession,
} from "@renderer/terminal/session-lifecycle";
import type { Project } from "@volli/shared";

interface SessionsLayerProps {
  /** Sessions is the active page. The layer stays MOUNTED regardless; this only
   *  toggles the SCRATCH surface's visibility. Ticket terminals it also hosts
   *  are shown independently, overlaid on the ticket plane, even while this is
   *  hidden — so no live terminal is ever unmounted incidentally. */
  visible: boolean;
}

/**
 * The always-mounted terminal surface. It owns EVERY live terminal across ALL
 * projects and tickets (each kept alive via the module engine registry), so
 * switching nav, projects, opening a ticket, or opening Settings only flips CSS
 * visibility — no terminal is ever unmounted incidentally (CLAUDE.md).
 *
 * Two regions: the SCRATCH surface (a tab strip + split trees for the selected
 * project's scratch sessions, hidden with `visible`), and the resident
 * {@link TicketTerminalOverlay} (positioned over the ticket detail's plane when
 * a ticket session tab is active). Both read the one unified store.
 */
export function SessionsLayer({ visible }: SessionsLayerProps) {
  const byOwner = useSessionsStore((state) => state.byOwner);
  const setActiveSession = useSessionsStore((state) => state.setActiveSession);
  const setActivePane = useSessionsStore((state) => state.setActivePane);
  const setSplitRatio = useSessionsStore((state) => state.setSplitRatio);
  const markExited = useSessionsStore((state) => state.markExited);
  const selected = useSelectedProject();
  // One guard for both scratch close surfaces (tab close + pane close): a busy
  // terminal interposes a confirm before the actual PTY teardown runs.
  const closeGuard = useCloseGuard();

  // Projects that already got their one auto-opened scratch session. Marked at
  // attempt time and never cleared — a failure's retry surface is the empty
  // state's "New session" button, and a user closing their last tab must be able
  // to hold zero sessions without the effect respawning one.
  const autoOpenedRef = React.useRef(new Set<string>());

  // The single subscription to the shared PTY streams (this layer is always
  // mounted, so it owns the app-wide fan-out for BOTH scratch and ticket
  // sessions): fan output to the matching engine (lookup ONLY — creating here
  // would leak engines for events racing a close), bump the session's activity,
  // and record exits. Every chunk is acked exactly once here: main's
  // flow-control bookkeeping must not starve.
  React.useEffect(() => {
    const offData = window.api.terminal.onData((event) => {
      getEngine(event.sessionId)?.write(event.data);
      window.api.terminal.ack(event.sessionId, event.data.length);
      useSessionsStore.getState().bumpOutput(event.sessionId, Date.now());
    });
    const offExit = window.api.terminal.onExit((event) => {
      markExited(event.sessionId, event.exitCode);
    });
    return () => {
      offData();
      offExit();
    };
  }, [markExited]);

  const createScratch = React.useCallback((project: Project) => {
    void createTerminalSession(scratchScope(project.id));
  }, []);

  // Zero-friction first visit: auto-open a scratch session when Sessions is
  // revealed for a project that has never had one — once per project.
  const scratch = selected ? byOwner[selected.id] : undefined;
  const scratchTabCount = scratch?.tabs.length ?? 0;
  const creatingSelected = useSessionsStore((state) =>
    selected ? (state.starting[selected.id] ?? false) : false,
  );
  React.useEffect(() => {
    if (
      visible &&
      selected &&
      scratchTabCount === 0 &&
      !autoOpenedRef.current.has(selected.id) &&
      !creatingSelected
    ) {
      autoOpenedRef.current.add(selected.id);
      createScratch(selected);
    }
  }, [visible, selected, scratchTabCount, creatingSelected, createScratch]);

  // ⌘D split, ⌘⌥arrow pane nav, ⌘+/-/0 font size — resolved off the focused
  // pane's data-* attributes, so it is surface-agnostic: the same handler drives
  // scratch panes and ticket panes (the overlay wires it too), routing through
  // the tab's own scope.
  const handleTerminalShortcut = React.useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (!event.metaKey || event.ctrlKey || event.repeat) return;
      const target = event.target;
      if (!(target instanceof Element)) return;
      const paneHost = target.closest<HTMLElement>("[data-terminal-pane-id]");
      const paneId = paneHost?.dataset.terminalPaneId;
      const tabId = paneHost?.dataset.terminalTabId;
      const ownerId = paneHost?.dataset.terminalOwnerId;
      if (!paneId || !tabId || !ownerId) return;
      const tab = useSessionsStore
        .getState()
        .byOwner[ownerId]?.tabs.find((candidate) => candidate.sessionId === tabId);
      if (tab === undefined) return;

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
        const nextPaneId = adjacentPaneId(tab.layout, paneId, direction);
        if (nextPaneId !== null) setActivePane(ownerId, tabId, nextPaneId);
        return;
      }
      if (event.code === "KeyD") {
        stop();
        const direction: TerminalSplitDirection = event.shiftKey ? "horizontal" : "vertical";
        void createTerminalSplit(tab.scope, tabId, paneId, direction);
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
    [setActivePane],
  );

  return (
    <>
      {/* SCRATCH surface — flow layout, hidden (not unmounted) when Sessions
          isn't the active page. */}
      <div className={cn("flex min-h-0 flex-1 flex-col bg-background", !visible && "hidden")}>
        {selected && (
          <SessionTabs
            tabs={scratch?.tabs ?? []}
            activeSessionId={scratch?.activeSessionId ?? null}
            onSelect={(sessionId) => setActiveSession(selected.id, sessionId)}
            onClose={(sessionId) => {
              const tab = scratch?.tabs.find((candidate) => candidate.sessionId === sessionId);
              const liveIds = tab
                ? sessionPanes(tab.layout)
                    .filter((pane) => pane.exitCode === null)
                    .map((pane) => pane.sessionId)
                : [sessionId];
              closeGuard.guard(liveIds, () => closeTerminalSession(selected.id, sessionId));
            }}
            onRename={renameTerminalSession}
            onNew={() => createScratch(selected)}
            creating={creatingSelected}
          />
        )}

        <div className="relative min-h-0 flex-1" onKeyDownCapture={handleTerminalShortcut}>
          {/* Keep-alive: render every project's scratch split tree; only the
              selected project's active tab is visible, the rest stay mounted. */}
          {Object.entries(byOwner).flatMap(([ownerId, container]) =>
            container.tabs
              .filter((tab) => tab.scope.kind === "scratch")
              .map((tab) => (
                <SessionSplitLayout
                  key={tab.sessionId}
                  ownerId={ownerId}
                  tab={tab}
                  visible={
                    visible &&
                    ownerId === selected?.id &&
                    tab.sessionId === container.activeSessionId
                  }
                  onActivate={(sessionId) => setActivePane(ownerId, tab.sessionId, sessionId)}
                  onSplit={(sessionId, direction) =>
                    void createTerminalSplit(tab.scope, tab.sessionId, sessionId, direction)
                  }
                  onClose={(sessionId) =>
                    closeGuard.guard([sessionId], () =>
                      closeTerminalPane(ownerId, tab.sessionId, sessionId),
                    )
                  }
                  onResize={(splitId, ratio) =>
                    setSplitRatio(ownerId, tab.sessionId, splitId, ratio)
                  }
                />
              )),
          )}

          {selected && scratchTabCount === 0 && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 text-center">
              <TerminalWindowIcon weight="fill" className="size-8 text-muted-foreground" />
              <p className="max-w-sm text-sm text-muted-foreground">
                Global scratch sessions — plan, brainstorm, and orchestrate outside any ticket.
              </p>
              <Button size="sm" onClick={() => createScratch(selected)} disabled={creatingSelected}>
                {creatingSelected ? "Starting…" : "New session"}
              </Button>
            </div>
          )}
        </div>
      </div>

      {/* Resident host for ticket-session terminals — positioned over the ticket
          detail's plane, shown independently of the scratch surface's visibility. */}
      <TicketTerminalOverlay byOwner={byOwner} onShortcut={handleTerminalShortcut} />

      <ConfirmCloseDialog
        pending={closeGuard.pending}
        onConfirm={closeGuard.confirm}
        onCancel={closeGuard.cancel}
      />
    </>
  );
}

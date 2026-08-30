import * as React from "react";

import { ConfirmCloseDialog } from "@renderer/components/sessions/confirm-close-dialog";
import { SessionSplitLayout } from "@renderer/components/sessions/session-split-layout";
import {
  TerminalViewportBox,
  useTerminalViewports,
} from "@renderer/components/sessions/terminal-viewport-box";
import { paneIdForElement } from "@renderer/components/split/split-view-grid";
import {
  createTerminalSplit,
  resumeTicketSession,
} from "@renderer/components/sessions/session-create";
import { useSessionsStore, type SessionContainer } from "@renderer/stores/sessions";
import { useWorkspaceStore } from "@renderer/stores/workspace";
import { useCloseGuard } from "@renderer/terminal/close-guard";
import { closeTerminalPane } from "@renderer/terminal/session-lifecycle";

/**
 * The resident host for EVERY ticket session's live terminal. Rendered by the
 * always-mounted sessions layer (never inside the ticket detail), so ticket
 * terminals survive navigating ticket ↔ board — the core keep-alive invariant.
 * Every ticket tab across every ticket is mounted here; the ones whose pane has
 * published an anchor are shown and positioned over it. The rest stay mounted
 * and paused (their engines outlive their being off-screen).
 *
 * SEVERAL AT ONCE, since VC-202: a ticket workspace can hold two terminals side
 * by side, so "which one is on screen" is no longer a single published slot but
 * a map keyed by tab id (`split/terminal-viewport-registry.ts`). The `ownerId`
 * check is what keeps this host to its own scope — Home's Session terminals
 * publish into the same registry and are drawn by the sessions layer.
 */
export function TicketTerminalOverlay({
  byOwner,
  onShortcut,
}: {
  byOwner: Record<string, SessionContainer>;
  onShortcut(event: React.KeyboardEvent<HTMLDivElement>): void;
}) {
  const viewports = useTerminalViewports();
  const setActivePane = useSessionsStore((state) => state.setActivePane);
  const setSplitRatio = useSessionsStore((state) => state.setSplitRatio);
  const closeGuard = useCloseGuard();

  return (
    <>
      {Object.entries(byOwner).flatMap(([ownerId, container]) =>
        container.tabs
          .filter((tab) => tab.scope.kind === "ticket")
          .map((tab) => {
            const published = viewports.get(tab.sessionId);
            const anchor = published?.ownerId === ownerId ? published.anchor : null;
            const scope = tab.scope;
            return (
              <TerminalViewportBox
                key={tab.sessionId}
                anchor={anchor}
                // The pane-focus half of a click into this terminal — see the
                // project-scope twin in sessions-layer.tsx (validation V1).
                // Same climb from the anchor, one scope down: the ticket's own
                // focus action, which is an identity write while unsplit.
                onPointerDownCapture={() => {
                  if (scope.kind !== "ticket") return;
                  const paneId = paneIdForElement(anchor);
                  if (paneId !== null) {
                    useWorkspaceStore
                      .getState()
                      .focusTicketPane(scope.projectId, scope.ticketId, paneId);
                  }
                }}
              >
                <div className="absolute inset-0" onKeyDownCapture={onShortcut}>
                  <SessionSplitLayout
                    ownerId={ownerId}
                    tab={tab}
                    visible={anchor !== null}
                    onActivate={(sessionId) => setActivePane(ownerId, tab.sessionId, sessionId)}
                    onSplit={(sessionId, direction) =>
                      void createTerminalSplit(scope, tab.sessionId, sessionId, direction)
                    }
                    onClose={(sessionId) =>
                      closeGuard.guard([sessionId], () =>
                        closeTerminalPane(ownerId, tab.sessionId, sessionId),
                      )
                    }
                    onResize={(splitId, ratio) =>
                      setSplitRatio(ownerId, tab.sessionId, splitId, ratio)
                    }
                    // Resume boots a NEW tab (session-create.ts's shared boot
                    // pipeline) and switches to it, mirroring "New session" —
                    // the dead pane stays exactly where it is, unresumed. The
                    // `tab.scope.kind === "ticket"` filter above guarantees
                    // this at runtime; the guard narrows `scope` so
                    // `.ticketId` is accessible below.
                    onResume={(resumeOfSessionId) => {
                      if (scope.kind !== "ticket") return;
                      void resumeTicketSession(scope, resumeOfSessionId).then((sessionId) => {
                        if (sessionId !== null) {
                          useWorkspaceStore
                            .getState()
                            .setTicketActiveTab(scope.projectId, scope.ticketId, sessionId);
                        }
                      });
                    }}
                  />
                </div>
              </TerminalViewportBox>
            );
          }),
      )}

      <ConfirmCloseDialog
        pending={closeGuard.pending}
        onConfirm={closeGuard.confirm}
        onCancel={closeGuard.cancel}
      />
    </>
  );
}

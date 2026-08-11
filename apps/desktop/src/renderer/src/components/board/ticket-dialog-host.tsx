import * as React from "react";

import { ConfirmCloseDialog } from "@renderer/components/sessions/confirm-close-dialog";
import { RemoveWorktreeDialog } from "@renderer/components/ticket/remove-worktree-dialog";
import { useBoardStore } from "@renderer/stores/board";
import { sessionPanes, useSessionsStore } from "@renderer/stores/sessions";
import { useCloseGuard } from "@renderer/terminal/close-guard";

/** What a card's context menu can ask the board to open on its behalf. */
export interface TicketDialogRequests {
  /** Archive the ticket, gated by the busy-terminal confirm. */
  requestArchive(ticketId: string): void;
  /** Open the two-step "Remove worktree…" confirm for the ticket. */
  requestRemoveWorktree(ticketId: string): void;
}

const TicketDialogContext = React.createContext<TicketDialogRequests | null>(null);

/**
 * The board's shared ticket dialogs, from a card that only knows how to ask.
 * Throws rather than no-op'ing outside the host: a menu item that silently does
 * nothing is worse than a surface that fails to render while it is being built.
 */
export function useTicketDialogs(): TicketDialogRequests {
  const requests = React.useContext(TicketDialogContext);
  if (requests === null) {
    throw new Error("useTicketDialogs must be used inside <TicketDialogHost>");
  }
  return requests;
}

/** The open "Remove worktree…" confirm's target. */
interface RemoveWorktreeTarget {
  ticketId: string;
  /** Separate from the target so the closed dialog can animate out on the id it was opened with. */
  open: boolean;
}

/**
 * ONE archive confirm and ONE remove-worktree confirm for the whole board,
 * whatever the ticket count. Each card used to mount its own pair — always
 * closed, always in the tree — so a 150-ticket board carried ~180 idle Radix
 * dialogs (~1,800 fibers, a fifth of the window's entire tree) that re-rendered
 * with every board render and cost nothing but time.
 *
 * `children` is a prop, not JSX built here, so opening a dialog re-renders this
 * host and nothing else: the children element is referentially unchanged and the
 * context value is stable, so React bails the whole board subtree out.
 *
 * The dialogs must be able to open AFTER the menu that asked for them is gone —
 * a Radix menu unmounts the instant an item is selected, and the archive guard's
 * busy probe is async, so its confirm always opens into an already-unmounted
 * menu. The old per-card pair satisfied that by being a sibling of the menu
 * inside a component that outlived it; a board-level host satisfies it outright,
 * being no menu's descendant. It also outlives the CARD, so a confirm no longer
 * dies mid-question when a filter keystroke drops the ticket behind it.
 */
export function TicketDialogHost({
  projectId,
  children,
}: {
  projectId: string;
  children: React.ReactNode;
}) {
  // Destructured because `guard` is the hook's stable callback while the object
  // it arrives in is not, and this memo must not be rebuilt per render.
  const { pending, guard, confirm, cancel } = useCloseGuard();
  const [removeWorktree, setRemoveWorktree] = React.useState<RemoveWorktreeTarget | null>(null);

  const requests = React.useMemo<TicketDialogRequests>(
    () => ({
      requestArchive(ticketId) {
        // Archiving kills the ticket's live TERMINALS (stores/board.ts), so gate
        // it behind a confirm when any is busy — the confirm says archiving will
        // end them, and for a terminal that is exactly what happens. It says
        // nothing about the ticket's chats because archiving does not touch
        // them: the worktree survives (only Archive & clean removes it) and the
        // Session outlives the board.
        const container = useSessionsStore.getState().byOwner[ticketId];
        const liveIds = (container?.tabs ?? []).flatMap((tab) =>
          sessionPanes(tab.layout)
            .filter((pane) => pane.exitCode === null)
            .map((pane) => pane.sessionId),
        );
        guard(liveIds, () => void useBoardStore.getState().archiveTicket(projectId, ticketId));
      },
      requestRemoveWorktree(ticketId) {
        setRemoveWorktree({ ticketId, open: true });
      },
    }),
    [guard, projectId],
  );

  return (
    <TicketDialogContext.Provider value={requests}>
      {children}
      <ConfirmCloseDialog
        pending={pending}
        onConfirm={confirm}
        onCancel={cancel}
        title="Archive ticket?"
        confirmLabel="Archive Anyway"
        verb="Archiving"
      />
      {removeWorktree === null ? null : (
        <RemoveWorktreeDialog
          ticketId={removeWorktree.ticketId}
          open={removeWorktree.open}
          onOpenChange={(open) =>
            setRemoveWorktree((current) => (current === null ? null : { ...current, open }))
          }
        />
      )}
    </TicketDialogContext.Provider>
  );
}

import * as React from "react";
import { toast } from "sonner";

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

/**
 * How long a closed dialog stays mounted before it is dropped: the exit
 * animation `AlertDialogContent` runs (`duration-200` there). An upper bound,
 * not a sync — nothing is visible past it, so ending early is free and ending
 * late only delays an unmount by a frame.
 */
const DIALOG_EXIT_MS = 200;

/** The open "Remove worktree…" confirm's target. */
interface RemoveWorktreeTarget {
  ticketId: string;
  /** Separate from the target so the closed dialog can animate out on the id it was opened with. */
  open: boolean;
}

/** What {@link TicketDialogs} lets the host ask of it, imperatively. */
interface TicketDialogHandle {
  archive(ticketId: string): void;
  removeWorktree(ticketId: string): void;
}

/**
 * Both confirms and ALL of their state. Split out from the host on purpose: the
 * host's context value must never change identity, and the cheapest way to
 * guarantee that is to leave the host nothing to change. Opening a dialog is a
 * state update in here, one level below the provider, so the provider does not
 * re-render at all and there is no memo dependency to get wrong.
 */
function TicketDialogs({
  ref,
  projectId,
}: {
  ref: React.Ref<TicketDialogHandle>;
  projectId: string;
}) {
  const { pending, guard, confirm, cancel } = useCloseGuard();
  const [removeWorktree, setRemoveWorktree] = React.useState<RemoveWorktreeTarget | null>(null);
  // ONE close guard now stands behind 150 cards, and the guard's own rule is
  // that a second request replaces the pending one (terminal/close-guard.ts).
  // Board-wide that would archive B and drop A's intent without a word, which
  // the confirm cannot even hint at — it names busy processes, never a ticket.
  // So the board admits one archive at a time. The gate is a ref, not `pending`:
  // the losing window opens at the request and closes on the busy probe, before
  // any dialog exists to be seen or to make the board modal.
  const archiving = React.useRef(false);

  React.useImperativeHandle(
    ref,
    (): TicketDialogHandle => ({
      archive(ticketId) {
        if (archiving.current) {
          toast("Only one archive at a time");
          return;
        }
        archiving.current = true;
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
        guard(liveIds, () => {
          // Reached either straight off an idle probe or on confirm; the only
          // other exit is cancel, which clears the gate below.
          archiving.current = false;
          void useBoardStore.getState().archiveTicket(projectId, ticketId);
        });
      },
      removeWorktree(ticketId) {
        setRemoveWorktree({ ticketId, open: true });
      },
    }),
    [guard, projectId],
  );

  // Drop the closed dialog once it has animated out. Without this the board
  // carries a mounted-but-closed AlertDialog from the first "Remove worktree…"
  // to the end of the session — the exact residue hoisting these out of the
  // cards existed to remove, just once instead of 150 times. A reopen inside
  // the window cancels the timer and reuses the instance.
  React.useEffect(() => {
    if (removeWorktree === null || removeWorktree.open) return;
    const timer = window.setTimeout(() => setRemoveWorktree(null), DIALOG_EXIT_MS);
    return () => window.clearTimeout(timer);
  }, [removeWorktree]);

  return (
    <>
      <ConfirmCloseDialog
        pending={pending}
        onConfirm={confirm}
        onCancel={() => {
          archiving.current = false;
          cancel();
        }}
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
    </>
  );
}

/**
 * ONE archive confirm and ONE remove-worktree confirm for the whole board,
 * whatever the ticket count. Each card used to mount its own pair — always
 * closed, always in the tree — so a 150-ticket board carried ~180 idle Radix
 * dialogs (~1,800 fibers, a fifth of the window's entire tree) that re-rendered
 * with every board render and cost nothing but time.
 *
 * The saving is entirely in the context value never changing identity: a new one
 * re-renders every consumer, and `TicketCard`'s `React.memo` cannot stop context,
 * so a churning value would put all 150 context menus back into every render.
 * That is why the dialogs' state lives one level down in {@link TicketDialogs}
 * and is reached through a ref. Nothing in this component's scope changes, so
 * the memo below has an empty dependency list rather than a correct one — there
 * is no dependency here that a later edit could widen by mistake.
 *
 * `children` is likewise a prop and not JSX built here, so when this host does
 * re-render (a new project) the board subtree is referentially unchanged and
 * React bails it out.
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
  const dialogs = React.useRef<TicketDialogHandle>(null);

  const requests = React.useMemo<TicketDialogRequests>(
    () => ({
      requestArchive(ticketId) {
        dialogs.current?.archive(ticketId);
      },
      requestRemoveWorktree(ticketId) {
        dialogs.current?.removeWorktree(ticketId);
      },
    }),
    [],
  );

  return (
    <TicketDialogContext.Provider value={requests}>
      {children}
      <TicketDialogs ref={dialogs} projectId={projectId} />
    </TicketDialogContext.Provider>
  );
}

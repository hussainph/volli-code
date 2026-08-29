/**
 * The armed-column delay window, alive (VC-128): the timers, the board reads
 * and the one IPC call. Every rule it enforces is arithmetic in
 * `armed-move-model.ts` beside it; this file only owns the clock and the wiring.
 *
 * Two decisions worth keeping when this changes.
 *
 * **A committed move is the only trigger.** `noteDeliberateMove` is called by
 * the board store after `api.tickets.move` came back OK, never from a drag
 * preview and never from a hover. A move that main refused, or that the store
 * reverted, cannot have opened a window, so there is no failure mode where a
 * Run starts against a status change that did not happen.
 *
 * **A timer is a request to reconsider, not a decision.** The timeout re-reads
 * the board, the Automations and the arming before it starts anything, and it
 * re-reads the wall clock too: an early wake reschedules for the real remainder
 * rather than firing. That is the whole of "a slipped pointer cannot start a
 * Run without passing the delay undisturbed" — the delay is measured against
 * the clock, and the arrival must still be true when it ends.
 *
 * Starting the Run deliberately does NOT navigate, unlike running one by hand
 * from the palette. Nobody asked for a chat tab here; they moved a card. VC-13
 * decision 2's no-redirect rule applies, so the finished window becomes a toast
 * whose action is the only door into the new Session.
 */
import { create } from "zustand";
import { displayTicketId, errorMessage, type TicketStatus } from "@volli/shared";
import { toast } from "sonner";

import {
  armedMoveDecision,
  armedRunVerdict,
  openArmedRun,
  type ArmedRunAbandonReason,
  type PendingArmedRun,
} from "./armed-move-model";
import { runAutomationAction } from "./run-automation-model";
import { chatTabId } from "@renderer/components/ticket/ticket-chat-tab";
import { toastError } from "@renderer/lib/toast";
import {
  useAutomationsStore,
  selectArmedAutomation,
  selectArmings,
} from "@renderer/stores/automations";
import { useBoardStore } from "@renderer/stores/board";
import { useChatSessionsStore } from "@renderer/stores/chat-sessions";
import { useProjectsStore } from "@renderer/stores/projects";
import { useTicketSessionRecordsStore } from "@renderer/stores/ticket-session-records";
import { useUiStore } from "@renderer/stores/ui";
import { useWorkspaceStore } from "@renderer/stores/workspace";

interface ArmedRunState {
  /** ticketId → its open window. At most one per Ticket; see PendingArmedRun. */
  pending: Record<string, PendingArmedRun>;
}

export const useArmedRunStore = create<ArmedRunState>()(() => ({ pending: {} }));

/**
 * Live timeouts by ticket id, at module scope rather than in the store: a
 * handle is not state anything renders, and putting it in the store would make
 * every countdown frame a store write.
 */
const timers = new Map<string, ReturnType<typeof setTimeout>>();

function clearWindow(ticketId: string): PendingArmedRun | undefined {
  const timer = timers.get(ticketId);
  if (timer !== undefined) {
    clearTimeout(timer);
    timers.delete(ticketId);
  }
  const pending = useArmedRunStore.getState().pending[ticketId];
  if (pending === undefined) return undefined;
  useArmedRunStore.setState((state) => {
    const { [ticketId]: _dropped, ...rest } = state.pending;
    return { pending: rest };
  });
  return pending;
}

/** The Ticket's column right now, or `null` when this renderer no longer holds it. */
function currentStatus(projectId: string, ticketId: string): TicketStatus | null {
  const tickets = useBoardStore.getState().ticketsByProject[projectId] ?? [];
  return tickets.find((ticket) => ticket.id === ticketId)?.status ?? null;
}

function ticketDisplayId(projectId: string, ticketId: string): string {
  const project = useProjectsStore.getState().projects.find((row) => row.id === projectId);
  const ticket = (useBoardStore.getState().ticketsByProject[projectId] ?? []).find(
    (row) => row.id === ticketId,
  );
  if (project === undefined || ticket === undefined) return "this ticket";
  return displayTicketId(project.ticketPrefix, ticket.ticketNumber);
}

/**
 * A committed Deliberate move. Opens a window when the destination column is
 * armed and the move was an arrival; does nothing at all otherwise, which is
 * every move on a board with no Automations on it.
 */
export function noteDeliberateMove(input: {
  projectId: string;
  ticketId: string;
  from: TicketStatus;
  to: TicketStatus;
}): void {
  // Any earlier window for this Ticket is void: it was opened for an arrival
  // that this move has just replaced.
  clearWindow(input.ticketId);
  const automations = useAutomationsStore.getState();
  const decision = armedMoveDecision({
    automations: automations.byProject[input.projectId] ?? [],
    armings: selectArmings(automations, input.projectId),
    from: input.from,
    to: input.to,
  });
  if (decision.kind === "nothing") return;

  const pending = openArmedRun({
    ticketId: input.ticketId,
    ticketDisplayId: ticketDisplayId(input.projectId, input.ticketId),
    projectId: input.projectId,
    automation: decision.automation,
    status: input.to,
    now: Date.now(),
  });
  useArmedRunStore.setState((state) => ({
    pending: { ...state.pending, [input.ticketId]: pending },
  }));
  schedule(pending);
}

function schedule(pending: PendingArmedRun): void {
  const delay = Math.max(0, pending.startAt - Date.now());
  timers.set(
    pending.ticketId,
    setTimeout(() => {
      timers.delete(pending.ticketId);
      void settle(pending);
    }, delay),
  );
}

async function settle(pending: PendingArmedRun): Promise<void> {
  // The window may have been cancelled between the timer firing and this call.
  if (useArmedRunStore.getState().pending[pending.ticketId] !== pending) return;
  const automations = useAutomationsStore.getState();
  const verdict = armedRunVerdict({
    pending,
    now: Date.now(),
    currentStatus: currentStatus(pending.projectId, pending.ticketId),
    armedNow: selectArmedAutomation(automations, pending.projectId, pending.status),
  });
  if (verdict.kind === "wait") {
    // The clock disagrees with the timer — reschedule for what is really left
    // rather than starting a Run the delay has not finished protecting.
    schedule(pending);
    return;
  }
  if (verdict.kind === "abandon") {
    clearWindow(pending.ticketId);
    announceAbandon(pending, verdict.reason);
    return;
  }
  clearWindow(pending.ticketId);
  await start(pending);
}

/**
 * A window that ended without a Run because the board moved on. Silent for
 * `left-column`: dragging the card straight out again IS the person saying no,
 * and answering a deliberate act with a toast is noise. The other two are
 * reported, because the person did nothing and still did not get the Run the
 * window promised.
 */
function announceAbandon(pending: PendingArmedRun, reason: ArmedRunAbandonReason): void {
  if (reason === "left-column") return;
  toast.info(`${pending.automationName} didn't start on ${pending.ticketDisplayId}`, {
    description:
      reason === "gone"
        ? "The ticket is no longer on this board."
        : "The column stopped arming it while the countdown ran.",
  });
}

async function start(pending: PendingArmedRun): Promise<void> {
  let action: ReturnType<typeof runAutomationAction>;
  try {
    action = runAutomationAction(
      await window.api.automations.run({
        // A durable retry identity, minted once per window. A window fires at
        // most once, so it needs no cross-call memory of its own.
        commandId: crypto.randomUUID(),
        automationId: pending.automationId,
        ticketId: pending.ticketId,
      }),
    );
  } catch (error) {
    toastError(`Couldn't run automation: ${errorMessage(error)}`);
    return;
  }
  switch (action.kind) {
    case "open-model-access":
      // Same classification as a hand-run — a missing default model is a
      // configuration state whose recovery is Model Access — but NOT the same
      // act. A hand-run's person is waiting on a Session and asked for it; this
      // person moved a card, and taking the window over with Settings 3.5
      // seconds later is the redirect VC-13 decision 2 rules out. The recovery
      // is offered instead of performed.
      toastError(`${pending.automationName} couldn't start on ${pending.ticketDisplayId}`, {
        description: "Choose a default model before an armed column can run one.",
        action: {
          label: "Model Access",
          onClick: () => useUiStore.getState().setSettingsOpen(true, "model-access"),
        },
      });
      return;
    case "toast":
      toastError(action.message);
      return;
    case "open-session": {
      const chat = useChatSessionsStore.getState();
      chat.adoptChatSession(action.sessionId);
      // So the ticket's rail shows the row without waiting on a refresh it did
      // not ask for.
      void useTicketSessionRecordsStore.getState().refresh(pending.ticketId);
      // No navigation: nobody asked for a tab, they moved a card. The toast's
      // action is the only door (VC-13 decision 2).
      toast.success(`${pending.automationName} started on ${pending.ticketDisplayId}`, {
        action: {
          label: "Open session",
          onClick: () => {
            chat.openChatTab(pending.ticketId, action.sessionId);
            useWorkspaceStore.getState().openTicketWorkspace(action.projectId, pending.ticketId, {
              tabId: chatTabId(action.sessionId),
            });
          },
        },
      });
      return;
    }
  }
}

/**
 * The window's one control. Keeps the move and starts nothing — reverting the
 * move is the board's ordinary undo and is deliberately not offered here.
 */
export function cancelArmedRun(ticketId: string): void {
  clearWindow(ticketId);
}

/** Test seam: drop every open window and its timer. */
export function resetArmedRuns(): void {
  for (const timer of timers.values()) clearTimeout(timer);
  timers.clear();
  useArmedRunStore.setState({ pending: {} });
}

/**
 * The armed-column delay window, alive (VC-128): the timers, the board reads
 * and the one IPC call. Every rule it enforces is arithmetic in
 * `armed-move-model.ts` beside it; this file only owns the clock and the wiring.
 *
 * Two decisions worth keeping when this changes.
 *
 * **A committed move is the only trigger, and there is one door for it.**
 * `noteDeliberateMove` is called by the board store after `api.tickets.move`
 * came back OK, and by main's own announcement of a `volli ticket move` it
 * committed — CONTEXT.md's two Deliberate moves, human drag and explicit CLI,
 * arriving at the same function with the same semantics. Never from a drag
 * preview and never from a hover: a move that main refused, or that the store
 * reverted, cannot have opened a window, so there is no failure mode where a
 * Run starts against a status change that did not happen.
 *
 * **A cold cache defers the question rather than answering it "unarmed".** The
 * board reads its Automations and armings when it mounts, and an arrival can
 * beat those reads — a drop a heartbeat after the board appears, or a CLI move
 * into a project no window has opened. Classifying against an empty cache would
 * silently lose the Run with no later sweep to recover it, so an arrival whose
 * caches are cold waits for them (`ensureLoaded`) and is classified afterwards.
 * The window therefore opens from the moment the answer is KNOWN, which can
 * only make the Run later than the arrival's 3500 ms, never earlier — and the
 * person always gets the whole delay to reach Cancel.
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
  type DeliberateMoveChoice,
  type PendingArmedRun,
} from "./armed-move-model";
import { runAutomationAction } from "./run-automation-model";
import { chatTabId } from "@renderer/components/ticket/ticket-chat-tab";
import { toastError } from "@renderer/lib/toast";
import {
  useAutomationsStore,
  selectArmedAutomation,
  selectArmings,
  selectPlanningLoaded,
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
 * A committed Deliberate move, as the arrival door takes it: which Ticket, and
 * the two columns — `from` is what makes an arrival distinguishable from a
 * reorder, and no re-read can recover it after the fact.
 *
 * One declaration for both reporters. The board store's
 * `DeliberateMoveObserver` is this type rather than a second spelling of it, so
 * a drag and a `volli ticket move` cannot drift into two shapes of one fact.
 * The transport's own `TicketMovedNotice` stays declared where the wire is
 * (`ipc/contract.ts`) and carries these same four fields: it is what MAIN
 * announces for callers that are not this renderer, which is a narrower fact
 * than "a Deliberate move happened", and the renderer is the only side that
 * knows both.
 */
export interface DeliberateMove {
  projectId: string;
  ticketId: string;
  from: TicketStatus;
  to: TicketStatus;
  /**
   * What the ⌥ drag picker named on release (VC-132), when this move came from
   * the board's own drop. Absent for every other Deliberate move — the card's
   * context menu, the ticket rail's status pill, an explicit `volli ticket
   * move` — and an absent choice is exactly today's path.
   */
  choice?: DeliberateMoveChoice;
}

/**
 * Which arrival is the live one for a Ticket.
 *
 * A cold-cache arrival is classified after an await, and the board can move
 * underneath it in that time. The token is what makes the late classification
 * check whether it is still the arrival being asked about: a second move for
 * the same Ticket bumps it, and the first one then opens nothing rather than a
 * window for a column the Ticket has already left.
 */
const arrivals = new Map<string, number>();
let nextArrival = 0;

/**
 * A committed Deliberate move — a human drag, a card's context menu, the
 * ticket rail's status pill, or an explicit `volli ticket move` main confirmed.
 * Opens a window when the destination column is armed and the move was an
 * arrival; does nothing at all otherwise, which is every move on a board with
 * no Automations on it.
 */
export function noteDeliberateMove(input: DeliberateMove): void {
  // Any earlier window for this Ticket is void: it was opened for an arrival
  // that this move has just replaced.
  clearWindow(input.ticketId);
  const token = ++nextArrival;
  arrivals.set(input.ticketId, token);
  // The warm path stays synchronous — no await, no frame — because that is
  // every move on a board a person is already looking at.
  if (selectPlanningLoaded(useAutomationsStore.getState(), input.projectId)) {
    classify(input, token);
    return;
  }
  void useAutomationsStore
    .getState()
    .ensureLoaded(input.projectId)
    .then(() => classify(input, token));
}

/** The arrival's whole decision, taken against caches that have landed. */
function classify(input: DeliberateMove, token: number): void {
  // A later move for this Ticket has replaced the arrival this was asked
  // about; the board has already moved on and this one decides nothing.
  if (arrivals.get(input.ticketId) !== token) return;
  arrivals.delete(input.ticketId);
  const automations = useAutomationsStore.getState();
  const decision = armedMoveDecision({
    automations: automations.byProject[input.projectId] ?? [],
    armings: selectArmings(automations, input.projectId),
    enabledAutomationIds: automations.enabledIds,
    from: input.from,
    to: input.to,
    choice: input.choice,
  });
  if (decision.kind === "nothing") return;

  const pending = openArmedRun({
    ticketId: input.ticketId,
    ticketDisplayId: ticketDisplayId(input.projectId, input.ticketId),
    projectId: input.projectId,
    automation: decision.automation,
    status: input.to,
    origin: decision.origin,
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
    enabledAutomationIds: automations.enabledIds,
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
    description: ABANDON_DESCRIPTIONS[reason],
  });
}

const ABANDON_DESCRIPTIONS: Record<Exclude<ArmedRunAbandonReason, "left-column">, string> = {
  gone: "The ticket is no longer on this board.",
  disarmed: "The column stopped arming it while the countdown ran.",
  "switched-off": "It was switched off on this machine while the countdown ran.",
};

async function start(pending: PendingArmedRun): Promise<void> {
  let action: ReturnType<typeof runAutomationAction>;
  try {
    action = runAutomationAction(
      await window.api.automations.run({
        // A durable retry identity, minted once per window. A window fires at
        // most once, so it needs no cross-call memory of its own.
        commandId: crypto.randomUUID(),
        target: { kind: "automation", automationId: pending.automationId },
        ticketId: pending.ticketId,
        // No override on the drag path, ever (VC-112): this Run belongs to a
        // card someone dropped, and the Runtime is the one the record resolves.
        modelOverride: null,
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

/** Test seam: drop every open window, its timer, and any arrival mid-classification. */
export function resetArmedRuns(): void {
  for (const timer of timers.values()) clearTimeout(timer);
  timers.clear();
  arrivals.clear();
  useArmedRunStore.setState({ pending: {} });
}

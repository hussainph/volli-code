/**
 * Run an Automation by hand from any renderer surface — the command palette,
 * and the Automations page's own row action. The decision of what to do with
 * the door's answer is `run-automation-model.ts`; this module is the glue that
 * performs it: the adopt + open pair every externally-minted Session already
 * rides (the session-started toast's own action in `main.tsx`), plus the rail
 * refresh `startTicketChat` does for the same reason.
 *
 * Two ways to land, and the difference is what the person was doing:
 *
 *  - {@link runAutomationOnTicket} NAVIGATES. It is the palette's "run by
 *    name": the person asked for this Run and has nothing else on screen they
 *    were in the middle of.
 *  - {@link runAutomationFromListing} does not. Someone on a listing surface
 *    is working through a list, and taking the window away from it is VC-13
 *    decision 2's no-redirect rule — so the finished Run becomes a toast whose
 *    action is the door (the shape VC-128's armed window also uses).
 */
import { errorMessage } from "@volli/shared";
import { toast } from "sonner";

import { runAutomationAction, type RunAutomationAction } from "./run-automation-model";
import { chatTabId } from "@renderer/components/ticket/ticket-chat-tab";
import { toastError } from "@renderer/lib/toast";
import { useChatSessionsStore } from "@renderer/stores/chat-sessions";
import { useTicketSessionRecordsStore } from "@renderer/stores/ticket-session-records";
import { useUiStore } from "@renderer/stores/ui";
import { useWorkspaceStore } from "@renderer/stores/workspace";

/** A click whose IPC reply was lost keeps its durable command id for Retry. */
const pendingCommandIds = new Map<string, string>();

/**
 * The one Run call. Answers the classified action, or `null` when the
 * transport itself failed — that arm has already toasted, because a person is
 * waiting on a Session and no other surface will tell them.
 */
async function startRun(input: {
  automationId: string;
  ticketId: string;
}): Promise<RunAutomationAction | null> {
  const retryKey = `${input.automationId}\u0000${input.ticketId}`;
  const commandId = pendingCommandIds.get(retryKey) ?? crypto.randomUUID();
  pendingCommandIds.set(retryKey, commandId);
  try {
    const action = runAutomationAction(
      await window.api.automations.run({
        ...input,
        // The command id is durable intent, not an Electron request counter.
        commandId,
      }),
    );
    // A typed response (success or refusal) reached the core, so a later
    // deliberate run is new intent. Only a transport throw keeps the id.
    pendingCommandIds.delete(retryKey);
    return action;
  } catch (error) {
    toastError(`Couldn't run automation: ${errorMessage(error)}`);
    return null;
  }
}

/**
 * The same call for a Run whose Target is the PROJECT (VC-130) — a schedule's
 * own door, reached by hand from a Skipped occurrence's "Run now".
 *
 * A second function rather than a nullable Ticket on the one above, because
 * the transports are two channels and the retry key is a different pair. What
 * they DO share is the retry map: a click whose IPC reply was lost keeps its
 * durable command id, so pressing again repeats the intent rather than opening
 * a second Session.
 */
async function startProjectRun(input: {
  automationId: string;
  projectId: string;
}): Promise<RunAutomationAction | null> {
  const retryKey = `project\u0000${input.automationId}\u0000${input.projectId}`;
  const commandId = pendingCommandIds.get(retryKey) ?? crypto.randomUUID();
  pendingCommandIds.set(retryKey, commandId);
  try {
    const action = runAutomationAction(
      await window.api.automations.runForProject({ ...input, commandId }),
    );
    pendingCommandIds.delete(retryKey);
    return action;
  } catch (error) {
    toastError(`Couldn't run automation: ${errorMessage(error)}`);
    return null;
  }
}

/**
 * Start the Run a Skipped occurrence records as not having happened (VC-112:
 * "a person may start it by hand from the Run history afterwards").
 *
 * It runs at the Target the schedule would have used — the Project — so what a
 * person gets by hand is the same Session the schedule would have opened. Like
 * every other listing-surface Run it does NOT navigate: the person is reading a
 * history and may well start a second one, so the door arrives as a toast
 * action (VC-13 decision 2).
 *
 * It starts ONE Run, whatever `missedCount` the row stands for. A skip covering
 * fifty missed hours is fifty occurrences that will never be replayed — the
 * button offers the work now, not the backlog.
 */
export async function runSkippedOccurrence(input: {
  automationId: string;
  automationName: string;
  projectId: string;
}): Promise<void> {
  const action = await startProjectRun({
    automationId: input.automationId,
    projectId: input.projectId,
  });
  if (action === null) return;
  switch (action.kind) {
    case "open-model-access":
      useUiStore.getState().setSettingsOpen(true, "model-access");
      return;
    case "toast":
      toastError(action.message);
      return;
    case "open-session": {
      useChatSessionsStore.getState().adoptChatSession(action.sessionId);
      toast.success(`${input.automationName} started`, {
        action: {
          label: "Open session",
          onClick: () =>
            openRunSession({
              sessionId: action.sessionId,
              projectId: action.projectId,
              // A schedule Run names no Ticket, so its Session opens in Home.
              ticketId: null,
            }),
        },
      });
      return;
    }
  }
}

export async function runAutomationOnTicket(input: {
  automationId: string;
  ticketId: string;
}): Promise<void> {
  const action = await startRun(input);
  if (action === null) return;
  switch (action.kind) {
    case "open-model-access":
      useUiStore.getState().setSettingsOpen(true, "model-access");
      return;
    case "toast":
      toastError(action.message);
      return;
    case "open-session":
      openRunSession({
        sessionId: action.sessionId,
        projectId: action.projectId,
        ticketId: input.ticketId,
      });
      return;
  }
}

/**
 * Run one Automation from a surface that LISTS it (VC-112: running by hand is
 * universal, and every listing surface can do it). The Automations page is the
 * caller today.
 *
 * It never navigates. The person is on a page of records, quite possibly
 * running a second one next, and a Session that seizes the window is VC-13
 * decision 2's redirect — so success is a toast naming the Automation and the
 * Ticket, whose action is the only door. A missing default model still opens
 * Model Access: that is not a redirect but the recovery for a configuration
 * state, and this person is waiting on a Run they asked for.
 */
export async function runAutomationFromListing(input: {
  automationId: string;
  automationName: string;
  ticketId: string;
  ticketDisplayId: string;
}): Promise<void> {
  const action = await startRun({
    automationId: input.automationId,
    ticketId: input.ticketId,
  });
  if (action === null) return;
  switch (action.kind) {
    case "open-model-access":
      useUiStore.getState().setSettingsOpen(true, "model-access");
      return;
    case "toast":
      toastError(action.message);
      return;
    case "open-session": {
      const chat = useChatSessionsStore.getState();
      chat.adoptChatSession(action.sessionId);
      // So the Ticket's rail holds the row without waiting on a refresh nobody
      // on this page would trigger.
      void useTicketSessionRecordsStore.getState().refresh(input.ticketId);
      toast.success(`${input.automationName} started on ${input.ticketDisplayId}`, {
        action: {
          label: "Open session",
          onClick: () =>
            openRunSession({
              sessionId: action.sessionId,
              projectId: action.projectId,
              ticketId: input.ticketId,
            }),
        },
      });
      return;
    }
  }
}

/**
 * Open the Session a Run created — the adopt + open pair every externally
 * minted Session already rides.
 *
 * Extracted from the success arm above so the Automations page's Run history
 * (VC-127) opens a Session by exactly the same steps a fresh Run does. A
 * history row that navigated differently from the launch it records would be
 * two answers to "where does this Run live", and the one nobody exercises is
 * the one that rots.
 *
 * `ticketId: null` is a Session that belongs to no Ticket — a Run whose Ticket
 * was deleted, or (VC-130) one that named the project instead. It opens in
 * Home, which is where every other ticketless Session opens from the sidebar's
 * own rows; a Run is never a dead row for want of a Ticket.
 */
export function openRunSession(input: {
  sessionId: string;
  projectId: string;
  ticketId: string | null;
}): void {
  const chat = useChatSessionsStore.getState();
  chat.adoptChatSession(input.sessionId);
  if (input.ticketId === null) {
    chat.openChatTab(input.projectId, input.sessionId);
    useWorkspaceStore.getState().openHome(input.projectId, chatTabId(input.sessionId));
    return;
  }
  chat.openChatTab(input.ticketId, input.sessionId);
  useWorkspaceStore.getState().openTicketWorkspace(input.projectId, input.ticketId, {
    tabId: chatTabId(input.sessionId),
  });
  // So the rail's row appears without waiting on an unrelated refresh.
  void useTicketSessionRecordsStore.getState().refresh(input.ticketId);
}

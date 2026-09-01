/**
 * Run an Automation by hand from any renderer surface. The decision of what to
 * do with the door's answer is `run-automation-model.ts`; this module performs
 * it and keeps the fresh Session resident for the toast's action.
 *
 * Universal landing ruling (VC-234, superseding the listing-versus-context
 * reading of VC-13 decision 2): NO Automation Run door navigates. Success is
 * always announced in place with an "Open session" action, and the person
 * decides whether to leave what they are doing. Rails, menus, pages, palettes,
 * drops, and skipped occurrences do not get different answers.
 */
import {
  automationRunRetryKey,
  errorMessage,
  type AutomationRunTarget,
  type ModelSelection,
} from "@volli/shared";
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

/** The transport fields shared by every Ticket-targeted Run request. */
interface RunRequest {
  target: AutomationRunTarget;
  ticketId: string;
  /** This invocation's Runtime, or `null` to resolve it the ordinary way. */
  modelOverride: ModelSelection | null;
}

/** The context every Ticket Run success toast names. */
export interface TicketRunRequest extends RunRequest {
  /** Fallback for an Unbound Run or a launch answer without a resolved name. */
  automationName: string;
  ticketDisplayId: string;
}

/**
 * The one Run call. Answers the classified action, or `null` when the
 * transport itself failed — that arm has already toasted, because a person is
 * waiting on a Session and no other surface will tell them.
 */
async function startRun(input: RunRequest): Promise<RunAutomationAction | null> {
  // What a lost reply is retried AS: the WHOLE intent (`automationRunRetryKey`)
  // — the record or the Unbound Run's own words, the Ticket, and this
  // invocation's model override. Running the same work on a different model is
  // a second Run, so it must not FIND the first one's durable command id: an
  // override left out of this key would reuse that id, and main would answer
  // the second press with the first Run's receipt. Main compares the same
  // identity durably (`sameAutomationRunRequestIdentity`), so the two halves of
  // "the same Run" are one statement rather than two that agree by luck.
  const retryKey = automationRunRetryKey(input);
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
 * own door, reached by hand from a scheduled row's Play or a Skipped
 * occurrence's "Run now".
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
 * Run one Automation at the PROJECT (VC-130) — the Target a schedule Trigger
 * names, reached by hand.
 *
 * Two surfaces press it, and they are the same act:
 *
 *  - A **scheduled record's Play**, on the Automations page. VC-112 rules that
 *    the Trigger decides the Target, so running a scheduled Automation by hand
 *    must start the Project Session its schedule would have started. Asking
 *    which Ticket instead would make the by-hand Run a different piece of work from
 *    the automatic one, which is the one thing this control must not be.
 *  - A **Skipped occurrence's "Run now"**, from the Run history (VC-112: "a
 *    person may start it by hand afterwards").
 *
 * Like every other Automation Run door it does NOT navigate: VC-234's universal
 * rule makes the success toast's "Open session" action the only door.
 *
 * It starts ONE Run, whatever number of occurrences a skip row stands for. A
 * skip covering fifty missed hours is fifty occurrences that will never be
 * replayed — the button offers the work now, not the backlog.
 */
export async function runAutomationForProject(input: {
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
    case "session-started": {
      useChatSessionsStore.getState().adoptChatSession(action.sessionId);
      toast.success(`${action.automationName ?? input.automationName} started`, {
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

/**
 * Run on one Ticket without navigating (VC-234's universal landing ruling).
 *
 * Every caller supplies the words its success toast can fall back to, but the
 * launch answer wins when main resolved a bound Automation under a newer name
 * (VC-231). A missing default model still opens Model Access: that is recovery
 * for the Run the person requested, not a successful landing.
 */
export async function runAutomationOnTicket(input: TicketRunRequest): Promise<void> {
  const action = await startRun({
    target: input.target,
    ticketId: input.ticketId,
    modelOverride: input.modelOverride,
  });
  if (action === null) return;
  switch (action.kind) {
    case "open-model-access":
      useUiStore.getState().setSettingsOpen(true, "model-access");
      return;
    case "toast":
      toastError(action.message);
      return;
    case "session-started": {
      const chat = useChatSessionsStore.getState();
      chat.adoptChatSession(action.sessionId);
      // Keep the Ticket's rail current while the person remains on the surface
      // that started the Run. Opening the toast action must not be required for
      // the fresh history row to exist.
      void useTicketSessionRecordsStore.getState().refresh(input.ticketId);
      toast.success(
        `${action.automationName ?? input.automationName} started on ${input.ticketDisplayId}`,
        {
          action: {
            label: "Open session",
            onClick: () =>
              openRunSession({
                sessionId: action.sessionId,
                projectId: action.projectId,
                ticketId: input.ticketId,
              }),
          },
        },
      );
      return;
    }
  }
}

/**
 * Open the Session a Run created — the adopt + open pair every externally
 * minted Session already rides.
 *
 * Extracted from the success arm above so the fresh Run's toast action and the
 * Automations page's Run history (VC-127) open a Session by exactly the same
 * steps. Two explicit doors with different navigation would be two answers to
 * "where does this Run live", and the one nobody exercises is the one that
 * rots.
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

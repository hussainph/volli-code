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
import { guardWrite } from "@renderer/components/hosts/use-hosts";
import { chatTabId } from "@renderer/components/ticket/ticket-chat-tab";
import { toastError } from "@renderer/lib/toast";
import { useBoardStore } from "@renderer/stores/board";
import { useChatSessionsStore } from "@renderer/stores/chat-sessions";
import { useUiStore } from "@renderer/stores/ui";
import { useWorkspaceStore } from "@renderer/stores/workspace";
import { refuseRemote, refuseRemoteTicket } from "@renderer/stores/remote-project";

/** A click whose IPC reply was lost keeps its durable command id for Retry. */
const pendingCommandIds = new Map<string, string>();

/**
 * What became of a hand-run, for a surface that gates its own control on it
 * (VC-406: the rail's inspect popover, whose Run must not be pressable twice
 * for one launch and must offer Retry when a launch did not land).
 *
 * It is a REPORT, not a second announcement: every arm below has already done
 * what a person needs — adopted the Session and toasted its door, toasted the
 * refusal, or opened Model Access. A caller that ignores the value behaves
 * exactly as it did before this existed, which is why every other Run door
 * still does.
 *
 * The two retryable arms are distinguished from the third on purpose:
 * `needs-model-access` is configuration a person must fix elsewhere before any
 * Run can land, so pressing Run again would fail the same way — it is not an
 * offer to retry (AGENTS.md: authentication, permissions, configuration and
 * quota failures require explicit user recovery).
 */
export type AutomationRunOutcome =
  /** Main accepted the Run; its Session is adopted and its door is on screen. */
  | "started"
  /** No default model: Model Access is open, and Run is not the recovery. */
  | "needs-model-access"
  /** A typed refusal, already toasted. Pressing again is a fresh attempt. */
  | "refused"
  /** The transport itself failed, already toasted. Retry repeats the intent. */
  | "failed";

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
  // A remote project's ticket runs on its host, not here (VC-711).
  if (refuseRemoteTicket(input.ticketId)) return null;
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
  if (refuseRemote(input.projectId)) return null;
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
 *    must start the Board Session its schedule would have started. Asking
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
 *
 * It ANSWERS with {@link AutomationRunOutcome} as well as acting on the result,
 * for the one caller that gates a control on the launch rather than firing and
 * forgetting. Nothing about the arms themselves changed.
 */
/** The project a ticket the board holds belongs to, `null` for one it does not hold. */
function ticketProject(ticketId: string): string | null {
  for (const [projectId, tickets] of Object.entries(useBoardStore.getState().ticketsByProject)) {
    if (tickets.some((ticket) => ticket.id === ticketId)) return projectId;
  }
  return null;
}

export async function runAutomationOnTicket(
  input: TicketRunRequest,
): Promise<AutomationRunOutcome> {
  // Every hand-run door (the card menu, the rail, the palette, the page, the
  // New-ticket composer) lands here. A ticket whose project's host cannot
  // serve (VC-576) starts no Run, and says why.
  if (!guardWrite(ticketProject(input.ticketId))) return "refused";
  const action = await startRun({
    target: input.target,
    ticketId: input.ticketId,
    modelOverride: input.modelOverride,
  });
  if (action === null) return "failed";
  switch (action.kind) {
    case "open-model-access":
      useUiStore.getState().setSettingsOpen(true, "model-access");
      return "needs-model-access";
    case "toast":
      toastError(action.message);
      return "refused";
    case "session-started": {
      const chat = useChatSessionsStore.getState();
      chat.adoptChatSession(action.sessionId);
      // No listing refetch here (VC-373). A Run's Session is minted through
      // the Session Engine, so main has already announced its row on
      // `volli:session-activity` — the rail's roster cache folds it in within a
      // frame or two, wherever the person happens to be looking. This surface
      // opening the Session does not change that, and a read here would only
      // race the push to say the same thing.
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
      return "started";
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
  // The rail's row for this Session is already on its way — the Run created
  // it through the Session Engine, and `volli:session-activity` carries the
  // row (VC-373). Opening the Ticket mounts the rail against the shared cache,
  // so nothing here needs to re-read the listing.
}

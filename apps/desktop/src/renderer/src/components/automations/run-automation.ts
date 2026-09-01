/**
 * Run an Automation by hand on one or more Tickets from any renderer surface.
 * Each Ticket keeps an independent durable command id and receipt; a board drop
 * fans the selected ids out in parallel, adopts every fresh Session, then opens
 * the first result instead of racing several navigation writes.
 */
import { errorMessage } from "@volli/shared";

import {
  automationTicketIdsFromDrop,
  runAutomationAction,
  type RunAutomationAction,
} from "./run-automation-model";
import { chatTabId } from "@renderer/components/ticket/ticket-chat-tab";
import { toastError } from "@renderer/lib/toast";
import { useChatSessionsStore } from "@renderer/stores/chat-sessions";
import { useTicketSessionRecordsStore } from "@renderer/stores/ticket-session-records";
import { useUiStore } from "@renderer/stores/ui";
import { useWorkspaceStore } from "@renderer/stores/workspace";

/** A click whose IPC reply was lost keeps its durable command id for Retry. */
const pendingCommandIds = new Map<string, string>();

async function requestAutomationRun(input: {
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

function adoptAutomationSession(
  ticketId: string,
  action: Extract<RunAutomationAction, { kind: "open-session" }>,
  navigate: boolean,
): void {
  const chat = useChatSessionsStore.getState();
  chat.adoptChatSession(action.sessionId);
  chat.openChatTab(ticketId, action.sessionId);
  if (navigate) {
    useWorkspaceStore.getState().openTicketWorkspace(action.projectId, ticketId, {
      tabId: chatTabId(action.sessionId),
    });
  }
  // So the rail's row appears without waiting on an unrelated refresh.
  void useTicketSessionRecordsStore.getState().refresh(ticketId);
}

export async function runAutomationOnTicket(input: {
  automationId: string;
  ticketId: string;
}): Promise<void> {
  const action = await requestAutomationRun(input);
  if (action === null) return;
  switch (action.kind) {
    case "open-model-access":
      useUiStore.getState().setSettingsOpen(true, "model-access");
      return;
    case "toast":
      toastError(action.message);
      return;
    case "open-session":
      adoptAutomationSession(input.ticketId, action, true);
  }
}

/** Starts one independent Automation Run per Ticket, concurrently. */
export async function runAutomationOnTickets(input: {
  automationId: string;
  ticketIds: readonly string[];
}): Promise<void> {
  const ticketIds = [...new Set(input.ticketIds)];
  const actions = await Promise.all(
    ticketIds.map(async (ticketId) => ({
      ticketId,
      action: await requestAutomationRun({ automationId: input.automationId, ticketId }),
    })),
  );

  let openedSession = false;
  let needsModelAccess = false;
  for (const { ticketId, action } of actions) {
    if (action === null) continue;
    switch (action.kind) {
      case "open-model-access":
        needsModelAccess = true;
        break;
      case "toast":
        toastError(action.message);
        break;
      case "open-session":
        adoptAutomationSession(ticketId, action, !openedSession);
        openedSession = true;
        break;
    }
  }
  if (needsModelAccess) useUiStore.getState().setSettingsOpen(true, "model-access");
}

/**
 * Shared drop door for the Automation UI incubating in the lab. Returns false
 * for unrelated drags; a Ticket payload always starts every selected Run in
 * parallel through the same per-ticket durable command path as the palette.
 */
export async function runAutomationOnTicketDrop(input: {
  automationId: string;
  dragData: unknown;
}): Promise<boolean> {
  const ticketIds = automationTicketIdsFromDrop(input.dragData);
  if (ticketIds === null) return false;
  await runAutomationOnTickets({ automationId: input.automationId, ticketIds });
  return true;
}

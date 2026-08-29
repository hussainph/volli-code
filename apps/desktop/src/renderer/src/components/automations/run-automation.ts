/**
 * Run an Automation by hand on a Ticket, from any renderer surface (the
 * command palette today). The decision of what to do with the door's answer
 * is `run-automation-model.ts`; this module is the glue that performs it:
 * the adopt + open pair every externally-minted Session already rides (the
 * session-started toast's own action in `main.tsx`), plus the rail refresh
 * `startTicketChat` does for the same reason.
 */
import { errorMessage } from "@volli/shared";

import { runAutomationAction } from "./run-automation-model";
import { chatTabId } from "@renderer/components/ticket/ticket-chat-tab";
import { toastError } from "@renderer/lib/toast";
import { useChatSessionsStore } from "@renderer/stores/chat-sessions";
import { useTicketSessionRecordsStore } from "@renderer/stores/ticket-session-records";
import { useUiStore } from "@renderer/stores/ui";
import { useWorkspaceStore } from "@renderer/stores/workspace";

/** A click whose IPC reply was lost keeps its durable command id for Retry. */
const pendingCommandIds = new Map<string, string>();

export async function runAutomationOnTicket(input: {
  automationId: string;
  ticketId: string;
}): Promise<void> {
  const retryKey = `${input.automationId}\u0000${input.ticketId}`;
  const commandId = pendingCommandIds.get(retryKey) ?? crypto.randomUUID();
  pendingCommandIds.set(retryKey, commandId);
  let action: ReturnType<typeof runAutomationAction>;
  try {
    action = runAutomationAction(
      await window.api.automations.run({
        ...input,
        // The command id is durable intent, not an Electron request counter.
        commandId,
      }),
    );
    // A typed response (success or refusal) reached the core, so a later
    // deliberate run is new intent. Only a transport throw keeps the id.
    pendingCommandIds.delete(retryKey);
  } catch (error) {
    toastError(`Couldn't run automation: ${errorMessage(error)}`);
    return;
  }
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
 * Open the Session a Run created — the adopt + open pair every externally
 * minted Session already rides.
 *
 * Extracted from the success arm above so the Automations page's Run history
 * (VC-127) opens a Session by exactly the same steps a fresh Run does. A
 * history row that navigated differently from the launch it records would be
 * two answers to "where does this Run live", and the one nobody exercises is
 * the one that rots.
 */
export function openRunSession(input: {
  sessionId: string;
  projectId: string;
  ticketId: string;
}): void {
  const chat = useChatSessionsStore.getState();
  chat.adoptChatSession(input.sessionId);
  chat.openChatTab(input.ticketId, input.sessionId);
  useWorkspaceStore.getState().openTicketWorkspace(input.projectId, input.ticketId, {
    tabId: chatTabId(input.sessionId),
  });
  // So the rail's row appears without waiting on an unrelated refresh.
  void useTicketSessionRecordsStore.getState().refresh(input.ticketId);
}

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

export async function runAutomationOnTicket(input: {
  automationId: string;
  ticketId: string;
}): Promise<void> {
  let action: ReturnType<typeof runAutomationAction>;
  try {
    action = runAutomationAction(await window.api.automations.run(input));
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
    case "open-session": {
      const chat = useChatSessionsStore.getState();
      chat.adoptChatSession(action.sessionId);
      chat.openChatTab(input.ticketId, action.sessionId);
      useWorkspaceStore.getState().openTicketWorkspace(action.projectId, input.ticketId, {
        tabId: chatTabId(action.sessionId),
      });
      // So the rail's row appears without waiting on an unrelated refresh.
      void useTicketSessionRecordsStore.getState().refresh(input.ticketId);
      return;
    }
  }
}

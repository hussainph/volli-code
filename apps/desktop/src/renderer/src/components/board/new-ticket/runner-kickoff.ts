import { errorMessage } from "@volli/shared";
import { toast } from "sonner";
import type { ComposerRunner } from "@renderer/components/chat/runner-picker-model";
import {
  runnerStartAccountScope,
  runnerStartIntent,
  submitRunnerDraft,
} from "@renderer/components/chat/runner-picker-start";
import { useChatDraftsStore } from "@renderer/stores/chat-drafts";
import { useChatSessionsStore } from "@renderer/stores/chat-sessions";
import type { KickoffChat } from "./submit";

/**
 * The ticket already exists. Keep its first turn in a recoverable Draft, not
 * the ticket form: a refused/lost start must never offer to create it again.
 * Every cloud kickoff uses C2, including this Mac; no local attach fallback.
 */
export async function startRunnerKickoff(
  projectId: string,
  ticketId: string,
  chat: KickoffChat,
  runner: ComposerRunner,
): Promise<string | null> {
  let sessionId: string | null = null;
  try {
    const accountScope = runnerStartAccountScope();
    if (accountScope === null) throw new Error("Sign in to Volli Cloud to start this Session.");
    sessionId = crypto.randomUUID();
    const operationId = crypto.randomUUID();
    const message = { id: crypto.randomUUID(), text: chat.message };
    const intent = runnerStartIntent(
      {
        clientRequestId: operationId,
        runnerId: runner.id,
        projectId,
        ticketId,
        model: chat.model ?? null,
      },
      message,
    );
    const drafts = useChatDraftsStore.getState();
    drafts.openProvisional(sessionId, {
      projectId,
      ticketId,
      operationId,
      title: chat.title,
      ...(chat.model === undefined ? {} : { model: chat.model }),
      runnerChoice: { id: runner.id, name: runner.name },
    });
    drafts.holdMessage(sessionId, message);
    // Freeze before opening the plane: its release loop must see the remote
    // intent even when this Mac is selected. submitRunnerDraft flushes it
    // durably before the network mutation and keeps its id for retries.
    drafts.freezeRunnerStart(sessionId, { intent, accountScope });
    useChatSessionsStore.getState().openChatTab(ticketId, sessionId);
    useChatSessionsStore.getState().setProvisionalActive(ticketId, sessionId);
    // Keep the current workspace in place. This recorded tab is reachable
    // when the person explicitly opens the new ticket, including on failure.
    await submitRunnerDraft(sessionId);
  } catch (error) {
    toast.error(`Couldn't start chat: ${errorMessage(error)}`);
  }
  return sessionId;
}

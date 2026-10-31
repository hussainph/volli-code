import { cloudMessageSubmit } from "@volli/shared";
import type { SessionStartOnArgs } from "@volli/shared/cloud";
import { queuedWireMessage, type QueuedMessage } from "@volli/session-presentation";
import { cloudAccountScope as runnerStartAccountScope } from "@renderer/stores/launch";
export { cloudAccountScope as runnerStartAccountScope } from "@renderer/stores/launch";
import { cloudSession, type CloudSession } from "@renderer/lib/cloud-client";
import { cloudFailure } from "@renderer/stores/cloud-board/source";
import { NOT_CONNECTED } from "@renderer/lib/cloud-board-api";
import { CHAT_DRAFTS_APP_STATE_KEY, useChatDraftsStore } from "@renderer/stores/chat-drafts";
import { appStateStorage, flushPendingAppStateKey } from "@renderer/lib/app-state-storage";

/** Persist this intent before submitting; a retry must keep its request id. */
export type RunnerStartIntent = Pick<SessionStartOnArgs, keyof SessionStartOnArgs>;

/** Text uses the same codec/size budget as an ordinary cloud message. */
export function runnerStartIntent(
  input: Omit<RunnerStartIntent, "body">,
  message: QueuedMessage,
): RunnerStartIntent {
  if ((message.attachments?.length ?? 0) > 0 || (message.resources?.length ?? 0) > 0) {
    throw new Error("Files and local skills aren’t available on another runner yet.");
  }
  const wire = queuedWireMessage(message);
  // Backend-minted ids are UUIDs too: this validates the canonical artifact's
  // byte budget before freezing an intent, without staging it on this Mac.
  cloudMessageSubmit({
    sessionId: input.clientRequestId,
    commandId: input.clientRequestId,
    message: wire,
  });
  return { ...input, body: JSON.stringify(wire) };
}

export function runnerStartText(intent: RunnerStartIntent): string {
  try {
    const message = JSON.parse(intent.body) as { parts?: { type?: string; text?: string }[] };
    return (
      message.parts
        ?.filter((part) => part.type === "text")
        .map((part) => part.text ?? "")
        .join("\n") ?? ""
    );
  } catch {
    return "";
  }
}

/** Freeze before sending. The Draft remains the pending surface until intake. */
export async function submitRunnerDraft(
  sessionId: string,
  intent?: RunnerStartIntent,
): Promise<boolean> {
  return useChatDraftsStore.getState().promote(sessionId, async (provisional) => {
    const accountScope = runnerStartAccountScope();
    if (accountScope === null) throw new Error("Sign in to Volli Cloud to start this Session.");
    const start =
      provisional.runnerStart ?? (intent === undefined ? undefined : { intent, accountScope });
    if (start === undefined) throw new Error("This Session has no pending start.");
    if (start.accountScope !== accountScope)
      throw new Error("Sign in to the account that started this Session.");
    useChatDraftsStore.getState().freezeRunnerStart(sessionId, start);
    // The Draft store suppresses equal writes. Retry must re-submit the exact
    // cached blob after a failed ack or cold hydration, without changing intent.
    const cached = appStateStorage.getItem(CHAT_DRAFTS_APP_STATE_KEY);
    if (typeof cached === "string") appStateStorage.setItem(CHAT_DRAFTS_APP_STATE_KEY, cached);
    if (!(await flushPendingAppStateKey(CHAT_DRAFTS_APP_STATE_KEY))) return false;
    // A close during the persistence barrier withdraws an unsent request.
    if (useChatDraftsStore.getState().drafts[sessionId]?.provisional === undefined) return false;
    let remoteSessionId: string;
    try {
      remoteSessionId = start.sessionId ?? (await startOnRunner(start.intent));
    } catch (error) {
      const code = cloudFailure(error instanceof Error ? error.cause : error).code;
      // These are transaction refusals, not an ambiguous lost reply. Restore
      // the words for correction; an id_taken response is deliberately not here.
      if (
        code !== null &&
        [
          "invalid_request",
          "runner_needs_update",
          "runner_unavailable",
          "ticket_archived",
          "not_a_member",
          "not_found",
        ].includes(code)
      ) {
        useChatDraftsStore
          .getState()
          .resetRunnerStart(sessionId, runnerStartText(start.intent), crypto.randomUUID());
        await flushPendingAppStateKey(CHAT_DRAFTS_APP_STATE_KEY);
      }
      throw error;
    }
    useChatDraftsStore.getState().acceptRunnerStart(sessionId, remoteSessionId);
    await flushPendingAppStateKey(CHAT_DRAFTS_APP_STATE_KEY);
    return true;
  });
}

/** The person's client starts remotely; this Mac must never attach an executor. */
export async function startOnRunner(
  intent: RunnerStartIntent,
  current: () => CloudSession | null = cloudSession,
): Promise<string> {
  const session = current();
  if (session === null || !session.client.connectionState().isWebSocketConnected) {
    throw new Error(NOT_CONNECTED);
  }
  try {
    const result = await session.client.mutation(session.api.sessionStarts.startOn, intent);
    return result.sessionId;
  } catch (error) {
    throw new Error(cloudFailure(error).message, { cause: error });
  }
}

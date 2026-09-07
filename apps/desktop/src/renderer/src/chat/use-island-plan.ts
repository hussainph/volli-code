/**
 * One Session's plan, bound for React (VC-6).
 *
 * Its own feed module rather than a field on {@link useSessionController},
 * because the Activity Island is fed by four independent sources — Browser
 * Tabs, subagents, the plan, background shells — and each is expected to arrive
 * on its own ticket and from its own runtime. VC-268 owns the chat-plane mount
 * and the `useActivityIsland` seam that spreads these together; this is the one
 * feed VC-6 owes it, shaped so that spreading it is the whole of the wiring.
 *
 * Deliberately empty of rules, like `use-session-controller.ts` beside it.
 * Where a `todo_write` call lives is the Session Engine's business, what "the
 * list as it stands now" means is `currentTodoList`'s, and what the card draws
 * is `islandPlanFromTodos`'. What is left here is the binding: one subscription
 * and one memo.
 *
 * RELAUNCH IS NOT A CASE THIS HANDLES, and that is the point. The input is the
 * Session's durable transcript, which the client replays from history on
 * attach, so the plan after a relaunch is the plan before it without a line of
 * recovery code.
 */
import * as React from "react";
import type { UIMessage } from "ai";
import { useStore } from "zustand";

import { currentTodoList } from "@volli/session-engine";
import { islandPlanFromTodos, type IslandPlan } from "@volli/session-presentation";

import { useChatSessionsStore } from "@renderer/stores/chat-sessions";
import type { ChatSessionsStore } from "./use-session-controller";

const NO_MESSAGES: readonly UIMessage[] = [];

/**
 * The plan card's model for one Session, or `null` when there is no plan.
 *
 * Subscribed to `durableMessages` alone, which is the settled transcript with
 * no live overlay: its identity moves once per SETTLE rather than once per
 * streamed frame, which is what keeps a plan that nobody touched out of the
 * stream's frame budget. A `todo_write` call settles the moment it answers, so
 * nothing is lost by ignoring the overlay — a half-streamed tool call has no
 * arguments to read yet anyway.
 *
 * The memo is what makes that saving real: the fold walks the whole transcript,
 * so re-running it per render would put every message the Session has ever
 * recorded into the render body — the exact mistake `ChatTranscriptState`
 * documents having made and fixed.
 */
export function useIslandPlan(
  sessionId: string,
  store: ChatSessionsStore = useChatSessionsStore,
): IslandPlan | null {
  const durableMessages = useStore(
    store,
    (state) => state.sessions[sessionId]?.transcript.durableMessages ?? NO_MESSAGES,
  );
  return React.useMemo(
    () => islandPlanFromTodos(sessionId, currentTodoList(durableMessages)),
    [durableMessages, sessionId],
  );
}

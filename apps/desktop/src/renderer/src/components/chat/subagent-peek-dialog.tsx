/**
 * Where a subagent opens from the Activity Island (VC-269, for `peekAgent`).
 *
 * A modal over the parent's chat, modelled on `ShellOutputDialog`: a glance at
 * what the helper is doing and back to the chat that delegated it, with the
 * overlay closing on Escape and focus returning to the row. The transcript is
 * READ-ONLY — no composer, no interaction cards, no verbs — because a peek is
 * a look, and the full conversation is one press away ("Open as tab", which
 * calls the same door `promoteAgent` does).
 *
 * WHAT IS RENDERED, and why it is small. There is no reusable transcript
 * component: `ChatPlane` is one component with the composer woven in. What
 * IS reusable is its exported, memoised `ChatTurn` and `groupTurns` from the
 * presentation package, so this draws exactly that — `groupTurns(messages)`
 * into `ChatTurn` inside a `Conversation` — with an empty interaction map
 * and a resolve that answers nothing. Context notices (compactions, dropped
 * reasoning) are left out of the peek on purpose: they are the parent's
 * reading aids, not a glance's.
 *
 * LIFECYCLE. The child is adopted on open (`adoptChatSession`, idempotent)
 * and its client is left RESIDENT on close: `closeChatSession` is not
 * ref-counted, and disposing here would blank the child's tab if it also has
 * one open. A resident client is cheap and is what a tab would have adopted
 * anyway.
 *
 * MOUNTED ONLY WHILE OPEN, like the shell dialog, so a closed peek subscribes
 * to nothing.
 *
 * WHERE FOCUS RETURNS. Radix hands focus back to the element that had it
 * when the dialog opened — the card row. But the card is a popover, and it
 * dismisses the moment the modal takes focus (a focus outside its layer), so
 * by the time Escape closes the peek the row is gone and Radix's default
 * would drop focus to the body. The mount says where focus goes instead
 * (`returnFocus`): in the plane, the island's agents cluster — the anchor
 * that reopens the card, from which Enter re-pins it with its first row
 * focused. Omitted, Radix's default stands.
 */
import * as React from "react";
import { useStore } from "zustand";
import { ArrowSquareOutIcon } from "@phosphor-icons/react";

import { agentStateWord, groupTurns, type IslandAgent } from "@volli/session-presentation";

import { useSessionController } from "@renderer/chat/use-session-controller";
import type { ChatSessionsStore } from "@renderer/chat/use-session-controller";
import { ChatTurn, type TurnContext } from "@renderer/components/chat/chat-plane";
import { ContentColumn } from "@renderer/components/layout/content-column";
import {
  Conversation,
  ConversationContent,
  ConversationEmptyState,
} from "@renderer/components/ui/ai-elements/conversation";
import { Button } from "@renderer/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@renderer/components/ui/dialog";
import { useChatSessionsStore } from "@renderer/stores/chat-sessions";

export interface SubagentPeekDialogProps {
  /** The child being peeked, as the island models it; `null` for none. */
  agent: IslandAgent | null;
  /** The host's own open-session door — the same one `promoteAgent` calls. */
  onOpenAsTab?: (sessionId: string) => void;
  onClose(): void;
  /**
   * Where focus goes when the peek closes, when the row it opened from is
   * gone — see the module doc. `null` means leave it to Radix.
   */
  returnFocus?: () => HTMLElement | null;
  /** The UI lab's own store; omitted in the app. */
  store?: ChatSessionsStore;
}

export function SubagentPeekDialog({
  agent,
  onOpenAsTab,
  onClose,
  returnFocus,
  store,
}: SubagentPeekDialogProps) {
  return (
    <Dialog
      open={agent !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent
        data-subagent-peek-dialog=""
        className="flex h-[70vh] max-w-3xl flex-col gap-0 overflow-hidden p-0 sm:max-w-3xl"
        onCloseAutoFocus={(event) => {
          const target = returnFocus?.() ?? null;
          if (target === null) return;
          event.preventDefault();
          target.focus();
        }}
      >
        {agent === null ? null : (
          <>
            {/* A title row tall enough that the content's close button
                (top-4 right-4) lands inside it; the state word rides the
                title the way it rides the card row. */}
            <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border pr-12 pl-4">
              <DialogTitle className="min-w-0 truncate text-ui font-medium">
                {agent.label}
              </DialogTitle>
              <span className="shrink-0 text-ui text-muted-foreground" data-subagent-peek-state>
                {agentStateWord(agent)}
              </span>
              {onOpenAsTab === undefined ? null : (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="ml-auto shrink-0"
                  onClick={() => onOpenAsTab(agent.id)}
                >
                  <ArrowSquareOutIcon />
                  {agent.promoted ? "Focus tab" : "Open as tab"}
                </Button>
              )}
            </div>
            <SubagentTranscript sessionId={agent.id} store={store} />
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** A resolve that answers nothing: the peek draws no interaction card. */
const NO_INTERACTIONS: TurnContext["interactions"] = new Map();
const NO_OPEN: TurnContext["open"] = [];
const NO_RESOLVING: TurnContext["resolving"] = new Set();
const noResolve: TurnContext["onResolve"] = () => Promise.resolve(false);

function SubagentTranscript({
  sessionId,
  store,
}: {
  sessionId: string;
  store: ChatSessionsStore | undefined;
}) {
  const sessions = store ?? useChatSessionsStore;
  const adopt = useStore(sessions, (state) => state.adoptChatSession);
  // Adopt on open, never dispose on close — see the module doc.
  React.useEffect(() => adopt(sessionId), [adopt, sessionId]);
  const controller = useSessionController(sessionId, sessions);
  const { messages, working } = controller.session;
  const turns = React.useMemo(() => groupTurns(messages), [messages]);
  const liveTurn = working ? (turns.at(-1) ?? null) : null;
  // A file a row names opens nowhere from a peek: the glance has no host to
  // open it in, and the row renders its object as text, as it does in the lab.
  const context = React.useMemo<TurnContext>(
    () => ({
      onOpenFile: () => {},
      interactions: NO_INTERACTIONS,
      open: NO_OPEN,
      resolving: NO_RESOLVING,
      onResolve: noResolve,
    }),
    [],
  );
  return (
    <Conversation className="min-h-0 flex-1 bg-background" data-subagent-peek-transcript="">
      <ConversationContent className="gap-4 px-0 pt-4 pb-6">
        {messages.length === 0 ? (
          <ConversationEmptyState
            className="min-h-40"
            title="Nothing yet"
            description="This subagent has not said anything."
          />
        ) : (
          <ContentColumn className="flex flex-col gap-6">
            {turns.map((turn) => (
              <ChatTurn
                key={turn[0]?.id}
                messages={turn}
                context={context}
                live={turn === liveTurn}
              />
            ))}
          </ContentColumn>
        )}
      </ConversationContent>
    </Conversation>
  );
}

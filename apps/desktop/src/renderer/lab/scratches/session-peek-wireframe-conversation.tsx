/** Fixture adapter for the shared chat overlay; no Session IPC or live client. */
import * as React from "react";
import type { UIMessage } from "ai";
import { groupTurns, type QueuedMessage } from "@volli/session-presentation";

import { ChatTurn, type TurnContext } from "@renderer/components/chat/chat-plane";
import { SessionComposer } from "@renderer/components/chat/composer-ui";
import { SessionPeekDialog } from "@renderer/components/chat/session-peek-dialog";
import { ContentColumn } from "@renderer/components/layout/content-column";
import {
  Conversation,
  ConversationContent,
} from "@renderer/components/ui/ai-elements/conversation";
import { TooltipProvider } from "@renderer/components/ui/tooltip";
import type { SessionFixture } from "./session-peek-wireframe-card";
import type { SendOutcome } from "./session-peek-wireframe-model";

const CONTEXT: TurnContext = {
  onOpenFile: () => {},
  interactions: new Map(),
  open: [],
  resolving: new Set(),
  onResolve: () => Promise.resolve(false),
};
const NO_QUEUE: readonly QueuedMessage[] = [];
interface Draft {
  text: string;
  messages: readonly UIMessage[];
  sending: boolean;
  error: string | null;
}
const EMPTY: Draft = { text: "", messages: [], sending: false, error: null };

export function PeekConversation({
  fixture,
  answer,
  outcome,
  onClose,
  onOpen,
  returnFocus,
}: {
  fixture: SessionFixture | null;
  answer?: string;
  outcome: SendOutcome;
  onClose(): void;
  onOpen(): void;
  returnFocus(): HTMLElement | null;
}) {
  // Outside the modal's mounted content: closing a preview does not discard a
  // message, and switching recipients cannot move one Session's draft to another.
  const [drafts, setDrafts] = React.useState<Record<string, Draft>>({});
  const pending = React.useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const sequence = React.useRef(0);
  React.useEffect(() => {
    const timers = pending.current;
    return () => {
      for (const timer of timers.values()) clearTimeout(timer);
    };
  }, []);
  const rowId = fixture?.rowId ?? "";
  const draft = drafts[rowId] ?? EMPTY;
  const update = (id: string, change: (before: Draft) => Draft) =>
    setDrafts((before) => ({ ...before, [id]: change(before[id] ?? EMPTY) }));
  const messages: UIMessage[] =
    fixture === null
      ? []
      : fixture.messages.map((message, index) => ({
          id: `${fixture.rowId}-source-${index}`,
          role: message.role,
          parts: [{ type: "text", text: message.text }],
        }));
  if (answer !== undefined)
    messages.push({ id: `${rowId}-answer`, role: "user", parts: [{ type: "text", text: answer }] });
  messages.push(...draft.messages);
  const turns = groupTurns(messages);

  const send = (text: string) => {
    if (fixture === null || text.trim() === "" || pending.current.has(rowId)) return;
    const id = rowId;
    update(id, (before) => ({ ...before, sending: true, error: null }));
    const timer = setTimeout(() => {
      pending.current.delete(id);
      const message: UIMessage = {
        id: `${id}-message-${++sequence.current}`,
        role: "user",
        parts: [{ type: "text", text }],
      };
      update(id, (before) =>
        outcome === "failure"
          ? { ...before, sending: false, error: "Couldn’t send. Your message is still here." }
          : {
              ...before,
              sending: false,
              error: null,
              text: before.text.trim() === text ? "" : before.text,
              messages: [...before.messages, message],
            },
      );
    }, 450);
    pending.current.set(id, timer);
  };

  return (
    <SessionPeekDialog
      open={fixture !== null}
      title="Conversation"
      description="Lab fixture · not a live session"
      openLabel="Open session"
      onOpen={onOpen}
      onClose={onClose}
      returnFocus={returnFocus}
      style={{
        maxWidth: "min(var(--container-content), calc(100vw - 32px))",
        height: "min(720px, calc(100svh - 104px))",
        top: 48,
        translate: "-50% 0",
      }}
    >
      {fixture === null ? null : (
        <TooltipProvider>
          <Conversation className="min-h-0 flex-1" data-conversation-transcript="">
            <ConversationContent className="gap-4 px-0 py-4">
              <ContentColumn className="flex flex-col gap-4">
                <div className="flex flex-col gap-2 border-b border-border pb-4">
                  <h2 className="text-ui font-semibold [overflow-wrap:anywhere]">
                    {fixture.sessionTitle}
                  </h2>
                  {fixture.ticketTitle === null ? null : (
                    <p className="text-ui text-muted-foreground [overflow-wrap:anywhere]">
                      {fixture.ticketId} · {fixture.ticketTitle}
                    </p>
                  )}
                </div>
                {turns.map((turn) => (
                  <ChatTurn key={turn[0]?.id} messages={turn} context={CONTEXT} live={false} />
                ))}
              </ContentColumn>
            </ConversationContent>
          </Conversation>
          <ContentColumn className="max-h-1/2 shrink-0 overflow-y-auto border-t border-border py-4">
            {draft.error === null ? null : (
              <p role="alert" className="pb-2 text-ui text-destructive">
                {draft.error}
              </p>
            )}
            <SessionComposer
              value={draft.text}
              onValueChange={(text) => update(rowId, (before) => ({ ...before, text }))}
              models={[{ ...fixture.model, id: fixture.model.modelId, reasoningLevels: [] }]}
              selection={{
                providerId: fixture.model.providerId,
                modelId: fixture.model.modelId,
                reasoningLevel: "",
              }}
              selectionProviderLabel={fixture.model.providerLabel}
              modelChoiceDisabled
              onSelectionChange={() => {}}
              // This adapter simulates ordinary messages only. The live subagent
              // overlay mounts ChatPlane and inherits its real queue/steer rules.
              working={false}
              ready={!draft.sending}
              queued={NO_QUEUE}
              verbs={[]}
              onQueuedChange={() => false}
              onSteerQueued={() => {}}
              onStop={() => {}}
              onSubmit={send}
            />
            {draft.sending ? (
              <p role="status" className="pt-2 text-ui text-muted-foreground">
                Sending…
              </p>
            ) : null}
          </ContentColumn>
        </TooltipProvider>
      )}
    </SessionPeekDialog>
  );
}

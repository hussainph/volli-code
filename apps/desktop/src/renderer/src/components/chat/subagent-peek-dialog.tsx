/**
 * The Activity Island's child conversation, in the shared Session overlay.
 *
 * The real ChatPlane owns the composer, pending interactions and delivery —
 * this overlay must not grow a second submit/queue/steer implementation.
 * Drafts remain Session-keyed, just as they do when that child has a tab open.
 * Adopt on open and leave the client resident on close: disposal is not
 * reference-counted and would break an already-open child tab.
 *
 * returnFocus names the island cluster because the source popover's row can
 * unmount when this modal opens. Only an open overlay subscribes to the child.
 */
import * as React from "react";
import { useStore } from "zustand";
import { agentStateWord, type IslandAgent } from "@volli/session-presentation";
import {
  CheckCircleIcon,
  HandIcon,
  PauseCircleIcon,
  WarningCircleIcon,
} from "@phosphor-icons/react";

import type { ChatSessionsStore } from "@renderer/chat/use-session-controller";
import { AgentModelLine } from "@renderer/components/chat/agent-model-ui";
import { ChatPlane } from "@renderer/components/chat/chat-plane";
import { SessionPeekDialog } from "@renderer/components/chat/session-peek-dialog";
import { useChatSessionsStore } from "@renderer/stores/chat-sessions";
import { Spinner } from "@renderer/components/ui/spinner";

export interface SubagentPeekDialogProps {
  agent: IslandAgent | null;
  /** Subagents inherit the parent's scope, not whichever tab is now selected. */
  projectId: string;
  ticketId: string | null;
  onOpenFile?(path: string): void;
  onOpenAsTab?(sessionId: string): void;
  onClose(): void;
  returnFocus?(): HTMLElement | null;
  store?: ChatSessionsStore;
}

export function SubagentPeekDialog({
  agent,
  projectId,
  ticketId,
  onOpenFile,
  onOpenAsTab,
  onClose,
  returnFocus,
  store,
}: SubagentPeekDialogProps) {
  return (
    <SessionPeekDialog
      open={agent !== null}
      title={agent?.label ?? "Conversation"}
      state={agent === null ? undefined : <SubagentState agent={agent} />}
      metadata={
        agent === null ? undefined : <AgentModelLine agent={agent} className="max-w-full text-ui" />
      }
      openLabel={agent?.promoted ? "Focus tab" : "Open as tab"}
      onOpen={agent === null || onOpenAsTab === undefined ? undefined : () => onOpenAsTab(agent.id)}
      onClose={onClose}
      returnFocus={returnFocus}
    >
      {(closeForNavigation) =>
        agent === null ? null : (
          <SubagentConversation
            key={agent.id}
            sessionId={agent.id}
            projectId={projectId}
            ticketId={ticketId}
            onOpenFile={onOpenFile}
            onOpenAsTab={
              onOpenAsTab === undefined
                ? undefined
                : (id) => {
                    closeForNavigation();
                    onOpenAsTab(id);
                  }
            }
            store={store}
          />
        )
      }
    </SessionPeekDialog>
  );
}

function SubagentState({ agent }: { agent: IslandAgent }) {
  // Promotion is already named by the header action; the state reports activity only.
  const word = agentStateWord({ ...agent, promoted: false });
  const Icon = {
    working: Spinner,
    done: CheckCircleIcon,
    failed: WarningCircleIcon,
    stopped: PauseCircleIcon,
    waiting: HandIcon,
  }[agent.state];
  return (
    <>
      <Icon
        aria-hidden
        className={
          agent.state === "failed" ? "size-4 text-destructive" : "size-4 motion-reduce:animate-none"
        }
      />
      {word.charAt(0).toUpperCase() + word.slice(1)}
    </>
  );
}

const noOpenFile = () => {};
function SubagentConversation({
  sessionId,
  projectId,
  ticketId,
  onOpenFile,
  onOpenAsTab,
  store,
}: {
  sessionId: string;
} & Pick<
  SubagentPeekDialogProps,
  "projectId" | "ticketId" | "onOpenFile" | "onOpenAsTab" | "store"
>) {
  const sessions = store ?? useChatSessionsStore;
  const adopt = useStore(sessions, (state) => state.adoptChatSession);
  React.useEffect(() => adopt(sessionId), [adopt, sessionId]);
  return (
    <ChatPlane
      constrainComposer
      sessionId={sessionId}
      projectId={projectId}
      ticketId={ticketId}
      onOpenFile={onOpenFile ?? noOpenFile}
      onOpenSession={onOpenAsTab}
      store={store}
    />
  );
}

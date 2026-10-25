/**
 * A ticket Session's working copy setup gate, as the chat plane answers it
 * (VC-584, behind the `cloud` flag).
 *
 * A failed environment setup refuses every start of the ticket's Session, and
 * the start's failure reads as a plain configuration Attention. When the row
 * shows one that a worktree preparation raised, this reads the working copy's
 * setup status once; a `failed` one turns the row into the setup's own, whose
 * acts answer the gate and try the start again, or file the ticket an agent
 * repairs the recipe in. One read per failure shown and per answer given:
 * nothing polls.
 */
import * as React from "react";
import { toast } from "sonner";
import {
  displayTicketId,
  environmentFixTicket,
  errorMessage,
  type SessionAttention,
  type WorktreeSetupAnswer,
  type WorktreeSetupRunView,
  type WorktreeSetupStatusView,
} from "@volli/shared";

import { mayBeWorktreeSetupGate } from "@renderer/components/chat/chat-plane-model";
import { guardWrite } from "@renderer/components/hosts/use-hosts";
import { sessionRpcClient } from "@renderer/lib/session-rpc-ipc-link";
import { toastError } from "@renderer/lib/toast";
import { useBoardStore } from "@renderer/stores/board";
import { useProjectUiStore } from "@renderer/stores/project-ui";
import { useProjectsStore } from "@renderer/stores/projects";

interface WorktreeSetupGateInput {
  /** `cloud` on, and the project This Mac's: off, nothing is read or offered. */
  enabled: boolean;
  projectId: string;
  /** The Session's ticket; a project Session has no working copy of its own. */
  ticketId: string | null;
  /** The Attention the blocker row draws. */
  attention: SessionAttention | null;
  /** The row's existing re-attempt of the start (`recover`). */
  recover(): Promise<boolean>;
}

interface WorktreeSetupGate {
  /** The failed run, once read; null while unread, and for anything but a failed setup. */
  failedSetup: WorktreeSetupRunView | null;
  answerSetup(answer: WorktreeSetupAnswer): void;
  fixSetup(): void;
}

const ANSWER_VERB: Record<WorktreeSetupAnswer, string> = {
  retry: "retry the setup",
  "start-anyway": "start without the setup",
};

export function useWorktreeSetupGate(input: WorktreeSetupGateInput): WorktreeSetupGate {
  const { enabled, projectId, ticketId, attention, recover } = input;
  // Bumped after each answer's re-attempt: the one read that says where the
  // setup stands now (the same failure again keeps the same Attention).
  const [answered, setAnswered] = React.useState(0);
  const [read, setRead] = React.useState<{ key: string; view: WorktreeSetupStatusView } | null>(
    null,
  );
  const gatedTicket = enabled && mayBeWorktreeSetupGate(attention) ? ticketId : null;
  const key =
    gatedTicket === null
      ? null
      : JSON.stringify([gatedTicket, attention?.id, attention?.detail, answered]);

  React.useEffect(() => {
    if (key === null || gatedTicket === null) return;
    let current = true;
    void sessionRpcClient()
      .worktree.setupStatus.query({ ticketId: gatedTicket })
      .then((view) => {
        if (current) setRead({ key, view });
      })
      // Nobody asked for this read: the plain configuration row it would
      // replace is already on screen, and stays.
      .catch((error: unknown) => {
        console.warn("[volli] couldn't read the worktree setup status:", error);
      });
    return () => {
      current = false;
    };
  }, [key, gatedTicket]);

  const failedSetup =
    key !== null && read?.key === key && read.view.kind === "failed" ? read.view.run : null;

  const answering = React.useRef(false);
  const answerSetup = React.useCallback(
    (answer: WorktreeSetupAnswer) => {
      if (gatedTicket === null || answering.current) return;
      answering.current = true;
      void (async () => {
        try {
          try {
            await sessionRpcClient().worktree.answerSetup.mutate({ ticketId: gatedTicket, answer });
          } catch (error) {
            toastError(`Couldn't ${ANSWER_VERB[answer]}: ${errorMessage(error)}`);
            return;
          }
          // The start again, exactly as the row's Retry makes it.
          await recover();
          setAnswered((count) => count + 1);
        } finally {
          answering.current = false;
        }
      })();
    },
    [gatedTicket, recover],
  );

  const fixSetup = React.useCallback(() => {
    if (gatedTicket === null || failedSetup === null) return;
    if (!guardWrite(projectId)) return;
    const board = useBoardStore.getState();
    const ticket = board.ticketsByProject[projectId]?.find(({ id }) => id === gatedTicket);
    const project = useProjectsStore.getState().projects.find(({ id }) => id === projectId);
    if (ticket === undefined || project === undefined) {
      toastError("Couldn't create the fix ticket: this ticket is no longer on the board");
      return;
    }
    const fix = environmentFixTicket(
      displayTicketId(project.ticketPrefix, ticket.ticketNumber),
      failedSetup,
    );
    void (async () => {
      try {
        // The board's own create, so it toasts a refusal like every other.
        const created = await board.addTicket(projectId, "todo", fix.title, {
          body: fix.body,
          labels: fix.labels,
        });
        if (created === null) return;
        toast.success(`${displayTicketId(project.ticketPrefix, created.ticketNumber)} created`);
        useProjectUiStore.getState().openTicketView(projectId, created.id);
      } catch (error) {
        toastError(`Couldn't create ticket: ${errorMessage(error)}`);
      }
    })();
  }, [failedSetup, gatedTicket, projectId]);

  return { failedSetup, answerSetup, fixSetup };
}

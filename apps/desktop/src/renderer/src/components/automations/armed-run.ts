/**
 * Renderer projection of main's armed-column countdowns (VC-226).
 *
 * Main owns the durable record, the one timer and the Run attempt. Every
 * renderer receives the same whole list, renders it, and can Cancel the exact
 * arrival from either window. No renderer lifecycle can create, duplicate or
 * prevent a Run anymore.
 */
import { create } from "zustand";
import { errorMessage, type PendingArmedRun } from "@volli/shared";
import type { PendingArmedRunSettledNotice } from "../../../../ipc/contract";
import { toast } from "sonner";

import { runAutomationAction } from "./run-automation-model";
import { chatTabId } from "@renderer/components/ticket/ticket-chat-tab";
import { toastError } from "@renderer/lib/toast";
import { useChatSessionsStore } from "@renderer/stores/chat-sessions";
import { useTicketSessionRecordsStore } from "@renderer/stores/ticket-session-records";
import { useUiStore } from "@renderer/stores/ui";
import { useWorkspaceStore } from "@renderer/stores/workspace";

interface ArmedRunState {
  /** Exact arrival id → main's durable pending record. */
  pending: Record<string, PendingArmedRun>;
}

export const useArmedRunStore = create<ArmedRunState>()(() => ({ pending: {} }));

/** Replaces this renderer's projection with main's whole canonical snapshot. */
export function receivePendingArmedRuns(pending: readonly PendingArmedRun[]): void {
  useArmedRunStore.setState({
    pending: Object.fromEntries(pending.map((row) => [row.id, row])),
  });
}

/**
 * The window's one control. Main deletes this exact arrival and broadcasts the
 * new whole list to every window; the committed Ticket move is untouched.
 */
export async function cancelArmedRun(id: string): Promise<void> {
  try {
    const result = await window.api.automations.cancelPendingArmedRun({ id });
    if (!result.ok) toastError(`Couldn't cancel automation: ${result.error}`);
  } catch (error) {
    toastError(`Couldn't cancel automation: ${errorMessage(error)}`);
  }
}

/** Preserves the existing post-window surfaces while main owns the attempt. */
export function announcePendingArmedRunSettlement(notice: PendingArmedRunSettledNotice): void {
  if (notice.kind === "abandoned") {
    announceAbandon(notice.pending, notice.reason);
    return;
  }
  if (notice.kind === "failed") {
    toastError(`Couldn't run automation: ${notice.error}`);
    return;
  }

  const pending = notice.pending;
  const action = runAutomationAction(notice.result);
  switch (action.kind) {
    case "open-model-access":
      toastError(`${pending.automationName} couldn't start on ${pending.ticketDisplayId}`, {
        description: "Choose a default model before an armed column can run one.",
        action: {
          label: "Model Access",
          onClick: () => useUiStore.getState().setSettingsOpen(true, "model-access"),
        },
      });
      return;
    case "toast":
      toastError(action.message);
      return;
    case "open-session": {
      const chat = useChatSessionsStore.getState();
      chat.adoptChatSession(action.sessionId);
      void useTicketSessionRecordsStore.getState().refresh(pending.ticketId);
      // A Deliberate move never redirects. The toast action remains the only
      // door into the fresh Session, exactly as before main owned the timer.
      toast.success(`${pending.automationName} started on ${pending.ticketDisplayId}`, {
        action: {
          label: "Open session",
          onClick: () => {
            chat.openChatTab(pending.ticketId, action.sessionId);
            useWorkspaceStore.getState().openTicketWorkspace(action.projectId, pending.ticketId, {
              tabId: chatTabId(action.sessionId),
            });
          },
        },
      });
      return;
    }
  }
}

function announceAbandon(
  pending: PendingArmedRun,
  reason: "gone" | "left-column" | "disarmed" | "switched-off",
): void {
  if (reason === "left-column") return;
  toast.info(`${pending.automationName} didn't start on ${pending.ticketDisplayId}`, {
    description: ABANDON_DESCRIPTIONS[reason],
  });
}

const ABANDON_DESCRIPTIONS: Record<"gone" | "disarmed" | "switched-off", string> = {
  gone: "The ticket is no longer on this board.",
  disarmed: "The column stopped arming it while the countdown ran.",
  "switched-off": "It was switched off on this machine while the countdown ran.",
};

/** Test seam: reset only this renderer's projection; main owns the real record. */
export function resetArmedRuns(): void {
  useArmedRunStore.setState({ pending: {} });
}

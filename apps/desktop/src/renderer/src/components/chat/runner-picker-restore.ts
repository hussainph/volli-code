import { useProjectsStore } from "@renderer/stores/projects";
import { useBoardStore } from "@renderer/stores/board";
import { useChatDraftsStore } from "@renderer/stores/chat-drafts";
import { useChatSessionsStore } from "@renderer/stores/chat-sessions";
import { runnerStartAccountScope } from "./runner-picker-start";

/** Cloud projects arrive after boot. Restore each account-owned Draft once,
 * when its project is visible; never discard another account's saved intent. */
export function followRunnerDraftTabs(): () => void {
  const scope = runnerStartAccountScope();
  if (scope === null) return () => {};
  const pending = Object.fromEntries(
    Object.entries(useChatDraftsStore.getState().drafts).filter(
      ([, draft]) =>
        (draft.provisional?.accountScope ?? draft.provisional?.runnerStart?.accountScope) === scope,
    ),
  );
  if (Object.keys(pending).length === 0) return () => {};
  const restore = () => {
    if (runnerStartAccountScope() !== scope) return;
    const projects = new Set(useProjectsStore.getState().projects.map(({ id }) => id));
    const ready = Object.fromEntries(
      Object.entries(pending).filter(([, draft]) => projects.has(draft.provisional!.projectId)),
    );
    if (Object.keys(ready).length === 0) return;
    // Mark before store writes; a board update may synchronously notify again.
    for (const id of Object.keys(ready)) delete pending[id];
    useChatSessionsStore
      .getState()
      .restoreProvisionalChatTabs(
        ready,
        new Set(
          Object.values(useBoardStore.getState().ticketsByProject).flatMap((rows) =>
            rows.map(({ id }) => id),
          ),
        ),
        projects,
      );
  };
  const stop = useProjectsStore.subscribe(restore);
  restore();
  return stop;
}

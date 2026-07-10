/**
 * Explicit terminal-session teardown, deliberately OUTSIDE the React tree:
 * engines and PTYs outlive views (keep-alive tabs, future headless agent
 * sessions, project removal while another page is showing), so teardown must
 * never depend on a TerminalView unmount happening to run. These two functions
 * are the only places a session's engine is disposed or its PTY killed.
 */
import { errorMessage } from "@volli/shared";
import { toast } from "sonner";

import { useSessionsStore, type SessionTab } from "../stores/sessions";
import { disposeEngine } from "./registry";

/** Close one tab: drop it from the store, dispose its engine, kill a live PTY. */
export function closeTerminalSession(projectId: string, sessionId: string): void {
  const tab = useSessionsStore
    .getState()
    .byProject[projectId]?.tabs.find((candidate) => candidate.sessionId === sessionId);
  useSessionsStore.getState().closeSession(projectId, sessionId);
  disposeEngine(sessionId);
  if (tab !== undefined) killIfLive(tab);
}

/** Tear down every session of a removed project, whether or not views are mounted. */
export function killProjectSessions(projectId: string): void {
  const tabs = useSessionsStore.getState().byProject[projectId]?.tabs ?? [];
  for (const tab of tabs) {
    disposeEngine(tab.sessionId);
    killIfLive(tab);
  }
  useSessionsStore.getState().forgetProject(projectId);
}

/** An exited tab has no PTY left in main — killing it would only toast an error. */
function killIfLive(tab: SessionTab): void {
  if (tab.exitCode !== null) return;
  window.api.terminal
    .kill(tab.sessionId)
    .then((result) => {
      if (!result.ok) toast.error(`Terminal close failed: ${result.error}`);
    })
    .catch((error: unknown) => {
      toast.error(`Terminal close failed: ${errorMessage(error)}`);
    });
}

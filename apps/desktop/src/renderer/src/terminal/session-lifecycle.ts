/**
 * Explicit terminal-session teardown, deliberately OUTSIDE the React tree:
 * engines and PTYs outlive views (keep-alive tabs, future headless agent
 * sessions, project removal while another page is showing), so teardown must
 * never depend on a TerminalView unmount happening to run. The functions in
 * this module are the only places a session's engine is disposed or PTY killed.
 */
import { errorMessage } from "@volli/shared";
import { toast } from "sonner";

import {
  findSessionPane,
  sessionPanes,
  useSessionsStore,
  type SessionPane,
} from "../stores/sessions";
import { disposeEngine } from "./registry";

/** Close one tab and every independent pane session it owns. */
export function closeTerminalSession(projectId: string, sessionId: string): void {
  const tab = useSessionsStore
    .getState()
    .byProject[projectId]?.tabs.find((candidate) => candidate.sessionId === sessionId);
  useSessionsStore.getState().closeSession(projectId, sessionId);
  if (tab === undefined) return;
  for (const pane of sessionPanes(tab.layout)) {
    disposeEngine(pane.sessionId);
    killIfLive(pane);
  }
}

/** Close one split leaf; closing the final leaf closes its containing tab. */
export function closeTerminalPane(projectId: string, tabId: string, sessionId: string): void {
  const tab = useSessionsStore
    .getState()
    .byProject[projectId]?.tabs.find((candidate) => candidate.sessionId === tabId);
  if (tab === undefined) return;
  const panes = sessionPanes(tab.layout);
  const pane = findSessionPane(tab.layout, sessionId);
  if (pane === null) return;
  if (panes.length === 1) {
    closeTerminalSession(projectId, tabId);
    return;
  }
  useSessionsStore.getState().closePane(projectId, tabId, sessionId);
  disposeEngine(sessionId);
  killIfLive(pane);
}

/** Tear down every session of a removed project, whether or not views are mounted. */
export function killProjectSessions(projectId: string): void {
  const tabs = useSessionsStore.getState().byProject[projectId]?.tabs ?? [];
  for (const tab of tabs) {
    for (const pane of sessionPanes(tab.layout)) {
      disposeEngine(pane.sessionId);
      killIfLive(pane);
    }
  }
  useSessionsStore.getState().forgetProject(projectId);
}

/** An exited tab has no PTY left in main — killing it would only toast an error. */
function killIfLive(pane: SessionPane): void {
  if (pane.exitCode !== null) return;
  window.api.terminal
    .kill(pane.sessionId)
    .then((result) => {
      if (!result.ok) toast.error(`Terminal close failed: ${result.error}`);
    })
    .catch((error: unknown) => {
      toast.error(`Terminal close failed: ${errorMessage(error)}`);
    });
}

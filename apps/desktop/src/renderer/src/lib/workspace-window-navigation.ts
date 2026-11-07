/** Explicit actions from Settings land in the workbench that can render them. */
import { errorMessage } from "@volli/shared";
import type { WorkspaceWindowNavigation } from "../../../ipc/settings-window";
import { useProjectsStore } from "@renderer/stores/projects";
import { useProjectUiStore } from "@renderer/stores/project-ui";
import { launchStore } from "@renderer/stores/launch";
import { selectCloudWorkspace, useCloudWorkspaceStore } from "@renderer/stores/cloud-board/workspace";
import { CLOUD_READ_ONLY } from "@renderer/stores/cloud-board/source";
import { useCloudLinkInputs } from "@renderer/stores/cloud-link";
import { cloudSession, followCloudSession } from "./cloud-client";
import { NOT_CONNECTED } from "./cloud-board-api";
import { TICKET_BODY_TAB_ID } from "@renderer/components/ticket/ticket-body-tab";
import { toastError } from "./toast";

/** Await state changes, not polling; closing/superseding a request releases every listener. */
function waitForNavigationState(ready: () => boolean, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const stops: (() => void)[] = [];
    let finished = false;
    const finish = (error?: unknown) => {
      if (finished) return;
      finished = true;
      for (const stop of stops) stop();
      signal.removeEventListener("abort", aborted);
      if (error === undefined) resolve();
      else reject(error);
    };
    const aborted = () => finish(signal.reason);
    const check = () => {
      try {
        signal.throwIfAborted();
        if (ready()) finish();
      } catch (error) { finish(error); }
    };
    signal.addEventListener("abort", aborted, { once: true });
    stops.push(useProjectsStore.subscribe(check), useCloudWorkspaceStore.subscribe(check), useCloudLinkInputs.subscribe(check));
    const stopSession = followCloudSession(check);
    if (finished) stopSession();
    else stops.push(stopSession);
    check();
  });
}

/** Shared view preparation for the two native-window navigation directions. */
export async function prepareWindowNavigation(
  navigation: { workspaceId?: string; projectId?: string | null },
  signal: AbortSignal,
): Promise<void> {
  const controller = new AbortController();
  const abort = () => controller.abort(signal.reason);
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  const timeout = setTimeout(() => controller.abort(new Error("Couldn't open the project. Check the connection and try again.")), 10_000);
  const current = controller.signal;
  try {
    if (
      launchStore() === "cloud" && navigation.workspaceId !== undefined &&
      useCloudWorkspaceStore.getState().workspace?.id !== navigation.workspaceId
    ) {
      await waitForNavigationState(() => {
        const input = useCloudLinkInputs.getState().input;
        if (!input.online || input.snapshotAt !== null) throw new Error(CLOUD_READ_ONLY);
        if (input.client === "closed" || input.authenticated === false) throw new Error(input.account?.failure ?? NOT_CONNECTED);
        return cloudSession()?.client.connectionState().isWebSocketConnected === true;
      }, current);
      current.throwIfAborted();
      // The existing selector owns membership, read-only checks and newest-wins
      // ordering. Cancellation also prevents a timed-out answer navigating late.
      const selection = selectCloudWorkspace(navigation.workspaceId, undefined, current);
      await new Promise<void>((resolve, reject) => {
        const aborted = () => reject(current.reason);
        current.addEventListener("abort", aborted, { once: true });
        if (current.aborted) aborted();
        void selection.then(resolve, reject).finally(() => current.removeEventListener("abort", aborted));
      });
    }
    await waitForNavigationState(() => {
      const cloud = launchStore() === "cloud";
      const workspace = useCloudWorkspaceStore.getState();
      const input = useCloudLinkInputs.getState().input;
      const hasProject = navigation.projectId == null || useProjectsStore.getState().projects.some(({ id }) => id === navigation.projectId);
      if (!cloud) return hasProject;
      if (navigation.workspaceId === undefined && navigation.projectId == null) return true;
      if (input.client === "closed" || input.authenticated === false) throw new Error(input.account?.failure ?? NOT_CONNECTED);
      if (navigation.workspaceId !== undefined && workspace.workspace?.id !== navigation.workspaceId) return false;
      const rosterReady = workspace.projectsReady || input.snapshotAt !== null;
      if (!rosterReady || cloudSession() === null) return false;
      if (!hasProject) throw new Error("The project is no longer available in this Workspace.");
      return true;
    }, current);
  } finally {
    clearTimeout(timeout);
    signal.removeEventListener("abort", abort);
  }
}

let pendingNavigation: AbortController | null = null;
export function acceptWorkspaceNavigation(navigation: WorkspaceWindowNavigation): void {
  pendingNavigation?.abort();
  const request = new AbortController();
  pendingNavigation = request;
  void prepareWindowNavigation(navigation, request.signal).then(() => {
    if (request.signal.aborted) return;
    useProjectsStore.getState().select(navigation.projectId);
    const workspace = useProjectUiStore.getState();
    if (navigation.kind === "ticket") {
      workspace.openTicketView(navigation.projectId, navigation.ticketId, { tabId: TICKET_BODY_TAB_ID });
    } else {
      workspace.setNav(navigation.projectId, "home");
      workspace.pinHomeFile(navigation.projectId, navigation.relPath);
    }
  }).catch((error: unknown) => {
    if (!request.signal.aborted) toastError(`Couldn't open the workspace: ${errorMessage(error)}`);
  }).finally(() => {
    if (pendingNavigation === request) pendingNavigation = null;
  });
}

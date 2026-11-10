/** Settings commands keep their existing callers; only their presentation moves. */
import { errorMessage } from "@volli/shared";
import type { SettingsWindowNavigation } from "../../../ipc/settings-window";
import { useProjectsStore } from "@renderer/stores/projects";
import { useCloudWorkspaceStore } from "@renderer/stores/cloud-board/workspace";
import { setSettingsWindowOpener, useUiStore } from "@renderer/stores/ui";
import { toastError } from "@renderer/lib/toast";
import { prepareWindowNavigation } from "./workspace-window-navigation";

export const isSettingsWindow = (): boolean => window.location?.hash === "#settings";

export function installSettingsWindowRouting(): void {
  setSettingsWindowOpener((navigation) => {
    void window.api.settingsWindow
      .open({
        ...navigation,
        projectId: useProjectsStore.getState().selectedProjectId,
        workspaceId: useCloudWorkspaceStore.getState().workspace?.id,
      })
      .then((result) => {
        if (!result.ok) toastError(`Couldn't open Settings: ${result.error}`);
      })
      .catch((error: unknown) => toastError(`Couldn't open Settings: ${errorMessage(error)}`));
  });
}

let acceptedRevision = 0;
let pendingNavigation: AbortController | null = null;

/** Navigation is addressed only to the Settings page, never broadcast as UI state. */
export function acceptSettingsNavigation(navigation: SettingsWindowNavigation): void {
  if (navigation.revision <= acceptedRevision) return;
  acceptedRevision = navigation.revision;
  pendingNavigation?.abort();
  const request = new AbortController();
  pendingNavigation = request;
  useUiStore.setState({
    settingsOpen: true,
    settingsNavigationRevision: navigation.revision,
    settingsProjectId: navigation.projectId,
    settingsWorkspaceId: navigation.workspaceId,
    settingsNavigationPending: true,
    settingsNavigationError: null,
    settingsCategory: navigation.category ?? null,
    configureCategory: navigation.configureCategory ?? null,
    settingsSignInProviderId: navigation.signInProviderId ?? null,
  });
  void prepareWindowNavigation(navigation, request.signal)
    .then(() => {
      if (request.signal.aborted || navigation.revision !== acceptedRevision) return;
      const projectId = navigation.projectId;
      // Only after the receiving follower owns the accepted Workspace's roster.
      // This renderer's selection supplies clients, never the main window's view.
      if (projectId !== undefined && projectId !== useProjectsStore.getState().selectedProjectId) {
        useProjectsStore.setState({ selectedProjectId: projectId });
      }
      useUiStore.setState({ settingsNavigationPending: false });
    })
    .catch((error: unknown) => {
      if (request.signal.aborted || navigation.revision !== acceptedRevision) return;
      // The panel acknowledges a painted failure too, so a permission, offline
      // or missing-project failure becomes visible instead of staying hidden.
      useUiStore.setState({
        settingsNavigationPending: false,
        settingsNavigationError: errorMessage(error),
      });
    })
    .finally(() => {
      if (pendingNavigation === request) pendingNavigation = null;
    });
}

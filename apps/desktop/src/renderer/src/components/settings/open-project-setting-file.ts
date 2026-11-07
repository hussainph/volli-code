/** An explicit Settings file action enters its project and opens the existing editor tab. */
import { useProjectsStore } from "@renderer/stores/projects";
import { useProjectUiStore } from "@renderer/stores/project-ui";
import { useUiStore } from "@renderer/stores/ui";
import { isSettingsWindow } from "@renderer/lib/settings-window";
import { toastError } from "@renderer/lib/toast";
import { errorMessage } from "@volli/shared";
import { useCloudWorkspaceStore } from "@renderer/stores/cloud-board/workspace";
export function openProjectSettingFile(projectId: string, relPath: string) {
  if (isSettingsWindow()) {
    void window.api.settingsWindow
      .openWorkspace({
        kind: "file",
        projectId,
        relPath,
        workspaceId: useCloudWorkspaceStore.getState().workspace?.id,
      })
      .then((result) => {
        if (!result.ok) toastError(`Couldn't open file: ${result.error}`);
      })
      .catch((error: unknown) => toastError(`Couldn't open file: ${errorMessage(error)}`));
    return;
  }
  useProjectsStore.getState().select(projectId);
  const workspace = useProjectUiStore.getState();
  workspace.setNav(projectId, "home");
  workspace.pinHomeFile(projectId, relPath);
  useUiStore.getState().setSettingsOpen(false);
}

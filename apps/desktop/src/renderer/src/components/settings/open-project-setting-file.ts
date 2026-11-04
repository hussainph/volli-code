/** An explicit Settings file action enters its project and opens the existing editor tab. */
import { useProjectsStore } from "@renderer/stores/projects";
import { useProjectUiStore } from "@renderer/stores/project-ui";
import { useUiStore } from "@renderer/stores/ui";
export function openProjectSettingFile(projectId: string, relPath: string) {
  useProjectsStore.getState().select(projectId);
  const workspace = useProjectUiStore.getState();
  workspace.setNav(projectId, "home");
  workspace.pinHomeFile(projectId, relPath);
  useUiStore.getState().setSettingsOpen(false);
}

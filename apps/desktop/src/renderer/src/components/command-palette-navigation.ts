/** Page activation owns Settings visibility; closing the palette must not close its destination. */
import type { CommandPaletteNavigationItem } from "./command-palette-model";
import { useProjectUiStore } from "@renderer/stores/project-ui";
import { useUiStore } from "@renderer/stores/ui";

export function activatePaletteNavigation(
  item: CommandPaletteNavigationItem,
  projectId: string | null,
): void {
  const ui = useUiStore.getState();
  if (item.id === "settings") {
    ui.setSettingsOpen(true);
    return;
  }
  if (projectId === null) return;
  if (item.id === "configure" || item.id === "configure-pane") {
    ui.requestConfigureCategory(item.id === "configure-pane" ? item.paneKey : "overview");
    return;
  }
  const project = useProjectUiStore.getState();
  if (item.id === "home") project.openHome(projectId);
  else {
    project.openHomeBoard(projectId);
    project.setBoardView(projectId, item.id);
  }
  ui.setSettingsOpen(false);
}

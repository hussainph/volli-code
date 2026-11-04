/** Compatibility destination for stored Configure routes. All settings use the same shell. */
import { useProjectsStore } from "@renderer/stores/projects";
import { SettingsPage } from "./settings-page";
export function ConfigurePage() {
  const projectId = useProjectsStore((state) => state.selectedProjectId);
  return <SettingsPage key={projectId} initialScope="project" />;
}

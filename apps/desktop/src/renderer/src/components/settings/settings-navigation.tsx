import * as React from "react";
import type { Project } from "@volli/shared";
import { Button } from "@renderer/components/ui/button";

export const SettingsNavigation = React.createContext<{
  openProject(projectId: string, page: string): void;
  selectPolicyProject?(projectId: string): void;
} | null>(null);
export function OverrideLinks({ projects, page }: { projects: readonly Project[]; page: string }) {
  const navigation = React.useContext(SettingsNavigation);
  if (!navigation || !projects.length) return null;
  return (
    <span className="flex flex-wrap gap-2">
      {projects.map((project) => (
        <Button
          key={project.id}
          size="xs"
          variant="link"
          onClick={() => navigation.openProject(project.id, page)}
        >
          {project.name} overrides this
        </Button>
      ))}
    </span>
  );
}

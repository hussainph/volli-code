import * as React from "react";
import { monogram, type Project } from "@volli/shared";
import { Button } from "@renderer/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@renderer/components/ui/dropdown-menu";
import { ChevronDownIcon } from "@renderer/components/ui/icon";
import { IdentityTile } from "@renderer/components/ui/identity-tile";

export const SettingsNavigation = React.createContext<{
  openProject(projectId: string, page: string): void;
  selectPolicyProject?(projectId: string): void;
} | null>(null);
export function OverrideMenu({ projects, page }: { projects: readonly Project[]; page: string }) {
  const navigation = React.useContext(SettingsNavigation);
  if (!navigation || !projects.length) return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="xs" variant="ghost" className="whitespace-nowrap text-muted-foreground">
          {projects.length} project {projects.length === 1 ? "override" : "overrides"}
          <ChevronDownIcon />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {projects.map((project) => (
          <DropdownMenuItem
            key={project.id}
            textValue={project.name}
            onSelect={() => navigation.openProject(project.id, page)}
          >
            <IdentityTile size="sm" aria-hidden>
              {monogram(project.name)}
            </IdentityTile>
            <span className="truncate">{project.name}</span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

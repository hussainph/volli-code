/** Scope is navigation, not explanatory copy. Picking a project here never retargets a live workspace. */
import * as React from "react";
import {
  ChevronDownIcon,
  FolderOpenIcon,
  SettingsIcon,
  AddIcon,
} from "@renderer/components/ui/icon";

import { monogram, projectColor, type Project } from "@volli/shared";
import { Button } from "@renderer/components/ui/button";
import { IdentityTile } from "@renderer/components/ui/identity-tile";
import { ListRow } from "@renderer/components/ui/list-row";
import { NextActionIllustration } from "@renderer/components/ui/next-action-illustration";
import { Popover, PopoverContent, PopoverTrigger } from "@renderer/components/ui/popover";
import { cn } from "@renderer/lib/utils";

function ProjectTile({ project }: { project: Project | null }) {
  return (
    <span
      aria-hidden
      className={cn(
        "inline-flex size-7 shrink-0 items-center justify-center rounded-control text-ui font-semibold",
        project ? "text-white" : "bg-muted text-muted-foreground",
      )}
      style={project ? { backgroundColor: projectColor(project.colorIndex) } : undefined}
    >
      {project ? monogram(project.name) : <FolderOpenIcon className="size-4" />}
    </span>
  );
}
export function SettingsScope({
  scope,
  project,
  projects,
  onScope,
  onProject,
  onAdd,
}: {
  scope: "app" | "project";
  project: Project | null;
  projects: readonly Project[];
  onScope(scope: "app" | "project"): void;
  onProject(id: string): void;
  onAdd(): void;
}) {
  const [open, setOpen] = React.useState(false);
  return (
    <div
      data-settings-scope
      className="space-y-1 border-b border-border/50 pb-3"
      aria-label="Settings scope"
    >
      <ListRow
        leading={
          <span className="grid size-7 shrink-0 place-items-center">
            <IdentityTile size="sm" aria-hidden>
              <SettingsIcon className="size-3.5" />
            </IdentityTile>
          </span>
        }
        primary="All projects"
        aria-label="All projects"
        aria-pressed={scope === "app"}
        selected={scope === "app"}
        onActivate={() => onScope("app")}
      />
      <ListRow
        leading={<ProjectTile project={project} />}
        primary={project?.name ?? "Your project"}
        aria-pressed={scope === "project"}
        selected={scope === "project"}
        onActivate={() => onScope("project")}
        actions={
          <Popover open={open} onOpenChange={setOpen}>
            <PopoverTrigger asChild>
              <Button aria-label="Switch project" size="icon-sm" variant="ghost">
                <ChevronDownIcon />
              </Button>
            </PopoverTrigger>
            <PopoverContent align="start" className="w-64 p-2">
              <div className="flex max-h-80 flex-col gap-2 overflow-y-auto">
                {projects.map((p) => (
                  <button
                    type="button"
                    key={p.id}
                    aria-label={p.name}
                    aria-current={project?.id === p.id ? "true" : undefined}
                    onClick={() => {
                      onProject(p.id);
                      setOpen(false);
                    }}
                    className={cn(
                      "flex min-w-0 items-center gap-2 rounded-row p-2 text-left text-ui outline-none focus-visible:ring-2 focus-visible:ring-ring",
                      project?.id === p.id ? "bg-(--accent-selected)" : "hover:bg-(--accent-tint)",
                    )}
                  >
                    <ProjectTile project={p} />
                    <span className="truncate">{p.name}</span>
                  </button>
                ))}
                <Button
                  variant="ghost"
                  className="justify-start"
                  onClick={() => {
                    setOpen(false);
                    onAdd();
                  }}
                >
                  <AddIcon />
                  Open a project
                </Button>
              </div>
            </PopoverContent>
          </Popover>
        }
      />
    </div>
  );
}

export function SettingsProjectWelcome({
  hasProjects,
  onOpen,
}: {
  hasProjects: boolean;
  onOpen(): void;
}) {
  return (
    <div className="flex min-h-80 flex-col justify-center gap-6 py-8">
      <NextActionIllustration kind={hasProjects ? "selection" : "project"} />
      <h2 className="text-title font-semibold">
        {hasProjects ? "No project selected" : "No projects"}
      </h2>
      <Button className="w-fit" onClick={onOpen}>
        <FolderOpenIcon />
        Open a project
      </Button>
    </div>
  );
}

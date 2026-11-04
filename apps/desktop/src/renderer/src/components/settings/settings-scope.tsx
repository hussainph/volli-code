/** Scope is navigation, not explanatory copy. Picking a project here never retargets a live workspace. */
import * as React from "react";
import { CaretDownIcon } from "@phosphor-icons/react/dist/csr/CaretDown";
import { FolderOpenIcon } from "@phosphor-icons/react/dist/csr/FolderOpen";
import { GearSixIcon } from "@phosphor-icons/react/dist/csr/GearSix";
import { PlusIcon } from "@phosphor-icons/react/dist/csr/Plus";
import { monogram, projectColor, type Project } from "@volli/shared";
import { Button } from "@renderer/components/ui/button";
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
    <div className="space-y-2" aria-label="Settings scope">
      <Button
        variant={scope === "app" ? "secondary" : "ghost"}
        className="h-auto w-full justify-start py-2"
        aria-label="All projects"
        aria-pressed={scope === "app"}
        onClick={() => onScope("app")}
      >
        <span className="grid size-7 place-items-center">
          <GearSixIcon aria-hidden />
        </span>
        All projects
      </Button>
      <div className="relative">
        <Button
          variant={scope === "project" ? "secondary" : "ghost"}
          className="h-auto w-full justify-start py-2 pr-8"
          aria-pressed={scope === "project"}
          onClick={() => onScope("project")}
        >
          <ProjectTile project={project} />
          <span className="truncate">{project?.name ?? "Your project"}</span>
        </Button>
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <Button
              aria-label="Switch project"
              size="icon-xs"
              variant="ghost"
              className="absolute top-1/2 right-1 -translate-y-1/2"
            >
              <CaretDownIcon />
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
                  className="flex min-w-0 items-center gap-4 rounded-control p-2 text-left text-ui outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
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
                <PlusIcon />
                Open a project
              </Button>
            </div>
          </PopoverContent>
        </Popover>
      </div>
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
      <Button variant="outline" className="w-fit" onClick={onOpen}>
        <FolderOpenIcon />
        Open a project
      </Button>
    </div>
  );
}

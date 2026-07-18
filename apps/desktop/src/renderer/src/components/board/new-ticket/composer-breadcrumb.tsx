import { ArrowsInIcon } from "@phosphor-icons/react/dist/csr/ArrowsIn";
import { ArrowsOutIcon } from "@phosphor-icons/react/dist/csr/ArrowsOut";
import { CaretDownIcon } from "@phosphor-icons/react/dist/csr/CaretDown";
import { CaretRightIcon } from "@phosphor-icons/react/dist/csr/CaretRight";
import { CheckIcon } from "@phosphor-icons/react/dist/csr/Check";
import { XIcon } from "@phosphor-icons/react/dist/csr/X";
import type { Project } from "@volli/shared";

import { ProjectMonogram } from "@renderer/components/board/new-ticket/project-monogram";
import { Button } from "@renderer/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@renderer/components/ui/dropdown-menu";

/**
 * The composer header: a project chip (monogram + name) opening a menu that
 * RETARGETS which project the ticket is created in, a static "New ticket"
 * crumb, and the Expand / Close controls. The chip carries
 * `data-testid="composer-project-chip"` and its menu items match on the bare
 * project name (the monogram is `aria-hidden`), the shape the acceptance smoke
 * drives.
 */
export function ComposerBreadcrumb({
  projects,
  target,
  onRetarget,
  expanded,
  onToggleExpand,
  onClose,
}: {
  projects: readonly Project[];
  target: Project;
  onRetarget: (project: Project) => void;
  expanded: boolean;
  onToggleExpand: () => void;
  onClose: () => void;
}) {
  return (
    <div className="flex items-center gap-1.5">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            data-testid="composer-project-chip"
            className="flex min-w-0 max-w-64 items-center gap-1.5 rounded-md px-1.5 py-1 text-ui font-medium text-foreground transition-colors duration-150 ease-out outline-none hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50"
          >
            <ProjectMonogram project={target} />
            <span className="truncate">{target.name}</span>
            <CaretDownIcon weight="bold" className="size-3 text-muted-foreground" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="max-h-72 min-w-52">
          {projects.map((project) => (
            <DropdownMenuItem key={project.id} onSelect={() => onRetarget(project)}>
              <ProjectMonogram project={project} />
              <span className="truncate">{project.name}</span>
              {project.id === target.id ? (
                <CheckIcon weight="bold" className="ml-auto size-3.5" />
              ) : null}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>

      <CaretRightIcon weight="bold" className="size-3 shrink-0 text-muted-foreground/60" />
      <span className="shrink-0 text-ui text-muted-foreground">New ticket</span>

      <div className="ml-auto flex shrink-0 items-center gap-0.5">
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={expanded ? "Collapse" : "Expand"}
          onClick={onToggleExpand}
          className="text-muted-foreground hover:text-foreground"
        >
          {expanded ? <ArrowsInIcon /> : <ArrowsOutIcon />}
        </Button>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label="Close"
          onClick={onClose}
          className="text-muted-foreground hover:text-foreground"
        >
          <XIcon weight="bold" />
        </Button>
      </div>
    </div>
  );
}

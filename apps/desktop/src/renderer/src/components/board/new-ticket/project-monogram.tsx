import { monogram, projectColor, type Project } from "@volli/shared";

import { cn } from "@renderer/lib/utils";

/**
 * A project's square monogram chip (initials on its round-robin palette color),
 * used in the composer breadcrumb and its project menu. `aria-hidden` because
 * the project name always sits beside it — the letters must not leak into an
 * accessible name (e.g. the project menu items match on the name alone).
 */
export function ProjectMonogram({ project, className }: { project: Project; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        "flex size-4 shrink-0 items-center justify-center rounded-[4px] text-label font-semibold text-white",
        className,
      )}
      style={{ backgroundColor: projectColor(project.colorIndex) }}
    >
      {monogram(project.name)}
    </span>
  );
}

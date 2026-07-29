import { monogram, projectColor, type Project } from "@volli/shared";

import { cn } from "@renderer/lib/utils";

/**
 * A project's square monogram chip (initials on its round-robin palette color),
 * used in the composer breadcrumb and its project menu. `aria-hidden` because
 * the project name always sits beside it — the letters must not leak into an
 * accessible name (e.g. the project menu items match on the name alone).
 *
 * `text-white` is NOT a dark-mode assumption and stays a literal: the chip
 * paints its own fill from `PROJECT_COLORS`, which is app color rather than
 * theme color (it identifies a project, so it must not move when the theme
 * does). The ink is therefore solved against that fill, not against the page,
 * and reads identically in both modes.
 */
export function ProjectMonogram({ project, className }: { project: Project; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        "flex size-5 shrink-0 items-center justify-center rounded-[5px] text-label font-semibold tracking-normal text-white",
        className,
      )}
      style={{ backgroundColor: projectColor(project.colorIndex) }}
    >
      {monogram(project.name)}
    </span>
  );
}

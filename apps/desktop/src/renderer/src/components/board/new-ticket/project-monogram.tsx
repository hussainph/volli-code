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
 *
 * `rounded-sm` (8px) rather than the control rung the 36px rail tile takes: at
 * 20px square the control rung's 12px exceeds half the side, so CSS clamps both
 * corners to 10px and the chip renders as a CIRCLE — a different shape family
 * from the tile it is the small twin of. 8px on 20px is the same corner-to-side
 * proportion as 12px on 36px, so the two read as one object at two sizes.
 */
export function ProjectMonogram({ project, className }: { project: Project; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        "flex size-5 shrink-0 items-center justify-center rounded-sm text-label font-semibold tracking-normal text-white",
        className,
      )}
      style={{ backgroundColor: projectColor(project.colorIndex) }}
    >
      {monogram(project.name)}
    </span>
  );
}

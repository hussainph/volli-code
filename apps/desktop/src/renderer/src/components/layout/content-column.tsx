import { cn } from "@renderer/lib/utils";

/*
 * The Tier A reading column (docs/DESIGN.md): content capped at the canonical
 * measure (--container-content) and centered, with the page gutter as the
 * responsive floor — side whitespace compresses before text ever reflows.
 * Workbench surfaces (board, list view, terminals) are Tier B and stay fluid;
 * they must not wrap in this.
 */
export function ContentColumn({ className, ...props }: React.ComponentProps<"div">) {
  return <div className={cn("mx-auto w-full max-w-content px-gutter", className)} {...props} />;
}

/**
 * The Tier B workbench column (docs/DESIGN.md): the same centered, gutter-
 * floored behaviour, capped at the wider `--container-workbench` instead.
 *
 * Settings and Configure use this. They read like prose but they are not: a
 * skills table carries a name, a description and its provenance, and at the
 * 45rem reading measure the description truncates to a few words — which
 * defeats the column, since the description is how you tell two skills apart.
 *
 * Still a COLUMN, not edge-to-edge. DESIGN.md's rule that responsiveness is
 * whitespace rather than breakpoints holds either way: the margins absorb a
 * wide window and compress to the gutter floor on a narrow one.
 */
export function WorkbenchColumn({ className, ...props }: React.ComponentProps<"div">) {
  return <div className={cn("mx-auto w-full max-w-workbench px-gutter", className)} {...props} />;
}

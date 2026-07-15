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

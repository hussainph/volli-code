import { cn } from "@renderer/lib/utils";

/*
 * The unified surface-header row (docs/DESIGN.md): every page-level header
 * (board header today; sessions/settings headers as they're built) composes
 * this so titles, filters, and actions land on the same gutter and rhythm
 * across surfaces instead of each page hand-rolling its own row.
 */
export function PageHeader({ className, ...props }: React.ComponentProps<"header">) {
  return (
    <header
      className={cn(
        "flex min-w-0 shrink-0 flex-wrap items-center gap-x-3 gap-y-2 px-gutter py-3",
        className,
      )}
      {...props}
    />
  );
}

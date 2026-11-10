import { SpinnerIcon, type IconProps } from "@renderer/components/ui/icon";

import { cn } from "@renderer/lib/utils";

/**
 * The one indeterminate spinner, and the one place its weight is decided.
 *
 * The heavier stroke makes the broken ring readable at 14–16px. Its drawing
 * stays outline, just like the other symbols; rotation communicates progress.
 */
function Spinner({ className, ...props }: IconProps) {
  return (
    <SpinnerIcon
      role="status"
      aria-label="Loading"
      strokeWidth={2.25}
      className={cn("size-4 animate-spin", className)}
      {...props}
    />
  );
}

export { Spinner };

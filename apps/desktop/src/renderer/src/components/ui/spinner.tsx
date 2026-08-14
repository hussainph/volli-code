import { SpinnerGapIcon } from "@phosphor-icons/react/dist/csr/SpinnerGap";

import { cn } from "@renderer/lib/utils";

/**
 * The one indeterminate spinner, and the one place its weight is decided.
 *
 * `bold` rather than the outline baseline, for the reason `ui/sonner.tsx` gives
 * for its loading toast: a spinner-gap has to READ as a broken ring for the
 * rotation to say anything, and at the sizes this is used (14–16px) regular
 * draws the arc thinner than the text beside it. `fill` is not the alternative —
 * a filled spinner-gap is a disc with no gap left to turn.
 */
function Spinner({ className, ...props }: React.ComponentProps<"svg">) {
  return (
    <SpinnerGapIcon
      role="status"
      aria-label="Loading"
      weight="bold"
      className={cn("size-4 animate-spin", className)}
      {...props}
    />
  );
}

export { Spinner };

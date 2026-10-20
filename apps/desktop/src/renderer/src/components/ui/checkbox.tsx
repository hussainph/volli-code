import * as React from "react";
import { CheckIcon } from "@phosphor-icons/react/dist/csr/Check";
import { MinusIcon } from "@phosphor-icons/react/dist/csr/Minus";
import { Checkbox as CheckboxPrimitive } from "radix-ui";

import { cn } from "@renderer/lib/utils";

/**
 * A Radix Checkbox, styled to the app's tokens, with a real mixed state.
 *
 * The app had none: every multi-select drew the platform's own `<input
 * type="checkbox">`, which ignores the theme (a stock blue tick on an ember
 * canvas) and cannot say "some". A group that is partly selected — the tools a
 * server offers, or the read-only half of them — needs that third state, so a
 * person can see at the group which way one click will go.
 *
 * `checked="indeterminate"` draws the dash; a click from it checks, as every
 * platform's mixed checkbox does. Like `Switch`, it takes its accessible name
 * from an `aria-label` or from a wrapping `<label>`: a `<button>` is labelable,
 * so clicking the label's text toggles it.
 */
function Checkbox({
  className,
  style,
  ...props
}: React.ComponentProps<typeof CheckboxPrimitive.Root>) {
  return (
    <CheckboxPrimitive.Root
      data-slot="checkbox"
      className={cn(
        // The focus ring is the button recipe's, for the same reason a switch
        // keeps it — there is no caret to speak for it.
        "peer inline-flex size-4 shrink-0 items-center justify-center border border-border bg-background text-primary-foreground shadow-raised transition-colors duration-150 ease-out outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:border-primary data-[state=checked]:bg-primary data-[state=indeterminate]:border-primary data-[state=indeterminate]:bg-primary",
        className,
      )}
      // A box, never a circle: at 16px every rung of the radius ladder (8px
      // and up) rounds it into a radio button, which says "one of these"
      // about a control that means "any of these". Half the smallest rung is
      // derived from the ladder rather than a literal beside it.
      style={{ borderRadius: "calc(var(--radius-sm) / 2)", ...style }}
      {...props}
    >
      <CheckboxPrimitive.Indicator data-slot="checkbox-indicator" className="flex">
        {props.checked === "indeterminate" ? (
          <MinusIcon weight="bold" className="size-3" />
        ) : (
          <CheckIcon weight="bold" className="size-3" />
        )}
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  );
}

export { Checkbox };

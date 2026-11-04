import type * as React from "react";
import { cn } from "@renderer/lib/utils";
import "./disclosure.css";

import { Collapsible as CollapsiblePrimitive } from "radix-ui";

function Collapsible({ ...props }: React.ComponentProps<typeof CollapsiblePrimitive.Root>) {
  return <CollapsiblePrimitive.Root data-slot="collapsible" {...props} />;
}

function CollapsibleTrigger({
  className,
  ...props
}: React.ComponentProps<typeof CollapsiblePrimitive.CollapsibleTrigger>) {
  return (
    <CollapsiblePrimitive.CollapsibleTrigger
      data-slot="collapsible-trigger"
      className={cn("font-semibold", className)}
      {...props}
    />
  );
}

function CollapsibleContent({
  className,
  animated = true,
  ...props
}: React.ComponentProps<typeof CollapsiblePrimitive.CollapsibleContent> & { animated?: boolean }) {
  return (
    <CollapsiblePrimitive.CollapsibleContent
      data-slot="collapsible-content"
      className={cn(
        animated &&
          "disclosure-content [--disclosure-height:var(--radix-collapsible-content-height)]",
        className,
      )}
      {...props}
    />
  );
}

export { Collapsible, CollapsibleTrigger, CollapsibleContent };

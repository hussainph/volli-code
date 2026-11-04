/** Compatibility for callers that still name explanation text a hint. No hidden meaning. */
import type * as React from "react";
import { cn } from "@renderer/lib/utils";

export function InfoHint({
  children,
  className,
}: {
  label: string;
  interactive?: boolean;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <span className={cn("block text-ui leading-5 text-muted-foreground", className)}>
      {children}
    </span>
  );
}

import type { ComponentProps } from "react";
import { cn } from "@renderer/lib/utils";

/** Determinate progress, with an accessible name supplied by its caller. */
export function Progress({
  value,
  className,
  children,
  ...props
}: ComponentProps<"div"> & { value: number }) {
  const bounded = Math.min(100, Math.max(0, Number.isFinite(value) ? value : 0));
  return (
    <div
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={bounded}
      data-slot="progress"
      className={cn("h-1 overflow-hidden rounded-full bg-accent", className)}
      {...props}
    >
      {children ?? (
        <div
          className="h-full rounded-full"
          style={{ background: "var(--flow)", width: `${bounded}%` }}
        />
      )}
    </div>
  );
}

import * as React from "react";
import {
  SuccessIcon,
  InfoIcon,
  SpinnerIcon,
  WarningIcon,
  ErrorIcon,
} from "@renderer/components/ui/icon";

import { Toaster as Sonner, type ToasterProps } from "sonner";

import { cn } from "@renderer/lib/utils";
import { useResolvedAppearance } from "@renderer/lib/resolved-appearance";

// Sonner needs the mode as a PROP — it swaps its own internal variables rather
// than exposing them all — so this is one of the few places the resolved
// appearance is read in JS instead of expressed as a token. The surface colors
// below stay tokens regardless, so `theme` only decides the parts sonner keeps
// to itself (its shadow and its close button).
const Toaster = ({ toastOptions, ...props }: ToasterProps) => {
  const appearance = useResolvedAppearance();

  return (
    <Sonner
      theme={appearance}
      className="toaster group"
      position="bottom-right"
      gap={6}
      // The error is the exception; routine confirmations keep outline glyphs.
      icons={{
        success: <SuccessIcon className="size-4" />,
        info: <InfoIcon className="size-4" />,
        warning: <WarningIcon className="size-4" />,
        error: <ErrorIcon className="size-4 text-destructive" />,
        loading: (
          <SpinnerIcon
            strokeWidth={2.25}
            className="size-4 animate-spin motion-reduce:animate-none"
          />
        ),
      }}
      toastOptions={{
        ...toastOptions,
        classNames: {
          ...toastOptions?.classNames,
          // Sonner's expanded ::after is an invisible hover bridge, not a
          // stacked rim. The glass rim otherwise paints into its 7px height,
          // leaving a ghost contour on every expanded toast. Keep the bridge
          // hit-testable (and unclipped), while Sonner keeps the real border.
          toast: cn(
            "material-floating !contain-none",
            "data-[expanded=true]:after:!bg-none data-[expanded=true]:after:!mask-none data-[expanded=true]:after:!p-0 data-[expanded=true]:after:!rounded-none data-[expanded=true]:after:!top-auto data-[expanded=true]:after:!pointer-events-auto",
            toastOptions?.classNames?.toast,
          ),
          description: cn("!text-muted-foreground", toastOptions?.classNames?.description),
          actionButton: cn(
            "!cursor-default !bg-(--accent-selected) !text-primary-text",
            toastOptions?.classNames?.actionButton,
          ),
          cancelButton: cn(
            "!cursor-default !bg-(--accent-tint) !text-foreground",
            toastOptions?.classNames?.cancelButton,
          ),
          closeButton: cn("!cursor-default", toastOptions?.classNames?.closeButton),
        },
      }}
      style={
        {
          "--normal-bg": "var(--popover)",
          "--normal-text": "var(--foreground)",
          "--normal-border": "var(--border)",
          "--border-radius": "var(--radius-menu)",
        } as React.CSSProperties
      }
      {...props}
    />
  );
};

export { Toaster };

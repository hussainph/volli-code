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
          toast: cn("material-floating", toastOptions?.classNames?.toast),
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

import * as React from "react";
import { CheckCircleIcon } from "@phosphor-icons/react/dist/csr/CheckCircle";
import { InfoIcon } from "@phosphor-icons/react/dist/csr/Info";
import { SpinnerGapIcon } from "@phosphor-icons/react/dist/csr/SpinnerGap";
import { WarningCircleIcon } from "@phosphor-icons/react/dist/csr/WarningCircle";
import { XCircleIcon } from "@phosphor-icons/react/dist/csr/XCircle";
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
        success: <CheckCircleIcon className="size-4" />,
        info: <InfoIcon className="size-4" />,
        warning: <WarningCircleIcon className="size-4" />,
        error: <XCircleIcon weight="fill" className="size-4" />,
        loading: (
          <SpinnerGapIcon
            weight="bold"
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

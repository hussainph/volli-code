import * as React from "react";
import { CheckCircleIcon } from "@phosphor-icons/react/dist/csr/CheckCircle";
import { InfoIcon } from "@phosphor-icons/react/dist/csr/Info";
import { SpinnerGapIcon } from "@phosphor-icons/react/dist/csr/SpinnerGap";
import { WarningCircleIcon } from "@phosphor-icons/react/dist/csr/WarningCircle";
import { XCircleIcon } from "@phosphor-icons/react/dist/csr/XCircle";
import { Toaster as Sonner, type ToasterProps } from "sonner";

// This app is dark-only (no next-themes provider, see globals.css) — theme is
// hardcoded rather than read from a theme context.
const Toaster = ({ ...props }: ToasterProps) => {
  return (
    <Sonner
      theme="dark"
      className="toaster group"
      icons={{
        success: <CheckCircleIcon weight="fill" className="size-4" />,
        info: <InfoIcon weight="fill" className="size-4" />,
        warning: <WarningCircleIcon weight="fill" className="size-4" />,
        error: <XCircleIcon weight="fill" className="size-4" />,
        loading: <SpinnerGapIcon weight="bold" className="size-4 animate-spin" />,
      }}
      style={
        {
          "--normal-bg": "var(--popover)",
          "--normal-text": "var(--popover-foreground)",
          "--normal-border": "var(--border)",
          "--border-radius": "var(--radius)",
        } as React.CSSProperties
      }
      {...props}
    />
  );
};

export { Toaster };

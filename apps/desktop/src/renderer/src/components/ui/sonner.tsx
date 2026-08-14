import * as React from "react";
import { CheckCircleIcon } from "@phosphor-icons/react/dist/csr/CheckCircle";
import { InfoIcon } from "@phosphor-icons/react/dist/csr/Info";
import { SpinnerGapIcon } from "@phosphor-icons/react/dist/csr/SpinnerGap";
import { WarningCircleIcon } from "@phosphor-icons/react/dist/csr/WarningCircle";
import { XCircleIcon } from "@phosphor-icons/react/dist/csr/XCircle";
import { Toaster as Sonner, type ToasterProps } from "sonner";

import { useResolvedAppearance } from "@renderer/lib/resolved-appearance";

// Sonner needs the mode as a PROP — it swaps its own internal variables rather
// than exposing them all — so this is one of the few places the resolved
// appearance is read in JS instead of expressed as a token. The surface colors
// below stay tokens regardless, so `theme` only decides the parts sonner keeps
// to itself (its shadow and its close button).
const Toaster = ({ ...props }: ToasterProps) => {
  const appearance = useResolvedAppearance();

  return (
    <Sonner
      theme={appearance}
      className="toaster group"
      // The one surface in the app where the glyph is MEANT to out-weigh its
      // sentence: a toast is read as a colour first and a string second, and it
      // is gone before a second read. Everywhere else outline is the baseline.
      // The spinner is the exception to the exception — a filled spinner-gap is
      // a disc with no gap to rotate — so it takes the weight step instead.
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
          "--normal-text": "var(--foreground)",
          "--normal-border": "var(--border)",
          "--border-radius": "var(--radius)",
        } as React.CSSProperties
      }
      {...props}
    />
  );
};

export { Toaster };

/**
 * Explicit hold controls beside the address (VC-239). Navigation and page input
 * never imply a takeover. Main owns the holder and every transition; this
 * drawing only relays Take over / Ask to leave / Hand back presses.
 *
 * Session identity is a colour mark and a hover label, not another chrome row.
 * Hook-free like BrowserChrome so tests can inspect the handler wiring.
 */
import { HandPalmIcon } from "@phosphor-icons/react/dist/csr/HandPalm";
import { HandWavingIcon } from "@phosphor-icons/react/dist/csr/HandWaving";
import { ArrowUUpLeftIcon } from "@phosphor-icons/react/dist/csr/ArrowUUpLeft";

import { Button } from "@renderer/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@renderer/components/ui/tooltip";
import { cn } from "@renderer/lib/utils";
import type { BrowserTabHolder } from "@volli/shared";
import { browserHolderLabel } from "./browser-holder-dot";

export interface BrowserHolderPillProps {
  /** Exactly what main pushes as the tab's `heldBy`. */
  holder: BrowserTabHolder;
  onTakeOver(): void;
  onAskToLeave(): void;
  onHandBack(): void;
  className?: string;
}

export function BrowserHolderPill({
  holder,
  onTakeOver,
  onAskToLeave,
  onHandBack,
  className,
}: BrowserHolderPillProps) {
  const identity = browserHolderLabel(holder);
  return (
    <TooltipProvider>
      <div
        data-slot="browser-holder-pill"
        data-holder={holder.kind}
        className={cn("flex shrink-0 items-center text-ui", className)}
      >
        <Tooltip>
          <TooltipTrigger asChild>
            <span
              tabIndex={0}
              aria-label={identity}
              className="size-2 shrink-0 rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
              style={{
                backgroundColor: holder.kind === "session" ? holder.color : "var(--foreground)",
              }}
            />
          </TooltipTrigger>
          <TooltipContent side="top">{identity}</TooltipContent>
        </Tooltip>
        {holder.kind === "session" ? (
          <>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Take over"
                  onClick={onTakeOver}
                >
                  <HandPalmIcon />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="top">Take over · {holder.name}</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Ask to leave"
                  onClick={onAskToLeave}
                >
                  <HandWavingIcon />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="top">Ask to leave · {holder.name}</TooltipContent>
            </Tooltip>
          </>
        ) : (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label="Hand back"
                onClick={onHandBack}
              >
                <ArrowUUpLeftIcon />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="top">Hand back · Yours</TooltipContent>
          </Tooltip>
        )}
      </div>
    </TooltipProvider>
  );
}

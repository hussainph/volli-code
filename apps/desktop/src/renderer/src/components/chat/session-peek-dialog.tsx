import * as React from "react";
import { ArrowSquareOutIcon } from "@phosphor-icons/react/dist/csr/ArrowSquareOut";

import { Button } from "@renderer/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@renderer/components/ui/dialog";

/** Shared overlay chrome for subagents and sidebar conversation previews.
 * The host owns the Session surface, scope, delivery and draft lifetime.
 */
export function SessionPeekDialog({
  open,
  title,
  state,
  metadata,
  description,
  openLabel = "Open as tab",
  onOpen,
  onClose,
  returnFocus,
  children,
  style,
}: {
  children?: React.ReactNode | ((closeForNavigation: () => void) => React.ReactNode);
  open: boolean;
  title: string;
  state?: string;
  metadata?: React.ReactNode;
  description?: React.ReactNode;
  openLabel?: string;
  onOpen?(): void;
  onClose(): void;
  returnFocus?(): HTMLElement | null;
  style?: React.CSSProperties;
}) {
  const descriptionId = React.useId();
  const openedAsTab = React.useRef(false);
  React.useEffect(() => {
    if (open) openedAsTab.current = false;
  }, [open]);
  // Header and transcript links share the same close/focus handoff.
  const closeForNavigation = () => {
    openedAsTab.current = true;
    onClose();
  };
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent
        data-session-peek-dialog=""
        aria-describedby={description === undefined ? undefined : descriptionId}
        className="flex h-[70svh] w-[calc(100%-2rem)] flex-col gap-0 overflow-hidden p-0 transition-none"
        style={{ maxWidth: "var(--container-content)", ...style }}
        // A modal's Escape must not also dismiss the peek/parent behind it.
        onEscapeKeyDown={(event) => event.stopPropagation()}
        onCloseAutoFocus={(event) => {
          // Navigation hands focus to the destination pane, not the row that
          // opened this preview (which may now be behind another tab).
          if (openedAsTab.current) {
            event.preventDefault();
            return;
          }
          const target = returnFocus?.() ?? null;
          if (target === null) return;
          event.preventDefault();
          target.focus();
        }}
      >
        <div className="flex shrink-0 flex-col gap-1 border-b border-border py-4 pr-12 pl-4">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <DialogTitle className="min-w-0 flex-1 truncate text-ui font-semibold" title={title}>
              {title}
            </DialogTitle>
            {state === undefined ? null : (
              <span data-session-peek-state="" className="text-ui text-muted-foreground">
                {state}
              </span>
            )}
            {metadata}
            {onOpen === undefined ? null : (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => {
                  closeForNavigation();
                  onOpen();
                }}
              >
                <ArrowSquareOutIcon />
                {openLabel}
              </Button>
            )}
          </div>
          {description === undefined ? null : (
            <DialogDescription id={descriptionId} className="text-ui">
              {description}
            </DialogDescription>
          )}
        </div>
        {typeof children === "function" ? children(closeForNavigation) : children}
      </DialogContent>
    </Dialog>
  );
}

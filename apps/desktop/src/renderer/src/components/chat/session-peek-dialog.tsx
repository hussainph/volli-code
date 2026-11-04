import * as React from "react";
import { ArrowSquareOutIcon } from "@phosphor-icons/react/dist/csr/ArrowSquareOut";

import { Button } from "@renderer/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@renderer/components/ui/dialog";

/** Shared overlay chrome for subagents and sidebar conversation previews.
 * The host owns the Session surface, scope, delivery and draft lifetime.
 */
export function SessionPeekDialog({
  open,
  title,
  state,
  metadata,
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
  state?: React.ReactNode;
  metadata?: React.ReactNode;
  openLabel?: string;
  onOpen?(): void;
  onClose(): void;
  returnFocus?(): HTMLElement | null;
  style?: React.CSSProperties;
}) {
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
        aria-describedby={undefined}
        className="flex h-[70svh] max-h-none w-[calc(100%-2rem)] flex-col gap-0 overflow-hidden p-0 transition-none"
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
        <div className="relative flex shrink-0 flex-col gap-2 py-4 pr-12 pl-4 after:absolute after:inset-x-[10%] after:bottom-0 after:border-b after:border-border">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <DialogTitle className="min-w-0 flex-1 break-words text-heading font-semibold">
              {title}
            </DialogTitle>
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
          {state === undefined && metadata === undefined ? null : (
            <div className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-2">
              {state === undefined ? null : (
                <span
                  data-session-peek-state=""
                  className="inline-flex shrink-0 items-center gap-1 text-ui text-muted-foreground"
                >
                  {state}
                </span>
              )}
              {metadata}
            </div>
          )}
        </div>
        {typeof children === "function" ? children(closeForNavigation) : children}
      </DialogContent>
    </Dialog>
  );
}

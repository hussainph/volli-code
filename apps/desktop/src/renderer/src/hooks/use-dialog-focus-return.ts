import * as React from "react";

/** A controlled dialog has no Radix Trigger to restore. Sample its invoker
 * during the opening render: an autoFocus child has already taken focus by
 * onOpenAutoFocus. Restore only after Radix releases the closing focus scope.
 */
export function useDialogFocusReturn(open: boolean) {
  const candidate = React.useMemo(() => {
    const active = open ? document.activeElement : null;
    return active instanceof HTMLElement ? active : null;
  }, [open]);
  const invoker = React.useRef<HTMLElement | null>(null);
  const skipped = React.useRef(false);
  React.useLayoutEffect(() => {
    if (open) {
      invoker.current = candidate;
      skipped.current = false;
    }
  }, [open, candidate]);
  const skipFocusReturn = React.useCallback(() => {
    skipped.current = true;
  }, []);
  const restoreFocus = React.useCallback((event: Event) => {
    const target = invoker.current;
    invoker.current = null;
    if (event.defaultPrevented || skipped.current || !target?.isConnected) return;
    event.preventDefault();
    target.focus({ preventScroll: true });
  }, []);
  return { restoreFocus, skipFocusReturn };
}

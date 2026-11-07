/**
 * One deferred layout driver for the auto-height document editor (whose Monaco
 * automaticLayout is disabled). Both content-size dispatch and the pane's
 * ResizeObserver only schedule a frame, never synchronously re-enter Monaco.
 *
 * The desired host height and VC-99 notification are unclamped; the layout
 * uses the CSS-clamped box measured AFTER the height write. Ports keep this
 * scheduling/lifetime contract testable without Monaco or DOM.
 */
export function createDocumentLayout(ports: {
  getContentHeight(): number;
  setHeight(px: number): void;
  getHostSize(): { width: number; height: number };
  layout(size: { width: number; height: number }): void;
  isResizeActive(): boolean;
  onContentHeightChange(px: number): void;
  requestFrame(callback: () => void): number;
  cancelFrame(id: number): void;
}): { schedule(): void; dispose(): void } {
  let frame: number | null = null;
  let disposed = false;
  let height: number | null = null;
  let size: { width: number; height: number } | null = null;

  return {
    schedule() {
      if (disposed || frame !== null) return;
      frame = ports.requestFrame(() => {
        frame = null;
        // observePaneLayout schedules again when the resize transaction ends.
        if (disposed || ports.isResizeActive()) return;
        const next = ports.getContentHeight();
        const changed = next !== height;
        if (changed) {
          height = next;
          ports.setHeight(next);
        }
        const nextSize = ports.getHostSize();
        if (
          nextSize.width > 0 &&
          nextSize.height > 0 &&
          (nextSize.width !== size?.width || nextSize.height !== size?.height)
        ) {
          size = nextSize;
          ports.layout(nextSize);
        }
        if (changed) ports.onContentHeightChange(next);
      });
    },
    dispose() {
      disposed = true;
      if (frame !== null) ports.cancelFrame(frame);
      frame = null;
    },
  };
}
